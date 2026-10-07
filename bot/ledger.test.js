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
