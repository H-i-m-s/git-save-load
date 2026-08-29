// Git Save/Load Card 前端模块 14/26：refresh.js — 提交记录分页与统一刷新编排
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
function resetLogPager(path) {
  logPager.generation += 1;
  logPager.path = path || "";
  logPager.offset = 0;
  logPager.hasMore = !!path;
  logPager.loading = false;
  logPager.commits = [];
  var cl = document.getElementById("commitList");
  if (cl) cl._commits = [];
}

async function loadLogPage(path, append) {
  path = path || currentPath || getSavedPath();
  if (!path || logPager.loading) return;
  if (append && (logPager.path !== path || !logPager.hasMore)) return;

  if (!append && logPager.path !== path) resetLogPager(path);
  var requestGeneration = logPager.generation;
  var offset = append ? logPager.offset : 0;
  logPager.loading = true;
  try {
    var url = "api/log?count=" + LOG_PAGE_SIZE + "&skip=" + offset + "&path=" + encodeURIComponent(path);
    var res = await pluginFetch(url);
    var data = await res.json();
    if (requestGeneration !== logPager.generation || logPager.path !== path) return;
    if (!data.ok) {
      if (!append) renderLog(data);
      return;
    }
    renderLog(data, append);
    logPager.path = path;
    logPager.offset = offset + (data.commits || []).length;
    logPager.hasMore = !!data.hasMore;
    logPager.commits = document.getElementById("commitList")._commits || [];

    // 内容还没填满滚动区时，继续补一页，避免用户必须先制造一次滚动。
    var cl = document.getElementById("commitList");
    if (logPager.hasMore && cl && cl.scrollHeight <= cl.clientHeight + LOG_SCROLL_THRESHOLD) {
      setTimeout(function() { loadLogPage(path, true); }, 0);
    }
  } catch (e) {
    if (!append) toast("提交记录加载失败：" + e.message, "err");
  } finally {
    if (requestGeneration === logPager.generation) logPager.loading = false;
  }
}

function maybeLoadMoreLog() {
  var cl = document.getElementById("commitList");
  if (!cl || logPager.loading || !logPager.hasMore) return;
  if (cl.scrollHeight - cl.scrollTop - cl.clientHeight <= LOG_SCROLL_THRESHOLD) {
    loadLogPage(logPager.path, true);
  }
}

function setupLogInfiniteScroll() {
  var cl = document.getElementById("commitList");
  if (!cl || cl.dataset.infiniteScrollBound === "1") return;
  cl.dataset.infiniteScrollBound = "1";
  cl.addEventListener("scroll", maybeLoadMoreLog, { passive: true });
}

// 手动刷新会话：普通提交/推送/拉取等事件只更新卡片，不显示“刷新完成”。
var _refreshRunId = 0;
var _refreshRun = null;

function beginRefreshRun() {
  const run = {
    id: ++_refreshRunId,
    pending: Bus._handlers["refresh-all"] ? Bus._handlers["refresh-all"].length : 0,
    done: 0,
    active: true,
  };
  _refreshRun = run;
  window._refreshActive = true;
  window._refreshRunId = run.id;
  window._refreshPending = run.pending;
  window._refreshDone = 0;
  return run;
}

function markRefreshPartDone(runId) {
  const run = _refreshRun;
  if (!run || !run.active || !runId || run.id !== runId) return;
  run.done += 1;
  window._refreshDone = run.done;
  if (run.done >= run.pending) finishRefreshRun(run.id);
}

function finishRefreshRun(runId) {
  const run = _refreshRun;
  if (!run || !run.active || run.id !== runId) return;
  run.active = false;
  window._refreshActive = false;
  window._refreshDone = run.done;
  const btn = document.getElementById("btnRefresh");
  if (btn) btn.classList.remove("spinning");
  toast("刷新完成", "success", { duration: 1200, dismissEvent: "pointerdown" });
}

// 刷新所有状态
function doRefreshAll() {
  compareCleanup();
  const btn = document.getElementById("btnRefresh");
  if (btn) btn.classList.add("spinning");
  invalidateRepoCaches(currentPath || getSavedPath());
  cacheClear();
  const run = beginRefreshRun();
  if (run.pending === 0) finishRefreshRun(run.id);
  else Bus.emit("refresh-all", run.id);
  loadNextVersion();
  // 超时兜底：只结束当前这一次手动刷新，不影响后续普通操作。
  setTimeout(function() { finishRefreshRun(run.id); }, 3000);
}

async function refresh(force) {
  compareCleanup();
  const btn = document.getElementById("btnRefresh");
  if (btn) btn.classList.add("spinning");
  // Prefer the path resolved from the current Card/config session. The
  // browser localStorage value can belong to an older surface instance.
  const savedPath = currentPath || getSavedPath();
  if (force) invalidateRepoCaches(savedPath);
  try {
    const cacheKey = "status-" + savedPath;
    let status = force ? null : cacheGet(cacheKey);
    if (!status) {
      const p = savedPath ? "path=" + encodeURIComponent(savedPath) : "";
      const statusUrl = p ? "api/status?" + p : "api/status";
      const statusRes = await pluginFetch(statusUrl);
      status = await statusRes.json();
      cacheSet(cacheKey, status);
    }
    renderStatus(status);

    // 首屏核心内容：状态先显示，提交记录立即并行加载，不等待后台卡片。
    if (status.ok) {
      const path = currentPath;
      resetLogPager(path);
      loadLogPage(path, false);
      scheduleBackgroundWarmup(path, 0);
    }
  } catch (e) {
    toast("刷新失败：" + e.message, "err");
  } finally {
    if (btn) btn.classList.remove("spinning");
  }
}

// 带指定路径刷新
async function refreshWithPath(path) {
  const btn = document.getElementById("btnRefresh");
  btn.classList.add("spinning");
  try {
    const statusRes = await pluginFetch("api/status?path=" + encodeURIComponent(path));
    const status = await statusRes.json();
    renderStatus(status);
    if (status.ok) {
      resetLogPager(path);
      await loadLogPage(path, false);
      loadStash();
    }
  } catch (e) {
    toast("刷新失败：" + e.message, "err");
  } finally {
    btn.classList.remove("spinning");
  }
}

// 渲染状态
