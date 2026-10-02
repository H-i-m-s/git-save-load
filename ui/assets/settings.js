// Git Save/Load 设置页（Hana 设置窗里的自定义设置页 · contributes.settings.ui）。
// 数据面：hana.api.fetch → /api/apps/git-save-load/routes/settings/*
// 渲染模型：单一 state + 单一 render()，轮询不会把进行中的交互抹掉。
// 容错：boot 先画一版加载态，请求带超时；任何失败都在页内显式报出原因与请求地址，
//       绝不让页面无声地停在「检测中」。
// 注意：页面跑在沙箱 iframe 里，window.confirm 被禁 —— 确认走页内确认条。
import { hana } from "./sdk.js";

const API = {
  status: "/settings/status",
  account: "/settings/account",
  ghLogin: "/settings/gh-login",
  ghLogout: "/settings/gh-logout",
  openDevice: "/settings/open-device",
  signGenerate: "/settings/signing/generate",
  signRotate: "/settings/signing/rotate",
  signToggle: "/settings/signing/toggle",
  pubkey: "/settings/signing/pubkey",
  token: "/settings/token",
  tokenClear: "/settings/token/clear",
};
const POLL_WAIT_MS = 3000;
const CODE_COPIED_RESET_MS = 1800;
const STATUS_TIMEOUT_MS = 15000;
const ACCOUNT_TIMEOUT_MS = 10000;
const READY_TIMEOUT_MS = 8000;

const el = (id) => document.getElementById(id);
const ui = {
  root: el("gs"),
  refreshBtn: el("btn-refresh"),
  acctId: el("acct-id"),
  authHint: el("auth-hint"),
  authAction: el("auth-action"),
  codeRow: el("code-row"),
  codeChip: el("device-code"),
  codeText: el("device-code-text"),
  codeTip: el("device-code-tip"),
  openDevice: el("open-device"),
  loginSteps: el("login-steps"),
  gitVer: el("git-ver"),
  gitBadge: el("git-badge"),
  ghVer: el("gh-ver"),
  ghBadge: el("gh-badge"),
  gpgVer: el("gpg-ver"),
  gpgBadge: el("gpg-badge"),
  signBadge: el("sign-badge"),
  signFpr: el("sign-fpr"),
  signUid: el("sign-uid"),
  signSwitch: el("sign-switch"),
  signActions: el("sign-actions"),
  signName: el("sign-name"),
  signEmail: el("sign-email"),
  pubkeyView: el("pubkey-view"),
  tokenInput: el("token-input"),
  tokenSave: el("token-save"),
  tokenClear: el("token-clear"),
  tokenState: el("token-state"),
  tokenProtection: el("token-protection"),
  tokenLocation: el("token-location"),
  confirmBar: el("confirm-bar"),
  confirmText: el("confirm-text"),
  confirmOk: el("confirm-ok"),
  confirmCancel: el("confirm-cancel"),
  note: el("gs-note"),
};

let state = { loading: true, error: "", accountId: "", git: {}, gh: {}, gpg: {}, signing: {}, device: {}, token: {} };
let pending = null; // "login" | "logout" | "generate" | "rotate" | null
let confirmRequest = null; // { message, onOk }
let pollTimer = null;
let pubkeyShown = false;

