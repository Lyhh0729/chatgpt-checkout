// ============================================================
// ChatGPT 订阅链接生成器 - 前端逻辑
// ============================================================

const state = {
  tab: "checkout",
  plan: "chatgptplusplan",
  uiMode: "custom",
  region: "US",
  promoEnabled: true,
};

// ---- 翻译映射 ----
const ORIGIN_MAP = {
  chatgpt_mobile_android: { label: "安卓 App（Google Play）", tone: "emerald" },
  chatgpt_mobile_ios: { label: "iOS App（Apple 内购）", tone: "sky" },
  chatgpt_web: { label: "网页（Stripe 信用卡）", tone: "indigo" },
  chatgpt_web_stripe: { label: "网页（Stripe 信用卡）", tone: "indigo" },
  chatgpt_web_apple_pay: { label: "网页（Apple Pay）", tone: "fuchsia" },
  chatgpt_web_paypal: { label: "网页（PayPal）", tone: "amber" },
  chatgpt_desktop: { label: "桌面客户端", tone: "slate" },
};

const PLAN_MAP = {
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Team",
  free: "Free",
  chatgptplusplan: "ChatGPT Plus",
  chatgptproplan: "ChatGPT Pro",
  chatgptteamplan: "ChatGPT Team",
};

const PROCESSOR_MAP = {
  a001: "Stripe（网页信用卡）",
  b001: "Apple（iOS 内购）",
  c001: "Google Play（安卓内购）",
};

// ---- DOM 引用 ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const tokenInput = $("#tokenInput");
const tokenStatus = $("#tokenStatus");
const checkoutPanel = $("#checkoutPanel");
const sourcePanel = $("#sourcePanel");
const regionBlock = $("#regionBlock");
const promoBlock = $("#promoBlock");
const promoEnabledInput = $("#promoEnabled");
const teamBlock = $("#teamBlock");
const checkoutOutput = $("#checkoutOutput");
const sourceOutput = $("#sourceOutput");
const generateButton = $("#generateButton");
const sourceButton = $("#sourceButton");

// ---- 事件绑定 ----
$$("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (state.tab !== btn.dataset.tab) {
      state.tab = btn.dataset.tab;
      renderTabs();
    }
  });
});

$$("[data-choice]").forEach((btn) => {
  btn.addEventListener("click", () => {
    state[btn.dataset.choice] = btn.dataset.value;
    renderChoices();
  });
});

tokenInput.addEventListener("input", renderTokenStatus);
promoEnabledInput.addEventListener("change", () => {
  state.promoEnabled = promoEnabledInput.checked;
});
generateButton.addEventListener("click", generateCheckout);
sourceButton.addEventListener("click", querySource);

// ---- 初始渲染 ----
renderTabs();
renderChoices();
renderTokenStatus();

// ======================== 渲染函数 ========================

function renderTabs() {
  $$("[data-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.tab);
  });
  checkoutPanel.classList.toggle("hidden", state.tab !== "checkout");
  sourcePanel.classList.toggle("hidden", state.tab !== "source");
}

function renderChoices() {
  $$("[data-choice]").forEach((btn) => {
    btn.classList.toggle("active", state[btn.dataset.choice] === btn.dataset.value);
  });

  // Team 套餐时隐藏区域和优惠码（Team 价格不按区域区分）
  const isTeam = state.plan === "chatgptteamplan";
  regionBlock.classList.toggle("hidden", isTeam);
  promoBlock.classList.toggle("hidden", isTeam);
  teamBlock.classList.toggle("hidden", !isTeam);
}

function renderTokenStatus() {
  const parsed = parseToken(tokenInput.value);
  if (!tokenInput.value.trim()) {
    tokenStatus.className = "token-status muted";
    tokenStatus.textContent = "请在上方输入内容";
    return;
  }
  if (!parsed.ok) {
    tokenStatus.className = "token-status";
    tokenStatus.innerHTML = `<span class="badge bad">${escHtml(parsed.error)}</span>`;
    return;
  }
  const pieces = [
    `<span class="badge good">已识别 · ${parsed.source === "json" ? "Session JSON" : "Access Token"}</span>`,
  ];
  if (parsed.meta?.email) pieces.push(`<span class="badge">${escHtml(parsed.meta.email)}</span>`);
  if (parsed.meta?.planType) pieces.push(`<span class="badge">${escHtml(parsed.meta.planType)}</span>`);
  if (parsed.meta?.expires) pieces.push(`<span class="badge">${escHtml(formatTime(parsed.meta.expires))}</span>`);
  tokenStatus.className = "token-status";
  tokenStatus.innerHTML = pieces.join(" ");
}

