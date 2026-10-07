"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const MAX_BODY_BYTES = 64 * 1024;

function secureEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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

function makeMessage(update, webAppUrl) {
  const message = update?.message;
  if (message?.chat?.type !== "private" || typeof message.text !== "string") return null;
  const command = /^\/(start|abrir|ajuda|privacidade)(?:@YoungMoneyOFC_bot)?(?:\s|$)/i.exec(message.text)?.[1]?.toLowerCase();
  if (!command) return null;

  const privacyUrl = new URL("privacy.html", webAppUrl).toString();
  if (command === "privacidade") {
    return { chat_id: message.chat.id, text: `Política de privacidade da Mini App Young Money:\n${privacyUrl}` };
  }
  if (command === "ajuda") {
    return {
      chat_id: message.chat.id,
      text: "Toque em Abrir Mini App para assistir aos anúncios disponíveis. O limite visual é de 15 vídeos por dia neste dispositivo. O contador local não representa saldo, pontos ou saque. Se um anúncio estiver indisponível, tente novamente mais tarde.",
      reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Mini App", web_app: { url: webAppUrl } }], [{ text: "Privacidade", url: privacyUrl }]] }
    };
  }
  return {
    chat_id: message.chat.id,
    text: "Bem-vindo ao Young Money! Abra a Mini App para assistir aos vídeos disponíveis e acompanhar seu limite diário de até 15 vídeos.",
    reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Mini App", web_app: { url: webAppUrl } }], [{ text: "Privacidade", url: privacyUrl }]] }
  };
}

function createServer({ botToken, webhookSecret, webAppUrl, sendMessage }) {
  if (!botToken || !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret || "")) {
    throw new Error("BOT_TOKEN and WEBHOOK_SECRET must be configured");
  }
  const url = new URL(webAppUrl);
  if (url.protocol !== "https:") throw new Error("WEBAPP_URL must use HTTPS");
  const appUrl = url.toString();

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
    if (req.method === "GET" && req.url === "/health") {
      reply(res, 200, { ok: true });
      return;
    }
    if (req.method !== "POST" || req.url !== "/telegram/webhook") {
      reply(res, 404, { ok: false });
      return;
    }
    if (!secureEqual(req.headers["x-telegram-bot-api-secret-token"], webhookSecret)) {
      reply(res, 403, { ok: false });
      return;
    }
    try {
      const update = await readJson(req);
      const message = makeMessage(update, appUrl);
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
  const server = createServer({
    botToken: process.env.BOT_TOKEN,
    webhookSecret: process.env.WEBHOOK_SECRET,
    webAppUrl: process.env.WEBAPP_URL
  });
  server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
    console.log("Young Money Telegram webhook listening");
  });
}

module.exports = { createServer, makeMessage };
