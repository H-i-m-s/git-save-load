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
