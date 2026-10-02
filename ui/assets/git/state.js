// Git Save/Load Card 前端模块 2/26：state.js — 全局状态、事件总线、卡片注册、缓存与后台预加载
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
let currentPath = "";
let _remotePanelPath = "";
let _remoteLoadGeneration = 0;

// 提交记录分页：首屏 20 条，滚动接近底部时自动追加下一页。
const LOG_PAGE_SIZE = 20;
const LOG_SCROLL_THRESHOLD = 64;
var logPager = {
  path: "",
  offset: 0,
  hasMore: false,
  loading: false,
  generation: 0,
  commits: [],
};

// ======== 事件总线（卡片间通信） ========
var Bus = {
  _handlers: {},
  on: function(event, fn) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(fn);
    return fn;
  },
  off: function(event, fn) {
    var list = this._handlers[event];
    if (list) this._handlers[event] = list.filter(function(f) { return f !== fn; });
  },
  emit: function(event, data) {
    var list = this._handlers[event];
    if (list) list.forEach(function(fn) { try { fn(data); } catch {} });
    // 同时触发 '*' 通配监听
    var all = this._handlers['*'];
    if (all) all.forEach(function(fn) { try { fn(event, data); } catch {} });
  }
};

// ======== 卡片注册系统 ========
var Cards = {};

Cards.register = function(id, config) {
  var card = {
    id: id,
    el: document.getElementById(id),
    refresh: config.refresh || function(){},
    events: config.events || [],
    collapsed: config.collapsed !== false,
    onCollapse: config.onCollapse || null,
  };
  // 订阅事件
  card.events.forEach(function(ev) {
    Bus.on(ev, function(data) {
      card.refresh(ev, data);
    });
  });
  Cards[id] = card;
  return card;
};

Cards.refreshAll = function() {
  for (var id in Cards) {
    if (Cards[id].refresh) Cards[id].refresh();
  }
};

// ======== 缓存机制与后台预加载 ========
var CACHE_TTL = 10000;
var REMOTE_CACHE_TTL = 15000;
var GH_REPO_CACHE_TTL = 300000;
var remoteDataCache = new Map();
var ghRepoCache = { data: null, fetchedAt: 0, promise: null, generation: 0 };
var _backgroundWarmupTimer = null;
var _lastBackgroundRefreshAt = 0;

function cacheSet(key, data) {
  // 失败的返回不写缓存：一次 403/503 不该在 TTL 内被反复渲染成"这不是仓库"。
  if (!data || data.ok !== true) {
    try { localStorage.removeItem("gsl-cache-" + key); } catch {}
    return;
  }
  try { localStorage.setItem("gsl-cache-" + key, JSON.stringify({ t: Date.now(), d: data })); } catch {}
}
function cacheGet(key) {
  try {
    var raw = JSON.parse(localStorage.getItem("gsl-cache-" + key));
    if (raw && Date.now() - raw.t < CACHE_TTL && raw.d && raw.d.ok === true) return raw.d;
  } catch {}
  return null;
}

// 清理历史遗留的失败缓存：旧版本会把 403/503 的 body 当状态写进去，
// 之后非强制 refresh 又把它读出来重放一遍，看着就像"仓库时不时自己消失"。
function purgeFailedStatusCache() {
  try {
    Object.keys(localStorage)
      .filter(function(k) { return k.indexOf("gsl-cache-status-") === 0; })
      .forEach(function(k) {
        try {
          var raw = JSON.parse(localStorage.getItem(k));
          if (!raw || !raw.d || raw.d.ok !== true) localStorage.removeItem(k);
        } catch { localStorage.removeItem(k); }
      });
  } catch {}
}
function repoCacheKey(path) {
  return String(path || "").trim().replace(/[\\/]+$/, "").toLowerCase();
}
function remoteCacheKey(path, preferredRemote, preferredBranch) {
  return repoCacheKey(path) + "|" + String(preferredRemote || "") + "|" + String(preferredBranch || "");
}
function invalidateRemoteCache(path) {
  var key = repoCacheKey(path);
  if (!key) { remoteDataCache.clear(); return; }
  Array.from(remoteDataCache.keys()).forEach(function(cacheKey) {
    if (cacheKey.indexOf(key + "|") === 0) remoteDataCache.delete(cacheKey);
  });
}
function invalidateGhRepoCache() {
  ghRepoCache.data = null;
  ghRepoCache.fetchedAt = 0;
  ghRepoCache.generation += 1;
}
function invalidateRepoCaches(path) {
  var p = String(path || currentPath || getSavedPath()).trim();
  invalidateRemoteCache(p);
  try {
    var prefix = p ? "status-" + p : "";
    var keys = Object.keys(localStorage).filter(function(k) { return k.startsWith("gsl-cache-"); });
    keys.forEach(function(k) {
      if (!prefix || k === "gsl-cache-" + prefix) localStorage.removeItem(k);
    });
  } catch {}
}
function cacheClear() {
  try {
    var keys = Object.keys(localStorage).filter(function(k) { return k.startsWith("gsl-cache-"); });
    keys.forEach(function(k) { localStorage.removeItem(k); });
  } catch {}
  remoteDataCache.clear();
}

