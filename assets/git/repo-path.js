// Git Save/Load Card 前端模块 4/26：repo-path.js — 仓库路径存储/历史/名片渲染、配置路径读写、Toast、路径编辑入口
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
const STORAGE_KEY = "git-tools-repo-path";

// 保存/读取仓库路径

function getSavedPath() {
  try { return localStorage.getItem(STORAGE_KEY) || ""; } catch(e) { return ""; }
}
function savePathToStorage(p) {
  try { localStorage.setItem(STORAGE_KEY, p); } catch(e) {}
}

// 仓库历史记录（最多 10 条）
const HISTORY_KEY = "git-sl-repo-history";
function getRepoHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch { return []; }
}
function addRepoHistory(path) {
  if (!path) return;
  let history = getRepoHistory();
  history = history.filter(p => p !== path); // 去重
  history.unshift(path);
  if (history.length > 20) history = history.slice(0, 20);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch {}
}

// 仓库元信息缓存（跨请求复用，避免翻页逐个请求）—— 30s 过期
const REPO_INFO_CACHE_TTL = 30000;
const _repoInfoCache = new Map();
async function fetchRepoInfo(path) {
  if (!path) return { ok:false, basename:"", parentTail:"", isGit:false, origin:"", defaultBranch:"" };
  const cached = _repoInfoCache.get(path);
  if (cached && Date.now() - cached.ts < REPO_INFO_CACHE_TTL) return cached.info;
  try {
    const res = await pluginFetch("api/repo-info?path=" + encodeURIComponent(path));
    const info = await res.json();
    _repoInfoCache.set(path, { ts: Date.now(), info });
    return info;
  } catch (e) {
    return { ok:false, path, basename: path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "", parentTail: path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).slice(-2).join("/") : "", isGit:false, origin:"", defaultBranch:"" };
  }
}

// 仓库名片渲染：始终渲染三行 —— basename、origin、tail。
// origin 行是个例：info 未加载时为空，info 加载无 origin 时启用 is-empty (CSS::after 显示"本地仓库")。
// 三个行都用 min-height 锁定，不论是否有内容都不额外撑高。
function formatRepoDisplay(path, info, opts = {}) {
  const basename = (info && info.basename) || (path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "") || "未命名仓库";
  const infoLoaded = !!(info && info.ok);
  const realOrigin = (info && info.origin) || "";
  const parentTail = (info && info.parentTail) || (path ? path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).slice(-2).join("/") : "");

  let originHtml = "";
  let originClass = "";
  if (infoLoaded && realOrigin && realOrigin !== basename) {
    originHtml = "↑ " + escapeHtml(realOrigin);
  } else if (infoLoaded) {
    originClass = " is-empty";   // CSS::after 显示 "本地仓库"
  }
  // 未加载时：originHtml 留空，originClass 也不加 = 纯空行，min-height 保住结构。

  const html =
    '<div class="repo-display" title="' + escapeHtml(path) + '">' +
      '<div class="repo-name">' + escapeHtml(basename) + '</div>' +
      '<div class="repo-origin' + originClass + '">' + originHtml + '</div>' +
      '<div class="repo-tail">' + (parentTail ? "…/" + escapeHtml(parentTail) : "") + '</div>' +
    '</div>';
  return { html, basename, origin: realOrigin, parentTail };
}


// 批量预热/拉取仓库元信息：过滤已缓存路径，一次请求拉齐（服务端内部全并行）。
// 结果写入 _repoInfoCache（与单条 fetchRepoInfo 共用同一缓存）。
async function fetchRepoInfoBatch(paths) {
  const todo = [...new Set(paths.filter(Boolean))].filter(p => {
    const cached = _repoInfoCache.get(p);
    return !(cached && Date.now() - cached.ts < REPO_INFO_CACHE_TTL);
  });
  if (!todo.length) return;
  try {
    const res = await pluginFetch("api/repo-info-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: todo }),
    });
    const data = await res.json();
    if (data && data.ok && data.infos) {
      const now = Date.now();
      for (const [p, info] of Object.entries(data.infos)) {
        _repoInfoCache.set(p, { ts: now, info });
      }
    }
  } catch {}
}

