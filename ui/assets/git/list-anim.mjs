// ui/assets/git/list-anim.mjs — 变更文件列表的「动效层」。
//
// 解决的问题：原来 renderStatus() 每次都 fl.innerHTML = "" 整块重建，
// 屏幕上的 li 每一帧都是全新节点，和上一帧没有血缘关系——滚动与推挤这类
// 「从旧状态过渡到新状态」的动画根本无处可挂。这里改成按文件名 keyed 的增量更新：
// 同名行复用同一个 li，只改里面的内容；新行展开入场，旧行收起离场。
//
// 顺带修掉一个一直存在的毛病：自动轮询（默认 5s）只要检测到变更就整块重画，
// 视觉上闪一下，而且会把用户正展开着的 diff 一起冲掉。增量更新后两者都不会发生。
//
// 为什么是 ESM：它要导出纯函数给测试直接 import（tests/cases/09-file-list-anim.mjs）。
// 主卡片那 26 个是经典脚本、不能 import，所以末尾把 API 挂到 window 上，
// status-card.js（经典脚本）运行时取用。取不到时那边有降级路径，不静默兜底。
//
// 三处刻意不做的事，都是坑：
//   1) 位数变化（+9 → +10）不做逐位复用，整组重建 + 一次 pop。
//      位数变化极罕见，而复用错位会让「个位忽然变成十位」这种错误看起来像数据错了。
//   2) 首屏、以及切换仓库后的第一帧，不做入场动画。否则一进卡片整列一起展开像放烟花，
//      把「这里有变化」这个信号稀释掉了。
//   3) 不用 FLIP 去补位移。行是普通流元素，插入/塌陷会由浏览器连续推动下方内容，
//      自己再算一遍位移只会跟它打架。

/** 每个数字格的高度（px）。必须与 git.css 里 --digit-h / .digit-g 的 14px 相等。 */
export const DIGIT_H = 14;

/** 入场 / 离场时长（ms）。与 git.css 里写的动画时间保持一致。 */
export const IN_MS = 300;
export const OUT_MS = 260;

/** 数字 d 对应的带子位移。带子自上而下排成 9,8,…,0，所以数字越大越靠上。 */
export function digitOffset(d) {
  return (Number(d) - 9) * DIGIT_H;
}

