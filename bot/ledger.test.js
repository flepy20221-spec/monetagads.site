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
    assert.deepEqual(ledger.dailyVideoProgress("123"), { day: "2026-10-07", completed: 0, goal: 15, rewardDays: [] });
    await ledger.recordAdEvent({ ymid, userId: "123", event: "impression", valued: true, price: 0.001, zone: "11977205", source: "daily_video" });
    assert.equal(ledger.dailyVideoProgress("123").completed, 1);
    time += 60000;
    assert.deepEqual(ledger.dailyVideoProgress("123"), { day: "2026-10-08", completed: 0, goal: 15, rewardDays: [] });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("confirmed impressions use server time in Sao Paulo and survive storage clearing and restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "young-money-impressions-"));
  let time = Date.parse("2026-10-08T02:59:30.000Z");
  try {
    let ledger = await createLedger(dir, () => time);
    const ymid = await ledger.createAttempt("123");
    await ledger.recordAdEvent({ ymid, userId: "123", event: "impression",
      valued: false, price: 0, zone: "11977205", source: "daily_video" });
    assert.equal(ledger.counts("123").today, "2026-10-07");
    assert.equal(ledger.counts("123").todayTotal, 1);
    assert.equal(ledger.counts("123").resetAt, "2026-10-08T03:00:00.000Z");
    ledger = await createLedger(dir, () => time);
    assert.equal(ledger.counts("123").todayTotal, 1);
    assert.equal(ledger.counts("456").todayTotal, 0);
    time += 30000;
    assert.equal(ledger.counts("123").todayTotal, 0);
    assert.equal(ledger.counts("123").total, 1);
    assert.equal(ledger.counts("123").today, "2026-10-08");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("account binding is permanent, one-to-one and preserved after restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "young-money-binding-"));
  try {
    let ledger = await createLedger(dir);
    assert.equal(await ledger.linkApp("token1", "123", 42, "a".repeat(64)), true);
    assert.equal(ledger.linkedAccount("123"), 42);
    assert.equal(ledger.linkAccount("token1"), 42);
    await assert.rejects(ledger.linkApp("token2", "456", 42), error => error.status === 409);
    await assert.rejects(ledger.linkApp("token3", "123", 43), error => error.status === 409);
    ledger = await createLedger(dir);
    assert.equal(ledger.linkedAccount("123"), 42);
    assert.equal(await ledger.linkApp("token4", "123", 42), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("15 completed videos unlock one daily reward; cap resets at Sao Paulo midnight", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "young-money-cap-"));
  let time = Date.parse("2026-10-07T15:00:00.000Z");
  try {
    let ledger = await createLedger(dir, () => time);
    for (let index = 0; index < 15; index++) {
      const ymid = await ledger.createAttempt("123");
      await ledger.recordAdEvent({ ymid, userId: "123", event: "impression",
        valued: false, price: 0, zone: "11977205", source: "daily_video" });
      await ledger.recordCompletion("123", ymid);
      assert.equal(await ledger.recordCompletion("123", ymid), "duplicate");
      time += 10000;
    }
    assert.equal(ledger.counts("123").todayTotal, 15);
    assert.equal(ledger.counts("123").completedVideos, 15);
    assert.deepEqual(ledger.counts("123").rewardDays, ["2026-10-07"]);
    await assert.rejects(ledger.createAttempt("123"), error => error.status === 409);
    time = Date.parse("2026-10-08T03:00:00.000Z");
    ledger = await createLedger(dir, () => time);
    assert.equal(ledger.counts("123").todayTotal, 0);
    assert.equal(ledger.counts("123").completedVideos, 0);
    assert.deepEqual(ledger.counts("123").rewardDays, ["2026-10-07"]);
    assert.equal(typeof await ledger.createAttempt("123"), "string");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