// ======================== 核心：生成订阅链接 ========================

async function generateCheckout() {
  const parsed = parseToken(tokenInput.value);
  if (!parsed.ok) {
    showError(checkoutOutput, parsed.error);
    return;
  }

  checkoutOutput.classList.add("hidden");
  setButtonLoading(generateButton, true, "正在生成链接...");
  try {
    const data = await postJson("/api/checkout", {
      accessToken: parsed.accessToken,
      planName: state.plan,
      uiMode: state.uiMode,
      region: state.region,
      promoEnabled: state.promoEnabled,
      workspaceName: $("#workspaceName")?.value || "MyTeam",
      seatQuantity: Number($("#seatQuantity")?.value || 5),
    });

    if (data.ok && data.link) {
      showCheckoutResult(data.link, data.raw);
    } else {
      showError(checkoutOutput, extractError(data));
    }
  } catch (error) {
    showError(checkoutOutput, extractError(error));
  } finally {
    setButtonLoading(generateButton, false, "生成订阅链接");
  }
}

function showCheckoutResult(link, raw) {
  checkoutOutput.className = "output";
  checkoutOutput.innerHTML = `
    <strong>订阅链接已生成 ✅</strong>
    <div class="result-link">${escHtml(link)}</div>
    <div class="output-actions">
      <button class="copy-button" type="button" data-copy="${escAttr(link)}">复制链接</button>
      <a class="open-link" href="${escAttr(link)}" target="_blank" rel="noreferrer noopener">在浏览器打开</a>
    </div>
    <div class="info-tip">
      将此链接发送给对方，对方在浏览器中打开即可用对应区域价格完成支付。
    </div>
    ${renderDetails(raw)}
  `;
  checkoutOutput.querySelector("[data-copy]")?.addEventListener("click", copyFromButton);
}

// ======================== 核心：查询订阅来源 ========================

async function querySource() {
  const parsed = parseToken(tokenInput.value);
  if (!parsed.ok) {
    showError(sourceOutput, parsed.error);
    return;
  }

  sourceOutput.classList.add("hidden");
  setButtonLoading(sourceButton, true, "正在查询...");

  try {
    const data = await postJson("/api/check", { accessToken: parsed.accessToken });
    const info = extractAccountInfo(data);
    if (!info) {
      showError(sourceOutput, "响应中未找到 accounts.default，可能账号异常或 Token 已失效");
      return;
    }
    showSourceResult(info, data);
  } catch (error) {
    showError(sourceOutput, extractError(error));
  } finally {
    setButtonLoading(sourceButton, false, "查询订阅来源");
  }
}

function showSourceResult(info, raw) {
  const origin = translateOrigin(info.purchaseOriginPlatform);
  sourceOutput.className = "output";
  sourceOutput.innerHTML = `
    <div class="details-grid">
      ${stat("订阅来源", origin.label)}
      ${stat("套餐类型", translatePlan(info.subscriptionPlan || info.planType))}
      ${stat("订阅状态", info.hasActiveSubscription ? "✅ 有效" : "❌ 无订阅 / 已失效")}
      ${stat("到期时间", info.expiresAt ? formatTime(info.expiresAt) : "-")}
      ${stat("续期时间", info.renewsAt ? formatTime(info.renewsAt) : "-")}
      ${stat("计费币种", info.billingCurrency || "-")}
      ${stat("订阅 ID", info.subscriptionId || "-")}
      ${stat("支付处理器", info.processors.length
        ? info.processors.map((p) => `${p} ${PROCESSOR_MAP[p] || "未知"}`).join("；")
        : "-")}
      ${stat("Account ID", info.accountId)}
    </div>
    ${info.cancelsAt ? `<p>订阅将于 ${escHtml(formatTime(info.cancelsAt))} 取消</p>` : ""}
    ${info.isDelinquent ? '<p class="warn">⚠️ 账号存在欠费状态</p>' : ""}
    ${renderDetails(raw)}
  `;
}

