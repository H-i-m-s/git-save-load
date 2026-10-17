// tests/cases/09-file-list-anim.mjs
// 覆盖：变更文件列表的动效层（ui/assets/git/list-anim.mjs）。
//
// 这一块的形态定下来不容易，几处踩过或差点踩到的坑，都在这里钉住：
//   1) 数字滚轮靠「9..0 竖排的一条带子 + translateY」实现，位移由 digitOffset 算。
//      格高 DIGIT_H 必须与 git.css 里 --digit-h 逐字相等，否则数字停偏。
//   2) 增量渲染的命脉是「同名行复用同一个 li」。只做静态检查抓不到
//      「其实又整块重建了」这种回归——所以这里配一个最小 DOM 桩，
//      真跑 renderFileList，比节点引用。
//   3) 首屏与换仓库后的第一帧不做入场动画（否则整列一起展开像放烟花）。
//   4) 位数变化（+9 → +10）不走逐位复用，整组重建。
//
// 三部分：纯函数断言 + DOM 行为（节点复用/增删）+ 静态接线。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { APP_DIR } from "../lib/fixture.mjs";
import { main, check, eq, deepEq, contains, excludes, matches, note } from "../lib/harness.mjs";

const readUi = (...parts) => readFileSync(join(APP_DIR, "ui", ...parts), "utf8");

/** 按 ESM 语法校验一段源码（ui/ 下的模块不在 selfcheck 的扫描面内）。 */
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

// ── 最小 DOM 桩 ─────────────────────────────────────────────────────────────
// 只实现 list-anim.mjs 真正用到的那部分 API。不做完整 DOM 模拟：
// 这里要验的是「哪些节点被复用、哪些被新建、哪些被摘掉」，
// 而不是渲染。getBoundingClientRect 一律返回 0 高度，于是收展动画退化为即时的
// 摘除/保留——node 的去留仍是模块真实代码路径决定的，所以断言依然成立。

function attrValue(node, name) {
  if (name.startsWith("data-")) {
    const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return node.dataset[key];
  }
  return (node.attributes || {})[name];
}

