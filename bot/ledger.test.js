"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLedger } = require("./ledger");

test("10-second cooldown is per user, expires, and survives restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "young-money-cooldown-"));
  let time = 1770000000000;
  try {
    let ledger = await createLedger(dir, () => time);
    await ledger.createAttempt("123");
    assert.equal(typeof await ledger.createAttempt("456"), "string");
    await assert.rejects(ledger.createAttempt("123"), error =>
      error.status === 429 && error.retryAfterSeconds === 10);
    time += 9001;
    await assert.rejects(ledger.createAttempt("123"), error =>
      error.status === 429 && error.retryAfterSeconds === 1);
    time += 999;
    ledger = await createLedger(dir, () => time);
    assert.equal(typeof await ledger.createAttempt("123"), "string");
    ledger = await createLedger(dir, () => time);
    await assert.rejects(ledger.createAttempt("123"), error => error.status === 429);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Mini App progress resets at midnight in Sao Paulo, counting only confirmed videos", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "young-money-daily-"));
  let time = Date.parse("2026-10-08T02:59:30.000Z");
  try {
    const ledger = await createLedger(dir, () => time);
    const ymid = await ledger.createAttempt("123");
    await ledger.recordCompletion("123", ymid);
    assert.deepEqual(ledger.dailyVideoProgress("123"), { day: "2026-10-07", completed: 0, goal: 15 });
    await ledger.recordAdEvent({ ymid, userId: "123", event: "impression", valued: true, price: 0.001, zone: "11977205", source: "daily_video" });
    assert.equal(ledger.dailyVideoProgress("123").completed, 1);
    time += 60000;
    assert.deepEqual(ledger.dailyVideoProgress("123"), { day: "2026-10-08", completed: 0, goal: 15 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
