(() => {
  "use strict";

  const DAILY_LIMIT = 15;
  const API_BASE = "https://telegram-webhook-production-aa93.up.railway.app";
  const STORAGE_KEY = "young-money-space-videos-v1";
  const button = document.getElementById("watch-button");
  const buttonLabel = document.getElementById("button-state-label");
  const countVisible = document.getElementById("count-visible");
  const countA11y = document.getElementById("count-a11y");
  const slots = document.getElementById("completed-slots");
  const notice = document.getElementById("notice");
  let inFlight = false;
  let noticeTimer;
  let memoryState = null;

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
    if (!response.ok) throw new Error("Could not prepare ad");
    const { ymid } = await response.json();
    if (!/^[a-f0-9-]{36}$/i.test(ymid)) throw new Error("Invalid ad identifier");
    return ymid;
  }

  button.addEventListener("click", async () => {
    if (inFlight) return;
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
      adStarted = true;
      await showAd({ type: "end", ymid, requestVar: "daily_video" }); // Zone 11977205.
      const latest = readState();
      if (latest.count < DAILY_LIMIT) {
        const next = { day: latest.day, count: latest.count + 1 };
        writeState(next);
        showNotice(`Vídeo concluído! ${next.count} de ${DAILY_LIMIT} hoje.`);
      }
    } catch {
      showNotice(adStarted ? "O vídeo não foi concluído. Tente novamente." : "Abra pelo bot no Telegram e tente novamente.", "error");
    } finally {
      inFlight = false;
      render();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !inFlight) render();
  });
  window.addEventListener("focus", () => { if (!inFlight) render(); });

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
  scheduleMidnightReset();
})();
