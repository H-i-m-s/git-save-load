// Git Save/Load v2 前端桥接模块（ESM，在 26 个经典脚本之后执行）。
// 职责只有三件：
// 1. 挂上 @hana/app-sdk/ui 的 hana 单例（external.open / clipboard.writeText 走 App 级能力授权）；
// 2. 把宿主主题名写进 body 的 data-hana-theme，供原有 getHanaTheme()/applyTheme() 消费；
// 3. 识别 function-panel 挂载位，给 body 打 data-hana-widget=1，复用原 widget 窄面板样式
//    （v1 的 contributes.widget 在 v2 没有对应贡献点，由卡片 functionPanel 接管）。

import { hana } from "./sdk.js";

window.hana = hana;

try { hana.ready(); } catch {}

// --- function-panel → widget 窄面板模式 ---
function syncSurfaceSlot(ctx) {
  if (ctx && ctx.slot === "function-panel") {
    document.body.setAttribute("data-hana-widget", "1");
  }
}
try {
  syncSurfaceSlot(hana.surface.getContext());
  hana.surface.onContextChanged(syncSurfaceSlot);
} catch {}

// --- 宿主主题 → data-hana-theme ---
function applyHostTheme(snapshot) {
  var theme = snapshot && snapshot.theme;
  if (theme) {
    document.body.setAttribute("data-hana-theme", theme);
    // 记住解析后的宿主主题名：下次启动宿主握手完成前，
    // getHanaTheme() 先用这个值上色，避免面板先闪暖白
    try { localStorage.setItem("git-sl-host-theme", theme); } catch {}
  }
}
try {
  applyHostTheme(hana.theme.getSnapshot());
  hana.theme.subscribe(applyHostTheme);
} catch {}
