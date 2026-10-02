// Git Save/Load 设置页（Hana 设置窗里的自定义设置页 · contributes.settings.ui）。
// 数据面：hana.api.fetch → /api/apps/git-save-load/routes/settings/*
// 渲染模型：单一 state + 单一 render()，轮询不会把进行中的交互抹掉。
// 注意：页面跑在沙箱 iframe 里，window.confirm 被禁 —— 确认走页内确认条。
import { hana } from "./sdk.js";

const API = {
  status: "/settings/status",
  ghLogin: "/settings/gh-login",
  ghLogout: "/settings/gh-logout",
  openDevice: "/settings/open-device",
  signGenerate: "/settings/signing/generate",
  signRotate: "/settings/signing/rotate",
  signToggle: "/settings/signing/toggle",
  pubkey: "/settings/signing/pubkey",
};
const POLL_WAIT_MS = 3000;
const CODE_COPIED_RESET_MS = 1800;

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
  confirmBar: el("confirm-bar"),
  confirmText: el("confirm-text"),
  confirmOk: el("confirm-ok"),
  confirmCancel: el("confirm-cancel"),
  note: el("gs-note"),
};

let state = { git: {}, gh: {}, gpg: {}, signing: {}, device: {} };
let pending = null; // "login" | "logout" | "generate" | "rotate" | null
let confirmRequest = null; // { message, onOk }
let pollTimer = null;

// ---------------------------------------------------------------- 基础件

async function api(path, init) {
  const res = await hana.api.fetch(path, init);
  const raw = await res.text();
  try {
    return { status: res.status, data: raw ? JSON.parse(raw) : null };
  } catch {
    return { status: res.status, data: { ok: false, error: raw } };
  }
}
const apiPost = (path, body) =>
  api(path, {
    method: "POST",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

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
  const { installed, loggedIn, login, accountId } = state.gh;
  const device = state.device;
  const waiting = !!device.active;

  ui.acctId.textContent = accountId || login || "—";

  ui.authHint.textContent = !installed
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
  setBadge(ui.gitBadge, state.git.installed, "可用", "未安装");
  ui.gitVer.textContent = state.git.installed ? state.git.version || "版本未知" : "—";
  setBadge(ui.ghBadge, state.gh.installed, "可用", "未安装");
  ui.ghVer.textContent = state.gh.installed ? state.gh.version || "版本未知" : "—";
  setBadge(ui.gpgBadge, state.gpg.installed, "可用", "未安装");
  ui.gpgVer.textContent = state.gpg.installed ? state.gpg.version || "版本未知" : "—";
}

function renderSigning() {
  const sign = state.signing;
  setBadge(ui.signBadge, sign.hasKey, "已生成", "未生成");
  ui.signFpr.textContent = sign.hasKey ? (sign.fingerprint || "").slice(-16) : "—";
  ui.signUid.textContent = sign.hasKey ? sign.uid || "—" : "—";
  ui.signSwitch.checked = !!sign.enabled;
  ui.signSwitch.disabled = !sign.hasKey || pending === "generate" || pending === "rotate";

  ui.signActions.textContent = "";
  if (pending === "generate" || pending === "rotate") {
    ui.signActions.append(makeBusy("正在生成密钥…"));
  } else if (sign.hasKey) {
    ui.signActions.append(
      makeButton("轮换密钥", { variant: "ghost", onClick: confirmRotate }),
      makeButton("复制公钥", { variant: "ghost", onClick: copyPubkey }),
    );
  } else {
    ui.signActions.append(makeButton("生成密钥", { onClick: requestGenerate }));
  }
}

function renderConfirm() {
  const active = !!confirmRequest;
  ui.confirmBar.hidden = !active;
  if (active) ui.confirmText.textContent = confirmRequest.message;
}

function render() {
  ui.root.setAttribute("aria-busy", "false");
  renderAccount();
  renderTools();
  renderSigning();
  renderConfirm();
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (state.device.active) pollTimer = setTimeout(refresh, POLL_WAIT_MS);
}

async function refresh() {
  try {
    const { data } = await api(API.status);
    if (!data?.ok) {
      setNote("读取状态失败，稍后自动重试。", "err");
      return;
    }
    state = {
      git: data.git || {},
      gh: data.gh || {},
      gpg: data.gpg || {},
      signing: data.signing || {},
      device: data.device || {},
    };
    render();
    schedulePoll();
  } catch (error) {
    setNote(`无法连接应用后端：${error?.message ?? error}`, "err");
  }
}

// ---------------------------------------------------------------- 动作

async function requestLogin() {
  pending = "login";
  setNote("");
  render();
  try {
    const { data } = await apiPost(API.ghLogin);
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
  const { data } = await apiPost(API.signGenerate);
  pending = null;
  if (!data?.ok) setNote(`生成失败：${data?.message || "未知错误"}`, "err");
  else setNote("密钥已生成，并已打开「提交时签名」。", "ok");
  refresh();
}

const confirmRotate = () =>
  askConfirm("确认轮换签名密钥？旧密钥会被删除，用它签过的提交签名将无法再次验证。", doRotate);

async function doRotate() {
  clearConfirm();
  pending = "rotate";
  setNote("正在轮换密钥…");
  render();
  const { data } = await apiPost(API.signRotate);
  pending = null;
  if (!data?.ok) setNote(`轮换失败：${data?.message || "未知错误"}`, "err");
  else setNote("密钥已轮换。若已把旧公钥加到 GitHub，请更新为新公钥。", "ok");
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

async function copyPubkey() {
  const { data } = await api(API.pubkey);
  if (!data?.ok || !data.armored) {
    setNote(`导出公钥失败：${data?.message || "未知错误"}`, "err");
    return;
  }
  const ok = await copyText(data.armored);
  setNote(ok ? "公钥已复制，可添加到 GitHub → Settings → SSH and GPG keys。" : "复制被浏览器拦截，请手动打开数据目录里的密钥。", ok ? "ok" : "warn");
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
  try { await hana.ready(); } catch {}
  await refresh();
})();
