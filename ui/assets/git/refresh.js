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
    if (status) {
      // 缓存命中：直接渲染，提交记录按需并行加载（保持原有次序语义）
      renderStatus(status);
      if (status.ok) {
        const path = currentPath;
        resetLogPager(path);
        loadLogPage(path, false);
        scheduleBackgroundWarmup(path, 0);
      }
      return;
    }

    // 缓存未命中：status 与提交记录并行拉取。log 不依赖 status 结果，
    // 只依赖目标路径；谁先返回谁先渲染，切仓库时提交记录不再等状态。
    // 非仓库场景：renderStatus 非 ok 会隐藏 logCard，log 的报错渲染不可见。
    const p = savedPath ? "path=" + encodeURIComponent(savedPath) : "";
    if (savedPath) {
      resetLogPager(savedPath);
      loadLogPage(savedPath, false).catch(function() {});
    }
    const statusRes = await pluginFetch(p ? "api/status?" + p : "api/status");
    status = await statusRes.json();
    cacheSet(cacheKey, status);
    renderStatus(status);
    if (status.ok) scheduleBackgroundWarmup(currentPath, 0);
  } catch (e) {
    toast("刷新失败：" + e.message, "err");
  } finally {
    if (btn) btn.classList.remove("spinning");
  }
}

// 带指定路径刷新（初始化仓库后用）：status 与提交记录并行，同 refresh()。
async function refreshWithPath(path) {
  const btn = document.getElementById("btnRefresh");
  btn.classList.add("spinning");
  try {
    const logPromise = (resetLogPager(path), loadLogPage(path, false).catch(function() {}));
    const statusRes = await pluginFetch("api/status?path=" + encodeURIComponent(path));
    const status = await statusRes.json();
    renderStatus(status);
    await logPromise;
    if (status.ok) loadStash();
  } catch (e) {
    toast("刷新失败：" + e.message, "err");
  } finally {
    btn.classList.remove("spinning");
  }
}

// 渲染状态
