// tests/cases/08-card-update-banner.mjs
// 覆盖：主卡片（ui/git.html）的「更新提示条 + 查看更新浮层」接线。
//
// 这一块的形态定下来不容易，几处踩过或差点踩到的坑，都在这里钉住：
//   1) 浮层是 ESM（../update-notice.mjs），而主卡片是经典脚本；所以 update-banner.js
//      必须用 type="module" 加载，且排在 hana-bridge.js 之后（要 window.hana 已是真单例）。
//   2) 浮层默认会在有新版时自动浮起来。主卡片要的是「顶部先出提示条，点了才看」，
//      所以必须给 installUpdateNotice 传 autoShow:false，否则一进卡片就砸一个弹窗。
//   3) 浮层的配色指向设置页那套 --gs-*，主卡片没有，必须在 git.css 里、且在 body 上
//      直接覆写 --tt-*（不是补 --gs-*：var() 在声明处就完成替换，补 --gs-* 是无效的）。
//   4) 提示条那四个 id 必须与 update-banner.js 里取的一致，否则条永远不出。
//
// 纯静态检查，不起浏览器：这些接线错了都会在浏览器里表现为「什么都没发生」，
// 而那是靠读代码最不容易看出来的。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { APP_DIR } from "../lib/fixture.mjs";
import { main, check, contains, note } from "../lib/harness.mjs";

const readUi = (...parts) => readFileSync(join(APP_DIR, "ui", ...parts), "utf8");

/** 按 ESM 语法校验一段源码（ui/ 下的模块不在 selfcheck 的扫描面内，这里自己夹一道）。 */
function checkEsm(file, label) {
  try {
    execFileSync(process.execPath, ["--input-type=module", "--check"], {
      input: readFileSync(file),
      stdio: ["pipe", "pipe", "pipe"],
    });
    check(true, label);
  } catch (e) {
    const out = [e.stdout, e.stderr].map((b) => String(b || "")).join("").trim().split("\n").slice(0, 3).join(" | ");
    check(false, label, out);
  }
}

