(() => {
  "use strict";

  const endpoint = "https://youngmoney-api-railway-production-5bf3.up.railway.app/withdraw/telegram.php";
  const byId = id => document.getElementById(id);
  const openButton = byId("withdraw-open");
  const screen = byId("withdraw-screen");
  const message = byId("withdraw-message");
  const wallet = byId("withdraw-wallet");
  const balance = byId("withdraw-balance");
  const balanceDetail = byId("withdraw-balance-brl");
  const form = byId("withdraw-form");
  const method = byId("withdraw-method");
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
    pixFields.hidden = selected !== "pix";
    faucetFields.hidden = selected !== "faucetpay";
    rules.textContent = "Mínimo de R$ 0,05. Saque em múltiplos de R$ 0,05 até o saldo disponível. FaucetPay recebe USDT convertido na cotação do pedido.";
    const normalized = amount.value.trim().replace(",", ".");
    const amountValid = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(normalized);
    const cents = amountValid ? Math.round(Number(normalized) * 100) : 0;
    const destinationValid = selected === "pix"
      ? pixKey.value.trim().length >= 5
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(faucetEmail.value.trim());
    const valid = Boolean(status?.unlocked && status.methods?.includes(selected) &&
      cents >= 5 && cents % 5 === 0 && cents <= status.balance_cents && destinationValid);
    submit.disabled = busy || !valid;
    validation.textContent = !status?.unlocked || !amount.value.trim() ? "" :
      !amountValid ? "Informe um valor válido com até duas casas decimais." :
      cents < 5 || cents % 5 !== 0 ? "Use R$ 0,05 ou um múltiplo desse valor." :
      cents > status.balance_cents ? "Saldo insuficiente para este saque." : "";
    return valid ? normalized : null;
  }

  function renderHistory(rows) {
    historyList.replaceChildren();
    history.hidden = !Array.isArray(rows) || rows.length === 0;
    if (history.hidden) return;
    for (const row of rows) {
      const line = document.createElement("p");
      const state = { pending: "em análise", paid: "pago", rejected: "recusado; saldo devolvido" }[row.status] || row.status;
      const usdt = row.method === "faucetpay" && row.crypto_amount !== null
        ? ` · ${Number(row.crypto_amount).toFixed(8)} USDT` : "";
      line.textContent = `#${row.id} · ${money.format(row.amount_cents / 100)} · ${row.method === "pix" ? "PIX" : "FaucetPay"}${usdt} · ${state}`;
      historyList.append(line);
    }
  }

  function render(data) {
    if (!Number.isInteger(data.balance_cents) || !Number.isInteger(data.current) || !Array.isArray(data.methods)) {
      throw new Error("Resposta inválida do servidor.");
    }
    status = data;
    wallet.hidden = false;
    balance.textContent = money.format(data.balance_cents / 100);
    balanceDetail.textContent = `Meta de hoje: ${data.current}/${data.goal} vídeos · +${money.format(data.reward_cents / 100)} ao completar`;
    form.hidden = !data.unlocked || data.methods.length === 0;
    for (const option of method.options) option.disabled = !data.methods.includes(option.value);
    if (data.methods.length && method.selectedOptions[0]?.disabled) method.value = data.methods[0];
    if (data.unlocked && !amount.value.trim()) amount.value = (data.balance_cents / 100).toFixed(2).replace(".", ",");
    if (!data.unlocked) setMessage(`Progresso de hoje: ${data.current}/${data.goal}. Complete 15 vídeos para ganhar R$ 0,05. O saldo acumulado fica disponível para saque.`);
    else setMessage("Escolha PIX ou FaucetPay para solicitar o saque do saldo da Mini App.");
    renderHistory(data.history);
    validate();
  }

  async function loadStatus() {
    setMessage("Consultando seu saldo...");
    try { render(await callApi({ action: "status" })); }
    catch (error) { status = null; wallet.hidden = true; form.hidden = true; history.hidden = true; setMessage(error.message, "error"); }
  }

  openButton.addEventListener("click", () => { screen.hidden = false; void loadStatus(); });
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
      amount.value = "";
      await loadStatus();
      setMessage(`Saque #${result.withdrawal_id} solicitado. Aguarde a análise no painel.`);
    } catch (error) {
      setMessage(error.message || "Não foi possível solicitar. Tente novamente.", "error");
      // A retry with the same request ID cannot debit the wallet twice.
    } finally {
      busy = false;
      validate();
    }
  });
})();