function matchSimple(node, part) {
  let rest = String(part || "");
  const nots = [];
  rest = rest.replace(/:not\(([^)]*)\)/g, (_, inner) => { nots.push(inner); return ""; });
  const attrs = [];
  rest = rest.replace(/\[([^\]]+)\]/g, (_, inner) => { attrs.push(inner); return ""; });
  const classes = [];
  rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, (_, c) => { classes.push(c); return ""; });
  const tag = rest.trim();

  if (tag && String(node.tagName || "").toLowerCase() !== tag.toLowerCase()) return false;
  for (const c of classes) if (!node.classList.contains(c)) return false;
  for (const a of attrs) {
    const eqIdx = a.indexOf("=");
    if (eqIdx < 0) {
      if (attrValue(node, a) === undefined) return false;
    } else {
      const name = a.slice(0, eqIdx);
      const want = a.slice(eqIdx + 1).replace(/^["']|["']$/g, "");
      if (String(attrValue(node, name)) !== want) return false;
    }
  }
  for (const n of nots) if (matchSimple(node, n)) return false;
  return true;
}

function descendants(root, out = []) {
  for (const child of root.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

function querySelector(root, selector) {
  const parts = String(selector).trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const chain = parts.slice(0, -1);
  for (const node of descendants(root)) {
    if (!matchSimple(node, last)) continue;
    if (chain.length) {
      // 从该节点的祖先往上，倒序匹配前面的选择器段，全中才算命中。
      let idx = chain.length - 1;
      let p = node.parentNode;
      while (p && idx >= 0) {
        if (matchSimple(p, chain[idx])) idx -= 1;
        p = p.parentNode;
      }
      if (idx >= 0) continue;
    }
    return node;
  }
  return null;
}

function makeClassList(node) {
  const list = {
    _set: new Set(),
    add(c) { this._set.add(c); node._className = [...this._set].join(" "); },
    remove(c) { this._set.delete(c); node._className = [...this._set].join(" "); },
    contains(c) { return this._set.has(c); },
  };
  return list;
}

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    parentNode: null,
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    _className: "",
    _text: "",
    offsetHeight: 0,
    listeners: {},
    get className() { return this._className; },
    set className(v) {
      this._className = String(v);
      this.classList._set = new Set(this._className.split(/\s+/).filter(Boolean));
    },
    get classList() { return this._classList; },
    _classList: null,
    get textContent() {
      if (!this.children.length) return this._text;
      return this._text + this.children.map((c) => c.textContent).join("");
    },
    set textContent(v) {
      this.children = [];
      this._text = v === null || v === undefined ? "" : String(v);
    },
    get firstChild() { return this.children[0] || null; },
    get nextSibling() {
      if (!this.parentNode) return null;
      const i = this.parentNode.children.indexOf(this);
      return i < 0 ? null : (this.parentNode.children[i + 1] || null);
    },
    get firstElementChild() {
      return this.children.find((c) => c.tagName) || null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.children = child.parentNode.children.filter((c) => c !== child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    append(...nodes) { for (const n of nodes) this.appendChild(n); },
    insertBefore(newNode, ref) {
      const i = ref ? this.children.indexOf(ref) : -1;
      if (newNode.parentNode) newNode.parentNode.children = newNode.parentNode.children.filter((c) => c !== newNode);
      newNode.parentNode = this;
      if (i < 0) this.children.push(newNode);
      else this.children.splice(i, 0, newNode);
      return newNode;
    },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      if (this.listeners[type]) this.listeners[type] = this.listeners[type].filter((f) => f !== fn);
    },
    querySelector(sel) { return querySelector(this, sel); },
    getBoundingClientRect() { return { height: 0, width: 0, top: 0, left: 0 }; },
    get offsetWidth() { return 0; },
  };
  node._classList = makeClassList(node);
  return node;
}

function installDom() {
  const documentStub = {
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => {
      const t = makeNode("#text");
      t._text = String(text);
      return t;
    },
  };
  const windowStub = {
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn) => globalThis.setTimeout(fn, 0),
    addEventListener: () => {},
  };
  globalThis.document = documentStub;
  globalThis.window = windowStub;
  return documentStub;
}

installDom();

const MOD = await import("../../ui/assets/git/list-anim.mjs");
const { diffFileItems, statParts, digitOffset, renderFileList, DIGIT_H } = MOD;

const row = (key, over = {}) => Object.assign(
  { key, name: key, label: "🟠 已修改", cls: "M", added: 1, deleted: 0, conflict: false },
  over,
);

await main("card: 变更列表动效层（数字滚轮 + 增量渲染）", async () => {
  const html = readUi("git.html");
  const css = readUi("assets", "git.css");
  const statusCard = readUi("assets", "git", "status-card.js");
  const anim = readUi("assets", "git", "list-anim.mjs");

  // ── 0) 模块能过语法 / 依赖都在 ───────────────────────────────────────────
  checkEsm(join(APP_DIR, "ui", "assets", "git", "list-anim.mjs"), "list-anim.mjs 过 ESM 语法检查");
  check(existsSync(join(APP_DIR, "ui", "assets", "git", "list-anim.mjs")), "list-anim.mjs 存在");

  // ── 1) 纯函数：增删统计 ──────────────────────────────────────────────────
  deepEq(statParts({ added: 3, deleted: 5 }), { show: true, add: 3, del: 5 }, "statParts：有增删就显示");
  eq(statParts({ added: 0, deleted: 0 }).show, false, "statParts：+0/-0 不显示（未跟踪文件）");
  eq(statParts({}).show, false, "statParts：没有统计字段也不显示");
  eq(statParts(null).show, false, "statParts：null 不炸");
  eq(statParts({ added: "12" }).add, 12, "statParts：字符串数字也认");

  // ── 2) 纯函数：列表比对（增量决策本身） ──────────────────────────────────
  const a = [row("a.js"), row("b.js")];
  deepEq(diffFileItems(a, a), { added: [], removed: [], kept: ["a.js", "b.js"] }, "diffFileItems：完全相同 → 全保留");
  deepEq(
    diffFileItems(a, [row("a.js"), row("b.js"), row("c.js")]),
    { added: ["c.js"], removed: [], kept: ["a.js", "b.js"] },
    "diffFileItems：多一个文件 → 只新增它",
  );
  deepEq(
    diffFileItems(a, [row("b.js")]),
    { added: [], removed: ["a.js"], kept: ["b.js"] },
    "diffFileItems：少一个文件 → 只移除它",
  );
  deepEq(
    diffFileItems([row("a.js", { added: 60 })], [row("a.js", { added: 90 })]),
    { added: [], removed: [], kept: ["a.js"] },
    "diffFileItems：同一文件行数 60→90 → 既不新增也不移除（而是复用后滚动）",
  );
  deepEq(diffFileItems([], a), { added: ["a.js", "b.js"], removed: [], kept: [] }, "diffFileItems：从空到有 → 全新增");
  deepEq(diffFileItems(a, []), { added: [], removed: ["a.js", "b.js"], kept: [] }, "diffFileItems：从有到空 → 全移除");

  // ── 3) 纯函数：数字刻度位移 ──────────────────────────────────────────────
  eq(digitOffset(9), 0, "digitOffset：9 在最上，位移 0");
  eq(digitOffset(0), -9 * DIGIT_H, "digitOffset：0 在最下，位移 -9 格");
  eq(digitOffset(6) - digitOffset(9), -3 * DIGIT_H, "digitOffset：9→6 是向下 3 格（数字变小往下走）");
  eq(digitOffset(3) - digitOffset(0), 3 * DIGIT_H, "digitOffset：0→3 是向上 3 格");
  check(digitOffset(9) > digitOffset(8) && digitOffset(8) > digitOffset(7), "digitOffset：数字越大位移越大（越靠上）");

  // ── 4) DOM 行为：同名行复用同一个节点 ────────────────────────────────────
  // 这是本次改动的命脉。若哪天被改回「整块 innerHTML 重建」，这里立刻红。
  const fl = globalThis.document.createElement("ul");
  fl.dataset.animPath = "";

  const first = [row("a.js", { added: 60 }), row("b.js", { added: 5 })];
  renderFileList(fl, first, { path: "/repo" });
  eq(fl.children.length, 2, "首帧渲染出 2 行");
  const liA = fl.children.find((c) => c.dataset.file === "a.js");
  const liB = fl.children.find((c) => c.dataset.file === "b.js");
  check(!!liA && !!liB, "首帧两个文件名各自成行");
  eq(
    liA.querySelector(".stat-add .digits").dataset.digits, "60",
    "首帧 a.js 的 + 数字是 60",
  );
  eq(fl.dataset.animPrimed, "1", "首帧渲染后置 animPrimed（下一帧才开始做动画）");

  // 第二帧：a.js 的 + 从 60 变 90，b.js 不变。
  renderFileList(fl, [row("a.js", { added: 90 }), row("b.js", { added: 5 })], { path: "/repo" });
  eq(fl.children.length, 2, "数字变化后仍是 2 行");
  check(fl.children.find((c) => c.dataset.file === "a.js") === liA,
    "a.js 的 li 是同一个节点（复用，不是重建）—— 数字滚动才挂得上");
  check(fl.children.find((c) => c.dataset.file === "b.js") === liB, "b.js 的 li 也是同一个节点");
  eq(liA.querySelector(".stat-add .digits").dataset.digits, "90", "a.js 的 + 已更新为 90");
  eq(liB.querySelector(".stat-add .digits").dataset.digits, "5", "b.js 未变，数字保持 5");

  // ── 5) DOM 行为：新增行、离场行 ──────────────────────────────────────────
  renderFileList(fl, [row("a.js", { added: 90 }), row("b.js", { added: 5 }), row("c.js", { added: 2 })], { path: "/repo" });
  eq(fl.children.length, 3, "多一个文件后是 3 行");
  const liC = fl.children.find((c) => c.dataset.file === "c.js");
  check(!!liC, "新增的 c.js 有了自己的行");
  check(fl.children.find((c) => c.dataset.file === "a.js") === liA, "新增他人不影响 a.js 的节点身份");

  renderFileList(fl, [row("a.js", { added: 90 }), row("c.js", { added: 2 })], { path: "/repo" });
  eq(fl.children.length, 2, "少一个文件后是 2 行");
  check(!fl.children.find((c) => c.dataset.file === "b.js"), "离场的 b.js 已被摘掉");
  check(fl.children.find((c) => c.dataset.file === "a.js") === liA, "b.js 离场不影响 a.js 的节点身份");

  // ── 6) DOM 行为：统计从有到无（数字格隐藏） ──────────────────────────────
  renderFileList(fl, [row("a.js", { added: 0, deleted: 0 }), row("c.js", { added: 2 })], { path: "/repo" });
  const cellA = liA.querySelector(".stat-cell");
  eq(cellA.style.display, "none", "增删都归零时统计格隐藏");

  // ── 7) DOM 行为：状态变化不重建节点（?? → M 是同一行的内容变了） ───────────
  renderFileList(fl, [row("a.js", { label: "⚪ 新文件", cls: "UNTRACKED", added: 0, deleted: 0 }), row("c.js", { added: 2 })], { path: "/repo" });
  check(fl.children.find((c) => c.dataset.file === "a.js") === liA, "状态从 ?? 变 M 仍是同一节点（不重放入场动画）");
  eq(liA.querySelector(".file-status").textContent, "⚪ 新文件", "状态标签文字已更新");

  // ── 8) DOM 行为：换仓库 → 整体重置，且新节点 ─────────────────────────────
  renderFileList(fl, [row("x.js")], { path: "/other-repo" });
  eq(fl.children.length, 1, "换仓库后只剩新仓库的 1 行");
  check(!!fl.children.find((c) => c.dataset.file === "x.js"), "新仓库的行已渲染");
  check(!fl.children.find((c) => c.dataset.file === "a.js"), "旧仓库的行没有残留");

  // ── 9) DOM 行为：清空列表 → 空态提示 ─────────────────────────────────────
  // 空态提示是等离场动画跑完（OUT_MS + 60）之后才出现的，所以这里得等一拍再断言。
  renderFileList(fl, [], { path: "/other-repo" });
  await new Promise((r) => globalThis.setTimeout(r, 30));
  check(fl.children.some((c) => c.classList.contains("empty-hint")), "列表清空后给出空态提示");

  // ── 10) 静态接线：页面与样式 ────────────────────────────────────────────
  const idxAnim = html.indexOf('<script type="module" src="assets/git/list-anim.mjs"></script>');
  check(idxAnim > -1, "git.html 以 type=module 加载 list-anim.mjs");
  const idxMain = html.indexOf('<script src="assets/git/main.js"></script>');
  check(idxMain > -1 && idxAnim > idxMain, "list-anim.mjs 排在 main.js 之后（首帧渲染前就位）");

  // 格高不变量：DIGIT_H 必须等于 CSS 的 --digit-h。
  const cssDigit = /\.file-list\s*\{[^}]*--digit-h:\s*(\d+)px/.exec(css);
  check(!!cssDigit, "git.css 在 .file-list 上定义了 --digit-h");
  eq(Number(cssDigit ? cssDigit[1] : NaN), DIGIT_H, `git.css 的 --digit-h 与 list-anim.mjs 的 DIGIT_H 相等（${DIGIT_H}px）`);

  // 数字带子：9..0 竖排 + 依赖 translateY 位移 + 溢出裁切。
  contains(css, ".digit-strip", "git.css 有 .digit-strip（带子）");
  matches(css, /\.digits\{[^}]*overflow:hidden/, ".digits 裁切溢出（只露出当前刻度）");
  matches(css, /\.digit-g\{[^}]*height:var\(--digit-h\)/, ".digit-g 一格高 = --digit-h");
  contains(anim, "for (let d = 9; d >= 0; d--)", "带子按 9..0 自上而下排（数字变大往下走，与「向下滚出 +90」一致）");
  contains(anim, "translateY(", "刻度靠 translateY 定位");
  contains(anim, "digits-pop", "位数变化时整组重建 + pop（逐位复用会错位）");
  contains(css, "@keyframes digitsPop", "git.css 有 digitsPop 关键帧");
  matches(css, /\.digits-pop\{animation/, ".digits-pop 真的挂了动画");

  // 文件名必须能自己收窄并省略：少了 overflow:hidden，flex 会把盒子压窄，
  // 文件名：可折行，最多两行，超出在第二行末省略。
  // 三条不变量都不能少：少了 overflow:hidden 文字会画出盒子外压住统计；
  // 少了 -webkit-line-clamp 就回到无限折行把行高撑爆；
  // 写回 white-space:nowrap 会直接让 clamp 只有一行（这条坑过一次）。
  // 判定看 .file-name 规则块里那几条同时在场，不是全文件里搜关键词。
  const cssFileName = /\.file-list li>\.file-name\{([^}]*)\}/.exec(css);
  check(!!cssFileName, "git.css 有 .file-list li>.file-name 规则");
  const nameRule = cssFileName ? cssFileName[1] : "";
  matches(nameRule, /overflow:hidden/, ".file-name 裁切溢出（否则长路径压到统计数字上）");
  matches(nameRule, /flex:1/, ".file-name 吃掉中间剩余宽度");
  matches(nameRule, /-webkit-line-clamp:\s*2/, ".file-name 限两行（-webkit-line-clamp:2）");
  matches(nameRule, /display:-webkit-box/, ".file-name 用 -webkit-box（line-clamp 生效的前提）");
  matches(nameRule, /white-space:normal/, ".file-name 允许折行（写 nowrap 会让 clamp 只剩一行）");
  matches(nameRule, /overflow-wrap:anywhere/, ".file-name 无分隔长串也能断（中文没有空格断点）");
  matches(nameRule, /cursor:pointer/, ".file-name 保留可点提示（原本写在内联 style 里）");

  // 徽标与统计格都跟整行垂直居中，而不是贴第一行。
  // 行是 align-items:baseline；两行名时徽标会悬在上半，得单独推翻：
  // 少了这条 align-self，徽标就跑回第一行，与右侧数字脱节。
  const cssBadge = /\.file-list li>\.file-status\{([^}]*)\}/.exec(css);
  check(!!cssBadge, "git.css 有 .file-list li>.file-status 规则");
  matches(cssBadge ? cssBadge[1] : "", /align-self:center/, "状态徽标按整行垂直居中（不贴第一行）");
  const cssStat = /\.stat-cell\{([^}]*)\}/.exec(css);
  matches(cssStat ? cssStat[1] : "", /align-self:center/, "统计格也垂直居中（与徽标同一规则）");
  // 冲突行的「解决」按钮同理：不居中时在两行名的行里会贴第一行。
  const cssConflict = /\.conflict-btn\{([^}]*)\}/.exec(css);
  matches(cssConflict ? cssConflict[1] : "", /align-self:center/, "冲突按钮也垂直居中（整行三条纵轴一致）");
  // 降级路径也必须用同一个类，不能自己再写一套内联排版：
  // 内联 display:flex 会盖掉 -webkit-box，降级时就变回单行。
  contains(statusCard, 'class="file-name"', "降级路径的建行也用 .file-name 类（排版同源）");
  excludes(statusCard, "overflow:hidden;text-overflow:ellipsis;white-space:nowrap", "降级路径不再自拼一套内联排版");
  // 冲突按钮同理：内联样式写着 margin-left:auto，会把 .conflict-btn 的 align-self:center 盖掉。
  // 两条路径都只用类，纵向对齐才不会一边一半。
  contains(statusCard, 'class="conflict-btn"', "降级路径的冲突按钮也用 .conflict-btn 类");
  excludes(statusCard, "border:1px solid #e74c3c", "降级路径不再自拼冲突按钮的内联样式");

  // 收展动画：height + padding + margin 一起过渡（只动 height 会在首尾各跳一下）。
  contains(anim, "MORPH_PROPS", "收展动画用一组属性（不止 height）");
  for (const p of ["padding-top", "padding-bottom", "margin-top", "margin-bottom", "opacity"]) {
    contains(anim, p, `收展动画带上 ${p}（否则动画首尾会跳）`);
  }

  // 减弱动效：模块与 CSS 两层各管一道。
  contains(anim, "prefers-reduced-motion", "模块自己识别「减弱动效」");
  matches(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, "git.css 也有 reduce 分支");
  contains(css, ".digit-strip{transition:none!important}", "reduce 时数字不再滚动");

  // ── 11) 静态接线：status-card.js 的行为 ─────────────────────────────────
  contains(statusCard, "window.FileListAnim", "status-card.js 从 window.FileListAnim 取动效层");
  contains(statusCard, "anim.renderFileList(fl, items, { path: data.path })", "走到了增量渲染，并把 path 传进去（换仓库识别为重置）");
  contains(statusCard, "renderFileListFallback", "留了降级路径（动效层没就位时不把列表空着）");
  contains(statusCard, "resetFileListEl", "非增量语境（不是仓库 / 接口被拒）走 resetFileList，一并清基线");
  // 降级路径必须是「正常情况用不到」的，不能变成默认路径。
  matches(statusCard, /if\s*\(anim && typeof anim\.renderFileList === "function"\)/, "先试动效层，取不到才降级");
  // 标签/类名的转换逻辑只应有一份，两条路径共用。
  contains(statusCard, "function describeFileStatus", "状态标签转换抽成了单一函数（两条路径共用）");
  eq((statusCard.match(/function describeFileStatus/g) || []).length, 1, "describeFileStatus 只定义一次");

  // 换仓库时的乐观 UI 也要清基线，否则新仓库的行会被当成「一直都在」。
  const ghRepos = readUi("assets", "git", "gh-repos.js");
  contains(ghRepos, "resetFileList", "切换仓库的乐观 UI 走 resetFileList（清掉动画基线）");

  // 动效层的 API 出口：经典脚本靠它取用。
  contains(anim, "window.FileListAnim", "list-anim.mjs 把 API 挂到 window.FileListAnim");
  for (const fn of ["renderFileList", "resetFileList", "diffFileItems", "statParts", "digitOffset"]) {
    contains(anim, fn, `出口里有 ${fn}`);
  }

  note("数字滚轮 / 增量渲染 / 节点复用 / 收展动画 / 减弱动效 已覆盖");
});
