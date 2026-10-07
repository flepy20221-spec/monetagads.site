"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const { createLedger } = require("./ledger");

const MAX_BODY_BYTES = 64 * 1024;
const MAX_AVATAR_BYTES = 256 * 1024;

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

function profileFromTelegram(user) {
  if (!user || typeof user !== "object") return null;
  const clean = value => typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 80) : "";
  const username = /^[A-Za-z0-9_]{1,32}$/.test(user.username || "") ? user.username : null;
  const name = [clean(user.first_name), clean(user.last_name)].filter(Boolean).join(" ").slice(0, 160)
    || (username ? `@${username}` : "");
  return name ? { name, username } : null;
}

function displayName(user) {
  return profileFromTelegram(user)?.name || "usuário";
}

async function fetchTelegramPhoto(botToken, userId, request = fetch) {
  const signal = AbortSignal.timeout(6500);
  const photosUrl = new URL(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos`);
  photosUrl.searchParams.set("user_id", userId);
  photosUrl.searchParams.set("limit", "1");
  const photosResponse = await request(photosUrl, { signal });
  if (!photosResponse.ok) return null;
  const photos = await photosResponse.json();
  const thumbnail = photos.ok && photos.result?.photos?.[0]?.[0];
  if (!thumbnail?.file_id || thumbnail.file_size > MAX_AVATAR_BYTES) return null;

  const fileUrl = new URL(`https://api.telegram.org/bot${botToken}/getFile`);
  fileUrl.searchParams.set("file_id", thumbnail.file_id);
  const fileResponse = await request(fileUrl, { signal });
  if (!fileResponse.ok) return null;
  const file = await fileResponse.json();
  const filePath = file.ok && file.result?.file_path;
  if (!filePath || !/^[A-Za-z0-9_./-]+$/.test(filePath) ||
      filePath.split("/").includes("..") || file.result.file_size > MAX_AVATAR_BYTES) return null;

  const download = await request(`https://api.telegram.org/file/bot${botToken}/${filePath}`, { signal });
  if (!download.ok || Number(download.headers.get("content-length")) > MAX_AVATAR_BYTES) return null;
  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.length > MAX_AVATAR_BYTES) return null;
  const contentType = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    ? "image/jpeg" : bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
      ? "image/png" : null;
  return contentType ? { bytes, contentType } : null;
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
    return { id: String(user.id), profile: profileFromTelegram(user) };
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

async function configureTelegramWebhook(botToken, webhookSecret, publicDomain, request = fetch) {
  if (typeof publicDomain !== "string" || !/^[A-Za-z0-9-]+\.up\.railway\.app$/.test(publicDomain)) {
    throw new Error("RAILWAY_PUBLIC_DOMAIN is not a valid Railway domain");
  }
  const endpoint = `https://api.telegram.org/bot${botToken}/`;
  const response = await request(endpoint + "setWebhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `https://${publicDomain}/telegram/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"]
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok || !(await response.json()).ok) {
    throw new Error(`Telegram setWebhook failed (${response.status})`);
  }
  const status = await request(endpoint + "getWebhookInfo", {
    signal: AbortSignal.timeout(8000)
  });
  if (!status.ok) throw new Error(`Telegram getWebhookInfo failed (${status.status})`);
  const info = await status.json();
  if (!info.ok ||
      info.result?.url !== `https://${publicDomain}/telegram/webhook` ||
      !info.result.allowed_updates?.includes("callback_query")) {
    throw new Error("Telegram webhook is not subscribed to callback_query");
  }
}

async function configureChatMenu(botToken, request = fetch, chatId = null) {
  const endpoint = `https://api.telegram.org/bot${botToken}/`;
  if (chatId !== null && (!Number.isSafeInteger(chatId) || chatId <= 0)) {
    throw new Error("Invalid private chat ID");
  }
  const response = await request(endpoint + "setChatMenuButton", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...(chatId === null ? {} : { chat_id: chatId }),
      menu_button: { type: "commands" }
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok || !(await response.json()).ok) {
    throw new Error(`Telegram setChatMenuButton failed (${response.status})`);
  }
  const checkUrl = new URL(endpoint + "getChatMenuButton");
  if (chatId !== null) checkUrl.searchParams.set("chat_id", String(chatId));
  const check = await request(checkUrl, {
    signal: AbortSignal.timeout(8000)
  });
  if (!check.ok || (await check.json()).result?.type !== "commands") {
    throw new Error("Telegram chat menu did not switch to commands");
  }
}

