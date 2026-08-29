// Git Save/Load Card 前端模块 11/26：ctx-menu.js — 右键菜单定位/关闭助手与全局关闭监听
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// === 菜单打开助手：定位 + 打开动画 ===
function openCtxMenuWithAnim(menu, x, y, fallbackW, fallbackH) {
  if (!menu) return;
  // 先加 opening 类（在 display:block 前设 opacity:0；这样 transition 才能从隐藏状态启动）
  menu.classList.add("hana-menu-opening");
  menu.style.display = "block";
  var w = menu.offsetWidth || fallbackW || 180;
  var h = menu.offsetHeight || fallbackH || 120;
  menu.style.left = Math.min(x, window.innerWidth - w - 6) + "px";
  menu.style.top = Math.min(y, window.innerHeight - h - 6) + "px";
  // 两帧后移除 opening 类，触发到默认状态
  requestAnimationFrame(function() {
    requestAnimationFrame(function() {
      menu.classList.remove("hana-menu-opening");
    });
  });
}
function closeAllCtxMenus() {
  var m = document.getElementById("ctxMenu");
  var gm = document.getElementById("ghCtxMenu");
  var rm = document.getElementById("remoteCtxMenu");
  if (m) m.style.display = "none";
  if (gm) gm.style.display = "none";
  if (rm) rm.style.display = "none";
}
// Esc 关闭菜单 + 下拉
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape" || e.keyCode === 27) {
    closeAllCtxMenus();
    closeAllHanaSelects();
  }
});
// 点击外部关闭 HanaSelect面板（面板是 document.body 的子，原生 select 被隐藏）
document.addEventListener("mousedown", function(e) {
  if (!e.target.closest('.hana-select') && !e.target.closest('.hana-select-panel')) {
    closeAllHanaSelects();
  }
}, true);