// 渲染仓库历史
async function renderRepoHistory() {
  const el = document.getElementById("repoHistory");
  const history = getRepoHistory();
  if (history.length === 0) { el.innerHTML = ""; return; }
  const highlight = _highlightedPath || currentPath || "";
  // 一上来以 3 行骨架渲染（name、tail 都是客户端可算，origin 位置占住）
  // —— 这样信息负载时行高不会被撑高，不产生察觉不到的行高伸长
  el.innerHTML = history.map((p, i) => {
    const init = formatRepoDisplay(p, null);  // name+tail 同步填上，origin 行为占位
    return '<div class="hist-row' + (p === highlight ? ' active' : '') + '" data-idx="' + i + '" data-path="' + escapeHtml(p) + '" style="cursor:pointer">' +
      '<div class="hist-slot" style="flex:1;min-width:0">' + init.html + '</div>' +
      '<button data-del="' + i + '" class="hist-del" title="从历史中移除">×</button>' +
    '</div>';
  }).join("");
  // 并行获取每条仓库的元信息，填补 origin 行（布局高度早已预留，不跳）。
  // 用批量接口一次拉齐（服务端异步并行），避免逐条请求串行排队；
  // 已缓存的路径直接命中，不发请求。
  await fetchRepoInfoBatch(history);
  await Promise.all(history.map(async (p) => {
    const info = await fetchRepoInfo(p);
    const slot = el.querySelector('.hist-row[data-path="' + CSS.escape(p) + '"] .hist-slot');
    if (!slot) return;
    const { html } = formatRepoDisplay(p, info);
    slot.innerHTML = html;
  }));
  el.onclick = function(e) {
    var row = e.target.closest("div.hist-row");
    if (!row) return;
    var delBtn = e.target.closest("button[data-del]");
    if (delBtn) {
      e.stopPropagation();
      var idx = parseInt(row.getAttribute("data-idx"));
      var h = getRepoHistory();
      h.splice(idx, 1);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {}
      renderRepoHistory();
      return;
    }
    var p = row.getAttribute("data-path");
    if (p) {
      document.getElementById("pathInput").value = p;
      if (_highlightedPath !== p) {
        _highlightedPath = p;
        updateHistoryHighlight();
      }
    }
  };
}

// 仅刷新历史列表的高亮态（避免重新拉仓库元信息）
function updateHistoryHighlight() {
  const el = document.getElementById("repoHistory");
  if (!el) return;
  const highlight = _highlightedPath || currentPath || "";
  el.querySelectorAll(".hist-row").forEach(function(row) {
    row.classList.toggle("active", row.getAttribute("data-path") === highlight);
  });
}

// 仓库名片（顶部卡片）渲染：上为 basename+origin，下为路径尾
async function updateRepoPathDisplay(path) {
  const el = document.getElementById("repoPathDisplay");
  if (!el) return;
  if (!path) {
    el.innerHTML = '<div class="repo-display"><div class="repo-name" style="color:var(--hana-fg-muted,#9ca3af)">未设置仓库</div></div>';
    return;
  }
  // 先按三行骨架填上（name、tail 同步可算，origin 行占住 min-height 位置）
  el.setAttribute("data-path", path);
  el.innerHTML = formatRepoDisplay(path, null).html;
  const info = await fetchRepoInfo(path);
  if (el.getAttribute("data-path") !== path) return;
  el.innerHTML = formatRepoDisplay(path, info).html;
}


// 从插件配置读取仓库路径
async function fetchConfigPath() {
  try {
    const res = await pluginFetch("api/repo");
    const data = await res.json();
    if (data.ok && data.repoPath) return data.repoPath;
  } catch {}
  return "";
}

// 保存仓库路径到插件配置
async function saveConfigPath(p) {
  try {
    await pluginFetch("api/repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath: p }),
    });
  } catch {}
}

// Toast 消息
let _toastTimer = null;
let _toastDismissHandler = null;
let _toastDismissEvent = "click";
function hideToast() {
  const el = document.getElementById("toast");
  el.style.display = "none";
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  if (_toastDismissHandler) {
    document.removeEventListener(_toastDismissEvent, _toastDismissHandler, true);
    _toastDismissHandler = null;
  }
}
function toast(msg, type = "info", options = {}) {
  hideToast(); // 清理上一次的计时器和点击监听
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "msg-toast " + type;
  el.style.display = "block";
  // 默认行为保持不变；单独的提示可传入自己的时长和外部关闭事件。
  const defaultDuration = type === "err" ? 12000 : 8000;
  const duration = Number.isFinite(options.duration) ? options.duration : defaultDuration;
  _toastTimer = setTimeout(hideToast, duration);
  _toastDismissEvent = options.dismissEvent || "click";
  _toastDismissHandler = (e) => {
    if (el !== e.target && !el.contains(e.target)) hideToast();
  };
  document.addEventListener(_toastDismissEvent, _toastDismissHandler, true);
}

// API paths are passed directly to pluginFetch; surface authentication is
// attached by the local helper above.


// 编辑/保存路径
function editPath() {
  document.getElementById("repoPathDisplay").style.display = "none";
  document.getElementById("repoPathEdit").style.display = "block";
  document.getElementById("pathInput").value = currentPath;
  document.getElementById("pathInput").focus();
  renderRepoHistory();
}
function cancelEditPath() {
  document.getElementById("repoPathDisplay").style.display = "";
  document.getElementById("repoPathEdit").style.display = "none";
  _highlightedPath = "";           // 取消后预期选择复位
  updateHistoryHighlight();
}