function requestGhRepos(force) {
  var now = Date.now();
  if (!force && ghRepoCache.data && now - ghRepoCache.fetchedAt < GH_REPO_CACHE_TTL) {
    return Promise.resolve(ghRepoCache.data);
  }
  if (!force && ghRepoCache.promise) return ghRepoCache.promise;
  var generation = ++ghRepoCache.generation;
  var promise = pluginFetch("api/gh/list")
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (generation === ghRepoCache.generation && data && data.ok && Array.isArray(data.repos)) {
        ghRepoCache.data = data;
        ghRepoCache.fetchedAt = Date.now();
      }
      return data;
    })
    .finally(function() {
      if (generation === ghRepoCache.generation) ghRepoCache.promise = null;
    });
  ghRepoCache.promise = promise;
  return promise;
}

function scheduleBackgroundWarmup(path, delay) {
  var p = String(path || currentPath || getSavedPath()).trim();
  if (!p) return;
  if (_backgroundWarmupTimer) clearTimeout(_backgroundWarmupTimer);
  _backgroundWarmupTimer = setTimeout(function() {
    _backgroundWarmupTimer = null;
    var target = currentPath || getSavedPath();
    if (!target || repoCacheKey(target) !== repoCacheKey(p)) return;
    loadLocalRemotes(undefined, undefined, target, false);
    loadStash();
    loadNextVersion();
    requestGhRepos(false).catch(function() {});
    // 顺带预热仓库历史的元信息：下次点“切换”时历史行直接全量就绪。
    // fetchRepoInfoBatch 内部会跳过已缓存路径，且单条缓存 30s TTL 兜底。
    fetchRepoInfoBatch(getRepoHistory()).catch(function() {});
  }, typeof delay === "number" ? delay : 0);
}

function setupBackgroundRefresh() {
  if (setupBackgroundRefresh._bound) return;
  setupBackgroundRefresh._bound = true;
  var refreshIfStale = function() {
    if (document.visibilityState && document.visibilityState !== "visible") return;
    var now = Date.now();
    if (now - _lastBackgroundRefreshAt < 30000) return;
    _lastBackgroundRefreshAt = now;
    scheduleBackgroundWarmup(currentPath || getSavedPath(), 0);
    // 切回窗口时变更文件也应该是最新的：热周边信息的同时补一次轻量状态拉取。
    // refreshFilesAuto 自带可见性判断/并发守卫/1s 去重/指纹跳过，与上面的定时器共存、
    // 不会重复发请求（定时器正在飞时它会直接跳过）。
    refreshFilesAuto();
  };
  document.addEventListener("visibilitychange", refreshIfStale);
  window.addEventListener("focus", refreshIfStale);
}

// ======== 变更文件「可见时自动轮询」 ========
// 为什么是轮询：App 进程受 Node Permission Model 限制，fs.watch 对用户仓库目录会抛
// ERR_ACCESS_DENIED（只授权了 app 目录 / app-data / 宿主 locales），没法事件驱动，
// 只能定时轻量拉取。这个定时器只干一件事：让「变更文件」卡在无操作时也能自己跟上。
var AUTO_REFRESH_SEC_VALUES = ["0", "2", "3", "5", "10", "30"];
var _autoRefreshSec = 5;           // 当前生效周期（秒），0 = 关闭
var _autoRefreshTimer = null;      // setTimeout 句柄；restartAutoRefresh 唯一负责清干净
var _filesAutoInFlight = false;    // 上一拍还没回来 → 跳过这一拍，不并发堆请求
var _filesAutoLastAt = 0;          // 上次发起时间：与 focus 路径 1s 内去重，避免同刻重复发
var _filesAutoFingerprint = "";    // 上次「渲染」用的指纹；没变就不碰 DOM
var _filesAutoHead = "";           // 上次「渲染」见到的 HEAD；只有变了才刷提交记录
var _filesAutoHeadPrimed = false;  // 首次观测只建立基线（首屏已渲染过提交记录，不重复刷）
var _filesAutoPath = "";           // 上面两个基线是哪个仓库建立的基准

// 未设置 / 非法值一律按 "5"；"0" = 关闭。
function normalizeAutoRefreshSec(value) {
  var s = String(value == null ? "" : value).trim();
  return AUTO_REFRESH_SEC_VALUES.indexOf(s) >= 0 ? parseInt(s, 10) : 5;
}

// 指纹只取「影响变更文件渲染」的字段：分支名、有无变更、带统计的变更列表、未跟踪列表。
// 这些一致时 renderStatus 画出来的 li 必然一致，可以安全跳过这次 DOM 重建。
function filesFingerprint(data) {
  return JSON.stringify([
    data.branch,
    !!data.hasChanges,
    data.changedWithStats || data.changedFiles || [],
    data.untrackedFiles || []
  ]);
}

