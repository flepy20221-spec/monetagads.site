"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// One Railway replica owns this append-only file on its persistent volume.
// Writes are serialized and synced before a Monetag postback is acknowledged.
async function createLedger(dataDir, now = () => Date.now()) {
  if (!dataDir) throw new Error("DATA_DIR must point to a persistent volume");
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "ad-events.jsonl");
  const attempts = new Map();
  const lastAttemptByUser = new Map();
  const impressions = new Map();
  const clicks = new Map();
  const profiles = new Map();
  const contents = await fs.readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const lines = contents.split("\n");
  // A crash can leave an unfinished last line. It must not become an event.
  const complete = contents.endsWith("\n") ? lines : lines.slice(0, -1);
  for (const line of complete) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (row.kind === "attempt") {
      attempts.set(row.ymid, row);
      lastAttemptByUser.set(row.userId, row);
      if (row.name) profiles.set(row.userId, { name: row.name, username: row.username || null, at: row.at });
    }
    if (row.kind === "impression") impressions.set(row.ymid, row);
    if (row.kind === "click") clicks.set(row.ymid, row);
    if (row.kind === "profile") profiles.set(row.userId, { name: row.name, username: row.username || null, at: row.at });
  }
  if (contents && !contents.endsWith("\n")) {
    await fs.truncate(file, Buffer.byteLength(complete.join("\n") + "\n"));
  }

  let tail = Promise.resolve();
  function serialized(action) {
    const task = tail.then(action);
    tail = task.catch(() => {});
    return task;
  }
  async function append(row) {
    const handle = await fs.open(file, "a");
    try {
      await handle.writeFile(JSON.stringify(row) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return {
    createAttempt(userId, profile = null) {
      return serialized(async () => {
        const timestamp = now();
        const last = lastAttemptByUser.get(userId);
        const elapsed = last ? timestamp - Date.parse(last.at) : Infinity;
        if (elapsed < 10000) {
          const error = new Error("Ad cooldown active");
          error.status = 429;
          error.retryAfterSeconds = Math.ceil(Math.min(10000, 10000 - elapsed) / 1000);
          throw error;
        }
        const row = {
          kind: "attempt", ymid: crypto.randomUUID(), userId, at: new Date(timestamp).toISOString(),
          ...(profile?.name ? { name: profile.name, username: profile.username || null } : {})
        };
        await append(row);
        attempts.set(row.ymid, row);
        lastAttemptByUser.set(userId, row);
        if (row.name) profiles.set(userId, { name: row.name, username: row.username, at: row.at });
        return row.ymid;
      });
    },
    saveProfile(userId, profile) {
      return serialized(async () => {
        if (!profile?.name) return false;
        const current = profiles.get(userId);
        const timestamp = now();
        if (current?.name === profile.name && current?.username === (profile.username || null) &&
            timestamp - Date.parse(current.at) < 86400000) return false;
        const row = {
          kind: "profile", userId, name: profile.name,
          username: profile.username || null, at: new Date(timestamp).toISOString()
        };
        await append(row);
        profiles.set(userId, { name: row.name, username: row.username, at: row.at });
        return true;
      });
    },
    getProfile(userId) { return profiles.get(userId) || null; },
    recordAdEvent({ ymid, userId, event, valued, price, zone, sub, source }) {
      return serialized(async () => {
        const attempt = attempts.get(ymid);
        if (!attempt || (userId && userId !== attempt.userId)) return "ignored";
        const collection = event === "click" ? clicks : impressions;
        if (collection.has(ymid)) return "duplicate";
        const row = {
          kind: event, ymid, userId: attempt.userId, valued,
          price, zone, sub, source, at: new Date(now()).toISOString()
        };
        await append(row);
        collection.set(ymid, row);
        return "recorded";
      });
    },
    report(telegramId = "", limit = 100) {
      const today = new Date(now()).toISOString().slice(0, 10);
      const totals = { impressions: 0, valuedImpressions: 0, clicks: 0, estimatedUsd: 0, todayEstimatedUsd: 0, users: 0 };
      const firstDay = Date.parse(`${today}T00:00:00.000Z`) - 29 * 86400000;
      const dailyRevenue = new Map(Array.from({ length: 30 }, (_, index) => [
        new Date(firstDay + index * 86400000).toISOString().slice(0, 10), 0
      ]));
      const users = new Map();
      const ads = new Map();
      for (const row of [...impressions.values(), ...clicks.values()]) {
        const usd = row.valued && Number.isFinite(row.price) && row.price > 0 ? row.price : 0;
        const user = users.get(row.userId) || {
          telegramId: row.userId, impressions: 0, valuedImpressions: 0,
          clicks: 0, estimatedUsd: 0, lastAt: row.at,
          name: profiles.get(row.userId)?.name || null,
          username: profiles.get(row.userId)?.username || null
        };
        if (row.kind === "impression") {
          totals.impressions++;
          user.impressions++;
          if (row.valued) { totals.valuedImpressions++; user.valuedImpressions++; }
        } else { totals.clicks++; user.clicks++; }
        totals.estimatedUsd += usd;
        if (row.at.slice(0, 10) === today) totals.todayEstimatedUsd += usd;
        const day = row.at.slice(0, 10);
        if (dailyRevenue.has(day)) dailyRevenue.set(day, dailyRevenue.get(day) + usd);
        user.estimatedUsd += usd;
        if (row.at > user.lastAt) user.lastAt = row.at;
        users.set(row.userId, user);
        if (row.userId === telegramId) {
          const ad = ads.get(row.ymid) || {
            ymid: row.ymid, at: row.at, impression: null, click: null, estimatedUsd: 0
          };
          ad[row.kind] = { at: row.at, valued: row.valued, estimatedUsd: usd };
          ad.estimatedUsd += usd;
          if (row.at > ad.at) ad.at = row.at;
          ads.set(row.ymid, ad);
        }
      }
      const recentUsers = [...users.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      totals.users = users.size;
      const selected = telegramId ? {
        ...(users.get(telegramId) || { telegramId, impressions: 0, valuedImpressions: 0, clicks: 0, estimatedUsd: 0, lastAt: null, name: null, username: null }),
        totalAds: ads.size,
        ads: [...ads.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
      } : null;
      return {
        currency: "USD", totals, users: recentUsers.slice(0, 50), selected,
        dailyRevenue: [...dailyRevenue].map(([date, estimatedUsd]) => ({ date, estimatedUsd }))
      };
    },
    counts(userId) {
      const today = new Date().toISOString().slice(0, 10);
      const result = { today, total: 0, valued: 0, todayTotal: 0, todayValued: 0 };
      for (const row of impressions.values()) {
        if (row.userId !== userId) continue;
        result.total++;
        if (row.valued) result.valued++;
        if (row.at.slice(0, 10) === today) {
          result.todayTotal++;
          if (row.valued) result.todayValued++;
        }
      }
      return result;
    }
  };
}

module.exports = { createLedger };
