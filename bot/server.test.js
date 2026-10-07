"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createServer, fetchTelegramPhoto, configureTelegramWebhook } = require("./server");

const config = {
  botToken: "test-token",
  webhookSecret: "a-secure-example-secret",
  postbackSecret: "example-postback-secret-long-enough-123",
  adminSecret: "example-admin-secret-long-enough-12345",
  webAppUrl: "https://example.com/monetagads.site/"
};

async function withServer(run, { getTelegramChat = async () => null, getTelegramPhoto, answerCallback } = {}) {
  const sent = [];
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "young-money-test-"));
  const server = await createServer({ ...config, dataDir, sendMessage: async message => sent.push(message), answerCallback, getTelegramChat, getTelegramPhoto });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, sent, dataDir);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function initData(id, profile = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, ...profile }) });
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

test("startup registers callback_query updates without discarding pending messages", async () => {
  const calls = [];
  await configureTelegramWebhook("test-token", config.webhookSecret,
    "telegram-webhook-production-aa93.up.railway.app", async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/setWebhook")) {
        const body = JSON.parse(options.body);
        assert.equal(body.url, "https://telegram-webhook-production-aa93.up.railway.app/telegram/webhook");
        assert.equal(body.secret_token, config.webhookSecret);
        assert.deepEqual(body.allowed_updates, ["message", "callback_query"]);
        assert.equal(body.drop_pending_updates, undefined);
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify({ ok: true, result: {
        url: "https://telegram-webhook-production-aa93.up.railway.app/telegram/webhook",
        allowed_updates: ["message", "callback_query"]
      } }));
    });
  assert.equal(calls.length, 2);
  await assert.rejects(configureTelegramWebhook("test-token", config.webhookSecret,
    "attacker.example", async () => { throw new Error("must not send"); }));
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
    const headers = { origin: "https://example.com", "x-telegram-init-data": initData(123, { first_name: "Ana", last_name: "Silva", username: "ana_silva" }) };
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
    assert.equal(report.dailyRevenue.length, 30);
    assert.equal(report.dailyRevenue.at(-1).estimatedUsd, report.totals.todayEstimatedUsd);
    assert.equal(report.selected.telegramId, "123");
    assert.equal(report.selected.name, "Ana Silva");
    assert.equal(report.selected.username, "ana_silva");
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
    const restarted = await createServer({ ...config, dataDir, sendMessage: async () => {}, getTelegramChat: async () => null });
    assert.equal(restarted.listening, false);
    await new Promise(resolve => restarted.listen(0, "127.0.0.1", resolve));
    const reloadedCounts = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/impressions`, { headers })).json();
    assert.equal(reloadedCounts.total, 1);
    const reloadedReport = await (await fetch(`http://127.0.0.1:${restarted.address().port}/admin/monetag?telegram_id=123`, { headers: adminHeaders })).json();
    assert.equal(reloadedReport.selected.ads[0].estimatedUsd, 0.0074);
    assert.equal(reloadedReport.selected.name, "Ana Silva");
    await new Promise(resolve => restarted.close(resolve));
  });
});

test("admin photo endpoint serves a small Telegram thumbnail without exposing the bot token", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const requested = [];
  const photo = await fetchTelegramPhoto(config.botToken, "123", async url => {
    const parsed = new URL(url);
    requested.push(parsed.pathname);
    if (parsed.pathname.endsWith("/getUserProfilePhotos")) {
      assert.equal(parsed.searchParams.get("user_id"), "123");
      return new Response(JSON.stringify({ ok: true, result: { photos: [[{ file_id: "small", file_size: 4 }]] } }));
    }
    if (parsed.pathname.endsWith("/getFile")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/thumb.jpg", file_size: 4 } }));
    }
    return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
  });
  assert.deepEqual(photo.bytes, jpeg);
  assert.equal(requested.length, 3);

  let photoLookups = 0;
  await withServer(async base => {
    assert.equal((await fetch(`${base}/admin/telegram-photo?telegram_id=123`)).status, 403);
    const headers = { authorization: `Bearer ${config.adminSecret}` };
    assert.equal((await fetch(`${base}/admin/telegram-photo?telegram_id=abc`, { headers })).status, 400);
    const response = await fetch(`${base}/admin/telegram-photo?telegram_id=123`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg);
    await fetch(`${base}/admin/telegram-photo?telegram_id=123`, { headers });
    assert.equal(photoLookups, 1);
  }, { getTelegramPhoto: async id => { photoLookups++; assert.equal(id, "123"); return photo; } });
});

