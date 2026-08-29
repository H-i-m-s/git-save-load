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
  try { localStorage.setItem("gsl-cache-" + key, JSON.stringify({ t: Date.now(), d: data })); } catch {}
}
function cacheGet(key) {
  try {
    var raw = JSON.parse(localStorage.getItem("gsl-cache-" + key));
    if (raw && Date.now() - raw.t < CACHE_TTL) return raw.d;
  } catch {}
  return null;
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
  };
  document.addEventListener("visibilitychange", refreshIfStale);
  window.addEventListener("focus", refreshIfStale);
}
