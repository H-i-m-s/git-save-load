// Git Save/Load Card 前端模块 16/26：log-view.js — 提交记录渲染与悬浮提示
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
let commitTooltipEl = null;
let activeCommitTip = null;
let activeCommitTipHideTimer = null;
let commitTooltipInteractive = false;
let commitTooltipLocked = false;
let commitTooltipIntentBound = false;

function setCommitTooltipInteractive(enabled) {
  commitTooltipInteractive = !!enabled;
  if (commitTooltipEl) commitTooltipEl.classList.toggle("interactive", commitTooltipInteractive);
}

function bindCommitTooltipIntent() {
  if (commitTooltipIntentBound) return;
  commitTooltipIntentBound = true;
  document.addEventListener("keydown", function(e) {
    if (e.key !== "Shift" || e.repeat || !activeCommitTip || !commitTooltipEl) return;
    commitTooltipLocked = true;
    setCommitTooltipInteractive(true);
  });
  document.addEventListener("keyup", function(e) {
    if (e.key !== "Shift" || !activeCommitTip || !commitTooltipEl) return;
    // Shift 释放后仍保持当前提示块锁定，直到鼠标离开提示块。
    if (commitTooltipEl.matches(":hover")) setCommitTooltipInteractive(true);
  });
}

function ensureCommitTooltip() {
  bindCommitTooltipIntent();
  if (commitTooltipEl && document.body.contains(commitTooltipEl)) return commitTooltipEl;
  commitTooltipEl = document.createElement("span");
  commitTooltipEl.id = "globalCommitTooltip";
  commitTooltipEl.className = "commit-tooltip";
  commitTooltipEl.onmouseenter = function() {
    if (!commitTooltipInteractive) return;
    if (activeCommitTipHideTimer) {
      clearTimeout(activeCommitTipHideTimer);
      activeCommitTipHideTimer = null;
    }
    activeCommitTip = commitTooltipEl;
    commitTooltipEl.classList.add("show");
  };
  commitTooltipEl.onmouseleave = function() {
    if (commitTooltipInteractive) {
      commitTooltipLocked = false;
      setCommitTooltipInteractive(false);
      scheduleActiveCommitTipHide(commitTooltipEl);
    }
  };
  commitTooltipEl.onmousedown = function(e) {
    // 保留浏览器默认行为，让提示文字可以正常拖选和复制。
    e.stopPropagation();
  };
  document.body.appendChild(commitTooltipEl);
  return commitTooltipEl;
}

function hideActiveCommitTip() {
  if (activeCommitTipHideTimer) {
    clearTimeout(activeCommitTipHideTimer);
    activeCommitTipHideTimer = null;
  }
  if (activeCommitTip) activeCommitTip.classList.remove("show");
  activeCommitTip = null;
  commitTooltipLocked = false;
  setCommitTooltipInteractive(false);
}

function scheduleActiveCommitTipHide(tip) {
  if (activeCommitTipHideTimer) clearTimeout(activeCommitTipHideTimer);
  activeCommitTipHideTimer = setTimeout(function() {
    if (activeCommitTip === tip && !tip.matches(":hover")) hideActiveCommitTip();
    activeCommitTipHideTimer = null;
  }, 180);
}

function showCommitTooltip(commit, event) {
  const tip = ensureCommitTooltip();
  if (commitTooltipLocked) return;
  hideActiveCommitTip();
  setCommitTooltipInteractive(false);
  tip.textContent = [
    `📅 完整时间: ${commit.date || ''}`,
    `🔖 Hash: ${commit.hash}`,
    commit.tag ? `🏷️  Tag: ${commit.tag}` : null,
    `✍️  作者: ${commit.author || ''}`,
    `💬 说明: ${commit.message}`,
  ].filter(Boolean).join("\n");
  activeCommitTip = tip;
  tip.classList.add("show");
  tip.style.left = Math.max(6, event.clientX - 10) + "px";
  tip.style.top = Math.max(6, event.clientY - tip.offsetHeight - 8) + "px";
}