test("video total counts one signed SDK completion only after a Monetag impression and survives restart", async () => {
  await withServer(async (base, _sent, dataDir) => {
    const headers = { origin: "https://example.com", "x-telegram-init-data": initData(123, { first_name: "Ana" }) };
    const { ymid } = await (await fetch(`${base}/api/ad-attempts`, { method: "POST", headers })).json();
    const completionUrl = `${base}/api/ad-completions`;
    const completion = { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ ymid }) };
    assert.equal((await fetch(completionUrl, { ...completion, headers: { ...completion.headers, "x-telegram-init-data": "forged" } })).status, 401);
    assert.equal((await fetch(completionUrl, { ...completion, headers: { ...completion.headers, origin: "https://evil.example" } })).status, 403);
    assert.equal((await fetch(completionUrl, { ...completion, headers: { ...completion.headers, "x-telegram-init-data": initData(456) } })).status, 404);
    assert.equal((await fetch(completionUrl, { ...completion, body: "{}" })).status, 400);
    assert.equal((await (await fetch(completionUrl, completion)).json()).result, "recorded");
    assert.equal((await (await fetch(completionUrl, completion)).json()).result, "duplicate");

    const adminUrl = `${base}/admin/monetag?telegram_id=123`;
    const adminHeaders = { authorization: `Bearer ${config.adminSecret}` };
    let report = await (await fetch(adminUrl, { headers: adminHeaders })).json();
    assert.equal(report.totals.completedVideos, 0);

    const postback = new URL(`${base}/monetag/postback`);
    Object.entries({ key: config.postbackSecret, ymid, event: "click", value: "valued", zone: "11977205", telegram_id: "123", source: "daily_video", price: "0.001" })
      .forEach(([key, value]) => postback.searchParams.set(key, value));
    assert.equal((await (await fetch(postback)).json()).result, "recorded");
    report = await (await fetch(adminUrl, { headers: adminHeaders })).json();
    assert.equal(report.selected.completedVideos, 0);
    postback.searchParams.set("event", "impression");
    assert.equal((await (await fetch(postback)).json()).result, "recorded");
    report = await (await fetch(adminUrl, { headers: adminHeaders })).json();
    assert.equal(report.totals.completedVideos, 1);
    assert.equal(report.selected.completedVideos, 1);
    assert.equal(report.users[0].completedVideos, 1);
    const restarted = await createServer({ ...config, dataDir, sendMessage: async () => {}, getTelegramChat: async () => null });
    await new Promise(resolve => restarted.listen(0, "127.0.0.1", resolve));
    const reloaded = await (await fetch(`http://127.0.0.1:${restarted.address().port}/admin/monetag?telegram_id=123`, { headers: adminHeaders })).json();
    assert.equal(reloaded.selected.completedVideos, 1);
    await new Promise(resolve => restarted.close(resolve));
  });
});

