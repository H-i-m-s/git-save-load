// Git Save/Load Card 前端模块 20/26：diff-view.js — 全局 Diff 模式、Diff 渲染、帮助气泡
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// 全局 diff 模式
let diffMode = localStorage.getItem('git-sl-diff-mode') || 'detail';

try { document.getElementById('diffModeBtn').textContent = diffMode === 'detail' ? '详细' : '精简'; } catch {}

function toggleGlobalDiffMode() {
  diffMode = diffMode === 'detail' ? 'simple' : 'detail';
  document.getElementById('diffModeBtn').textContent = diffMode === 'detail' ? '详细' : '精简';
  localStorage.setItem('git-sl-diff-mode', diffMode);
  saveSetting('defaultDiffMode', diffMode, true);
  // 已展开的面板重排。高度是 auto 就不要紧，
  // 若刚好还在补间中，重排后把目标高度重算一下，否则会停在旧值上。
  document.querySelectorAll('.diff-inline').forEach(container => {
    const inner = container.querySelector('.diff-inline-inner');
    const body = container.querySelector('.diff-body');
    if (!inner || !body) return;
    // 缓存里存的是原始 diff 文本，模式只是渲染时的过滤，直接重渲染即可
    const cached = diffCache.get(diffCacheKey(currentPath || getSavedPath(), container.dataset.file));
    if (typeof cached !== 'string') return;
    const lines = cached.split('\n');
    body._diffLines = lines;
    renderDiffLines(body, lines, diffMode);
    container.style.height = 'auto';
  });
}

