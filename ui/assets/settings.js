// Git Save/Load 设置页（Hana 设置窗里的自定义设置页 · contributes.settings.ui）。
// 数据面：hana.api.fetch → /api/apps/git-save-load/routes/settings/*
// 渲染模型：单一 state + 单一 render()，轮询不会把进行中的交互抹掉。
// 容错：boot 先画一版加载态，请求带超时；任何失败都在页内显式报出原因与请求地址，
//       绝不让页面无声地停在「检测中」。
// 注意：页面跑在沙箱 iframe 里，window.confirm 被禁 —— 确认走页内确认条。
import { hana } from "./sdk.js";
import { createUpdateApi } from "./update-api.mjs";
import { installUpdateNotice } from "./update-notice.mjs";

const API = {
  local: "/settings/local",
  gh: "/settings/gh",
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
  updateCheck: "/settings/update-check",
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
  aboutCheck: el("about-check"),
  aboutNotes: el("about-notes"),
  aboutCurrent: el("about-current"),
  aboutLatest: el("about-latest"),
  aboutTag: el("about-tag"),
  aboutEnabled: el("about-enabled"),
  aboutInterval: el("about-interval"),
  aboutIntervalHint: el("about-interval-hint"),
};

let state = { loading: true, error: "", accountId: "", git: {}, gh: {}, gpg: {}, signing: {}, device: {}, token: {} };
// gh 账号校验要联网，单独一个进度位：本地那一趟回来就把整页画出来，
// 「gh 认证」那一行自己转圈，不陪它等。
let ghChecking = false;
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

// gh 校验失败时给个短原因。完整原文放在 title 里，短句这里只需让人一眼看懂方向。
function verifyFailureText(err) {
  const s = String(err || "");
  if (/bad credentials|401|403|invalid|expired|revoked/i.test(s)) return "凭据失效";
  if (/no connection|dial tcp|no such host|proxyconnect|timeout|i\/o timeout|EOF|TLS|network|certificate/i.test(s)) return "网络不通";
  return "校验失败";
}

function renderAccount() {
  const { installed, loggedIn, login } = state.gh;
  const verifyFailed = !!(state.gh && state.gh.verifyFailed);
  const verifyError = (state.gh && state.gh.verifyError) || "";
  const probeFailed = !!(state.gh && state.gh.probeFailed);
  const device = state.device;
  const waiting = !!device.active;

  ui.acctId.textContent = state.accountId || login || (ghChecking ? "…" : "—");

  // “未能确认”和“未登录”必须分开说：gh 网络不通时退出码是 0，但 state 是 error，
  // 以前这会被读成“未登录”，于是刷新几下就看见登录状态来回跳。
  // “探测失败”和“未检测到 gh”同理，也不能混。
  // 这里读的是 ghChecking（那一趟要联网），不是 state.loading：本地那一趟回来就能把
  // “未检测到 gh”这类结论说清楚，只有“登没登上”才需要等联网校验。
  ui.authHint.textContent = state.loading || ghChecking
    ? "检测中…"
    : state.error
      ? "检测失败"
      : !installed
        ? probeFailed
          ? "gh 探测失败"
          : "未检测到 gh"
        : loggedIn
          ? `已登录 · ${login || "（账号未报告）"}`
          : waiting
            ? "等待授权中…"
            : verifyFailed
              ? `未能确认 · ${verifyFailureText(verifyError)}`
              : "未登录";
  // 完整原因（gh 原文）挂 tooltip，不占版面但可追溯。
  ui.authHint.title = verifyFailed ? verifyError : probeFailed ? (state.gh && state.gh.probeError) || "" : "";

  ui.authAction.textContent = "";
  if (pending === "login" || pending === "logout") {
    ui.authAction.append(makeBusy("处理中…"));
  } else if (ghChecking || state.loading) {
    // 还没问过 GitHub 就不摆「登录 / 退出」：这一刻不知道登没登上，
    // 提前摆一个按钮就是在猜（而且猜错的时候按钮还会闪一下）。
    ui.authAction.append(makeBusy("校验中…"));
  } else if (loggedIn) {
    ui.authAction.append(makeButton("退出登录", { variant: "danger", onClick: requestLogout }));
  } else if (!installed) {
    // 探测失败不等于没装：这种情况不该引导去安装/登录，先重查。
    if (probeFailed) ui.authAction.append(makeButton("重新检测", { variant: "ghost", onClick: refresh }));
    else ui.authAction.append(makeButton("登录", { disabled: true, title: "需先安装 GitHub CLI（gh）" }));
  } else if (waiting) {
    ui.authAction.append(makeButton("重新获取代码", { variant: "ghost", onClick: requestLogin }));
  } else if (verifyFailed) {
    // 没能确认时不该引导去登录（可能本来就登着，只是没验成），先重查。
    ui.authAction.append(makeButton("重新检测", { variant: "ghost", onClick: refresh }));
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
  // gh 探测失败时不要把“没探成”说成“未安装”（同一个诚性问题）。
  if (state.gh && state.gh.probeFailed) {
    setBadge(ui.ghBadge, false, "", "未知");
    ui.ghVer.textContent = "—";
  } else {
    setBadge(ui.ghBadge, state.gh.installed, "可用", "未安装");
    ui.ghVer.textContent = state.gh.installed ? state.gh.version || "版本未知" : "—";
  }
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
    const { data } = await withTimeout(api(API.local), STATUS_TIMEOUT_MS, "本地状态请求");
    if (!data?.ok) throw new Error(data?.message || "后端返回失败");
    state.loading = false;
    state.git = data.git || {};
    // gh 只拿到本地探针（装没装、版本号）；「登没登上」要等下面那次联网校验。
    state.gh = data.gh || {};
    state.gpg = data.gpg || {};
    state.signing = data.signing || {};
    state.device = data.device || {};
    setNote("");
    render();
    schedulePoll();
  } catch (error) {
    state.loading = false;
    state.error = explainError("读取状态失败", error, API.local);
    render();
    setNote(`${state.error}。点右上角「重新检测」重试。`, "err");
  }
  // 剩下两件都是「首屏之后自己补」，不拦住上面那些格的显示：
  // 账号校验要联网、令牌摘要要读本地记录，两件互不依赖，所以一起发出去。
  void loadGhAccount();
  void loadTokenInfo();
}

