(() => {
  "use strict";

  const DAILY_LIMIT = 15;
  const COOLDOWN_MS = 10000;
  const API_BASE = "https://telegram-webhook-production-aa93.up.railway.app";
  const PENDING_COMPLETIONS_KEY = "young-money-pending-completions-v1";
  const COOLDOWN_KEY = "young-money-ad-cooldown-v1";
  const button = document.getElementById("watch-button");
  const buttonLabel = document.getElementById("button-state-label");
  const countVisible = document.getElementById("count-visible");
  const countA11y = document.getElementById("count-a11y");
  const slots = document.getElementById("completed-slots");
  const notice = document.getElementById("notice");
  const accountStatus = document.getElementById("account-status");
  let inFlight = false;
  let noticeTimer;
  let progress = null;
  let resetTimer;
  let loadingProgress = null;
  let memoryPending = [];
  let syncing = false;
  let cooldownUntil = 0;
  let cooldownTimer;
  try {
    const saved = Number(localStorage.getItem(COOLDOWN_KEY));
    if (Number.isFinite(saved)) cooldownUntil = Math.min(saved, Date.now() + COOLDOWN_MS);
  } catch { /* Use the in-memory timer when storage is unavailable. */ }

  async function refreshProgress() {
    if (loadingProgress) return loadingProgress;
    loadingProgress = (async () => {
      const initData = window.Telegram?.WebApp?.initData;
      if (!initData) throw new Error("Abra a Mini App pelo Telegram.");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${API_BASE}/api/impressions`, {
          headers: { "x-telegram-init-data": initData },
          cache: "no-store", signal: controller.signal
        });
        if (!response.ok) throw new Error("Não foi possível consultar as impressões.");
        const data = await response.json();
        if (!Number.isInteger(data.todayTotal) || data.todayTotal < 0 ||
            !Number.isInteger(data.completedVideos) || data.completedVideos < 0 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(data.today) ||
            !Number.isFinite(Date.parse(data.resetAt)) ||
            !Number.isFinite(Date.parse(data.serverNow))) {
          throw new Error("Resposta inválida do servidor.");
        }
        progress = data;
        window.dispatchEvent(new CustomEvent("ym:progress", { detail: data }));
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { void refreshProgress().catch(showProgressError); },
          Math.max(100, Date.parse(data.resetAt) - Date.parse(data.serverNow) + 100));
        render();
      } finally { clearTimeout(timeout); }
    })().catch(error => {
      progress = null;
      window.dispatchEvent(new CustomEvent("ym:progress", { detail: null }));
      clearTimeout(resetTimer);
      render();
      throw error;
    }).finally(() => { loadingProgress = null; });
    return loadingProgress;
  }

  function showProgressError() {
    showNotice("Não foi possível consultar o servidor. Tente novamente.", "error");
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
    const count = Math.min(DAILY_LIMIT, progress?.completedVideos || 0);
    countVisible.textContent = String(count);
    countA11y.textContent = String(count);
    accountStatus.textContent = !progress ? "Conectando ao servidor..." :
      "Telegram conectado • saldo da Mini App separado • meta reinicia às 00:00 (Brasília)";
    slots.replaceChildren();

    for (let i = 0; i < count; i++) {
      const mark = document.createElement("span");
      mark.className = "slot-complete";
      mark.textContent = "✓";
      mark.style.left = `${(i < 8 ? 12.2 + i * 9.7 : 13.9 + (i - 8) * 10.7)}%`;
      mark.style.top = `${i < 8 ? 29.95 : 36.65}%`;
      slots.append(mark);
    }

    if (inFlight || !progress) {
      button.disabled = true;
      button.dataset.state = "loading";
      buttonLabel.textContent = inFlight ? "Carregando..." : "Conectando...";
      button.setAttribute("aria-label", inFlight ? "Carregando vídeo" : "Aguardando o servidor");
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
      button.setAttribute("aria-label", `Assistir vídeo. ${count} de ${DAILY_LIMIT} vídeos concluídos e confirmados hoje.`);
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
    if (response.status === 409) {
      await refreshProgress();
      showNotice("Meta de vídeos concluída. Volte após meia-noite.");
      return null;
    }
    if (!response.ok) throw new Error("Could not prepare ad");
    const { ymid } = await response.json();
    if (!/^[a-f0-9-]{36}$/i.test(ymid)) throw new Error("Invalid ad identifier");
    return ymid;
  }

  button.addEventListener("click", async () => {
    if (inFlight || !progress || secondsRemaining()) return;
    if (progress.completedVideos >= DAILY_LIMIT) { render(); return; }

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
      await syncPending();
      await refreshProgress().catch(showProgressError);
      showNotice("Vídeo concluído. A contagem aparece após a confirmação da impressão.");
    } catch {
      showNotice(adStarted ? "O vídeo não foi concluído. Tente novamente." : "Abra pelo bot no Telegram e tente novamente.", "error");
    } finally {
      if (adStarted) startCooldown(10);
      inFlight = false;
      render();
      setTimeout(() => { void refreshProgress().catch(showProgressError); }, 5000);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshProgress().catch(showProgressError);
      void syncPending();
    }
  });
  window.addEventListener("focus", () => {
    void refreshProgress().catch(showProgressError);
    void syncPending();
  });

  try {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
  } catch { /* Also works as a normal mobile site. */ }

  render();
  void syncPending();
  void refreshProgress().catch(showProgressError);
  setInterval(() => { if (!document.hidden) void refreshProgress().catch(showProgressError); }, 30000);
  if (secondsRemaining()) scheduleCooldownTimer();
})();

