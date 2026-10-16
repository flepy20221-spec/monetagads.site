"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const vm = require("node:vm");

test("the third action opens Popup within the click and sends its completion for a later paid click", async () => {
  const handlers = new Map();
  const elements = new Map();
  const calls = [];
  const ymid = "123e4567-e89b-12d3-a456-426614174000";
  let inClick = false;
  let completed = 2;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, style: {}, disabled: false, textContent: "",
      classList: { add() {}, remove() {} },
      setAttribute() {}, replaceChildren() {}, append() {},
      addEventListener(event, handler) { handlers.set(`${id}:${event}`, handler); }
    });
    return elements.get(id);
  }
  const context = {
    console, Date, Promise, Number, JSON, Math, AbortController,
    CustomEvent: class { constructor() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      hidden: false, getElementById: element,
      createElement: () => ({ style: {}, textContent: "" }),
      addEventListener() {}
    },
    window: {
      Telegram: { WebApp: { initData: "signed", ready() {}, expand() {} } },
      dispatchEvent() {}, addEventListener() {},
      show_11977205(options) {
        calls.push(options);
        if (options.type === "inApp") return Promise.resolve();
        assert.equal(options.type, "pop");
        assert.equal(inClick, true, "Popup must not wait for another async operation after the click");
        return Promise.resolve({ reward_event_type: "non_valued" });
      }
    },
    async fetch(url, options = {}) {
      if (url.endsWith("/api/impressions")) return new Response(JSON.stringify({
        todayTotal: completed, completedVideos: completed, today: "2026-10-13",
        serverNow: "2026-10-14T01:00:00Z", resetAt: "2026-10-14T03:00:00Z"
      }));
      if (url.endsWith("/api/ad-attempts")) {
        assert.equal(JSON.parse(options.body).format, "pop");
        return new Response(JSON.stringify({ ymid }), { status: 201 });
      }
      if (url.endsWith("/api/ad-completions")) {
        assert.equal(JSON.parse(options.body).ymid, ymid);
        completed++;
        return new Response(JSON.stringify({ ok: true }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    },
    Response
  };
  const app = await fs.readFile(path.join(__dirname, "../app.js"), "utf8");
  vm.runInNewContext(app, context, { filename: "app.js" });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("watch-button").disabled, true);
  assert.equal(elements.get("popup-button").disabled, false);
  inClick = true;
  handlers.get("popup-button:click")();
  inClick = false;
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].type, "inApp");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].inAppSettings)), {
    frequency: 2, capping: 0.1, interval: 30, timeout: 5, everyPage: false
  });
  assert.equal(calls[1].ymid, ymid);
  assert.equal(calls[1].requestVar, "daily_popup");
  assert.equal(completed, 3);
});

test("the video button remains available while the Popup button waits for its next step", async () => {
  const handlers = new Map();
  const elements = new Map();
  const calls = [];
  const ymid = "123e4567-e89b-12d3-a456-426614174001";
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, style: {}, disabled: false, textContent: "",
      classList: { add() {}, remove() {} },
      setAttribute() {}, replaceChildren() {}, append() {},
      addEventListener(event, handler) { handlers.set(`${id}:${event}`, handler); }
    });
    return elements.get(id);
  }
  const context = {
    Date, Promise, Number, JSON, Math, AbortController,
    CustomEvent: class { constructor() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      hidden: false, getElementById: element,
      createElement: () => ({ style: {}, textContent: "" }),
      addEventListener() {}
    },
    window: {
      Telegram: { WebApp: { initData: "signed", ready() {}, expand() {} } },
      dispatchEvent() {}, addEventListener() {},
      show_11977205(options) {
        calls.push(options);
        return Promise.resolve({ reward_event_type: "valued" });
      }
    },
    async fetch(url, options = {}) {
      if (url.endsWith("/api/impressions")) return new Response(JSON.stringify({
        todayTotal: 1, completedVideos: 1, today: "2026-10-13",
        serverNow: "2026-10-14T01:00:00Z", resetAt: "2026-10-14T03:00:00Z"
      }));
      if (url.endsWith("/api/ad-attempts")) {
        assert.equal(JSON.parse(options.body).format, "end");
        return new Response(JSON.stringify({ ymid }), { status: 201 });
      }
      if (url.endsWith("/api/ad-completions")) return new Response(JSON.stringify({ ok: true }));
      throw new Error(`Unexpected fetch: ${url}`);
    },
    Response
  };
  const app = await fs.readFile(path.join(__dirname, "../app.js"), "utf8");
  vm.runInNewContext(app, context, { filename: "app.js" });
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get("watch-button").disabled, false);
  assert.equal(elements.get("popup-button").disabled, true);
  assert.equal(elements.get("popup-button-label").textContent, "Oferta na etapa 3");
  handlers.get("popup-button:click")();
  assert.equal(calls.length, 1, "inactive Popup cannot open an ad");
  handlers.get("watch-button:click")();
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1].type, "end");
  assert.equal(calls[1].requestVar, "daily_video");
});