/** 是否要求减弱动效。 */
function prefersReduced() {
  try {
    return typeof window !== "undefined" && !!window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ── 纯逻辑（无 DOM；测试直接覆盖这一层，渲染路径调用的也正是这几个） ──────────

/**
 * 取一条变更记录的增删统计。
 * @returns {{show:boolean, add:number, del:number}} show=false 时不该渲染统计格
 */
export function statParts(item) {
  const add = Number(item && item.added) || 0;
  const del = Number(item && item.deleted) || 0;
  // 与改动前一致：+0/-0 不显示这一格（未跟踪文件就是这种）。
  const show = !!(item && (item.added || item.deleted));
  return { show, add, del };
}

/**
 * 按 key（文件名）比对新旧两版列表。
 * 这是增量渲染的决策函数本身，不是给测试看的等价副本：
 * 返回的 added 决定「哪些行要新建并放入场动画」，
 * removed 决定「哪些行要塌陷离场」，kept 决定「哪些行复用节点」。
 * @param {Array<{key:string}>} prev
 * @param {Array<{key:string}>} next
 * @returns {{added:string[], removed:string[], kept:string[]}}
 */
export function diffFileItems(prev, next) {
  const p = Array.isArray(prev) ? prev : [];
  const n = Array.isArray(next) ? next : [];
  const prevKeys = new Set(p.map((i) => i && i.key).filter((k) => k !== undefined));
  const nextKeys = new Set(n.map((i) => i && i.key).filter((k) => k !== undefined));

  const added = [];
  const removed = [];
  const kept = [];
  for (const item of n) {
    if (!item) continue;
    if (prevKeys.has(item.key)) kept.push(item.key);
    else added.push(item.key);
  }
  for (const item of p) {
    if (item && !nextKeys.has(item.key)) removed.push(item.key);
  }
  return { added, removed, kept };
}

// ── DOM 胶水 ────────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 一个数字格：内含 9…0 竖排的一条带子，靠 translateY 停在目标刻度。 */
function makeDigit(ch) {
  const slot = el("span", "digit");
  const strip = el("span", "digit-strip");
  for (let d = 9; d >= 0; d--) strip.appendChild(el("span", "digit-g", String(d)));
  slot.appendChild(strip);
  setDigit(slot, ch, false);
  return slot;
}

/** 把某个数字格放到新刻度。animate=false 时瞬移（首屏 / 新增行 / 位数重建）。 */
function setDigit(slot, ch, animate) {
  const strip = slot.firstElementChild;
  if (!strip) return;
  const num = Number(ch) || 0;
  if (slot.dataset.d === String(num)) return;
  const first = slot.dataset.d === undefined;
  slot.dataset.d = String(num);
  const y = digitOffset(num);
  if (!animate || first) {
    strip.style.transition = "none";
    strip.style.transform = "translateY(" + y + "px)";
    void strip.offsetWidth;          // 让「无过渡」这一帧落地，再交还给 CSS
    strip.style.transition = "";
    return;
  }
  strip.style.transform = "translateY(" + y + "px)";
}

/** 更新一组数字（.digits 容器）。位数不变时逐位滚；位数变了整组重建 + pop。 */
function setNumber(box, value, animate) {
  if (!box) return;
  const str = String(Number(value) || 0);
  if (box.dataset.digits === str) return;
  const hadPrev = box.dataset.digits !== undefined;
  box.dataset.digits = str;

  if (box.children.length !== str.length) {
    box.textContent = "";
    for (const ch of str) box.appendChild(makeDigit(ch));
    if (animate && hadPrev) {
      box.classList.remove("digits-pop");
      void box.offsetWidth;
      box.classList.add("digits-pop");
    }
    return;
  }
  for (let i = 0; i < str.length; i++) setDigit(box.children[i], str[i], animate);
}

function makeStatCell() {
  const cell = el("span", "stat-cell");
  const add = el("span", "stat-grp stat-add", "+");
  add.appendChild(el("span", "digits"));
  const del = el("span", "stat-grp stat-del", "-");
  del.appendChild(el("span", "digits"));
  cell.append(add, el("span", "stat-sep", "/"), del);
  return cell;
}

function makeConflictButton(name) {
  const b = el("button", "conflict-btn", "解决");
  b.onclick = function () {
    if (typeof resolveConflict === "function") resolveConflict(name);
  };
  return b;
}

function bindName(nameEl, item) {
  nameEl.title = "点击查看 diff";
  nameEl.onclick = function () {
    if (typeof toggleDiff === "function") toggleDiff(item.name, this);
  };
}

/** 把统计写进（或隐藏）某一行的统计格。 */
function writeStat(cell, item, animate) {
  const p = statParts(item);
  cell.style.display = p.show ? "" : "none";
  if (!p.show) return;
  setNumber(cell.querySelector(".stat-add .digits"), p.add, animate);
  setNumber(cell.querySelector(".stat-del .digits"), p.del, animate);
}

function buildRow(item) {
  const li = el("li");
  li.dataset.file = item.key;

  const badge = el("span", "file-status " + item.cls, item.label);
  const name = el("span", "file-name", item.name);
  bindName(name, item);
  li.append(badge, name);

  const cell = makeStatCell();
  li.appendChild(cell);
  writeStat(cell, item, false);

  if (item.conflict) li.appendChild(makeConflictButton(item.name));
  return li;
}

function updateRow(li, item, animate) {
  const badge = li.querySelector(".file-status");
  if (badge) {
    const cls = "file-status " + item.cls;
    if (badge.className !== cls) badge.className = cls;
    if (badge.textContent !== item.label) badge.textContent = item.label;
  }
  const nameEl = li.querySelector(".file-name");
  if (nameEl) {
    if (nameEl.textContent !== item.name) nameEl.textContent = item.name;
    bindName(nameEl, item);
  }
  const cell = li.querySelector(".stat-cell");
  if (cell) writeStat(cell, item, animate);

  const btn = li.querySelector(".conflict-btn");
  if (item.conflict && !btn) li.appendChild(makeConflictButton(item.name));
  else if (!item.conflict && btn) btn.remove();
}

/** 收集当前列表里的行，并把紧跟在某行后面的 diff 展开容器挂到该行名下。 */
function collectEntries(fl) {
  const out = [];
  let last = null;
  for (const child of Array.from(fl.children)) {
    if (child.tagName === "LI" && child.dataset && child.dataset.file && child.dataset.leaving !== "1") {
      last = { key: child.dataset.file, li: child, extras: [] };
      out.push(last);
    } else if (child.classList && child.classList.contains("diff-inline") && last) {
      last.extras.push(child);
    }
  }
  return out;
}

// 收展动画要把 padding / margin 一起带上：只动 height 的话，
// 行本身那 3px 上下内边距（以及 diff 容器那 4px 外边距）会在动画首尾各跳一下。
const MORPH_PROPS = ["height", "padding-top", "padding-bottom", "margin-top", "margin-bottom", "opacity"];

function morphTransition(ms, easing) {
  return MORPH_PROPS.map((p) => p + " " + ms + "ms " + easing).join(", ");
}

function clearMorph(node) {
  node.style.transition = "";
  node.style.height = "";
  node.style.overflow = "";
  node.style.boxSizing = "";
  node.style.opacity = "";
  node.style.paddingTop = "";
  node.style.paddingBottom = "";
  node.style.marginTop = "";
  node.style.marginBottom = "";
}

/** 收成 0 后再摘掉节点。padding/margin 同步归零，避免末尾残留一条边。 */
function collapse(node, ms) {
  const h = node.getBoundingClientRect().height;
  if (!h) { node.remove(); return; }
  node.style.boxSizing = "border-box";
  node.style.overflow = "hidden";
  node.style.height = h + "px";
  void node.offsetHeight;                      // 提交起始值，动画才有起点
  node.style.transition = morphTransition(ms, "cubic-bezier(.4,0,.2,1)");
  node.style.height = "0px";
  node.style.paddingTop = "0px";
  node.style.paddingBottom = "0px";
  node.style.marginTop = "0px";
  node.style.marginBottom = "0px";
  node.style.opacity = "0";

  let ended = false;
  const onEnd = () => {
    if (ended) return;
    ended = true;
    node.removeEventListener("transitionend", onEnd);
    node.remove();
  };
  node.addEventListener("transitionend", onEnd);
  window.setTimeout(onEnd, ms + 140);
}

/** 从 0 展开到自然高度，下方各行被真实布局连续推下去。 */
function expandIn(node, ms) {
  const h = node.getBoundingClientRect().height;
  if (!h) return;
  node.style.boxSizing = "border-box";
  node.style.overflow = "hidden";
  node.style.height = "0px";
  node.style.paddingTop = "0px";
  node.style.paddingBottom = "0px";
  node.style.marginTop = "0px";
  node.style.marginBottom = "0px";
  node.style.opacity = "0";
  void node.offsetHeight;
  node.style.transition = morphTransition(ms, "cubic-bezier(.22,.61,.36,1)");
  node.style.height = h + "px";
  // 置空即回到 CSS 里的自然值（padding 3px、margin 0、opacity 1），由过渡补间到它。
  node.style.paddingTop = "";
  node.style.paddingBottom = "";
  node.style.marginTop = "";
  node.style.marginBottom = "";
  node.style.opacity = "";

  let ended = false;
  const onEnd = () => {
    if (ended) return;
    ended = true;
    node.removeEventListener("transitionend", onEnd);
    clearMorph(node);
  };
  node.addEventListener("transitionend", onEnd);
  window.setTimeout(onEnd, ms + 140);
}

function showEmptyHint(fl) {
  fl.textContent = "";
  const li = el("li", "empty-hint");
  li.appendChild(document.createTextNode("工作区干净 ✅"));
  li.appendChild(document.createElement("br"));
  const tip = el("span", "", "💡 可以点「存档」提交，或从「拉取」获取最新版本");
  tip.style.fontSize = "11px";
  tip.style.color = "var(--hana-fg-muted,#9ca3af)";
  li.appendChild(tip);
  fl.appendChild(li);
}

/**
 * 增量渲染变更列表。
 * @param {HTMLElement} fl   #fileList
 * @param {Array} items      行模型：{key,name,label,cls,added,deleted,conflict}
 * @param {{path?:string, animate?:boolean}} [options]
 *   path 用来识别「换了仓库」——变了就整体重置、且这一帧不做入场动画。
 */
export function renderFileList(fl, items, options) {
  if (!fl || typeof fl.appendChild !== "function") return;
  const opts = options || {};
  const list = Array.isArray(items) ? items : [];
  const animate = opts.animate !== false && !prefersReduced();
  const path = opts.path == null ? "" : String(opts.path);

  // 换了仓库（或这是本页面第一次渲染）：清空、重置基线，这一帧不做动画。
  if (fl.dataset.animPath !== path) {
    fl.dataset.animPath = path;
    fl.dataset.animPrimed = "";
    fl.textContent = "";
  }
  const primed = fl.dataset.animPrimed === "1";

  if (!list.length) {
    const rows = collectEntries(fl);
    if (rows.length && primed && animate) {
      for (const e of rows) {
        e.li.dataset.leaving = "1";
        collapse(e.li, OUT_MS);
        for (const x of e.extras) collapse(x, OUT_MS);
      }
      window.setTimeout(() => {
        if (!fl.querySelector('li[data-file]:not([data-leaving="1"])')) showEmptyHint(fl);
      }, OUT_MS + 60);
    } else {
      showEmptyHint(fl);
    }
    fl.dataset.animPrimed = "1";
    return;
  }

  const hint = fl.querySelector("li.empty-hint");
  if (hint) hint.remove();

  // 以「屏幕上实际存在的行」为唯一事实源做比对：比拿一份影子数组更稳，
  // 不会有「影子与 DOM 已漂移」的中间态。
  const entries = collectEntries(fl);
  const plan = diffFileItems(entries, list);
  const addedKeys = [];
  for (const k of plan.added) addedKeys.push(k);
  const enteringKeys = new Set(addedKeys);
  const byKey = new Map();
  for (const e of entries) byKey.set(e.key, e);

  const ordered = [];
  const entering = [];
  for (const item of list) {
    const e = byKey.get(item.key);
    if (e && !enteringKeys.has(item.key)) {
      // 同名行：复用节点，只改差异。状态从 ?? 变 M 也走这里，不再放一次入场动画。
      updateRow(e.li, item, primed && animate);
      ordered.push(e.li);
      for (const x of e.extras) ordered.push(x);
      byKey.delete(item.key);
    } else {
      const li = buildRow(item);
      entering.push(li);
      ordered.push(li);
    }
  }

  // 剩下的就是要离场的。标记 data-leaving，免得它在收展期间被下一拍当成「还在列表里」。
  for (const e of byKey.values()) {
    if (primed && animate) {
      e.li.dataset.leaving = "1";
      collapse(e.li, OUT_MS);
      for (const x of e.extras) collapse(x, OUT_MS);
    } else {
      e.li.remove();
      for (const x of e.extras) x.remove();
    }
  }

  // 按目标顺序就位（diff 展开容器跟着它所属的行一起走）。
  let cursor = fl.firstChild;
  for (const node of ordered) {
    if (node === cursor) { cursor = node.nextSibling; continue; }
    fl.insertBefore(node, cursor);
  }

  // 入场放在就位之后：节点已在文档里，才量得到自然高度。
  if (primed && animate) for (const li of entering) expandIn(li, IN_MS);

  fl.dataset.animPrimed = "1";
}

/**
 * 把列表恢复成初始态（用于「不是 git 仓库」「接口被拒」「正在加载仓库…」这类非增量语境）。
 * 必须一并清掉动画基线：否则下一次 renderFileList 会拿旧基线去比对，
 * 把刚要显示的新行当成「一直都在」、或者把整列表当成集体离场。
 * @param {HTMLElement} fl
 * @param {string} [hintHtml] 非空则作为唯一占位内容写进去
 */
export function resetFileList(fl, hintHtml) {
  if (!fl) return;
  fl.textContent = "";
  fl.dataset.animPrimed = "";
  fl.dataset.animPath = "";
  if (hintHtml) fl.innerHTML = hintHtml;
}

// 给经典脚本（status-card.js）用的出口。
if (typeof window !== "undefined") {
  window.FileListAnim = { renderFileList, resetFileList, diffFileItems, statParts, digitOffset, DIGIT_H, IN_MS, OUT_MS };
}