await main("card: 更新提示条与浮层接线", async () => {
  const html = readUi("git.html");
  const css = readUi("assets", "git.css");
  const banner = readUi("assets", "git", "update-banner.js");
  const notice = readUi("assets", "update-notice.mjs");

  // ── 0) 模块能过语法 / 依赖都真的在 ───────────────────────────────────────
  // selfcheck 只扫 entry / routes / tools / lib，ui/ 下的 JS 不在它的扫描面内。
  // 这里出一次语法错，浏览器里的表现是「提示条永远不出现」——最难看出来的那种。
  checkEsm(join(APP_DIR, "ui", "assets", "git", "update-banner.js"), "update-banner.js 过 ESM 语法检查");
  checkEsm(join(APP_DIR, "ui", "assets", "update-notice.mjs"), "update-notice.mjs 过 ESM 语法检查");
  checkEsm(join(APP_DIR, "ui", "assets", "update-api.mjs"), "update-api.mjs 过 ESM 语法检查");
  for (const rel of ["assets/update-notice.mjs", "assets/update-api.mjs", "assets/sdk.js"]) {
    check(existsSync(join(APP_DIR, "ui", rel)), `import 的目标存在：ui/${rel}`);
  }

  // ── 1) 浮层样式与模块的挂载 ──────────────────────────────────────────────
  contains(html, 'href="assets/update-notice.css"', "主卡片引入了浮层样式（与设置页同一份）");
  check(/<script\s+type="module"\s+src="assets\/git\/update-banner\.js"><\/script>/.test(html),
    "update-banner.js 以 type=module 加载（它 import 的都是 ESM）");
  const idxBridge = html.indexOf('<script type="module" src="./assets/hana-bridge.js">');
  const idxBanner = html.indexOf('<script type="module" src="assets/git/update-banner.js">');
  check(idxBridge > -1, "找到 hana-bridge.js 的 script 标签");
  check(idxBanner > -1, "找到 update-banner.js 的 script 标签");
  check(idxBridge > -1 && idxBanner > idxBridge, "update-banner.js 排在 hana-bridge.js 之后（window.hana 已就位）");

  // ── 2) 提示条 DOM 与 id ──────────────────────────────────────────────────
  for (const id of ["updateBanner", "updateBannerVer", "updateBannerBtn", "updateBannerX"]) {
    contains(html, `id="${id}"`, `主卡片有 #${id}`);
    // 取 id 用 el("...")，两边必须逐字对上。
    contains(banner, `el("${id}")`, `update-banner.js 取的就是 #${id}`);
  }
  // 默认不显示：条只在服务端说「有新版且没处理过」时才亮。
  check(/id="updateBanner"[^>]*style="display:none"/.test(html) || /style="display:none"[^>]*id="updateBanner"/.test(html),
    "提示条默认 display:none（不先闪一下再收）");
  // 落在 #panelsArea 里，与工作流程提示条同一块横幅区。
  const areaIdx = html.indexOf('id="panelsArea"');
  check(areaIdx > -1 && html.indexOf('id="updateBanner"') > areaIdx, "提示条在 #panelsArea 内");

  // ── 3) 关闭自动浮，交给提示条 ────────────────────────────────────────────
  contains(banner, "autoShow: false", "主卡片传 autoShow:false（浮层不自己浮，由提示条唤起）");
  contains(notice, "autoShow = true", "installUpdateNotice 的 autoShow 默认 true（设置页行为不变）");
  contains(notice, "if (!autoShow) return;", "autoShow:false 时 scheduleAuto 直接不排自动弹");

  // ── 4) 关闭之后订阅方要立刻知道 ──────────────────────────────────────────
  // markLocal 是「她刚自己做了决定」，不广播的话提示条要等一个轮询周期才收。
  const markLocalStart = notice.indexOf("function markLocal(");
  const markLocalEnd = notice.indexOf("\n  }", markLocalStart);
  check(markLocalStart > -1 && markLocalEnd > markLocalStart, "找到 markLocal 实现");
  const markLocalBody = notice.slice(markLocalStart, markLocalEnd);
  contains(markLocalBody, "listeners", "markLocal 会广播给订阅方（否则点「我已知晓」后提示条赖着不走）");

  // ── 5) 配色：必须直接覆写 --tt-*，且落在 body 上 ─────────────────────────
  // 取出那条声明了 --tt-t1 的 body 规则（不能用 indexOf("body{")：会错抓到 html,body{）。
  const bodyRuleMatch = /body\s*\{[^}]*--tt-t1:[^}]*\}/.exec(css);
  check(!!bodyRuleMatch, "git.css 在 body 上覆写了 --tt-*（浮层取色不落空）");
  const bodyRule = bodyRuleMatch ? bodyRuleMatch[0] : "";
  // 覆写的位置要在 body 上而不是 :root —— .theme-* 挂在 body，写 :root 会被固定成浅色。
  const rootHasTt = /:root\s*\{[^}]*--tt-t1/.test(css);
  check(!rootHasTt, "没有在 :root 上重复声明 --tt-*（那会被固定成浅色，深色主题不跟随）");
  // 逐个确认浮层用到的那批变量有着落。
  for (const v of ["--tt-t1", "--tt-t2", "--tt-t3", "--tt-card", "--tt-bg", "--tt-b1", "--tt-select-fg", "--tt-select-bg", "--tt-red", "--tt-green", "--tt-blue", "--tt-radius-inner"]) {
    contains(bodyRule, v + ":", `body 层覆盖了 ${v}`);
  }

  // ── 6) 取数走现成端点，不另起一套 ────────────────────────────────────────
  contains(banner, "settings/update-check", "取数走 /settings/update-check（复用已有的后端）");
  contains(banner, 'from "../update-api.mjs"', "复用 sett度页那层 update-api（不另起取数逻辑）");
  contains(banner, 'from "../update-notice.mjs"', "复用同一份浮层组件");
  check(!/fetch\(/.test(banner.replace(/pluginFetch|fetchJson/g, "")), "没有绕过 pluginFetch 自己发请求");

  note("提示条 / 浮层的接线已覆盖");
});
