(() => {
  "use strict";

  const endpoint = "https://youngmoney-api-railway-production-5bf3.up.railway.app/withdraw/telegram.php";
  const openButton = document.getElementById("withdraw-open");
  const screen = document.getElementById("withdraw-screen");
  const backButton = document.getElementById("withdraw-back");
  const message = document.getElementById("withdraw-message");
  const wallet = document.getElementById("withdraw-wallet");
  const balance = document.getElementById("withdraw-balance");
  const balanceBrl = document.getElementById("withdraw-balance-brl");
  const form = document.getElementById("withdraw-form");
  const method = document.getElementById("withdraw-method");
  const amount = document.getElementById("withdraw-amount");
  const rules = document.getElementById("withdraw-rules");
  const pixFields = document.getElementById("withdraw-pix-fields");
  const faucetFields = document.getElementById("withdraw-faucet-fields");
  const pixType = document.getElementById("withdraw-pix-type");
  const pixKey = document.getElementById("withdraw-pix-key");
  const faucetEmail = document.getElementById("withdraw-faucet-email");
  const validation = document.getElementById("withdraw-validation");
  const submit = document.getElementById("withdraw-submit");
  const pointFormat = new Intl.NumberFormat("pt-BR");
  const moneyFormat = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
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
    const settings = status?.settings;
    const selected = method.value;
    const enabled = settings?.methods?.includes(selected);
    pixFields.hidden = selected !== "pix";
    faucetFields.hidden = selected !== "faucetpay";
    const minimumBrl = selected === "pix" ? settings?.min_pix_brl : settings?.min_faucetpay_brl;
    const minimumPoints = selected === "pix" ? settings?.min_pix_points : settings?.min_faucetpay_points;
    rules.textContent = settings
      ? `Mínimo: ${moneyFormat.format(minimumBrl || 0)} e ${pointFormat.format(minimumPoints || 0)} pontos. Máximo: ${moneyFormat.format(settings.max_brl)}.`
      : "";
    const normalized = amount.value.trim().replace(",", ".");
    const amountValid = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(normalized);
    const amountNumber = amountValid ? Number(normalized) : 0;
    const neededPoints = Math.round(amountNumber * (settings?.points_per_real || 0));
    const destinationValid = selected === "pix"
      ? pixKey.value.trim().length >= 5
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(faucetEmail.value.trim());
    const valid = Boolean(status?.unlocked && enabled && amountValid &&
      amountNumber >= minimumBrl && amountNumber <= settings.max_brl &&
      neededPoints >= minimumPoints && neededPoints <= status.balance_points && destinationValid);
    submit.disabled = busy || !valid;
    validation.textContent = !status?.unlocked ? "" : !amount.value.trim() ? "" :
      !amountValid ? "Informe um valor válido com até duas casas decimais." :
        neededPoints > status.balance_points ? "Saldo insuficiente para este valor." :
          amountNumber < minimumBrl || neededPoints < minimumPoints ? "Valor abaixo do mínimo configurado." :
            amountNumber > settings.max_brl ? "Valor acima do máximo configurado." : "";
    return valid ? normalized : null;
  }

  function render(data) {
    status = data;
    wallet.hidden = !data.linked;
    if (data.linked) {
      balance.textContent = `${pointFormat.format(data.balance_points)} pontos`;
      balanceBrl.textContent = data.settings?.points_per_real
        ? `Equivalente aproximado: ${moneyFormat.format(data.balance_points / data.settings.points_per_real)}`
        : "";
    }
    form.hidden = !data.unlocked || !data.settings;
    if (!data.mission_active) setMessage("A missão e o saque do Mini App estão pausados. Aguarde a liberação no painel.");
    else if (!data.linked) setMessage("Vincule o Telegram à sua conta pelo app Young Money para solicitar saques.");
    else if (!data.unlocked) setMessage(`Progresso de hoje: ${data.current}/15. Complete as impressões confirmadas para abrir o saque.`);
    else if (!data.settings.methods.length) setMessage("PIX e FaucetPay estão desativados no painel administrativo.");
    else setMessage("Meta de 15/15 confirmada. Escolha o método e confira seu saldo antes de solicitar.");
    for (const option of method.options) option.disabled = !data.settings?.methods?.includes(option.value);
    if (data.settings?.methods?.length && method.selectedOptions[0]?.disabled) {
      method.value = data.settings.methods[0];
    }
    validate();
  }

  async function loadStatus() {
    setMessage("Consultando sua conta...");
    form.hidden = true;
    try { render(await callApi({ action: "status" })); }
    catch (error) { status = null; wallet.hidden = true; setMessage(error.message, "error"); }
  }

  openButton.addEventListener("click", () => {
    screen.hidden = false;
    void loadStatus();
  });
  backButton.addEventListener("click", () => { screen.hidden = true; });
  window.addEventListener("ym:progress", event => {
    const unlockedByCount = event.detail?.todayTotal >= 15;
    openButton.hidden = !unlockedByCount;
    if (!unlockedByCount) screen.hidden = true;
  });
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
      await loadStatus();
      setMessage(`Saque #${result.withdrawal_id} solicitado. Aguarde a análise no painel.`);
    } catch (error) {
      setMessage(error.message || "Não foi possível solicitar. Tente novamente.", "error");
      // Preserve requestId: a retry cannot debit the wallet twice.
    } finally {
      busy = false;
      validate();
    }
  });
})();
