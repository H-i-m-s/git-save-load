// tests/cases/11-commit-action-layout.mjs
// 覆盖：存档区「版本输入 + 存档 / 推送 / 拉取」三个动作槽的位移计算。
//
// 这一块用一个 --commit-slot-shift 把按钮往左收回空白，让它们在换行判定上仍按
// 最长状态占位、视觉上却紧挨着。踩过的坑：
//   1) 打开「分支列表」时 #mainInterface 被 display:none，整块面积归零。
//      函数照算不误，量到的全是 0，gap 被逐个累加进 shift，
//      写出 [6, 12, 18] 这种无意义位移；卡片回来后没人重算，三个按钮就一直错位。
//   2) 原来用 getBoundingClientRect() 取位置。它给的是屏幕坐标，会被祖先的
//      transform 缩放；而 button.offsetWidth 是布局宽度，不跟着缩。
//      两个坐标系混用，卡片正在做收拢动画（#panelsArea 带 scale(.1)）时就会算错。
//
// 这里把真实函数从源码里抠出来，配一个最小 DOM 桩跑，断言：
//   · 隐藏（offsetWidth 为 0）时一个属性都不写；
//   · 可见时算出的 shift 与线上实测值一致；
//   · 源码里不再用 getBoundingClientRect 取位置。

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APP_DIR } from "../lib/fixture.mjs";
import { main, check, eq, contains, excludes } from "../lib/harness.mjs";

const readUi = (...parts) => readFileSync(join(APP_DIR, "ui", ...parts), "utf8");

/**
 * 从源码里按名字截一个顶层函数（含到配对的 }）。
 * commit-actions.js 是拆分后的脚本片段，没有导出，只能这样取。
 */
function sliceFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到函数 ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 的花括号不配对`);
}

const SRC = readUi("assets", "git", "commit-actions.js");

/** 去掉 // 行注释与 /* *\/ 块注释，只留代码。 */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── 最小 DOM 桩 ─────────────────────────────────────────────────────────────
// 只实现 syncCommitActionLayout 真正用到的那几个 API：
// querySelector / getElementById / getComputedStyle / requestAnimationFrame。
// 不模拟渲染，因为要验的是「读到了什么坐标、写出了什么位移」。
function makeButton(width) {
  return {
    offsetWidth: width,
    cloneNode() {
      return { style: {}, textContent: "", offsetWidth: 0, remove() {} };
    },
  };
}

function makeSlot(id, { left, top, width, btnWidth }) {
  const button = makeButton(btnWidth);
  const writes = {};
  const el = {
    id,
    offsetLeft: left,
    offsetTop: top,
    offsetWidth: width,
    style: {
      setProperty(name, value) {
        writes[name] = value;
      },
      getPropertyValue(name) {
        return writes[name] ?? "";
      },
    },
    querySelector() {
      return button;
    },
  };
  return { el, writes };
}

function makeEnv({ areaWidth }) {
  const input = {
    offsetLeft: 0,
    offsetTop: 0,
    offsetWidth: 140,
    style: { setProperty() {} },
    classList: { contains: () => false },
    querySelector: () => null,
  };

  const s1 = makeSlot("commitActionSlot", { left: 146, top: 0, width: 88, btnWidth: 54 });
  const s2 = makeSlot("pushActionSlot", { left: 240, top: 0, width: 79, btnWidth: 66 });
  const s3 = makeSlot("pullActionSlot", { left: 325, top: 0, width: 79, btnWidth: 66 });

  for (const s of [s1.el, s2.el, s3.el]) {
    s.classList = { contains: (c) => c === "commit-action-slot" };
  }

  const area = {
    offsetLeft: 25,
    offsetWidth: areaWidth,
    offsetHeight: 34,
    children: [input, s1.el, s2.el, s3.el],
    style: { setProperty() {} },
    classList: { contains: () => false },
  };

  const slotsById = { commitActionSlot: s1.el, pushActionSlot: s2.el, pullActionSlot: s3.el };
  let rafCalls = 0;
  let hostResizeCalls = 0;
  let appended = 0;

  const document = {
    querySelector: (sel) => (sel === ".commit-area" ? area : null),
    getElementById: (id) => slotsById[id] ?? null,
    body: { appendChild: () => { appended += 1; } },
  };

  return {
    document,
    getComputedStyle: () => ({ columnGap: "6px" }),
    requestAnimationFrame: (cb) => { rafCalls += 1; cb(); return 0; },
    requestHostResize: () => { hostResizeCalls += 1; },
    stats: () => ({ rafCalls, hostResizeCalls, appended }),
    writes: { s1: s1.writes, s2: s2.writes, s3: s3.writes },
  };
}

/** 把源码里的两个函数装进给定环境跑一次。 */
function runSync(env) {
  const measure = sliceFn(SRC, "measureCommitActionWidth");
  const sync = sliceFn(SRC, "syncCommitActionLayout");
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "document", "getComputedStyle", "requestAnimationFrame", "requestHostResize",
    `var _commitActionLayoutFrame = 0;
     ${measure}
     ${sync}
     syncCommitActionLayout();
     return _commitActionLayoutFrame;`,
  );
  return factory(env.document, env.getComputedStyle, env.requestAnimationFrame, env.requestHostResize);
}

await main("存档区动作槽位移", async () => {
  // 1) 可见时：算出的位移必须与线上实测一致（0 / -34 / -47）
  const visible = makeEnv({ areaWidth: 404 });
  runSync(visible);
  eq(visible.writes.s1["--commit-slot-shift"], "0.00px", "可见：存档槽不位移");
  eq(visible.writes.s2["--commit-slot-shift"], "-34.00px", "可见：推送槽左收 34px");
  eq(visible.writes.s3["--commit-slot-shift"], "-47.00px", "可见：拉取槽左收 47px");
  check(
    Boolean(visible.writes.s1["--commit-slot-width"]),
    "可见：槽宽按最长状态占位",
    `实际 ${visible.writes.s1["--commit-slot-width"]}`,
  );
  check(visible.stats().hostResizeCalls > 0, "可见：算完通知宿主同步高度");

  // 2) 隐藏时：一个属性都不写
  //    这是这次要修的主症状——量不到就别写，别把 0 当坐标算。
  const hidden = makeEnv({ areaWidth: 0 });
  runSync(hidden);
  eq(Object.keys(hidden.writes.s1).length, 0, "隐藏：存档槽没被写");
  eq(Object.keys(hidden.writes.s2).length, 0, "隐藏：推送槽没被写");
  eq(Object.keys(hidden.writes.s3).length, 0, "隐藏：拉取槽没被写");
  eq(hidden.stats().hostResizeCalls, 0, "隐藏：不通知宿主 resize");

  // 3) 隐藏之后再可见：位移能自己回到正确值
  //    这条钉的是「错值写进去以后没有回来」那个后遗症。
  const flaky = makeEnv({ areaWidth: 0 });
  runSync(flaky);
  const reShow = makeEnv({ areaWidth: 404 });
  runSync(reShow);
  eq(reShow.writes.s2["--commit-slot-shift"], "-34.00px", "隐藏→可见：推送槽回到正确位移");
  eq(reShow.writes.s3["--commit-slot-shift"], "-47.00px", "隐藏→可见：拉取槽回到正确位移");

  // 4) 源码层面：那段不能再拿 getBoundingClientRect 当坐标
  //    先去注释再查。这段代码里注释特意写了「不用 getBoundingClientRect」，
  //    直接全文搜会把解释当成违规。
  const syncSrc = stripComments(sliceFn(SRC, "syncCommitActionLayout"));
  excludes(syncSrc, "getBoundingClientRect", "位移计算不再用屏幕坐标");
  excludes(syncSrc, "areaRect", "不再引用区域绝对左边缘");
  contains(syncSrc, "offsetLeft", "改用布局坐标 offsetLeft");
  contains(syncSrc, "offsetTop", "改用布局坐标 offsetTop");
  contains(syncSrc, "if (!area.offsetWidth) return", "隐藏时提前返回");

  // 5) 槽位宽度测量本身没被改动（它一直是对的）
  const measureSrc = stripComments(sliceFn(SRC, "measureCommitActionWidth"));
  contains(measureSrc, "max-content", "探针按内容自然宽度量");
  contains(measureSrc, "-10000px", "探针移出可视区");
});