// 自动轮询的一拍。静默：不弹 toast、不报「刷新完成」、不调 doRefreshAll、不发 refresh-all 事件。
function refreshFilesAuto() {
  // 可见才跑：看不见的面板不该反复读用户磁盘，连请求都不发。
  if (document.visibilityState && document.visibilityState !== "visible") return;
  if (_filesAutoInFlight) return;                       // 上一拍还没回，跳过这一拍
  var now = Date.now();
  if (now - _filesAutoLastAt < 1000) return;            // 与 focus 路径 1s 内去重
  var p = currentPath || getSavedPath();
  if (!p) return;
  _filesAutoLastAt = now;
  _filesAutoInFlight = true;
  pluginFetch("api/status?path=" + encodeURIComponent(p))
    .then(function(res) { return res.json(); })
    .then(function(d) {
      // 失败静默：!ok（会话过期/后端被拒/不是仓库）一律什么都做，保留上一次渲染的内容。
      // 「⚠ 接口被拒绝」「不是 git 仓库」这类失败态只在手动刷新时才该说，
      // 绝不能把用户正在看的正常列表盖掉。
      if (!d || d.ok !== true) return;
      if (typeof apiFailureInfo === "function" && apiFailureInfo(d)) return;

      // 换了仓库：手动「切换」那条链路已经把这个仓库渲染好了，这里只重建基线，
      // 既不重画、也不触发提交记录刷新。
      // 不这样做的后果：新仓库的指纹/HEAD 必然跟老仓库的基线不同，于是首拍会白发一次
      // 提交记录刷新。在大仓库上那是一次约 2.7s 的增删统计请求，还会把用户刚滚到的
      // 提交列表拽回顶部。
      // 首次观测（还没渲染过任何仓库）不走这条，免得「首屏渲染失败后自动轮询也不补渲染」。
      if (d.path !== _filesAutoPath) {
        var hadAutoBaseline = (_filesAutoFingerprint !== "" || _filesAutoHeadPrimed);
        _filesAutoPath = d.path;
        if (hadAutoBaseline) {
          _filesAutoFingerprint = filesFingerprint(d);
          _filesAutoHead = String(d.head || "");
          _filesAutoHeadPrimed = true;
          return;
        }
      }

      var fp = filesFingerprint(d);
      if (fp !== _filesAutoFingerprint) {               // 内容没变就不碰 DOM，一个像素都不动
        _filesAutoFingerprint = fp;
        renderStatus(d);
      }

      // head 变化才刷提交记录：提交记录那条会顺带请求增删统计，大仓库上要 ~2s，不能每拍都跑。
      var head = String(d.head || "");
      if (!_filesAutoHeadPrimed) {
        // 首屏刷新已经渲染过提交记录，首次观测只建立基线。
        _filesAutoHead = head;
        _filesAutoHeadPrimed = true;
      } else if (head !== _filesAutoHead) {
        _filesAutoHead = head;
        if (Cards && Cards.logCard && typeof Cards.logCard.refresh === "function") {
          try { Cards.logCard.refresh("auto-refresh"); } catch {}
        }
      }
    })
    .catch(function() { /* 静默：网络/解析失败不打扰用户 */ })
    .finally(function() { _filesAutoInFlight = false; });
}

// 按当前配置重起定时器。设置页改完立即调；旧定时器的清理只在这里收口。
function restartAutoRefresh(explicitSec) {
  if (_autoRefreshTimer) { clearTimeout(_autoRefreshTimer); _autoRefreshTimer = null; }
  if (explicitSec !== undefined && explicitSec !== null) {
    armAutoRefresh(normalizeAutoRefreshSec(explicitSec));
    return;
  }
  // 无显式值（初始化）：向后端要一次配置，未配置/非法一律 5 秒。
  pluginFetch("api/config")
    .then(function(res) { return res.json(); })
    .then(function(d) {
      var c = (d && d.ok && d.config) || {};
      armAutoRefresh(normalizeAutoRefreshSec(c.autoRefreshSec));
    })
    .catch(function() { armAutoRefresh(normalizeAutoRefreshSec("")); });
}

// 起一拍递归的 setTimeout：不用裸 setInterval，每拍结束后按同一周期续排，
// 句柄始终挂在 _autoRefreshTimer 上，restartAutoRefresh 能干净清掉整条链。
function armAutoRefresh(sec) {
  _autoRefreshSec = sec;                                // 记住当前周期（含 0=关闭）
  if (_autoRefreshTimer) { clearTimeout(_autoRefreshTimer); _autoRefreshTimer = null; }
  if (!sec || sec <= 0) return;                          // "0" = 关闭，不起定时器
  _autoRefreshTimer = setTimeout(function() {
    _autoRefreshTimer = null;
    refreshFilesAuto();
    armAutoRefresh(sec);                                 // 递归排下一拍
  }, sec * 1000);
}
