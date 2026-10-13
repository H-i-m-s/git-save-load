// 主卡片：顶部更新提示条 + 「查看更新」浮层。
//
// 这是本卡片上唯一一个 ES 模块（除了 hana-bridge.js）——它要复用的两样东西都是 ESM：
//   · ../update-notice.mjs  设置页那个浮层（与 doc-intake 同源，逐字可 diff）
//   · ../update-api.mjs     取数层
// 那 26 个编号模块是「原单文件脚本机械切分」的产物，本文件不属于那套序列，别去给它编号。
//
// 为什么是「提示条 + 浮层」两件东西，而不是让浮层自己浮起来：
//   installUpdateNotice 默认会在有新版时自动弹窗。主卡片这边要的是「顶部先出一条提示，
//   她点了才看」，所以装它时传 autoShow:false，自动弹的职责交给下面这条提示条。
//   设置页那边不传，行为不变（照旧自动浮）。
//
// 两边的关闭语义仍然各自生效，而且正好对应提示条上的两个动作：
//   「先不看」（提示条那个 ×）→ later：只记在 App 进程内存里，本次会话内不再出现。
//   「我已知晓」（浮层里那个）→ ack：落盘记住这个版本，直到发了下一版才再提。
// 无论走哪条，服务端下一份快照里 shouldAutoShow 都会变成 false，提示条自己就收起。
//
// 取数走 /settings/update-check（后端与设置页共用同一份 lib/update-check.mjs，不新增逻辑）。
// pluginFetch 是本页 env.js（经典脚本）挂在全局的，模块里读 window 上一份。

import { hana } from "../sdk.js";
import { createUpdateApi } from "../update-api.mjs";
import { installUpdateNotice } from "../update-notice.mjs";

// update-api 那层内部只认相对路径 /update-check（为了跟 doc-intake / magpie-hana /
// token-tracker-app 那几份逐字可 diff），本 App 的端点在 /settings/* 下，前缀在这里补。
// pluginFetch 由本页 env.js（经典脚本，全局作用域声明）挂在 window 上；取不到就明说，
// 不静默变成一个永远拿不到数据的浮层。
const updateApi = createUpdateApi({
  fetchJson: async (path, init) => {
    if (typeof window.pluginFetch !== "function") throw new Error("pluginFetch 不可用（前端模块没加载全）");
    const suffix = String(path || "").replace(/^\/update-check/, "");
    const res = await window.pluginFetch("settings/update-check" + suffix, init);
    return res.json();
  },
});

function el(id) { return document.getElementById(id); }

(async function initUpdateBanner() {
  const banner = el("updateBanner");
  const verEl = el("updateBannerVer");
  const btn = el("updateBannerBtn");
  const x = el("updateBannerX");
  if (!banner || !btn || !x) return;

  let notice = null;
  try {
    notice = installUpdateNotice({ hana, api: updateApi, autoShow: false });
  } catch (error) {
    // 拿不到就安静退场：提示条不是这张卡片的主功能，不该因为一次初始化失败去弹警告。
    return;
  }
  if (!notice) return;

  function hide() { banner.style.display = "none"; }

  function paint(snapshot) {
    const latest = snapshot && snapshot.latest;
    // 只认服务端算出来的判断，界面不自己比版本号。
    if (!snapshot || !snapshot.shouldAutoShow || !latest) { hide(); return; }
    if (verEl) verEl.textContent = "v" + latest.version;
    banner.style.display = "flex";
  }

  // 快照一到就刷。subscribe 会立刻回调一次手里已有的那份（若已拿到）。
  notice.subscribe(paint);

  btn.addEventListener("click", () => {
    // openCached 只读手里那份，一次网络都不出：点下去立刻出浮层。
    // （装了 autoShow:false 之后，浮层的「自动浮」被关掉了，手动打开不受影响。）
    void notice.openCached();
  });

  // 「先不看」：先本地收起（观感上立刻响应），再把这个动作落到服务端内存里，
  // 顺便拿一份新快照回来 —— 它会让别的界面也跟着收起。
  x.addEventListener("click", () => {
    hide();
    const version = (notice.data && notice.data.latest && notice.data.latest.tag) || "";
    Promise.resolve(updateApi.dismissUpdate({ action: "later", version }))
      .then(() => notice.refresh())
      .catch(() => {});
  });

  // 兜底轮询不需要另起：浮层组件自己每 5 分钟 refresh 一次（间隔没到服务端不会真出网），
  // 每次快照都会广播到 paint。这里只负责页面被拆掉时把它的定时器收回。
  window.addEventListener("pagehide", () => {
    try { notice.dispose(); } catch {}
  }, { once: true });
})();
