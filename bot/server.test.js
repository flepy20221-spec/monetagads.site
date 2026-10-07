"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createServer } = require("./server");

const config = {
  botToken: "test-token",
  webhookSecret: "a-secure-example-secret",
  postbackSecret: "example-postback-secret-long-enough-123",
  adminSecret: "example-admin-secret-long-enough-12345",
  webAppUrl: "https://example.com/monetagads.site/"
};

async function withServer(run) {
  const sent = [];
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "young-money-test-"));
  const server = await createServer({ ...config, dataDir, sendMessage: async message => sent.push(message) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, sent, dataDir);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function initData(id) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) });
  const key = crypto.createHmac("sha256", "WebAppData").update(config.botToken).digest();
  const hash = crypto.createHmac("sha256", key).update([...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n")).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

test("health is public; webhook requires the Telegram secret", async () => {
  await withServer(async (base, sent) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const response = await fetch(`${base}/telegram/webhook`, { method: "POST", body: "{}" });
    assert.equal(response.status, 403);
    assert.equal(sent.length, 0);
  });
});

test("private /start returns the Mini App button and privacy link", async () => {
  await withServer(async (base, sent) => {
    const response = await fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
      body: JSON.stringify({ message: { chat: { id: 123, type: "private" }, text: "/start" } })
    });
    assert.equal(response.status, 200);
    assert.equal(sent[0].chat_id, 123);
    assert.equal(sent[0].reply_markup.inline_keyboard[0][0].web_app.url, config.webAppUrl);
    assert.equal(sent[0].reply_markup.inline_keyboard[1][0].url, `${config.webAppUrl}privacy.html`);
  });
});

test("ignores group messages and rejects malformed JSON", async () => {
  await withServer(async (base, sent) => {
    const headers = { "x-telegram-bot-api-secret-token": config.webhookSecret };
    const group = await fetch(`${base}/telegram/webhook`, {
      method: "POST", headers,
      body: JSON.stringify({ message: { chat: { id: 42, type: "group" }, text: "/start" } })
    });
    assert.equal(group.status, 200);
    assert.equal(sent.length, 0);
    const broken = await fetch(`${base}/telegram/webhook`, { method: "POST", headers, body: "{" });
    assert.equal(broken.status, 400);
  });
});

test("signed user attempt links priced impression and click once, with a private admin report", async () => {
  await withServer(async (base, sent, dataDir) => {
    const headers = { origin: "https://example.com", "x-telegram-init-data": initData(123) };
    assert.equal((await fetch(`${base}/api/ad-attempts`, { method: "POST", headers: { ...headers, "x-telegram-init-data": "forged" } })).status, 401);
    assert.equal((await fetch(`${base}/api/ad-attempts`, { method: "POST", headers: { ...headers, origin: "https://evil.example" } })).status, 403);
    const attempt = await fetch(`${base}/api/ad-attempts`, { method: "POST", headers });
    assert.equal(attempt.status, 201);
    const { ymid } = await attempt.json();
    const rapidRepeat = await fetch(`${base}/api/ad-attempts`, { method: "POST", headers });
    assert.equal(rapidRepeat.status, 429);
    assert.equal(rapidRepeat.headers.get("retry-after"), "10");
    assert.equal((await rapidRepeat.json()).retryAfterSeconds, 10);
    const url = new URL(`${base}/monetag/postback`);
    Object.entries({ key: config.postbackSecret, ymid, event: "impression", value: "valued", zone: "11977205", telegram_id: "123", source: "daily_video", price: "0.003700" }).forEach(([k, v]) => url.searchParams.set(k, v));
    assert.equal((await fetch(url.toString().replace(config.postbackSecret, "bad"))).status, 403);
    url.searchParams.set("telegram_id", "456");
    assert.equal((await (await fetch(url)).json()).result, "ignored");
    url.searchParams.set("telegram_id", "123");
    url.searchParams.set("event", "click");
    assert.equal((await (await fetch(url)).json()).result, "recorded");
    assert.equal((await (await fetch(url)).json()).result, "duplicate");
    url.searchParams.set("event", "impression");
    assert.equal((await (await fetch(url)).json()).result, "recorded");
    assert.equal((await (await fetch(url)).json()).result, "duplicate");
    const counts = await (await fetch(`${base}/api/impressions`, { headers })).json();
    assert.equal(counts.total, 1);
    assert.equal(counts.valued, 1);
    const other = await (await fetch(`${base}/api/impressions`, { headers: { ...headers, "x-telegram-init-data": initData(456) } })).json();
    assert.equal(other.total, 0);
    assert.equal((await fetch(`${base}/admin/monetag`)).status, 403);
    const adminHeaders = { authorization: `Bearer ${config.adminSecret}` };
    const reportResponse = await fetch(`${base}/admin/monetag?telegram_id=123`, { headers: adminHeaders });
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json();
    assert.equal(report.currency, "USD");
    assert.equal(report.totals.impressions, 1);
    assert.equal(report.totals.clicks, 1);
    assert.equal(report.totals.users, 1);
    assert.equal(report.selected.telegramId, "123");
    assert.equal(report.selected.totalAds, 1);
    assert.equal(report.selected.ads[0].ymid, ymid);
    assert.equal(report.selected.ads[0].estimatedUsd, 0.0074);
    assert.equal((await fetch(`${base}/admin/monetag?limit=101`, { headers: adminHeaders })).status, 400);
    const secondAttempt = await fetch(`${base}/api/ad-attempts`, {
      method: "POST", headers: { ...headers, "x-telegram-init-data": initData(456) }
    });
    const { ymid: secondYmid } = await secondAttempt.json();
    url.searchParams.set("ymid", secondYmid);
    url.searchParams.set("telegram_id", "456");
    url.searchParams.set("value", "non_valued");
    url.searchParams.set("price", "0.5");
    assert.equal((await (await fetch(url)).json()).result, "recorded");
    const unpaid = await (await fetch(`${base}/admin/monetag?telegram_id=456`, { headers: adminHeaders })).json();
    assert.equal(unpaid.totals.estimatedUsd, 0.0074);
    assert.equal(unpaid.selected.estimatedUsd, 0);
    const status = await fetch(`${base}/telegram/webhook`, {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
      body: JSON.stringify({ message: { chat: { id: 123, type: "private" }, from: { id: 123 }, text: "/status" } })
    });
    assert.equal(status.status, 200);
    assert.match(sent[0].text, /Total: 1 \(1 monetizadas\)/);
    const restarted = await createServer({ ...config, dataDir, sendMessage: async () => {} });
    assert.equal(restarted.listening, false);
    await new Promise(resolve => restarted.listen(0, "127.0.0.1", resolve));
    const reloadedCounts = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/impressions`, { headers })).json();
    assert.equal(reloadedCounts.total, 1);
    const reloadedReport = await (await fetch(`http://127.0.0.1:${restarted.address().port}/admin/monetag?telegram_id=123`, { headers: adminHeaders })).json();
    assert.equal(reloadedReport.selected.ads[0].estimatedUsd, 0.0074);
    await new Promise(resolve => restarted.close(resolve));
  });
});
