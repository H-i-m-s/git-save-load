// Git Save/Load Card 前端模块 1/26：env.js — 请求适配（pluginFetch/会话头）、Hana 宿主桥接 shim、共享转义工具
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// escapeHtml/escapeAttr 为共享工具，自原 gh-repos / repo-init 区块上移至此（纯函数声明，无加载期副作用）。
// Local request helper for the App routes. The v2 App route door is
// /api/apps/<appId>/routes/*, authorized by the appSurfaceSession query
// parameter the host mints into the iframe URL (header preferred, query also
// accepted). Keep it inline so the session is available during first refresh.
const _nativeFetch = window.fetch.bind(window);
function pluginFetch(path, init) {
  var params = new URLSearchParams(window.location.search);
  var session = params.get("appSurfaceSession");
  var headers = new Headers((init && init.headers) || {});
  if (session) headers.set("X-Hana-App-Surface-Session", session);
  return _nativeFetch("/api/apps/git-save-load/routes/" + String(path || "").replace(/^\/+/, ""), Object.assign({}, init || {}, { headers: headers }));
}
// hana 用 var 声明：桥接模块（hana-bridge.js）会在加载后用真正的 App SDK 单例
// 覆盖 window.hana，各功能模块通过全局变量读到的是同一个引用。
var hana = window.hana || {
  ready: function() {},
  external: { open: function(url) { return Promise.resolve(window.open(url, "_blank")); } },
  clipboard: { writeText: function(text) { return navigator.clipboard.writeText(text); } },
  toast: { show: function() { return Promise.resolve(); } }
};
hana.ready();
function escapeAttr(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ======== 接口失败分级 ========
// app_route 这扇门的凭证是宿主挂在 iframe URL 上的 appSurfaceSession（TTL 上限 12h，
// 面板自己无法续签）。它一过期，所有 api/* 都返回 403 {error:"app_surface_session_expired"}；
// 这种「接口被拒绝」跟「这个目录不是仓库」是两件事，UI 不能拿前者去清屏。
// 返回 null 表示"这不是接口失败"：可能是成功（ok:true），也可能是服务端就这个路径
// 给出的仓库结论（isRepo:false），后者交给调用方原本的"不是 git 仓库"分支。
const API_SESSION_ERROR_CODES = {
  app_surface_session_expired: 1,
  app_surface_session_invalid: 1,
  app_surface_session_required: 1,
  app_surface_session_revoked: 1,
  app_surface_session_unavailable: 1,
  missing_credential: 1,
  invalid_credential: 1,
  forbidden: 1
};
const API_RUNTIME_ERROR_CODES = {
  APP_RUNTIME_SERVICE_UNAVAILABLE: 1,
  APP_RUNTIME_SERVICE_EXITED: 1,
  APP_UI_NOT_FOUND: 1
};
function apiFailureInfo(data) {
  if (!data || typeof data !== "object") {
    return { kind: "unknown", code: "", detail: "", message: "接口返回了无法识别的内容", hint: "请稍后重试；仍失败就关闭并重新打开本面板" };
  }
  if (data.ok === true) return null;
  // 后端把错误码放在哪个字段不统一：鉴权门槛在 error，托管服务 503 在 code，
  // 缺凭证拒绝在 reason。三个都认。
  const candidates = [String(data.error || ""), String(data.code || ""), String(data.reason || "")];
  const matches = function(table) {
    for (const c of candidates) if (c && table[c]) return true;
    return false;
  };
  const detail = String(data.detail || data.message || "");
  if (matches(API_SESSION_ERROR_CODES)) {
    return { kind: "session", code: candidates.filter(Boolean)[0] || "", detail: detail, message: "面板会话已过期，后端拒绝了这次请求", hint: "刷新按钮无法续签；请关闭本面板再重新打开（或重启 Hana）" };
  }
  if (matches(API_RUNTIME_ERROR_CODES)) {
    return { kind: "runtime", code: candidates.filter(Boolean)[0] || "", detail: detail, message: "应用后端暂时不可用", hint: "稍等几秒后点「重试」" };
  }
  if (data.isRepo === false) return null;   // 服务端明确回答了"不是仓库"
  return { kind: "unknown", code: candidates.filter(Boolean)[0] || "", detail: detail, message: detail || "接口调用失败", hint: "请稍后重试；仍失败就关闭并重新打开本面板" };
}

// 请求层面就失败了（返回不是 JSON、网络断了、被宿主拦掉）：这些 catch 以前是静默的，
// 面板会停在旧画面上。统一报出来，同一条失败 6 秒内只提示一次（toast 会替换上一条，不堆叠）。
var _lastApiFailureNoticeAt = 0;
function notifyApiFailure(err, what, force) {
  var now = Date.now();
  if (!force && now - _lastApiFailureNoticeAt < 6000) return;
  _lastApiFailureNoticeAt = now;
  var msg;
  if (typeof what === "string" && what) msg = what;
  else {
    var e = err || {};
    msg = "Git 面板请求失败：" + (e.message || e.statusText || String(e));
  }
  toast(msg, "err");
}
