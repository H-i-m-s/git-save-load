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
    commitStatTooltipLine(commit),
  ].filter(Boolean).join("\n");
  activeCommitTip = tip;
  tip.classList.add("show");
  // 横向照旧跟随鼠标；只在鼠标走到「增删」列右侧（hash / tag 列）时收住，
  // 上限取增删列右缘那个位置——于是 hash / tag 上的浮层停在和增删列一样的地方，
  // 不再贴着屏幕右缘探出去；日期 / 说明 / 增删三列的行为与以前完全一致。
  const mouseLeft = event.clientX - 10;
  const stat = event && event.currentTarget ? event.currentTarget.querySelector(".commit-stat") : null;
  const capLeft = stat ? stat.getBoundingClientRect().right - 10 : mouseLeft;
  tip.style.left = Math.max(6, Math.min(mouseLeft, capLeft)) + "px";
  tip.style.top = Math.max(6, event.clientY - tip.offsetHeight - 8) + "px";
}

// ======== 增删统计：列表先渲染，± 数字异步补齐（不在首屏关键路径上） ========
// 列表端点不带 --numstat（快），统计另发一条请求（慢，无法避免），回来后填进已经
// 渲染好的行里。宽度用固定的 11ch（等宽字体），占位与补齐共用同一宽度：整列不会
// 因为补齐而左右抽动。缓存按「仓库路径 + hash」记，翻页时已取过的 hash 不再重复请求。
const COMMIT_STAT_PENDING_TEXT = "—";
const _commitStatCache = new Map();    // "<path>|<hash>" -> { added, deleted }
const _commitStatInflight = new Set(); // 正在请求的 "<path>|<hash>"

function commitStatKey(path, hash) {
  return String(path || "").replace(/[\\/]+$/, "").toLowerCase() + "|" + String(hash || "");
}

function commitStatsReady(commit) {
  return !!commit && typeof commit.added === "number" && typeof commit.deleted === "number";
}

// 就地写入一行：有数字显示 +N/-M，没有数字显示占位（不显示 0/0，也不显示 ±）。
function applyCommitStat(el, commit) {
  if (!el) return;
  if (commitStatsReady(commit)) {
    el.style.color = "";
    el.innerHTML = `<span style="color:#27ae60;font-weight:600">+${commit.added}</span>/<span style="color:#e74c3c;font-weight:600">-${commit.deleted}</span>`;
    el.dataset.commitStatPending = "";
  } else {
    el.style.color = "var(--hana-fg-muted,#6b7280)";
    el.textContent = COMMIT_STAT_PENDING_TEXT;
    el.dataset.commitStatPending = "1";
  }
}

// hover 详情与列表显示同一份数字（同一个 commit 对象），未到/失败时如实说明。
function commitStatTooltipLine(commit) {
  if (commitStatsReady(commit)) return `📊 变更: +${commit.added} / -${commit.deleted}`;
  if (commit && commit._statUnavailable) return "📊 变更: 统计不可用";
  return "📊 变更: 统计加载中…";
}

// 把缓存里已有的统计就地补到当前列表行上：只改 .commit-stat 的文本，不重排节点。
function applyStatsToRows(path) {
  const cl = document.getElementById("commitList");
  if (!cl) return;
  const commits = cl._commits || [];
  cl.querySelectorAll("li[data-commit-hash]").forEach(function(li) {
    const hash = li.dataset.commitHash;
    const stat = _commitStatCache.get(commitStatKey(path, hash));
    if (!stat) return;
    const c = commits.find(function(item) { return item.hash === hash; });
    if (c) { c.added = stat.added; c.deleted = stat.deleted; c._statUnavailable = false; }
    applyCommitStat(li.querySelector(".commit-stat"), stat);
  });
}

// 请求结束后仍未拿到统计的 hash：标为不可用，让 hover 详情说实话（列表继续留占位）。
function markUnresolvedStats(path, hashes) {
  const cl = document.getElementById("commitList");
  if (!cl) return;
  const commits = cl._commits || [];
  for (const hash of hashes) {
    if (_commitStatCache.has(commitStatKey(path, hash))) continue;
    const c = commits.find(function(item) { return item.hash === hash; });
    if (c) c._statUnavailable = true;
  }
}

