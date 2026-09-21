// Git Save/Load Card 前端模块 26/26：main.js — 初始化入口（IIFE，最后执行）
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
(async function init() {
  // 应用主题
  var savedTheme = localStorage.getItem("git-sl-theme") || "auto";
  applyTheme(savedTheme);
  // 获取插件版本号
  try {
    const versionRes = await pluginFetch("api/plugin-version");
    const versionData = await versionRes.json();
    if (versionData.ok && versionData.version) {
      document.getElementById("pluginVersion").textContent = "v" + versionData.version;
    }
  } catch (e) {}
  var configPath = await fetchConfigPath();
  if (configPath) {
    currentPath = configPath;
    savePathToStorage(configPath);
  }
  setupCtxMenuEvents();
  initAllHanaSegs();
  // 默认 公开
  setHanaSegActive("segGhPrivacy", "0");
  // 替换原生 select 为 HanaSelect
  if (typeof initHanaSelects === "function") initHanaSelects();
  const connectSelect = document.getElementById("ghConnectRepoSelect");
  if (connectSelect) connectSelect.dataset.loading = "0";
  const remoteUrlSelect = document.getElementById("remoteUrlRepoSelect");
  if (remoteUrlSelect) remoteUrlSelect.dataset.loading = "0";
  initCardDrag();
  setupCommitActionLayout();
  setupLogInfiniteScroll();
  // 注册卡片（事件驱动的自动刷新）
  Cards.register("fileCard", { events: ["commit","push","pull","reset","branch-switch","refresh-all"], refresh: function(event, runId){
    var p = currentPath || getSavedPath();
    if (!p) { if (event === "refresh-all") markRefreshPartDone(runId); return; }
    pluginFetch("api/status?path="+encodeURIComponent(p)).then(function(r){return r.json()}).then(function(d){
      renderStatus(d);
      if (event === "refresh-all") markRefreshPartDone(runId);
    }).catch(function(){ if (event === "refresh-all") markRefreshPartDone(runId); });
  }});
  Cards.register("logCard", { events: ["commit","reset","branch-switch","refresh-all"], refresh: function(event, runId){
    var p = currentPath || getSavedPath();
    if (!p) { if (event === "refresh-all") markRefreshPartDone(runId); return; }
    resetLogPager(p);
    loadLogPage(p, false).then(function(){ if (event === "refresh-all") markRefreshPartDone(runId); }).catch(function(){ if (event === "refresh-all") markRefreshPartDone(runId); });
  }});
  Cards.register("stashCard", { events: ["commit","stash-push","stash-pop","stash-drop","refresh-all"], refresh: function(event, runId){
    var p = currentPath || getSavedPath();
    if (!p) { if (event === "refresh-all") markRefreshPartDone(runId); return; }
    pluginFetch("api/stash/list?path="+encodeURIComponent(p)).then(function(r){return r.json()}).then(function(d){
      loadStash();
      if (event === "refresh-all") markRefreshPartDone(runId);
    }).catch(function(){ if (event === "refresh-all") markRefreshPartDone(runId); });
  }});
  // The config request is authoritative; bypass any status cached by an
  // older Card instance that may point at a different repository.
  refresh(true);
  setupBackgroundRefresh();

  loadSettingsUI();
  loadNextVersion();
  window.parent.postMessage({ type: "ready" }, "*");

  // 首次打开自动弹新手引导
  maybeShowWalkthrough();
  // 显示三步工作流程提示条
  maybeShowWorkflowGuide();
  
  // 监听 body 的 data-hana-theme 属性变化（Hana 切换主题时会更新）
  var savedTheme = localStorage.getItem("git-sl-theme") || "auto";
  if (savedTheme === "auto") {
    try {
      var observer = new MutationObserver(function(mutations) {
        applyTheme("auto");
      });
      observer.observe(document.body, { attributes: true, attributeFilter: ["data-hana-theme"] });
    } catch {}
  }
})();
