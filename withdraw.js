(() => {
  "use strict";

  const endpoint = "https://youngmoney-api-railway-production-5bf3.up.railway.app/withdraw/telegram.php";
  const byId = id => document.getElementById(id);
  const openButton = byId("withdraw-open");
  const screen = byId("withdraw-screen");
  const message = byId("withdraw-message");
  const form = byId("withdraw-form");
  const method = byId("withdraw-method");
  const methodIcon = document.querySelector("#withdraw-method-icon use");
  const amount = byId("withdraw-amount");
  const rules = byId("withdraw-rules");
  const pixFields = byId("withdraw-pix-fields");
  const faucetFields = byId("withdraw-faucet-fields");
  const pixType = byId("withdraw-pix-type");
  const pixKey = byId("withdraw-pix-key");
  const faucetEmail = byId("withdraw-faucet-email");
  const validation = byId("withdraw-validation");
  const submit = byId("withdraw-submit");
  const historyScreen = byId("history-screen");
  const historyList = byId("history-list");
  const historyMessage = byId("history-message");
  const historyMore = byId("history-more");
  const historyTemplate = byId("history-card-template");
  const historyFilters = [...document.querySelectorAll(".history-filter")];
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  let status = null;
  let busy = false;
  let requestId = null;
  let historyFilter = "all";
  let historyCursor = null;
  let historyDay = "";
  let historySequence = 0;

  function setMessage(value, kind = "info") {
    message.textContent = value;
    message.dataset.kind = kind;
  }

  function validCpf(value) {
    const digits = value.replace(/\D/g, "");
    if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false;
    for (let position = 9; position <= 10; position++) {
      let sum = 0;
      for (let i = 0; i < position; i++) sum += Number(digits[i]) * (position + 1 - i);
      const check = (sum * 10) % 11;
      if (Number(digits[position]) !== (check === 10 ? 0 : check)) return false;
    }
    return true;
  }

  async function callApi(payload) {
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) throw new Error("Abra o Mini App pelo Telegram.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), payload.action === "request" ? 22000 : 12000);
    try {
      const response = await fetch(endpoint, {
        method: "POST", cache: "no-store", signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, init_data: initData })
      });
      const data = await response.json();
      if (!response.ok || data.ok !== true) {
        throw new Error(data.message || "Não foi possível consultar o saque.");
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  function validate() {
    const selected = method.value;
    methodIcon.setAttribute("href", selected === "pix" ? "#icon-pix" : "#icon-mail");
    pixFields.hidden = selected !== "pix";
    faucetFields.hidden = selected !== "faucetpay";
    rules.textContent = "Um pagamento de R$ 0,05 por dia após 15 vídeos. Se os dados forem devolvidos, você pode corrigir e pedir novamente hoje. Não acumula. FaucetPay recebe USDT convertido na cotação do pedido.";
    amount.value = money.format(0.05);
    const destinationValid = selected === "pix"
      ? pixType.value === "CPF" && validCpf(pixKey.value)
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(faucetEmail.value.trim());
    const valid = Boolean(status?.eligible && status.methods?.includes(selected) && destinationValid);
    submit.disabled = busy || !valid;
    validation.textContent = selected === "pix" && pixKey.value.replace(/\D/g, "").length === 11 && !destinationValid
      ? "CPF inválido. Confira os 11 números." : "";
    return valid ? "0.05" : null;
  }

  function historyDate(value) {
    const day = String(value || "").slice(0, 10);
    const time = String(value || "").slice(11, 16);
    const yesterday = new Date(`${historyDay}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const label = day === historyDay ? "Hoje" : day === yesterday.toISOString().slice(0, 10)
      ? "Ontem" : /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : "Data indisponível";
    return time ? `${label}, ${time}` : label;
  }

  function addHistoryCard(row) {
    const fragment = historyTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".history-card");
    const state = {
      paid: ["Concluído", "#icon-check"],
      pending: ["Pendente", "#icon-clock"],
      rejected: ["Devolvido", "#icon-return"]
    }[row.status] || ["Em análise", "#icon-clock"];
    card.dataset.status = row.status;
    fragment.querySelector(".history-card-icon use").setAttribute("href", row.method === "pix" ? "#icon-pix" : "#icon-wallet");
    fragment.querySelector(".history-card-method").textContent = row.method === "pix" ? "PIX" : "FaucetPay";
    fragment.querySelector(".history-card-amount").textContent = money.format(Number(row.amount_cents) / 100);
    fragment.querySelector(".history-card-date span").textContent = historyDate(row.created_at);
    fragment.querySelector(".history-card-destination").textContent = row.destination || "Dados do pagamento indisponíveis";
    fragment.querySelector(".history-card-status use").setAttribute("href", state[1]);
    fragment.querySelector(".history-card-status span").textContent = state[0];
    fragment.querySelector(".history-card-id").textContent = `Pedido #${row.id}`;
    const crypto = fragment.querySelector(".history-card-crypto");
    if (row.method === "faucetpay" && Number(row.crypto_amount) > 0) {
      crypto.hidden = false;
      crypto.textContent = `${Number(row.crypto_amount).toFixed(8)} USDT`;
    }
    const note = fragment.querySelector(".history-card-note");
    if (row.status === "rejected" && row.admin_note) {
      note.hidden = false;
      note.textContent = `Motivo da devolução: ${row.admin_note}`;
    }
    historyList.append(fragment);
  }

  async function loadHistory(reset = false) {
    const sequence = ++historySequence;
    if (reset) {
      historyCursor = null;
      historyList.replaceChildren();
      historyMore.hidden = true;
      historyMessage.textContent = "Carregando seus pedidos...";
    } else historyMessage.textContent = "Carregando mais pedidos...";
    historyMore.dataset.retry = "false";
    historyMore.textContent = "Carregar mais pedidos";
    historyMessage.dataset.kind = "info";
    historyMore.disabled = true;
    try {
      const data = await callApi({ action: "history", method: historyFilter,
        ...(historyCursor === null ? {} : { cursor: historyCursor }) });
      if (sequence !== historySequence || historyScreen.hidden) return;
      if (!Array.isArray(data.history) || !data.summary ||
          !Number.isInteger(data.summary.total) || !Number.isInteger(data.summary.today) ||
          !Number.isInteger(data.summary.pending) ||
          (data.next_cursor !== null && !Number.isInteger(data.next_cursor))) {
        throw new Error("Resposta inválida do histórico.");
      }
      historyDay = data.day;
      byId("history-total").textContent = data.summary.total;
      byId("history-today").textContent = data.summary.today;
      byId("history-pending").textContent = data.summary.pending;
      for (const row of data.history) addHistoryCard(row);
      historyCursor = data.next_cursor;
      historyMore.hidden = historyCursor === null;
      historyMessage.textContent = historyList.childElementCount === 0 ? "Nenhum pedido de saque encontrado." : "";
    } catch (error) {
      if (sequence !== historySequence || historyScreen.hidden) return;
      historyMessage.textContent = error.message || "Não foi possível consultar o histórico.";
      historyMessage.dataset.kind = "error";
      historyMore.hidden = false;
      historyMore.dataset.retry = "true";
      historyMore.textContent = "Tentar novamente";
    } finally {
      if (sequence === historySequence) historyMore.disabled = false;
    }
  }

  function render(data) {
    if (!Number.isInteger(data.current) || !Number.isInteger(data.goal) ||
        data.amount_cents !== 5 || typeof data.eligible !== "boolean" ||
        typeof data.requested_today !== "boolean" || typeof data.returned_today !== "boolean" ||
        !Array.isArray(data.methods)) {
      throw new Error("Resposta inválida do servidor.");
    }
    status = data;
    form.hidden = !data.eligible || data.methods.length === 0;
    for (const option of method.options) option.disabled = !data.methods.includes(option.value);
    if (data.methods.length && method.selectedOptions[0]?.disabled) method.value = data.methods[0];
    if (data.requested_today) setMessage("O saque de hoje já foi solicitado. Volte amanhã após completar a nova meta de 15 vídeos.");
    else if (data.returned_today) setMessage(`Seu pedido foi devolvido${data.return_reason ? `: ${data.return_reason}` : "."} Corrija os dados e solicite novamente hoje. O direito de saque não passa para amanhã.`);
    else if (!data.eligible) setMessage(`Vídeos de hoje: ${data.current}/${data.goal}. Complete 15 para solicitar R$ 0,05 hoje; não acumula para amanhã.`);
    else setMessage("Meta de 15 vídeos concluída. Escolha PIX ou FaucetPay para solicitar R$ 0,05 hoje.");
    validate();
  }

  async function loadStatus() {
    setMessage("Consultando os vídeos de hoje...");
    try { render(await callApi({ action: "status" })); }
    catch (error) { status = null; form.hidden = true; setMessage(error.message, "error"); }
  }

  openButton.addEventListener("click", () => { screen.hidden = false; screen.scrollTop = 0; void loadStatus(); });
  byId("withdraw-back").addEventListener("click", () => { screen.hidden = true; });
  byId("withdraw-history-open").addEventListener("click", () => {
    screen.hidden = true;
    historyScreen.hidden = false;
    historyScreen.scrollTop = 0;
    byId("history-back").focus();
    void loadHistory(true);
  });
  byId("history-back").addEventListener("click", () => {
    ++historySequence;
    historyScreen.hidden = true;
    screen.hidden = false;
    byId("withdraw-history-open").focus();
    void loadStatus();
  });
  for (const button of historyFilters) button.addEventListener("click", () => {
    if (historyFilter === button.dataset.method) return;
    historyFilter = button.dataset.method;
    for (const filter of historyFilters) filter.setAttribute("aria-pressed", String(filter === button));
    void loadHistory(true);
  });
  historyMore.addEventListener("click", () => {
    if (!historyMore.disabled && (historyCursor !== null || historyMore.dataset.retry === "true"))
      void loadHistory(historyCursor === null);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !screen.hidden) void loadStatus();
    else if (!document.hidden && !historyScreen.hidden) void loadHistory(true);
  });
  pixKey.addEventListener("input", () => {
    const digits = pixKey.value.replace(/\D/g, "").slice(0, 11);
    pixKey.value = digits.replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, "$1.$2.$3-$4");
  });
  form.addEventListener("input", () => { requestId = null; validate(); });
  form.addEventListener("change", () => { requestId = null; validate(); });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const value = validate();
    if (!value) return;
    if (!requestId) requestId = crypto.randomUUID();
    const selected = method.value;
    const payload = {
      action: "request", request_id: requestId, method: selected, amount: value,
      ...(selected === "pix"
        ? { pix_key_type: pixType.value, pix_key: pixKey.value.trim() }
        : { currency: "USDT", faucetpay_email: faucetEmail.value.trim() })
    };
    busy = true;
    validate();
    setMessage("Registrando sua solicitação...");
    try {
      const result = await callApi(payload);
      requestId = null;
      await loadStatus();
      setMessage(`Saque #${result.withdrawal_id} solicitado. Aguarde a análise no painel.`);
    } catch (error) {
      setMessage(error.message || "Não foi possível solicitar. Tente novamente.", "error");
      // A retry with the same request ID cannot create a second request.
    } finally {
      busy = false;
      validate();
    }
  });
})();
