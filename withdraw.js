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
  const history = byId("withdraw-history");
  const historyList = byId("withdraw-history-list");
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  let status = null;
  let busy = false;
  let requestId = null;

  function setMessage(value, kind = "info") {
    message.textContent = value;
    message.dataset.kind = kind;
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
      ? pixKey.value.trim().length >= 5
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(faucetEmail.value.trim());
    const valid = Boolean(status?.eligible && status.methods?.includes(selected) && destinationValid);
    submit.disabled = busy || !valid;
    validation.textContent = "";
    return valid ? "0.05" : null;
  }

  function renderHistory(rows) {
    historyList.replaceChildren();
    history.hidden = !Array.isArray(rows) || rows.length === 0;
    if (history.hidden) return;
    for (const row of rows) {
      const line = document.createElement("p");
      const state = { pending: "em análise", paid: "pago", rejected: "devolvido para correção" }[row.status] || row.status;
      const usdt = row.method === "faucetpay" && row.crypto_amount !== null
        ? ` · ${Number(row.crypto_amount).toFixed(8)} USDT` : "";
      line.textContent = `#${row.id} · ${money.format(row.amount_cents / 100)} · ${row.method === "pix" ? "PIX" : "FaucetPay"}${usdt} · ${state}${row.status === "rejected" && row.admin_note ? ` · Motivo: ${row.admin_note}` : ""}`;
      historyList.append(line);
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
    renderHistory(data.history);
    validate();
  }

  async function loadStatus() {
    setMessage("Consultando os vídeos de hoje...");
    try { render(await callApi({ action: "status" })); }
    catch (error) { status = null; form.hidden = true; history.hidden = true; setMessage(error.message, "error"); }
  }

  openButton.addEventListener("click", () => { screen.hidden = false; screen.scrollTop = 0; void loadStatus(); });
  byId("withdraw-back").addEventListener("click", () => { screen.hidden = true; });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !screen.hidden) void loadStatus();
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
