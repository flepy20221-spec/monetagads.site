"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("./server");

const config = {
  botToken: "test-token",
  webhookSecret: "a-secure-example-secret",
  webAppUrl: "https://example.com/monetagads.site/"
};

async function withServer(run) {
  const sent = [];
  const server = createServer({ ...config, sendMessage: async message => sent.push(message) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, sent);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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
