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
  document.querySelectorAll('.diff-inline').forEach(container => {
    if (container._diffLines) {
      const body = container.querySelector('.diff-body');
      if (body) renderDiffLines(body, container._diffLines, diffMode);
    }
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
async function toggleDiff(file, nameEl) {
  const p = currentPath || getSavedPath();
  const li = nameEl.closest("li");
  const existing = li.nextElementSibling;
  if (existing && existing.classList.contains("diff-inline") && existing.dataset.file === file) {
    existing.remove();
    return;
  }

  const container = document.createElement("div");
  container.className = "diff-inline";
  container.dataset.file = file;
  container.style.cssText = "padding:8px 10px;margin:4px 0;border:1px solid var(--hana-border,#e2e5ea);border-radius:8px;font-size:11px;font-family:monospace;line-height:1.6;background:var(--hana-bg,#f5f6f8);resize:vertical;overflow-x:hidden;overflow-y:auto;min-height:60px;max-height:300px;white-space:pre-wrap;word-break:break-all";
  container.textContent = "加载中...";
  li.parentNode.insertBefore(container, li.nextSibling);

  try {
    const res = await pluginFetch("api/diff?file=" + encodeURIComponent(file) + "&path=" + encodeURIComponent(p));
    const data = await res.json();
    if (data.ok && data.detail && data.detail !== "(no diff)") {
      const lines = data.detail.split('\n');
      container._diffLines = lines;
      const header = document.createElement("div");
      header.style.cssText = "font-size:11px;color:var(--hana-fg-muted,#6b7280);margin-bottom:4px";
      header.textContent = file;
      const body = document.createElement("div");
      body.className = "diff-body";
      renderDiffLines(body, lines, diffMode);
      container.textContent = '';
      container.append(header, body);
    } else {
      container.textContent = "(没有变更内容)";
    }
  } catch (e) {
    container.textContent = "加载失败：" + e.message;
  }
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