test("Telegram callback confirms the app link and exposes only today's paired completions", async () => {
  const answers = [];
  await withServer(async (base, sent, dataDir) => {
    const created = await fetch(`${base}/api/app-links`, { method: "POST" });
    assert.equal(created.status, 201);
    const { token, url } = await created.json();
    const id = new URL(url).searchParams.get("start").slice("link_".length);
    const statusUrl = `${base}/api/app-links/status`;
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(statusUrl)).status, 401);
    assert.deepEqual(await (await fetch(statusUrl, { headers: auth })).json(), { state: "pending" });
    const webhook = payload => fetch(`${base}/telegram/webhook`, {
      method: "POST", headers: { "x-telegram-bot-api-secret-token": config.webhookSecret },
      body: JSON.stringify(payload)
    });
    await webhook({ message: { chat: { id: 123, type: "private" }, from: { id: 123, first_name: "Ana" }, text: `/start link_${id}` } });
    assert.equal(sent[0].reply_markup.inline_keyboard[0][0].callback_data, `connect:${id}`);
    assert.equal((await (await fetch(statusUrl, { headers: auth })).json()).state, "pending");
    await webhook({ callback_query: { id: "bad", data: `connect:${id}`, from: { id: 456 }, message: { chat: { id: 123, type: "private" } } } });
    assert.equal((await (await fetch(statusUrl, { headers: auth })).json()).state, "pending");
    await webhook({ callback_query: { id: "good", data: `connect:${id}`, from: { id: 123, first_name: "Ana" }, message: { chat: { id: 123, type: "private" } } } });
    assert.equal(answers.at(-1).text.startsWith("Conta vinculada"), true);
    let progress = await (await fetch(statusUrl, { headers: auth })).json();
    assert.equal(progress.state, "linked");
    assert.equal(progress.completed, 0);
    assert.equal(progress.goal, 15);

    const headers = { origin: "https://example.com", "x-telegram-init-data": initData(123) };
    const { ymid } = await (await fetch(`${base}/api/ad-attempts`, { method: "POST", headers })).json();
    await fetch(`${base}/api/ad-completions`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ymid })
    });
    progress = await (await fetch(statusUrl, { headers: auth })).json();
    assert.equal(progress.completed, 0);
    const postback = new URL(`${base}/monetag/postback`);
    Object.entries({ key: config.postbackSecret, ymid, event: "impression", value: "valued", zone: "11977205", telegram_id: "123", source: "daily_video", price: "0.001" })
      .forEach(([key, value]) => postback.searchParams.set(key, value));
    await fetch(postback);
    progress = await (await fetch(statusUrl, { headers: auth })).json();
    assert.equal(progress.completed, 1);
    assert.match(progress.day, /^\d{4}-\d\d-\d\d$/);
    assert.equal((await fetch(statusUrl, { headers: { authorization: `Bearer ${"a".repeat(43)}` } })).status, 401);

    const restarted = await createServer({ ...config, dataDir, sendMessage: async () => {}, answerCallback: async () => {} });
    await new Promise(resolve => restarted.listen(0, "127.0.0.1", resolve));
    const persisted = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/app-links/status`, { headers: auth })).json();
    assert.equal(persisted.completed, 1);
    await new Promise(resolve => restarted.close(resolve));
  }, { answerCallback: async answer => answers.push(answer) });
});

test("old Telegram IDs receive a cached name from getChat without changing their ads", async () => {
  let lookups = 0;
  await withServer(async (base, _sent, dataDir) => {
    const headers = { origin: "https://example.com", "x-telegram-init-data": initData(789) };
    const { ymid } = await (await fetch(`${base}/api/ad-attempts`, { method: "POST", headers })).json();
    const url = new URL(`${base}/monetag/postback`);
    Object.entries({ key: config.postbackSecret, ymid, event: "impression", value: "valued", zone: "11977205", telegram_id: "789", source: "daily_video", price: "0.00123" })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    assert.equal((await (await fetch(url)).json()).result, "recorded");
    const adminHeaders = { authorization: `Bearer ${config.adminSecret}` };
    const reportUrl = `${base}/admin/monetag?telegram_id=789`;
    const first = await (await fetch(reportUrl, { headers: adminHeaders })).json();
    assert.equal(first.selected.name, "Carlos Farias");
    assert.equal(first.users[0].name, "Carlos Farias");
    assert.equal(first.selected.estimatedUsd, 0.00123);
    await fetch(reportUrl, { headers: adminHeaders });
    assert.equal(lookups, 1);
    const restarted = await createServer({ ...config, dataDir, sendMessage: async () => {}, getTelegramChat: async () => { throw new Error("offline"); } });
    await new Promise(resolve => restarted.listen(0, "127.0.0.1", resolve));
    const reloaded = await (await fetch(`http://127.0.0.1:${restarted.address().port}/admin/monetag?telegram_id=789`, { headers: adminHeaders })).json();
    assert.equal(reloaded.selected.name, "Carlos Farias");
    await new Promise(resolve => restarted.close(resolve));
  }, { getTelegramChat: async id => {
    lookups++;
    return { id: Number(id), type: "private", first_name: "Carlos", last_name: "Farias", username: "carlos" };
  } });
});