// gh 账号校验（联网，可能卡十几秒）：单独立一个口。本地那一趟已经把「装没装」交代清楚，
// 这一次只补「登没登上」，慢也只慢那一行。
async function loadGhAccount() {
  ghChecking = true;
  render();
  try {
    const { data } = await withTimeout(api(API.gh), STATUS_TIMEOUT_MS, "gh 校验");
    if (data?.ok) {
      // 只覆盖 gh 那一块：本地那一趟已经带来的 git / gpg / signing 不动。
      state.gh = { ...state.gh, ...data };
    } else {
      // 校验没成：不谎报“未登录”，老老实实说没能确认。
      state.gh = { ...state.gh, verifyFailed: true, verifyError: data?.message || "校验请求失败" };
    }
  } catch (error) {
    // 超时也算“没验成”，不是“未登录”——两者在界面上的说法必須分开。
    state.gh = { ...state.gh, verifyFailed: true, verifyError: String(error?.message || error) };
  }
  ghChecking = false;
  render();
  loadAccountId();
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

// ---------------------------------------------------------------- 版本与更新说明

// 检查间隔的合法区间与服务端 lib/update-check.mjs 同源（那边是权威）。
// 前端也存一份，是为了打字时就能给得出范围，不必为一个数字来回一趟。
// 不能直接把 lib/update-check.mjs import 进来：那一份要 node:fs，浏览器里跑不了。
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 10080;
const INTERVAL_FALLBACK = 360;

// 取数通道：设置页跑在宿主的沙箱 iframe 里，走 hana.api.fetch（凭据头由 SDK 带）。
// update-api 那层内部只认相对路径 /update-check，本 App 的设置端点统一挂在 /settings/* 下，
// 前缀在这里补上（那一层因此能与 doc-intake / magpie-hana 那几份逐字可 diff）。
const updateApi = createUpdateApi({
  fetchJson: async (path, init) => (await api(`${API.updateCheck}${path.replace(/^\/update-check/, "")}`, init)).data,
});
let updateNotice = null;

function parseInterval(raw) {
  const s = String(raw ?? "").trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= INTERVAL_MIN && n <= INTERVAL_MAX ? n : null;
}

/** 间隔那一行的副文案：平时是一句说明，填得不对时就地变红说清范围。 */
function setIntervalHint(bad) {
  const node = ui.aboutIntervalHint;
  if (!node) return;
  if (bad) {
    node.textContent = `要填 ${INTERVAL_MIN} – ${INTERVAL_MAX} 的整数分钟`;
    node.dataset.kind = "err";
  } else {
    node.textContent = "超过就自动检查";
    delete node.dataset.kind;
  }
}

/** 快照一到就刷这一格。不自己算版本高低，只听服务端的判断（拿不到就保持上一个值）。 */
function syncAbout() {
  if (!ui.aboutCurrent) return;
  const d = updateNotice?.data;
  ui.aboutCurrent.textContent = d?.current ? `v${d.current}` : "—";
  ui.aboutLatest.textContent = d ? (d.latest ? `v${d.latest.version}` : "—") : "…";
  ui.aboutLatest.dataset.state = d?.hasUpdate ? "new" : "";
  const showTag = !!d?.hasUpdate;
  ui.aboutTag.hidden = !showTag;
  if (showTag) ui.aboutTag.textContent = `有新版本 v${d.latest.version}`;
  if (ui.aboutEnabled) ui.aboutEnabled.checked = d ? d.enabled !== false : true;
  // 输入框正在填的时候别去覆盖它，否则打字打到一半会被刷走。
  if (ui.aboutInterval && document.activeElement !== ui.aboutInterval) {
    const minutes = d?.intervalMinutes ?? INTERVAL_FALLBACK;
    if (ui.aboutInterval.value !== String(minutes)) ui.aboutInterval.value = String(minutes);
    setIntervalHint(false);
  }
}

// 这一格改完就存，但走的不是插件配置，是插件进程里那份状态文件（更新提示开关与检查间隔）。
// 两笔都成功才算存好：任何一笔失败都报出来，不让界面停在一个没生效的位置上。
async function commitAbout() {
  const enabled = !!ui.aboutEnabled?.checked;
  const minutes = parseInterval(ui.aboutInterval?.value);
  if (minutes === null) {
    setIntervalHint(true);
    setNote(`检查间隔要填 ${INTERVAL_MIN} – ${INTERVAL_MAX} 之间的整数分钟`, "err");
    return;
  }
  setIntervalHint(false);
  try {
    await withTimeout(updateApi.dismissUpdate({ action: "toggle", enabled }), STATUS_TIMEOUT_MS, "保存更新提示");
    await withTimeout(updateApi.setUpdateInterval(minutes), STATUS_TIMEOUT_MS, "保存检查间隔");
    // 新间隔可能已经过期，顺手问一次（间隔没到它不会真出门）。
    void updateNotice?.refresh();
    setNote("已保存", "ok");
  } catch (error) {
    setNote(`保存失败：${error?.message || error}`, "err");
  }
}

ui.aboutCheck.addEventListener("click", () => updateNotice?.openManual());
ui.aboutNotes.addEventListener("click", () => updateNotice?.openCached());
ui.aboutEnabled.addEventListener("change", () => void commitAbout());
ui.aboutInterval.addEventListener("input", () => {
  // 打字时只做一件事：改对了就把红字收回。打到一半不判它错。
  if (parseInterval(ui.aboutInterval.value) !== null) setIntervalHint(false);
});
ui.aboutInterval.addEventListener("change", () => void commitAbout());

(async function boot() {
  render(); // 先画一版加载态，页面不会像卡住
  try { await withTimeout(hana.ready(), READY_TIMEOUT_MS, "SDK 就绪"); } catch {}
  // 更新说明接在 SDK 就绪之后、首屏请求之前：它是自己一条线（按服务端定的间隔去查一次），
  // 与下面那趟本地请求互不依赖，所以不排在它后面。
  // 没网络通道时它不报错，只是拿不到新东西，已缓存的版本与历史照旧能看。
  try {
    updateNotice = installUpdateNotice({ hana, api: updateApi });
    updateNotice?.subscribe(() => syncAbout());
    syncAbout();
  } catch (error) {
    setNote(`更新说明没装上：${error?.message || error}`, "err");
  }
  // 这一趟只等本地探针（秒回）；gh 账号校验与令牌摘要在它内部自己铺开去跑，不拦住首屏。
  await refresh();
})();