async function clearBotDescription(botToken, request = fetch) {
  const endpoint = `https://api.telegram.org/bot${botToken}/`;
  for (const languageCode of ["", "pt"]) {
    const body = { description: "", ...(languageCode ? { language_code: languageCode } : {}) };
    const response = await request(endpoint + "setMyDescription", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok || !(await response.json()).ok) {
      throw new Error(`Telegram setMyDescription failed (${response.status})`);
    }
    const checkUrl = new URL(endpoint + "getMyDescription");
    if (languageCode) checkUrl.searchParams.set("language_code", languageCode);
    const check = await request(checkUrl, { signal: AbortSignal.timeout(8000) });
    if (!check.ok || (await check.json()).result?.description !== "") {
      throw new Error("Telegram bot description was not cleared");
    }
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
      text: `Impressões confirmadas pela Monetag (Brasília):\nHoje: ${counts.todayTotal} (${counts.todayValued} monetizadas)\nTotal: ${counts.total} (${counts.valued} monetizadas)\n\nUma impressão começa quando o anúncio aparece; não significa vídeo concluído, saldo ou saque.`
    };
  }
  if (command === "privacidade") {
    return { chat_id: message.chat.id, text: `Política de privacidade da Mini App Young Money:\n${privacyUrl}` };
  }
  if (command === "ajuda") {
    return {
      chat_id: message.chat.id,
      text: "Toque em Abrir Mini App para acompanhar até 15 impressões confirmadas por dia na sua conta Telegram. A contagem reinicia à meia-noite de Brasília. Use /status para consultar o histórico. Impressões não representam saldo, pontos ou saque.",
      reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Mini App", web_app: { url: webAppUrl } }], [{ text: "Privacidade", url: privacyUrl }]] }
    };
  }
  return {
    chat_id: message.chat.id,
    text: `Olá, ${displayName(message.from)}! Bem-vindo ao Young Money. Abra a Mini App para assistir aos vídeos disponíveis e acompanhar seu limite diário de até 15 vídeos.`,
    reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Mini App", web_app: { url: webAppUrl } }], [{ text: "Privacidade", url: privacyUrl }]] }
  };
}