function renderLog(data, append) {
  hideActiveCommitTip();
  const cl = document.getElementById("commitList");
  append = !!append;
  if (!append) cl.innerHTML = "";

  // 说明列 flex:1 1 0 → 容器宽度响应天然渐进：
  // - 容器宽度 ≤ 必需列总宽（≈256px）：其他列已占满 li，msg = 0（说明列被压没）
  // - 容器宽度 > 必需列总宽：msg 从剩余空间逐渐扩张，列间距保持 4px

  if (!data.ok || !data.commits || data.commits.length === 0) {
    if (!append) {
      cl._commits = [];
      cl.innerHTML = '<li class="empty-hint">暂无提交记录<br><span style="font-size:11px;color:var(--hana-fg-muted,#9ca3af)">💡 改一下文件，然后点上面的「存档」按钮</span></li>';
    }
    return;
  }

  // 首次加载替换列表，后续加载只追加，保留已有滚动位置和交互状态。
  const previousCommits = append && Array.isArray(cl._commits) ? cl._commits : [];
  cl._commits = append ? previousCommits.concat(data.commits) : data.commits.slice();

  for (const c of data.commits) {
    const li = document.createElement("li");
    const display = showTag && c.tag ? c.tag : c.hash;

    // 1. 日期时间（主标识）- 始终显示 "MM-DD HH:MM" 或 "昨天 HH:MM" 或 "MM-DD"
    const dateSpan = document.createElement("span");
    dateSpan.className = "commit-date-primary";
    dateSpan.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;font-weight:600;color:var(--hana-accent,#5e6ad2);background:rgba(94,106,210,.08);padding:2px 0;border-radius:4px;flex-shrink:0;white-space:nowrap;min-width:68px;text-align:center;cursor:pointer";
    dateSpan.textContent = formatCommitDateFull(c.date);
    dateSpan.title = `${c.date || ""}\n左键回滚；右键修改提交记录`;
    dateSpan.onclick = () => doReset(c.hash);
    dateSpan.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      doEditCommitMessage(c, dateSpan);
      return false;
    };

    // 2. 提交消息
    const msgSpan = document.createElement("span");
    msgSpan.className = "commit-msg";
    msgSpan.textContent = c.message;
    msgSpan.style.flex = "1";
    msgSpan._isMsg = true;

    // 3. 增删行数
    const statSpan = document.createElement("span");
    statSpan.className = "commit-stat";
    if (c.added || c.deleted) {
      statSpan.style.cssText = "font-size:10px;white-space:nowrap;min-width:32px;text-align:right;flex-shrink:0";
      statSpan.innerHTML = `<span style="color:#27ae60;font-weight:600">+${c.added}</span>/<span style="color:#e74c3c;font-weight:600">-${c.deleted}</span>`;
    } else {
      statSpan.style.cssText = "font-size:10px;color:var(--hana-fg-muted,#6b7280);min-width:32px;text-align:right;flex-shrink:0";
      statSpan.textContent = "—";
    }

    // 4. hash 缩到辅助位置（小字、淡色、hover 提示）
    const hashSpan = document.createElement("span");
    hashSpan.className = "commit-hash-secondary";
    hashSpan.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--hana-fg-muted,#9ca3af);flex-shrink:0;cursor:pointer;padding:0 3px;width:48px;text-align:center";
    hashSpan.textContent = display;
    hashSpan.title = "左键回滚；右键修改提交说明和版本号";
    hashSpan.onclick = (e) => { e.stopPropagation(); doReset(c.hash); };
    hashSpan.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      doEditCommitMessage(c, hashSpan);
      return false;
    };

    // tag 列固定占位：没有版本号时也保留同样宽度，避免后面的 hash / 对比列错位。
    const tagBadge = document.createElement("span");
    tagBadge.style.cssText = "font-size:10px;color:#fff;background:#8b5cf6;padding:1px 4px;border-radius:3px;flex-shrink:0;width:44px;box-sizing:border-box;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;visibility:" + (c.tag ? "visible" : "hidden");
    tagBadge.textContent = c.tag || "—";

    // 提示块统一挂到 body，避免 fixed 浮层仍受提交行 hover 关系影响。
    li.onmouseenter = function(e) {
      if (!commitTooltipLocked) showCommitTooltip(c, e);
    };
    li.onmouseleave = function() {
      if (!commitTooltipInteractive) {
        scheduleActiveCommitTipHide(commitTooltipEl);
      }
    };

    // 对比选择按钮
    let compareBtn = null;
    if (compareMode) {
      compareBtn = document.createElement("button");
      compareBtn.style.cssText = "padding:1px 5px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;font-size:10px;cursor:pointer;background:transparent;flex-shrink:0;width:24px;text-align:center";
      if (c.hash === compareFrom) {
        compareBtn.textContent = "←旧";
        compareBtn.style.borderColor = "#4a8cff";
        compareBtn.style.color = "#4a8cff";
      } else if (c.hash === compareTo) {
        compareBtn.textContent = "→新";
        compareBtn.style.borderColor = "#e74c3c";
        compareBtn.style.color = "#e74c3c";
      } else {
        compareBtn.textContent = "选";
        compareBtn.style.color = "var(--hana-fg-muted,#6b7280)";
      }
      compareBtn.onclick = (e) => { e.stopPropagation(); pickCompare(c.hash); };
    }

    // 组装：日期 → 消息 → 增删 → hash → tag → 对比按钮 → tooltip
    const items = [dateSpan, msgSpan, statSpan, hashSpan, tagBadge];
    if (compareBtn) items.push(compareBtn);
    items.forEach(function(el) { li.appendChild(el); });
    cl.appendChild(li);
  }

  // 统一 diff 列宽度
  const statEls = cl.querySelectorAll('.commit-stat');
  let maxStatWidth = 32;
  statEls.forEach(el => {
    const w = el.scrollWidth;
    if (w > maxStatWidth) maxStatWidth = w;
  });
  statEls.forEach(el => {
    el.style.width = maxStatWidth + 'px';
  });
}

// 提交