// ---------------------------------------------------------------- 基础件

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms 未响应）`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function api(path, init) {
  const res = await hana.api.fetch(path, init);
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { ok: false, error: raw };
  }
  return { status: res.status, data };
}
const apiPost = (path, body) =>
  api(path, {
    method: "POST",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

// 失败时尽量把「为什么」说清楚：错误信息 + 实际请求地址 + 会话参数是否在位。
function explainError(prefix, error, path) {
  const msg = String(error?.message || error || "未知错误");
  let url = "";
  try { url = hana.api.url(path); } catch { url = ""; }
  const hasSession = new URLSearchParams(location.search).has("appSurfaceSession");
  const parts = [`${prefix}：${msg}`];
  if (url) parts.push(`请求 ${url}`);
  if (!hasSession) parts.push("本页 URL 缺少 appSurfaceSession（应用后端会话未下发）");
  return parts.join("；");
}

function makeButton(label, { variant = "primary", onClick, disabled = false, title } = {}) {
  const node = document.createElement("button");
  node.type = "button";
  const variantClass = { primary: "", ghost: "gs-btn--ghost", danger: "gs-btn--danger", dangerSolid: "gs-btn--danger-solid" }[variant];
  node.className = ["gs-btn", variantClass].filter(Boolean).join(" ");
  node.textContent = label;
  node.disabled = disabled;
  if (title) node.title = title;
  if (onClick) node.addEventListener("click", onClick);
  return node;
}

function makeBusy(label) {
  const wrap = document.createElement("span");
  wrap.className = "gs-busy";
  const spinner = document.createElement("span");
  spinner.className = "gs-spinner";
  const node = document.createElement("span");
  node.textContent = label;
  wrap.append(spinner, node);
  return wrap;
}

function setNote(message, kind) {
  ui.note.textContent = message || "";
  ui.note.hidden = !message;
  ui.note.dataset.kind = kind || "";
}

function askConfirm(message, onOk) {
  confirmRequest = { message, onOk };
  render();
}
function clearConfirm() {
  confirmRequest = null;
  render();
}

function setBadge(node, ok, labelOk, labelOff) {
  node.dataset.state = ok ? "ok" : "off";
  node.textContent = ok ? labelOk : labelOff;
}
function setBadgeLoading(node) {
  node.dataset.state = "off";
  node.textContent = "…";
}

// 复制：宿主剪贴板 → navigator.clipboard → execCommand，全失败给可全选输入框
async function copyText(value) {
  const data = String(value ?? "");
  if (!data) return false;
  try { await hana.clipboard.writeText(data, { timeoutMs: 2000 }); return true; } catch {}
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(data); return true; } } catch {}
  try {
    const area = document.createElement("textarea");
    area.value = data;
    area.readOnly = true;
    area.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 渲染

function renderAccount() {
  const { installed, loggedIn, login } = state.gh;
  const device = state.device;
  const waiting = !!device.active;

  ui.acctId.textContent = state.accountId || login || (state.loading ? "…" : "—");

  ui.authHint.textContent = state.loading
    ? "检测中…"
    : state.error
      ? "检测失败"
      : !installed
        ? "未检测到 gh"
        : loggedIn
          ? `已登录 · ${login || "（账号未报告）"}`
          : waiting
            ? "等待授权中…"
            : "未登录";

  ui.authAction.textContent = "";
  if (pending === "login" || pending === "logout") {
    ui.authAction.append(makeBusy("处理中…"));
  } else if (loggedIn) {
    ui.authAction.append(makeButton("退出登录", { variant: "danger", onClick: requestLogout }));
  } else if (!installed) {
    ui.authAction.append(makeButton("登录", { disabled: true, title: "需先安装 GitHub CLI（gh）" }));
  } else if (waiting) {
    ui.authAction.append(makeButton("重新获取代码", { variant: "ghost", onClick: requestLogin }));
  } else {
    ui.authAction.append(makeButton("登录", { onClick: requestLogin }));
  }

  ui.codeRow.hidden = !waiting;
  ui.loginSteps.hidden = !waiting;
  if (waiting) ui.codeText.textContent = device.code;
}

function renderTools() {
  if (state.loading) {
    for (const [badge, ver] of [[ui.gitBadge, ui.gitVer], [ui.ghBadge, ui.ghVer], [ui.gpgBadge, ui.gpgVer]]) {
      setBadgeLoading(badge);
      ver.textContent = "…";
    }
    return;
  }
  setBadge(ui.gitBadge, state.git.installed, "可用", "未安装");
  ui.gitVer.textContent = state.git.installed ? state.git.version || "版本未知" : "—";
  setBadge(ui.ghBadge, state.gh.installed, "可用", "未安装");
  ui.ghVer.textContent = state.gh.installed ? state.gh.version || "版本未知" : "—";
  setBadge(ui.gpgBadge, state.gpg.installed, "可用", "未安装");
  ui.gpgVer.textContent = state.gpg.installed ? state.gpg.version || "版本未知" : "—";
}

function renderSigning() {
  const busy = pending === "generate" || pending === "rotate";
  if (state.loading) {
    setBadgeLoading(ui.signBadge);
    ui.signFpr.textContent = "…";
    ui.signUid.textContent = "…";
    ui.signSwitch.checked = false;
    ui.signSwitch.disabled = true;
    ui.signName.disabled = true;
    ui.signEmail.disabled = true;
    ui.signActions.textContent = "";
    return;
  }
  const sign = state.signing;
  setBadge(ui.signBadge, sign.hasKey, "已生成", "未生成");
  ui.signFpr.textContent = sign.hasKey ? sign.fingerprint || "—" : "—";
  ui.signUid.textContent = sign.hasKey ? sign.uid || "—" : "—";
  ui.signSwitch.checked = !!sign.enabled;
  ui.signSwitch.disabled = !sign.hasKey || busy;
  ui.signName.disabled = busy;
  ui.signEmail.disabled = busy;

  ui.signActions.textContent = "";
  if (busy) {
    ui.signActions.append(makeBusy(pending === "rotate" ? "正在轮换密钥…" : "正在生成密钥…"));
    return;
  }
  ui.signActions.append(
    makeButton("生成/轮换密钥", {
      onClick: sign.hasKey ? confirmRotate : requestGenerate,
      disabled: !state.gpg.installed,
      title: state.gpg.installed ? "" : "未检测到 gpg",
    }),
    makeButton("查看公钥", { variant: "ghost", disabled: !sign.hasKey, onClick: viewPubkey }),
    makeButton("复制公钥", { variant: "ghost", disabled: !sign.hasKey, onClick: copyPubkey }),
  );
}

function renderConfirm() {
  const active = !!confirmRequest;
  ui.confirmBar.hidden = !active;
  if (active) ui.confirmText.textContent = confirmRequest.message;
}

function renderToken() {
  const busy = pending === "token";
  const info = state.token || {};
  if (state.loading) {
    ui.tokenState.dataset.state = "off";
    ui.tokenState.textContent = "…";
    ui.tokenProtection.textContent = "…";
    ui.tokenLocation.textContent = "…";
  } else {
    setBadge(ui.tokenState, !!info.configured, "已配置", "未配置");
    ui.tokenProtection.textContent = info.backendAvailable === false
      ? "本平台无可用加密后端"
      : (info.protection || "—");
    ui.tokenLocation.textContent = info.location || "—";
  }
  ui.tokenInput.disabled = busy;
  ui.tokenSave.disabled = busy;
  ui.tokenClear.disabled = busy || !info.configured;
}

function render() {
  ui.root.setAttribute("aria-busy", state.loading ? "true" : "false");
  renderAccount();
  renderTools();
  renderSigning();
  renderToken();
  renderConfirm();
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (state.device.active) pollTimer = setTimeout(refresh, POLL_WAIT_MS);
}

async function refresh() {
  state.loading = true;
  state.error = "";
  render();
  try {
    const { data } = await withTimeout(api(API.status), STATUS_TIMEOUT_MS, "状态请求");
    if (!data?.ok) throw new Error(data?.message || "后端返回失败");
    state.loading = false;
    state.git = data.git || {};
    state.gh = data.gh || {};
    state.gpg = data.gpg || {};
    state.signing = data.signing || {};
    state.device = data.device || {};
    setNote("");
    render();
    schedulePoll();
    loadAccountId();
  } catch (error) {
    state.loading = false;
    state.error = explainError("读取状态失败", error, API.status);
    render();
    setNote(`${state.error}。点右上角「重新检测」重试。`, "err");
  }
  loadTokenInfo();
}

// 账号数字 ID 是联网查询，放到首屏之后异步补，失败就留空，不影响其它部分。
async function loadAccountId() {
  if (!state.gh.loggedIn) return;
  try {
    const { data } = await withTimeout(api(API.account), ACCOUNT_TIMEOUT_MS, "账号 ID 请求");
    if (data?.ok && data.accountId) {
      state.accountId = data.accountId;
      renderAccount();
    }
  } catch {
    /* 拿不到就算了，状态页其它内容照常 */
  }
}

// 令牌状态摘要（不联网，只读本地记录）：独立请求，失败不波及其它部分。
async function loadTokenInfo() {
  try {
    const { data } = await withTimeout(api(API.token), ACCOUNT_TIMEOUT_MS, "令牌状态请求");
    if (data?.ok) state.token = data;
  } catch {
    /* 读不到就保持默认值 */
  }
  renderToken();
}

// ---------------------------------------------------------------- 动作

async function requestLogin() {
  pending = "login";
  setNote("");
  render();
  try {
    const { data } = await withTimeout(apiPost(API.ghLogin), 30000, "获取设备码");
    if (!data?.ok) setNote(`获取设备码失败：${data?.message || "未知错误"}，重试即可。`, "err");
    else if (data.browserOpened === false) setNote("浏览器未能自动打开，点「打开授权页」手动打开。", "warn");
  } catch (error) {
    setNote(`获取设备码失败：${error?.message ?? error}`, "err");
  }
  pending = null;
  refresh();
}

const requestLogout = () =>
  askConfirm(`确认退出 ${state.gh.login || "当前账号"} 的 gh 登录？（只删本地凭据，不影响远端令牌）`, doLogout);

async function doLogout() {
  clearConfirm();
  pending = "logout";
  render();
  const { data } = await apiPost(API.ghLogout);
  pending = null;
  if (!data?.ok) setNote(`退出失败：${data?.message || "未知错误"}`, "err");
  refresh();
}

async function requestGenerate() {
  if (!state.gpg.installed) { setNote("未检测到 gpg，请先安装 GnuPG（Git for Windows 也自带 gpg）。", "err"); return; }
  pending = "generate";
  setNote("正在生成密钥，ed25519 通常一瞬间，老版本 gpg 回退 RSA 时可能稍慢…");
  render();
  try {
    const body = { name: ui.signName.value.trim(), email: ui.signEmail.value.trim() };
    const { data } = await withTimeout(apiPost(API.signGenerate, body), 150000, "生成密钥");
    if (!data?.ok) setNote(`生成失败：${data?.message || "未知错误"}`, "err");
    else { hidePubkey(); setNote("密钥已生成，并已打开「提交时签名」。", "ok"); }
  } catch (error) {
    setNote(`生成失败：${error?.message ?? error}`, "err");
  }
  pending = null;
  refresh();
}

const confirmRotate = () =>
  askConfirm("确认轮换签名密钥？旧密钥会被删除，用它签过的提交签名将无法再次验证。", doRotate);

async function doRotate() {
  clearConfirm();
  pending = "rotate";
  setNote("正在轮换密钥…");
  render();
  try {
    const body = { name: ui.signName.value.trim(), email: ui.signEmail.value.trim() };
    const { data } = await withTimeout(apiPost(API.signRotate, body), 150000, "轮换密钥");
    if (!data?.ok) setNote(`轮换失败：${data?.message || "未知错误"}`, "err");
    else { hidePubkey(); setNote("密钥已轮换。若已把旧公钥加到 GitHub，请更新为新公钥。", "ok"); }
  } catch (error) {
    setNote(`轮换失败：${error?.message ?? error}`, "err");
  }
  pending = null;
  refresh();
}

ui.signSwitch.addEventListener("change", async () => {
  const enabled = ui.signSwitch.checked;
  const { data } = await apiPost(API.signToggle, { enabled });
  if (!data?.ok) {
    ui.signSwitch.checked = !enabled;
    setNote(`设置失败：${data?.message || "未知错误"}`, "err");
    return;
  }
  setNote(enabled ? "已开启：后续「存档」会签名。" : "已关闭提交签名。", enabled ? "ok" : "");
  refresh();
});

// ---------------------------------------------------------------- GitHub 令牌

async function saveToken() {
  const token = ui.tokenInput.value.trim();
  if (!token) { setNote("请先粘贴 GitHub 令牌再保存（留空保存 = 清除）。", "warn"); return; }
  pending = "token";
  setNote("正在加密保存令牌…");
  render();
  try {
    const { data } = await withTimeout(apiPost(API.token, { token }), STATUS_TIMEOUT_MS, "保存令牌");
    if (!data?.ok) setNote(`保存失败：${data?.message || "未知错误"}`, "err");
    else {
      ui.tokenInput.value = "";
      state.token = data.token || state.token;
      setNote(`令牌已加密保存（${data.protection || "加密后端"}），后续 gh 命令会按次注入。`, "ok");
    }
  } catch (error) {
    setNote(`保存失败：${error?.message ?? error}`, "err");
  }
  pending = null;
  render();
  loadTokenInfo();
}

const confirmTokenClear = () =>
  askConfirm("确认清除已保存的 GitHub 令牌？清除后 gh 命令会回到用你自己的登录态。", doTokenClear);

async function doTokenClear() {
  clearConfirm();
  pending = "token";
  render();
  try {
    const { data } = await apiPost(API.tokenClear);
    if (!data?.ok) setNote(`清除失败：${data?.message || "未知错误"}`, "err");
    else { state.token = data.token || {}; setNote("令牌已清除。", "ok"); }
  } catch (error) {
    setNote(`清除失败：${error?.message ?? error}`, "err");
  }
  pending = null;
  render();
  loadTokenInfo();
}

ui.tokenSave.addEventListener("click", saveToken);
ui.tokenClear.addEventListener("click", confirmTokenClear);
ui.tokenInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); saveToken(); }
});

async function copyPubkey() {
  const { data } = await api(API.pubkey);
  if (!data?.ok || !data.armored) {
    setNote(`导出公钥失败：${data?.message || "未知错误"}`, "err");
    return;
  }
  const ok = await copyText(data.armored);
  setNote(ok ? "公钥已复制，可添加到 GitHub → Settings → SSH and GPG keys。" : "复制被浏览器拦截，请手动打开数据目录里的密钥。", ok ? "ok" : "warn");
}

function hidePubkey() {
  pubkeyShown = false;
  ui.pubkeyView.hidden = true;
  ui.pubkeyView.textContent = "";
}

// 查看公钥：再点一次收起
async function viewPubkey() {
  if (pubkeyShown) { hidePubkey(); return; }
  const { data } = await api(API.pubkey);
  if (!data?.ok || !data.armored) {
    setNote(`读取公钥失败：${data?.message || "未知错误"}`, "err");
    return;
  }
  ui.pubkeyView.textContent = data.armored;
  ui.pubkeyView.hidden = false;
  pubkeyShown = true;
}

ui.codeChip.addEventListener("click", async () => {
  const code = ui.codeText.textContent.trim();
  if (!code) return;
  const ok = await copyText(code);
  if (ok) {
    ui.codeChip.dataset.copied = "1";
    ui.codeTip.textContent = "已复制";
    setTimeout(() => { ui.codeChip.dataset.copied = "0"; ui.codeTip.textContent = "复制"; }, CODE_COPIED_RESET_MS);
  } else {
    setNote("自动复制被拦截，请手动选中代码复制。", "warn");
  }
});

ui.openDevice.addEventListener("click", async (event) => {
  event.preventDefault();
  await apiPost(API.openDevice);
});

ui.confirmOk.addEventListener("click", () => {
  const handler = confirmRequest?.onOk;
  clearConfirm();
  if (handler) handler();
});
ui.confirmCancel.addEventListener("click", clearConfirm);

ui.refreshBtn.addEventListener("click", () => refresh());

(async function boot() {
  render(); // 先画一版加载态，页面不会像卡住
  try { await withTimeout(hana.ready(), READY_TIMEOUT_MS, "SDK 就绪"); } catch {}
  await refresh();
})();