async function createServer({ botToken, webhookSecret, postbackSecret, adminSecret, webAppUrl, dataDir, sendMessage, answerCallback, setChatMenu, getTelegramChat, getTelegramPhoto, getYoungMoneyAccount }) {
  if (!botToken || !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret || "") ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(postbackSecret || "")) {
    throw new Error("BOT_TOKEN, WEBHOOK_SECRET and MONETAG_POSTBACK_SECRET must be configured");
  }
  const url = new URL(webAppUrl);
  if (url.protocol !== "https:") throw new Error("WEBAPP_URL must use HTTPS");
  const appUrl = url.toString();
  const ledger = await createLedger(dataDir);
  const allowedOrigin = new URL(appUrl).origin;
  const profileLookupAt = new Map();
  const photoCache = new Map();
  const menuConfiguredForChat = new Set();
  const pendingLinks = new Map();
  const lookupPhoto = getTelegramPhoto || (userId => fetchTelegramPhoto(botToken, userId));
  const lookupAccount = getYoungMoneyAccount || (async (token, deviceId) => {
    const base = process.env.YOUNGMONEY_API_URL || "https://youngmoney-api-railway-production-5bf3.up.railway.app";
    const url = new URL("/api/v1/telegram/identity.php", base);
    if (url.protocol !== "https:" || url.origin !== new URL(base).origin) throw new Error("Invalid Young Money API URL");
    const response = await fetch(url, {
      method: "POST", headers: {
        authorization: `Bearer ${token}`, "x-youngmoney-device-id": deviceId
      },
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error(`Young Money identity unavailable (${response.status})`);
    const payload = await response.json();
    return payload.status === "success" ? payload.data : null;
  });

  function linkTokenHash(req) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    return match ? crypto.createHash("sha256").update(match[1]).digest("hex") : null;
  }

  async function cachedPhoto(userId) {
    const cached = photoCache.get(userId);
    if (cached && cached.expires > Date.now()) return cached.value;
    try {
      const value = await lookupPhoto(userId);
      if (photoCache.size >= 200) photoCache.delete(photoCache.keys().next().value);
      photoCache.set(userId, { value, expires: Date.now() + (value ? 21600000 : 3600000) });
      return value;
    } catch { return null; }
  }

  const lookupChat = getTelegramChat || (async userId => {
    const endpoint = new URL(`https://api.telegram.org/bot${botToken}/getChat`);
    endpoint.searchParams.set("chat_id", userId);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload.ok ? payload.result : null;
  });

  async function hydrateReportNames(report) {
    const candidates = [report.selected?.totalAds ? report.selected : null, ...report.users]
      .filter(Boolean).map(user => user.telegramId);
    const unique = [...new Set(candidates)];
    await Promise.all(unique.filter(userId => {
      const profile = ledger.getProfile(userId);
      if (profile?.name && Date.now() - Date.parse(profile.at) < 86400000) return false;
      if (Date.now() - (profileLookupAt.get(userId) || 0) < 21600000) return false;
      return true;
    }).slice(0, 8).map(async userId => {
      profileLookupAt.set(userId, Date.now());
      try {
        const chat = await lookupChat(userId);
        if (chat?.type === "private" && String(chat.id) === userId) {
          const profile = profileFromTelegram(chat);
          if (profile) await ledger.saveProfile(userId, profile);
        }
      } catch { /* O bot pode não ter acesso a todos os chats privados. */ }
    }));
  }

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
  const acknowledge = answerCallback || (async payload => {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok || !(await response.json()).ok) {
      throw new Error(`Telegram answerCallbackQuery failed (${response.status})`);
    }
  });
  const ensurePrivateMenu = setChatMenu || (chatId => configureChatMenu(botToken, fetch, chatId));

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, "http://localhost");
    if (req.method === "GET" && requestUrl.pathname === "/health") {
      reply(res, 200, { ok: true });
      return;
    }
    if ((requestUrl.pathname === "/api/app-links" || requestUrl.pathname === "/api/app-links/v2") &&
        req.method === "POST") {
      // Only a Telegram callback can bind this opaque token to an account.
      let account = null;
      if (requestUrl.pathname === "/api/app-links/v2") {
        if (req.headers.origin) { reply(res, 403, { ok: false }); return; }
        const match = /^Bearer ([A-Za-z0-9._~-]{16,4096})$/.exec(req.headers.authorization || "");
        const deviceId = req.headers["x-youngmoney-device-id"];
        if (!match) { reply(res, 401, { ok: false }); return; }
        if (typeof deviceId !== "string" || !/^v4[a-f0-9]{62}$/.test(deviceId)) {
          reply(res, 403, { ok: false }); return;
        }
        try { account = await lookupAccount(match[1], deviceId); }
        catch (error) {
          console.error("Young Money identity check failed:", error.message);
          reply(res, 503, { ok: false }); return;
        }
        if (!account || !Number.isSafeInteger(account.id) || account.id <= 0 ||
            account.deviceHash !== crypto.createHash("sha256").update(deviceId).digest("hex")) {
          reply(res, 401, { ok: false }); return;
        }
      }
      for (const [id, link] of pendingLinks) {
        if (link.expiresAt <= Date.now()) pendingLinks.delete(id);
      }
      if (pendingLinks.size >= 300) { reply(res, 429, { ok: false }); return; }
      const id = crypto.randomBytes(18).toString("base64url");
      const token = crypto.randomBytes(32).toString("base64url");
      pendingLinks.set(id, {
        tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
        accountId: account?.id || null,
        deviceHash: account?.deviceHash || null,
        expiresAt: Date.now() + 10 * 60000
      });
      reply(res, 201, { token, url: `https://t.me/YoungMoneyOFC_bot?start=link_${id}` });
      return;
    }
    if (requestUrl.pathname === "/api/app-links/status" && req.method === "GET") {
      const tokenHash = linkTokenHash(req);
      if (!tokenHash) { reply(res, 401, { ok: false }); return; }
      const userId = ledger.linkedUser(tokenHash);
      if (userId) {
        reply(res, 200, { state: "linked", accountId: ledger.linkAccount(tokenHash),
          ...ledger.dailyVideoProgress(userId) });
        return;
      }
      const pending = [...pendingLinks.values()].some(
        entry => entry.tokenHash === tokenHash && entry.expiresAt > Date.now()
      );
      reply(res, pending ? 200 : 401, pending ? { state: "pending" } : { ok: false });
      return;
    }
    if (requestUrl.pathname === "/admin/telegram-photo") {
      if (req.method !== "GET") { reply(res, 405, { ok: false }); return; }
      if (!adminSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(adminSecret)) {
        reply(res, 503, { ok: false }); return;
      }
      if (!secureEqual(req.headers.authorization, `Bearer ${adminSecret}`)) {
        reply(res, 403, { ok: false }); return;
      }
      const userId = requestUrl.searchParams.get("telegram_id");
      if (requestUrl.searchParams.getAll("telegram_id").length !== 1 || !/^\d{1,16}$/.test(userId || "")) {
        reply(res, 400, { ok: false }); return;
      }
      const photo = await cachedPhoto(userId);
      if (!photo) { reply(res, 404, { ok: false }); return; }
      res.writeHead(200, {
        "content-type": photo.contentType, "content-length": photo.bytes.length,
        "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff"
      });
      res.end(photo.bytes);
      return;
    }
    if (requestUrl.pathname === "/admin/monetag") {
      if (req.method !== "GET") { reply(res, 405, { ok: false }); return; }
      if (!adminSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(adminSecret)) {
        reply(res, 503, { ok: false }); return;
      }
      if (!secureEqual(req.headers.authorization, `Bearer ${adminSecret}`)) {
        reply(res, 403, { ok: false }); return;
      }
      const telegramId = requestUrl.searchParams.get("telegram_id") || "";
      const limitText = requestUrl.searchParams.get("limit") || "100";
      if (requestUrl.searchParams.getAll("telegram_id").length > 1 ||
          requestUrl.searchParams.getAll("limit").length > 1 ||
          (telegramId && !/^\d{1,16}$/.test(telegramId)) ||
          !/^(?:[1-9]|[1-9]\d|100)$/.test(limitText)) {
        reply(res, 400, { ok: false }); return;
      }
      const report = ledger.report(telegramId, Number(limitText));
      await hydrateReportNames(report);
      reply(res, 200, ledger.report(telegramId, Number(limitText)));
      return;
    }
    if (requestUrl.pathname === "/api/ad-attempts" || requestUrl.pathname === "/api/impressions" ||
        requestUrl.pathname === "/api/ad-completions") {
      if (req.headers.origin !== allowedOrigin) { reply(res, 403, { ok: false }); return; }
      res.setHeader("access-control-allow-origin", allowedOrigin);
      res.setHeader("vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "x-telegram-init-data", "access-control-max-age": "600" });
        res.end();
        return;
      }
      const user = verifyInitData(req.headers["x-telegram-init-data"], botToken);
      if (!user) { reply(res, 401, { ok: false }); return; }
      try {
        if (req.method === "POST" && requestUrl.pathname === "/api/ad-attempts") {
          const ymid = await ledger.createAttempt(user.id, user.profile);
          reply(res, 201, { ymid });
          return;
        }
        if (req.method === "GET" && requestUrl.pathname === "/api/impressions") {
          reply(res, 200, ledger.counts(user.id));
          return;
        }
        if (req.method === "POST" && requestUrl.pathname === "/api/ad-completions") {
          const body = await readJson(req);
          if (!body || typeof body !== "object" || Object.keys(body).length !== 1 ||
              !/^[a-f0-9-]{36}$/i.test(body.ymid || "")) {
            reply(res, 400, { ok: false });
            return;
          }
          const result = await ledger.recordCompletion(user.id, body.ymid);
          reply(res, result === "ignored" ? 404 : 200, { ok: result !== "ignored", result });
          return;
        }
      } catch (error) {
        if (error.status === 400 || error.status === 413) {
          reply(res, error.status, { ok: false });
          return;
        }
        if (error.status === 429) {
          res.setHeader("retry-after", String(error.retryAfterSeconds));
          reply(res, 429, { ok: false, retryAfterSeconds: error.retryAfterSeconds });
          return;
        }
        if (error.status === 409) {
          reply(res, 409, { ok: false, ...ledger.counts(user.id) });
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
      try {
        const result = await ledger.recordAdEvent({
          ymid, userId, event, valued: value === "valued", price: Number(priceText), zone, sub, source
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
      const callback = update?.callback_query;
      if (callback && typeof callback.id === "string") {
        const match = /^connect:([A-Za-z0-9_-]{24})$/.exec(callback.data || "");
        const userId = callback.from?.id;
        const isPrivate = callback.message?.chat?.type === "private" &&
          callback.message.chat.id === userId && Number.isSafeInteger(userId) && userId > 0;
        const link = isPrivate && match ? pendingLinks.get(match[1]) : null;
        const active = link && link.expiresAt > Date.now();
        let linked = false;
        let conflict = false;
        if (active) {
          try {
            linked = await ledger.linkApp(link.tokenHash, String(userId), link.accountId, link.deviceHash);
          } catch (error) {
            if (error.status !== 409) throw error;
            conflict = true;
          }
          pendingLinks.delete(match[1]);
          if (linked) await ledger.saveProfile(String(userId), profileFromTelegram(callback.from));
        }
        await acknowledge({
          callback_query_id: callback.id,
          text: conflict ? "Esta conta Young Money ou Telegram já está vinculada a outra conta. Fale com o suporte." :
            linked ? "Conta vinculada. Volte ao aplicativo Young Money." : "Vínculo expirado. Abra o aplicativo para gerar outro.",
          show_alert: !linked
        });
        if (linked) await send({ chat_id: userId, text: `${displayName(callback.from)}, sua conta Telegram foi vinculada ao card Mini App. O card mostra os vídeos de hoje e não dá pontos. Abra a Mini App para assistir aos vídeos.`, reply_markup: { inline_keyboard: [[{ text: "🚀 Abrir Mini App", web_app: { url: appUrl } }]] } });
        reply(res, 200, { ok: true });
        return;
      }
      const from = update?.message?.from;
      if (update?.message?.chat?.type === "private" && Number.isSafeInteger(from?.id) && from.id > 0) {
        if (!menuConfiguredForChat.has(from.id)) {
          try {
            await ensurePrivateMenu(from.id);
            menuConfiguredForChat.add(from.id);
          } catch (error) {
            console.error("Private Telegram chat menu update failed:", error.message);
          }
        }
        await ledger.saveProfile(String(from.id), profileFromTelegram(from));
      }
      const linkId = /^\/start(?:@YoungMoneyOFC_bot)? link_([A-Za-z0-9_-]{24})\s*$/i.exec(update?.message?.text || "")?.[1];
      if (linkId && update?.message?.chat?.type === "private" &&
          update.message.chat.id === from?.id) {
        const link = pendingLinks.get(linkId);
        if (link && link.expiresAt > Date.now()) {
          await send({
            chat_id: from.id,
            text: `Conta Telegram: ${displayName(from)}. Vincular seu progresso à conta Young Money${link.accountId ? ` #${link.accountId}` : ""}? A contagem diária de impressões confirmadas ficará no servidor. Essa ação não concede pontos.`,
            reply_markup: { inline_keyboard: [[{ text: "Vincular meu progresso", callback_data: `connect:${linkId}` }]] }
          });
        } else {
          await send({ chat_id: from.id, text: "Esse vínculo expirou. Volte ao aplicativo Young Money e toque no card Mini App novamente." });
        }
        reply(res, 200, { ok: true });
        return;
      }
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
    adminSecret: process.env.MONETAG_ADMIN_SECRET,
    webAppUrl: process.env.WEBAPP_URL,
    dataDir: process.env.DATA_DIR
  }).then(server => server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
    console.log("Young Money Telegram webhook and Monetag postback listening");
    configureTelegramWebhook(
      process.env.BOT_TOKEN,
      process.env.WEBHOOK_SECRET,
      process.env.RAILWAY_PUBLIC_DOMAIN
    ).then(() => {
      console.log("Telegram webhook subscribed to messages and button callbacks");
    }).catch(error => {
      console.error("Telegram webhook subscription failed:", error.message);
    });
    configureChatMenu(process.env.BOT_TOKEN).then(() => {
      console.log("Telegram chat menu set to commands");
    }).catch(error => {
      console.error("Telegram chat menu update failed:", error.message);
    });
    clearBotDescription(process.env.BOT_TOKEN).then(() => {
      console.log("Telegram bot intro description cleared");
    }).catch(error => {
      console.error("Telegram bot intro update failed:", error.message);
    });
  })).catch(error => { console.error("Startup failed:", error); process.exitCode = 1; });
}

module.exports = { createServer, makeMessage, verifyInitData, fetchTelegramPhoto, configureTelegramWebhook, configureChatMenu, clearBotDescription };
