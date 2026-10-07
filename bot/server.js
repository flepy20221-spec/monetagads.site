"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { createLedger } = require("./ledger");

const MAX_BODY_BYTES = 64 * 1024;

function secureEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function verifyInitData(raw, botToken, now = Date.now()) {
  if (typeof raw !== "string" || !raw || raw.length > 8192) return null;
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const hash = params.get("hash");
  if (!/^[a-f0-9]{64}$/i.test(hash || "")) return null;
  params.delete("hash");
  const data = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(data).digest("hex");
  if (!secureEqual(hash.toLowerCase(), expected)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isSafeInteger(authDate) || authDate <= 0 ||
      now / 1000 - authDate > 86400 || authDate - now / 1000 > 60) return null;
  try {
    const user = JSON.parse(params.get("user"));
    if (!Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return String(user.id);
  } catch { return null; }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Update too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

function makeMessage(update, webAppUrl, ledger) {
  const message = update?.message;
  if (message?.chat?.type !== "private" || typeof message.text !== "string") return null;
  const command = /^\/(start|abrir|ajuda|privacidade|status)(?:@YoungMoneyOFC_bot)?(?:\s|$)/i.exec(message.text)?.[1]?.toLowerCase();
  if (!command) return null;

  const privacyUrl = new URL("privacy.html", webAppUrl).toString();
  if (command === "status") {
    const userId = String(message.from?.id || message.chat.id);
    const counts = ledger.counts(userId);
    return {
      chat_id: message.chat.id,
      text: `Impressões confirmadas pela Monetag (UTC):\nHoje: ${counts.todayTotal} (${counts.todayValued} monetizadas)\nTotal: ${counts.total} (${counts.valued} monetizadas)\n\nUma impressão começa quando o anúncio aparece; não significa vídeo concluído, saldo ou saque.`
    };
  }
  if (command === "privacidade") {
    return { chat_id: message.chat.id, text: `Política de privacidade da Mini App Young Money:\n${privacyUrl}` };
  }
  if (command === "ajuda") {
    return {
      chat_id: message.chat.id,
      text: "Toque em Abrir Mini App para assistir aos anúncios disponíveis. O limite visual é de 15 vídeos por dia neste dispositivo. Use /status para consultar as impressões confirmadas pela Monetag. Impressões não representam saldo, pontos ou saque.",
      reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Mini App", web_app: { url: webAppUrl } }], [{ text: "Privacidade", url: privacyUrl }]] }
    };
  }
  return {
    chat_id: message.chat.id,
    text: "Bem-vindo ao Young Money! Abra a Mini App para assistir aos vídeos disponíveis e acompanhar seu limite diário de até 15 vídeos.",
    reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Mini App", web_app: { url: webAppUrl } }], [{ text: "Privacidade", url: privacyUrl }]] }
  };
}

async function createServer({ botToken, webhookSecret, postbackSecret, webAppUrl, dataDir, sendMessage }) {
  if (!botToken || !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret || "") ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(postbackSecret || "")) {
    throw new Error("BOT_TOKEN, WEBHOOK_SECRET and MONETAG_POSTBACK_SECRET must be configured");
  }
  const url = new URL(webAppUrl);
  if (url.protocol !== "https:") throw new Error("WEBAPP_URL must use HTTPS");
  const appUrl = url.toString();
  const ledger = await createLedger(dataDir);
  const allowedOrigin = new URL(appUrl).origin;

  const send = sendMessage || (async payload => {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok || !(await response.json()).ok) {
      throw new Error(`Telegram sendMessage failed (${response.status})`);
    }
  });

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, "http://localhost");
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      reply(res, 200, { ok: true });
      return;
    }
    if (requestUrl.pathname === "/api/ad-attempts" || requestUrl.pathname === "/api/impressions") {
      if (req.headers.origin !== allowedOrigin) { reply(res, 403, { ok: false }); return; }
      res.setHeader("access-control-allow-origin", allowedOrigin);
      res.setHeader("vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "x-telegram-init-data", "access-control-max-age": "600" });
        res.end();
        return;
      }
      const userId = verifyInitData(req.headers["x-telegram-init-data"], botToken);
      if (!userId) { reply(res, 401, { ok: false }); return; }
      try {
        if (req.method === "POST" && requestUrl.pathname === "/api/ad-attempts") {
          const ymid = await ledger.createAttempt(userId);
          reply(res, 201, { ymid });
          return;
        }
        if (req.method === "GET" && requestUrl.pathname === "/api/impressions") {
          reply(res, 200, ledger.counts(userId));
          return;
        }
      } catch (error) {
        if (error.status === 429) {
          res.setHeader("retry-after", String(error.retryAfterSeconds));
          reply(res, 429, { ok: false, retryAfterSeconds: error.retryAfterSeconds });
          return;
        }
        console.error("Ad ledger failed:", error.message);
        reply(res, 503, { ok: false });
        return;
      }
      reply(res, 405, { ok: false });
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/monetag/postback") {
      const q = requestUrl.searchParams;
      if (!secureEqual(q.get("key"), postbackSecret)) { reply(res, 403, { ok: false }); return; }
      const ymid = q.get("ymid");
      const event = q.get("event");
      const value = q.get("value");
      const zone = q.get("zone");
      const userId = q.get("telegram_id") || "";
      const source = q.get("source") || "";
      const sub = q.get("sub") || "";
      const priceText = q.get("price") || "";
      if (["key", "ymid", "event", "value", "zone", "telegram_id", "source", "sub", "price"].some(k => q.getAll(k).length > 1) ||
          !/^[a-f0-9-]{36}$/i.test(ymid || "") || zone !== "11977205" ||
          !["impression", "click"].includes(event) || !["valued", "non_valued"].includes(value) ||
          (userId && !/^\d{1,16}$/.test(userId)) ||
          (sub && !/^\d{1,16}$/.test(sub)) ||
          (source && source !== "daily_video") ||
          !/^\d+(?:\.\d+)?$/.test(priceText) || !Number.isFinite(Number(priceText))) {
        reply(res, 400, { ok: false }); return;
      }
      if (event === "click") { reply(res, 200, { ok: true, result: "click_ignored" }); return; }
      try {
        const result = await ledger.recordImpression({
          ymid, userId, valued: value === "valued", price: Number(priceText), zone, sub, source
        });
        reply(res, 200, { ok: true, result });
      } catch (error) {
        console.error("Postback persistence failed:", error.message);
        reply(res, 503, { ok: false });
      }
      return;
    }
    if (req.method !== "POST" || requestUrl.pathname !== "/telegram/webhook") {
      reply(res, 404, { ok: false });
      return;
    }
    if (!secureEqual(req.headers["x-telegram-bot-api-secret-token"], webhookSecret)) {
      reply(res, 403, { ok: false });
      return;
    }
    try {
      const update = await readJson(req);
      const message = makeMessage(update, appUrl, ledger);
      if (message) await send(message);
      reply(res, 200, { ok: true });
    } catch (error) {
      const status = error.status || 502;
      if (status === 502) console.error("Webhook processing failed:", error.message);
      reply(res, status, { ok: false });
    }
  });
}

if (require.main === module) {
  createServer({
    botToken: process.env.BOT_TOKEN,
    webhookSecret: process.env.WEBHOOK_SECRET,
    postbackSecret: process.env.MONETAG_POSTBACK_SECRET,
    webAppUrl: process.env.WEBAPP_URL,
    dataDir: process.env.DATA_DIR
  }).then(server => server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
    console.log("Young Money Telegram webhook and Monetag postback listening");
  })).catch(error => { console.error("Startup failed:", error); process.exitCode = 1; });
}

module.exports = { createServer, makeMessage, verifyInitData };