// 渲染 diff 行
function renderDiffLines(el, lines, mode) {
  const filtered = mode === 'simple'
    ? lines.filter(l => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@'))
    : lines;
  const count = filtered.length;
  if (count === 0) {
    el.innerHTML = '<div style="color:var(--hana-fg-muted,#6b7280);padding:4px">(没有变更)</div>';
    return;
  }
  // 标记每行是否高亮
  const isHighlight = filtered.map(l => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@'));
  // 检测连续高亮块的起始和结束位置
  const blocks = [];
  let i = 0;
  while (i < count) {
    if (isHighlight[i]) {
      const start = i;
      while (i < count && isHighlight[i]) i++;
      blocks.push({ start, end: i - 1 });
    } else {
      i++;
    }
  }
  el.innerHTML = filtered.map((line, index) => {
    let cls = '';
    let style = '';
    if (line.startsWith('+')) { cls = 'diff-add'; style = 'padding:0 4px'; }
    else if (line.startsWith('-')) { cls = 'diff-del'; style = 'padding:0 4px'; }
    else if (line.startsWith('@@')) { cls = 'diff-hunk'; style = 'padding:0 4px'; }
    else if (mode === 'detail') { style = 'padding:0 4px;color:var(--hana-fg-muted,#6b7280)'; }
    // 给高亮块的第一行和最后一行加圆角
    for (const b of blocks) {
      if (index === b.start && index === b.end) {
        style += ';border-radius:5px';
        break;
      } else if (index === b.start) {
        style += ';border-radius:5px 5px 0 0';
        break;
      } else if (index === b.end) {
        style += ';border-radius:0 0 5px 5px';
        break;
      }
    }
    const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<div style="${style}" class="${cls}">${esc}</div>`;
  }).join('');
}

// 切换 diff 内联展开
/* ── diff 预取与缓存 ──
 *
 * 点开才发请求，等的就是那一趟 git 子进程；文件多的时候每个都要等。
 * 所以列表渲染完就在后台把整批 diff 取回来存住，点击时直接命中。
 *
 * 缓存的键里带上仓库路径：同一会话可能切仓库，只拿文件名会串到别的仓。
 * 刷新时清掉，否则看到的是上一次的差异。
 */
const diffCache = new Map();
let prefetchToken = 0;

function diffCacheKey(p, file) {
  return String(p || "") + "\u0000" + String(file || "");
}

function clearDiffCache() {
  diffCache.clear();
  prefetchToken++;
}

/* 把一批文件的 diff 一次取回来。
 * 失败不打扰用户：预取只是提速，拿不到就退回点击时才请求。 */
async function prefetchDiffs(files) {
  const p = currentPath || getSavedPath();
  if (!p || !files || !files.length) return;
  const need = files.filter((f) => f && f !== "(no diff)" && !diffCache.has(diffCacheKey(p, f)));
  if (!need.length) return;

  const token = ++prefetchToken;
  try {
    const res = await pluginFetch(
      "api/diff-batch?path=" + encodeURIComponent(p) +
      "&files=" + encodeURIComponent(need.join("\n"))
    );
    const data = await res.json();
    // 取回来时仓库可能已经换了，或又刷新过一次，这批就不要了
    if (token !== prefetchToken) return;
    if (!data.ok || !data.diffs) return;
    for (const [file, text] of Object.entries(data.diffs)) {
      if (typeof text === "string") diffCache.set(diffCacheKey(p, file), text);
    }
  } catch (e) { /* 预取失败不报，点击时会重新请 */ }
}

/* 高度补间。
 *
 * 只动容器的 height，不动内容：内容一次性铺满，外层 overflow:hidden 裁着，
 * 容器逐帧长高，看起来就是展开。若改成动内容高度，每帧都要重排文字。
 *
 * 用 requestAnimationFrame 跟屏幕刷新对齐，进度按时间戳算，
 * 掉帧不会把总时长拖长。 */
const DIFF_ANIM_MS = 220;
const diffAnims = new WeakMap();

function diffEase(p) {
  const x = Math.min(1, Math.max(0, p));
  return x * x * (3 - 2 * x);
}

function animateDiffHeight(el, from, to, done) {
  const prev = diffAnims.get(el);
  if (prev) cancelAnimationFrame(prev);

  el.style.height = from + "px";
  let start = 0;
  function step(ts) {
    if (!start) start = ts;
    const p = Math.min(1, (ts - start) / DIFF_ANIM_MS);
    const h = from + (to - from) * diffEase(p);
    el.style.height = h + "px";
    if (p < 1) {
      diffAnims.set(el, requestAnimationFrame(step));
    } else {
      diffAnims.delete(el);
      // 展开完交回 auto，内容再变（换 diff 模式、滚动条）不会被固定值卡住
      el.style.height = "auto";
      if (done) done();
    }
  }
  diffAnims.set(el, requestAnimationFrame(step));
}

// 是否该跳过动画
function diffReduced() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { return false; }
}

async function toggleDiff(file, nameEl) {
  const p = currentPath || getSavedPath();
  const li = nameEl.closest("li");
  const existing = li.nextElementSibling;
  if (existing && existing.classList.contains("diff-inline") && existing.dataset.file === file) {
    collapseDiff(existing);
    return;
  }

  const container = document.createElement("div");
  container.className = "diff-inline";
  container.dataset.file = file;
  const inner = document.createElement("div");
  inner.className = "diff-inline-inner";
  container.appendChild(inner);
  li.parentNode.insertBefore(container, li.nextSibling);

  // 收起时的高度记下来，下次展开从这个高度长出去
  container.style.height = "0px";

  const cached = diffCache.get(diffCacheKey(p, file));
  if (typeof cached === "string") {
    // 已经预取过：先铺内容再开动画，点击到展开之间没有空档
    fillDiff(container, inner, file, cached);
    const h = expandedHeight(container, inner);
    if (diffReduced()) {
      container.style.height = "auto";
    } else {
      container.style.height = "0px";
      container.getBoundingClientRect();   // 强制一次布局，保证从 0 起算
      animateDiffHeight(container, 0, h);
    }
    return;
  }

  // 没预取到（刚刷新、刚改文件、或预取还没回来）：先把面板长出来占位，
  // 不让用户看着没反应，内容到了再填
  inner.textContent = "加载中...";
  const placeholderH = expandedHeight(container, inner);
  if (!diffReduced()) {
    container.style.height = "0px";
    container.getBoundingClientRect();
    animateDiffHeight(container, 0, placeholderH);
  } else {
    container.style.height = "auto";
  }

  try {
    const res = await pluginFetch("api/diff?file=" + encodeURIComponent(file) + "&path=" + encodeURIComponent(p));
    const data = await res.json();
    if (!container.isConnected) return;   // 等待期间已被收起/移除
    if (data.ok && data.detail && data.detail !== "(no diff)") {
      diffCache.set(diffCacheKey(p, file), data.detail);
      const from = container.offsetHeight;
      fillDiff(container, inner, file, data.detail);
      if (diffReduced()) {
        container.style.height = "auto";
      } else {
        const to = expandedHeight(container, inner);
        animateDiffHeight(container, from, to);
      }
    } else {
      const from = container.offsetHeight;
      inner.textContent = "(没有变更内容)";
      if (diffReduced()) container.style.height = "auto";
      else animateDiffHeight(container, from, expandedHeight(container, inner));
    }
  } catch (e) {
    if (!container.isConnected) return;
    inner.textContent = "加载失败：" + e.message;
    container.style.height = "auto";
  }
}

/* 展开到位后容器该有多高。
 *
 * 不能直接拿 inner.offsetHeight：容器是 border-box，上下边框占掉 2px，
 * 按 inner 高度给的话最后一帧会被裁掉内容。
 * 也不能用 offsetHeight - clientHeight 去反推：此刻容器高度可能被钉在 0，量不准。
 * 直接读计算样式里的边框宽度，与当前高度无关。 */
function expandedHeight(container, inner) {
  let border = 0;
  try {
    const cs = getComputedStyle(container);
    border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  } catch (e) { border = 2; }
  return inner.offsetHeight + border;
}

/* 把 diff 正文填进面板。
 * 分开写是因为“缓存命中”与“请求回来”两条路径都要填同一种结构，
 * 各写一份迟早长歪。 */
function fillDiff(container, inner, file, detail) {
  const lines = String(detail).split("\n");
  inner.textContent = "";
  const header = document.createElement("div");
  header.className = "diff-inline-head";
  header.textContent = file;
  const body = document.createElement("div");
  body.className = "diff-body";
  body._diffLines = lines;   // 切详细/精简时重排要用
  renderDiffLines(body, lines, diffMode);
  inner.append(header, body);
}

/* 收起：先量当前高度，再补间到 0，结束后才把节点删掉。
 * 直接 remove 的话下方内容会瞬移上去。 */
function collapseDiff(container) {
  if (diffReduced()) { container.remove(); return; }
  const from = container.offsetHeight;
  container.style.height = from + "px";
  container.style.overflow = "hidden";
  container.getBoundingClientRect();
  animateDiffHeight(container, from, 0, () => container.remove());
}

// 状态帮助气泡
let statusHelpListener = null;
function showStatusHelp() {
  const bubble = document.getElementById("statusHelpBubble");
  if (bubble.style.display !== "none") { bubble.style.display = "none"; return; }
  const btn = event.target;
  const rect = btn.getBoundingClientRect();
  bubble.style.right = (window.innerWidth - rect.right) + "px";
  bubble.style.left = "auto";
  bubble.style.top = (rect.bottom + 4) + "px";
  bubble.style.display = "";
  if (statusHelpListener) document.removeEventListener("click", statusHelpListener);
  statusHelpListener = (e) => {
    if (!bubble.contains(e.target) && e.target !== btn) {
      bubble.style.display = "none";
      document.removeEventListener("click", statusHelpListener);
      statusHelpListener = null;
    }
  };
  setTimeout(() => document.addEventListener("click", statusHelpListener), 0);
  var sc1 = function() { var b=document.getElementById("statusHelpBubble"); if(b)b.style.display="none"; document.removeEventListener("click",statusHelpListener); window.removeEventListener("scroll",sc1,true); };
  setTimeout(function() { window.addEventListener("scroll", sc1, true); }, 0);
}

// reset 帮助气泡
let resetHelpListener = null;
function showResetHelp() {
  const bubble = document.getElementById("resetHelpBubble");
  if (bubble.style.display !== "none") { bubble.style.display = "none"; return; }
  const btn = event.target;
  const rect = btn.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 480;
  const viewportPadding = 8;
  const gap = 4;

  // 先脱离按钮右侧的 right 锚点再测量，避免宽提示框向左展开到可视区域外。
  bubble.style.right = "auto";
  bubble.style.left = "-9999px";
  bubble.style.top = "-9999px";
  bubble.style.maxHeight = "none";
  bubble.style.width = Math.min(380, Math.max(120, viewportWidth - viewportPadding * 2)) + "px";
  bubble.style.display = "";

  const bubbleWidth = bubble.offsetWidth || Math.min(380, viewportWidth - viewportPadding * 2);
  const maxLeft = Math.max(viewportPadding, viewportWidth - bubbleWidth - viewportPadding);
  // 相比原来的右对齐位置，整体向右偏移 48px；越过视口时自动收回到边界内。
  const preferredLeft = rect.right - bubbleWidth + 48;
  const left = Math.max(viewportPadding, Math.min(preferredLeft, maxLeft));
  bubble.style.left = left + "px";

  // 优先放在按钮下方；下方空间不足时移到按钮上方，并把超出的内容交给滚动条。
  const naturalHeight = bubble.scrollHeight;
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - viewportPadding);
  const spaceAbove = Math.max(0, rect.top - viewportPadding);
  if (spaceBelow < naturalHeight && spaceAbove > spaceBelow) {
    const height = Math.min(naturalHeight, spaceAbove);
    bubble.style.maxHeight = Math.max(1, spaceAbove) + "px";
    bubble.style.top = Math.max(viewportPadding, rect.top - height - gap) + "px";
  } else {
    bubble.style.maxHeight = Math.max(1, spaceBelow) + "px";
    bubble.style.top = (rect.bottom + gap) + "px";
  }
  if (resetHelpListener) document.removeEventListener("click", resetHelpListener);
  resetHelpListener = (e) => {
    if (!bubble.contains(e.target) && e.target !== btn) {
      bubble.style.display = "none";
      document.removeEventListener("click", resetHelpListener);
      resetHelpListener = null;
    }
  };
  setTimeout(() => document.addEventListener("click", resetHelpListener), 0);
  var sc2 = function() { var b=document.getElementById("resetHelpBubble"); if(b)b.style.display="none"; document.removeEventListener("click",resetHelpListener); window.removeEventListener("scroll",sc2,true); };
  setTimeout(function() { window.addEventListener("scroll", sc2, true); }, 0);
}

// 确认弹窗
