(() => {
  "use strict";

  const DAILY_LIMIT = 15;
  const COOLDOWN_MS = 10000;
  const API_BASE = "https://telegram-webhook-production-aa93.up.railway.app";
  const STORAGE_KEY = "young-money-space-videos-v1";
  const PENDING_COMPLETIONS_KEY = "young-money-pending-completions-v1";
  const COOLDOWN_KEY = "young-money-ad-cooldown-v1";
  const button = document.getElementById("watch-button");
  const buttonLabel = document.getElementById("button-state-label");
  const countVisible = document.getElementById("count-visible");
  const countA11y = document.getElementById("count-a11y");
  const slots = document.getElementById("completed-slots");
  const notice = document.getElementById("notice");
  let inFlight = false;
  let noticeTimer;
  let memoryState = null;
  let memoryPending = [];
  let syncing = false;
  let cooldownUntil = 0;
  let cooldownTimer;
  try {
    const saved = Number(localStorage.getItem(COOLDOWN_KEY));
    if (Number.isFinite(saved)) cooldownUntil = Math.min(saved, Date.now() + COOLDOWN_MS);
  } catch { /* Use the in-memory timer when storage is unavailable. */ }

  // The visual daily progress is local; Monetag postbacks are recorded separately
  // after the Telegram identity is validated on our server.
  function localDay() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function readState() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(STORAGE_KEY)); }
    catch { stored = memoryState; }

    const day = localDay();
    if (!stored || stored.day !== day) return { day, count: 0 };
    const count = Number.isInteger(stored.count) ? stored.count : 0;
    return { day, count: Math.max(0, Math.min(DAILY_LIMIT, count)) };
  }

  function writeState(state) {
    memoryState = state;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { /* The UI continues in memory if storage is unavailable. */ }
  }

  function readPending() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem(PENDING_COMPLETIONS_KEY)); }
    catch { stored = memoryPending; }
    if (!Array.isArray(stored)) stored = memoryPending;
    return stored.filter(ymid => typeof ymid === "string" && /^[a-f0-9-]{36}$/i.test(ymid)).slice(-500);
  }

  function writePending(pending) {
    memoryPending = pending;
    try { localStorage.setItem(PENDING_COMPLETIONS_KEY, JSON.stringify(pending)); }
    catch { /* Retry from memory while this page remains open. */ }
  }

  function queueCompletion(ymid) {
    writePending([...new Set([...readPending(), ymid])].slice(-500));
  }

  async function syncPending() {
    if (syncing) return;
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) return;
    syncing = true;
    try {
      while (readPending().length) {
        const ymid = readPending()[0];
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const response = await fetch(`${API_BASE}/api/ad-completions`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-telegram-init-data": initData },
            body: JSON.stringify({ ymid }),
            cache: "no-store",
            keepalive: true,
            signal: controller.signal
          });
          if (!response.ok && response.status !== 404) break;
          writePending(readPending().filter(id => id !== ymid));
        } catch { break; }
        finally { clearTimeout(timeout); }
      }
    } finally { syncing = false; }
  }

  function secondsRemaining() {
    return Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  }

  function scheduleCooldownTimer() {
    if (!cooldownTimer) {
      cooldownTimer = setInterval(() => {
        render();
        if (!secondsRemaining()) {
          clearInterval(cooldownTimer);
          cooldownTimer = null;
        }
      }, 250);
    }
  }

  function startCooldown(seconds = 10) {
    const duration = Math.min(COOLDOWN_MS, Math.max(0, Math.ceil((Number(seconds) || 10) * 1000)));
    cooldownUntil = Math.max(cooldownUntil, Date.now() + duration);
    try { localStorage.setItem(COOLDOWN_KEY, String(cooldownUntil)); }
    catch { /* The in-memory timer still prevents repeated taps. */ }
    scheduleCooldownTimer();
    render();
  }

  function render() {
    const { count } = readState();
    countVisible.textContent = String(count);
    countA11y.textContent = String(count);
    slots.replaceChildren();

    for (let i = 0; i < count; i++) {
      const mark = document.createElement("span");
      mark.className = "slot-complete";
      mark.textContent = "✓";
      mark.style.left = `${(i < 8 ? 12.2 + i * 9.7 : 13.9 + (i - 8) * 10.7)}%`;
      mark.style.top = `${i < 8 ? 29.95 : 36.65}%`;
      slots.append(mark);
    }

    if (inFlight) {
      button.disabled = true;
      button.dataset.state = "loading";
      buttonLabel.textContent = "Carregando...";
      button.setAttribute("aria-label", "Carregando vídeo");
    } else if (count >= DAILY_LIMIT) {
      button.disabled = true;
      button.dataset.state = "limit";
      buttonLabel.textContent = "Volte amanhã";
      button.setAttribute("aria-label", "Limite diário atingido. Volte amanhã.");
    } else if (secondsRemaining()) {
      const seconds = secondsRemaining();
      button.disabled = true;
      button.dataset.state = "cooldown";
      buttonLabel.textContent = `Aguarde ${seconds}s`;
      button.setAttribute("aria-label", `Próximo anúncio disponível em ${seconds} segundos.`);
    } else {
      button.disabled = false;
      button.dataset.state = "ready";
      button.setAttribute("aria-label", `Assistir vídeo. ${count} de ${DAILY_LIMIT} hoje.`);
    }
  }

  function showNotice(message, kind = "success") {
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.dataset.kind = kind;
    notice.classList.add("is-visible");
    noticeTimer = setTimeout(() => notice.classList.remove("is-visible"), 4200);
  }

  async function prepareAd() {
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) throw new Error("Open the Mini App from Telegram");
    const response = await fetch(`${API_BASE}/api/ad-attempts`, {
      method: "POST",
      headers: { "x-telegram-init-data": initData },
      cache: "no-store"
    });
    if (response.status === 429) {
      const { retryAfterSeconds } = await response.json();
      startCooldown(retryAfterSeconds);
      return null;
    }
    if (!response.ok) throw new Error("Could not prepare ad");
    const { ymid } = await response.json();
    if (!/^[a-f0-9-]{36}$/i.test(ymid)) throw new Error("Invalid ad identifier");
    return ymid;
  }

  button.addEventListener("click", async () => {
    if (inFlight || secondsRemaining()) return;
    const state = readState();
    if (state.count >= DAILY_LIMIT) { render(); return; }

    const showAd = window.show_11977205;
    if (typeof showAd !== "function") {
      showNotice("Vídeo indisponível no momento. Tente novamente.", "error");
      return;
    }

    inFlight = true;
    render();
    let adStarted = false;
    try {
      const ymid = await prepareAd();
      if (!ymid) return;
      adStarted = true;
      startCooldown(10);
      await showAd({ type: "end", ymid, requestVar: "daily_video", catchIfNoFeed: true }); // Zone 11977205.
      queueCompletion(ymid);
      void syncPending();
      const latest = readState();
      if (latest.count < DAILY_LIMIT) {
        const next = { day: latest.day, count: latest.count + 1 };
        writeState(next);
        showNotice(`Vídeo concluído! ${next.count} de ${DAILY_LIMIT} hoje.`);
      }
    } catch {
      showNotice(adStarted ? "O vídeo não foi concluído. Tente novamente." : "Abra pelo bot no Telegram e tente novamente.", "error");
    } finally {
      if (adStarted) startCooldown(10);
      inFlight = false;
      render();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      if (!inFlight) render();
      void syncPending();
    }
  });
  window.addEventListener("focus", () => {
    if (!inFlight) render();
    void syncPending();
  });

  function scheduleMidnightReset() {
    const now = new Date();
    const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    setTimeout(() => {
      if (!inFlight) render();
      scheduleMidnightReset();
    }, nextMidnight.getTime() - now.getTime() + 50);
  }

  try {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
  } catch { /* Also works as a normal mobile site. */ }

  render();
  void syncPending();
  if (secondsRemaining()) scheduleCooldownTimer();
  scheduleMidnightReset();
})();