// 每一页各自补齐：只请求本页里还没取过的 hash。失败静默（保持占位），不影响首屏。
async function fillCommitStats(path, hashes) {
  const list = (hashes || []).filter(Boolean);
  if (!path || !list.length) return;
  const need = [];
  for (const hash of list) {
    const key = commitStatKey(path, hash);
    if (_commitStatCache.has(key) || _commitStatInflight.has(key)) continue;
    _commitStatInflight.add(key);
    need.push(hash);
  }
  if (!need.length) { applyStatsToRows(path); return; }
  try {
    const res = await pluginFetch("api/log-stats?path=" + encodeURIComponent(path) + "&hashes=" + encodeURIComponent(need.join(",")));
    const data = await res.json();
    if (data && data.ok && data.stats && typeof data.stats === "object") {
      for (const hash of need) {
        const stat = data.stats[hash];
        if (stat && typeof stat.added === "number" && typeof stat.deleted === "number") {
          _commitStatCache.set(commitStatKey(path, hash), { added: stat.added, deleted: stat.deleted });
        }
      }
    }
  } catch (e) {
    // 统计失败既不该弹错误，也不该让首屏失败：保持占位即可。
  } finally {
    for (const hash of need) _commitStatInflight.delete(commitStatKey(path, hash));
  }
  applyStatsToRows(path);
  markUnresolvedStats(path, need);
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
      // 接口被拒绝时说实话，不演成"没有提交记录"；但 git 层面的正常状态
      // （目录还没 init、刚 init 还没有提交）就用原来的友好文案，不当异常报。
      const failure = typeof apiFailureInfo === "function" ? apiFailureInfo(data) : null;
      const quietFailure = !failure || failure.kind === "repo";
      if (quietFailure) {
        cl.innerHTML = '<li class="empty-hint">暂无提交记录<br><span style="font-size:11px;color:var(--hana-fg-muted,#9ca3af)">💡 改一下文件，然后点上面的「存档」按钮</span></li>';
      } else {
        cl.innerHTML = '<li class="empty-hint">' + escapeHtml(failure.message) +
          '<br><span style="font-size:11px;color:var(--hana-fg-muted,#9ca3af)">💡 ' + escapeHtml(failure.hint) + '</span></li>';
      }
    }
    return;
  }

  // 首次加载替换列表，后续加载只追加，保留已有滚动位置和交互状态。
  const previousCommits = append && Array.isArray(cl._commits) ? cl._commits : [];
  cl._commits = append ? previousCommits.concat(data.commits) : data.commits.slice();

  for (const c of data.commits) {
    const li = document.createElement("li");
    li.dataset.commitHash = c.hash;
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

    // 3. 增删行数：宽度固定（占位与补齐共用同一宽度，整列不会左右抽动）。
    //    统计未到时先占位，/api/log-stats 返回后由 applyStatsToRows 就地替换。
    const statSpan = document.createElement("span");
    statSpan.className = "commit-stat";
    statSpan.style.cssText = "font-size:10px;white-space:nowrap;width:11ch;box-sizing:border-box;text-align:right;flex-shrink:0";
    applyCommitStat(statSpan, c);

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
    // 整行都可触发（含 hash / tag 列）；横向跟随鼠标，但在「增删」列右侧收住，
    // 细节见 showCommitTooltip。
    li.onmouseenter = function(e) {
      if (!commitTooltipLocked) showCommitTooltip(c, e);
    };
    li.onmouseleave = function() {
      // 锁定（Shift）或正在与浮层交互时不收。
      if (commitTooltipInteractive) return;
      if (activeCommitTip) scheduleActiveCommitTipHide(activeCommitTip);
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

  // 增删列宽度不再按内容重算：.commit-stat 统一 11ch，占位与补齐一致，
  // 补齐时不会因为列宽变化把整列推来推去。
}

// 提交