// ======================== 网络请求 ========================

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text || "响应不是 JSON" };
  }
  if (!response.ok) throw data;
  return data;
}

// ======================== Token 解析 ========================

function parseToken(input) {
  const value = input.trim();
  if (!value) return { ok: false, error: "请输入内容" };

  // Session JSON 格式
  if (value.startsWith("{")) {
    try {
      const data = JSON.parse(value);
      const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
      if (!accessToken.startsWith("eyJ")) {
        return { ok: false, error: "JSON 中未找到有效的 accessToken 字段" };
      }
      return {
        ok: true,
        accessToken,
        source: "json",
        meta: {
          email: data?.user?.email,
          planType: data?.account?.planType,
          expires: data?.expires,
        },
      };
    } catch {
      return { ok: false, error: "JSON 解析失败，请检查是否粘贴完整" };
    }
  }

  // 纯 JWT Token
  if (value.startsWith("eyJ") && value.split(".").length === 3) {
    return { ok: true, accessToken: value, source: "raw" };
  }

  return { ok: false, error: "格式不识别：请粘贴完整 session JSON，或以 eyJ 开头的 Access Token" };
}

// ======================== 数据提取 ========================

function extractAccountInfo(data) {
  const account = data?.accounts?.default;
  if (!account) return null;

  const processors = [];
  const processorMap = account.account?.processor || {};
  Object.entries(processorMap).forEach(([key, value]) => {
    if (value?.has_transaction_history || value?.has_customer_object) {
      processors.push(key);
    }
  });

  return {
    accountId: account.account?.account_id || "-",
    planType: account.account?.plan_type || "-",
    hasActiveSubscription: Boolean(account.entitlement?.has_active_subscription),
    subscriptionPlan: account.entitlement?.subscription_plan,
    subscriptionId: account.entitlement?.subscription_id,
    expiresAt: account.entitlement?.expires_at,
    renewsAt: account.entitlement?.renews_at,
    cancelsAt: account.entitlement?.cancels_at || null,
    willRenew: account.last_active_subscription?.will_renew,
    billingCurrency: account.entitlement?.billing_currency,
    purchaseOriginPlatform: account.last_active_subscription?.purchase_origin_platform,
    processors,
    isDelinquent: account.account?.is_delinquent,
  };
}

// ======================== UI 辅助 ========================

function showError(target, message) {
  target.className = "output error";
  target.innerHTML = escHtml(message);
}

function setButtonLoading(button, loading, text) {
  button.disabled = loading;
  button.textContent = text;
}

function copyFromButton(event) {
  const button = event.currentTarget;
  const text = button.dataset.copy;
  const markCopied = () => {
    const oldText = button.textContent;
    button.textContent = "已复制 ✓";
    setTimeout(() => {
      button.textContent = oldText;
    }, 1400);
  };

  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(markCopied).catch(() => window.prompt("复制链接", text));
    return;
  }
  window.prompt("复制链接", text);
}

function renderDetails(data) {
  return `
    <details class="raw-details">
      <summary>查看原始响应</summary>
      <pre>${escHtml(JSON.stringify(data, null, 2))}</pre>
    </details>
  `;
}

function stat(label, value) {
  return `
    <div class="stat">
      <div class="stat-label">${escHtml(label)}</div>
      <div class="stat-value">${escHtml(value)}</div>
    </div>
  `;
}

// ---- 翻译函数 ----
function translateOrigin(raw) {
  if (!raw) return { label: "未知", tone: "slate", raw: "" };
  return ORIGIN_MAP[raw] || { label: raw, tone: "slate", raw };
}

function translatePlan(raw) {
  if (!raw) return "-";
  return PLAN_MAP[raw] || raw;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN");
}

function extractError(value) {
  if (typeof value === "string") return value;
  if (typeof value?.error === "string") return value.error;
  if (typeof value?.error?.detail === "string") return value.error.detail;
  if (typeof value?.error?.message === "string") return value.error.message;
  try {
    return JSON.stringify(value).slice(0, 600);
  } catch {
    return "请求失败";
  }
}

// ---- 安全转义 ----
function escHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escAttr(value) {
  return escHtml(value).replaceAll("`", "&#096;");
}
