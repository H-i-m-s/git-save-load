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
// 宿主对 iframe 只在主题“真正变化”时推送 hana.theme.changed（刻意跳过第一次发射）；
// 挂载当刻的主题已经写在 iframe URL 里。但宿主重启时渲染进程的 data-theme 可能还是
// 默认值，URL 里带的就是那个默认值——它和上次同步的主题一致时直接采用，不一致时先
// 按住（真正的变更推来会立即覆盖），避免整段启动期闪暖白。
var heldInitial = null;
var fallbackTimer = null;
var firstSnapshotHandled = false;

function commitHostTheme(theme, appearance) {
  if (!theme) return;
  // 先落盘再写属性：MutationObserver 触发时 getHanaTheme() 读到的已是新值
  try {
    localStorage.setItem("git-sl-host-theme", theme);
    if (appearance === "light" || appearance === "dark") {
      localStorage.setItem("git-sl-host-appearance", appearance);
    }
  } catch {}
  document.body.setAttribute("data-hana-theme", theme);
}

function applyHostTheme(snapshot) {
  var theme = snapshot && snapshot.theme;
  if (!theme) return;
  if (!firstSnapshotHandled) {
    firstSnapshotHandled = true;
    var remembered = null;
    try { remembered = localStorage.getItem("git-sl-host-theme"); } catch {}
    if (remembered && remembered !== theme) {
      heldInitial = { theme: theme, appearance: snapshot.appearance };
      if (fallbackTimer) clearTimeout(fallbackTimer);
      // 兜底：真没有变更推来时（很少），不要永远停在旧主题
      fallbackTimer = setTimeout(function () {
        if (!heldInitial) return;
        var held = heldInitial;
        heldInitial = null;
        commitHostTheme(held.theme, held.appearance);
      }, 10000);
      return;
    }
    commitHostTheme(theme, snapshot.appearance);
    return;
  }
  if (heldInitial) {
    if (fallbackTimer) clearTimeout(fallbackTimer);
    heldInitial = null;
  }
  commitHostTheme(theme, snapshot.appearance);
}

// 订阅会先同步回调一次当前快照（即 URL 里的值），视作初始快照；之后的回调是真变更
try {
  hana.theme.subscribe(applyHostTheme);
} catch {}
