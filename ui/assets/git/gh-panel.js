// Git Save/Load Card 前端模块 6/26：gh-panel.js — GitHub 面板（折叠、标签页、帮助气泡、连接下拉）
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// ======== GitHub 面板 ========
var GH_TAB_STORAGE_KEY = "git-save-load-gh-tab";

function getSavedGhTab() {
  try { return localStorage.getItem(GH_TAB_STORAGE_KEY) || "create"; } catch { return "create"; }
}

function saveGhTab(tab) {
  try { localStorage.setItem(GH_TAB_STORAGE_KEY, tab); } catch {}
}

function toggleGhPanel() {
  var body = document.getElementById("ghBody");
  var toggle = document.getElementById("ghToggle");
  if (!body) return;
  var open = body.style.maxHeight !== "0px" && body.style.maxHeight !== "";
  if (open) {
    body.style.maxHeight = "0px";
    if (toggle) toggle.textContent = "▸";
  } else {
    body.style.maxHeight = "0px";
    if (toggle) toggle.textContent = "▾";
    switchGhTab(getSavedGhTab());
    requestAnimationFrame(updateGhBodyHeight);
  }
  requestHostResize();
  if (open) setTimeout(requestHostResize, 240);
}

function showBranchColorHelp() {
  var bubble = document.getElementById("branchColorBubble");
  if (bubble.style.display !== "none") { bubble.style.display = "none"; return; }
  bubble.style.left = "50%";
  bubble.style.top = "50%";
  bubble.style.transform = "translate(-50%, -50%)";
  bubble.style.display = "block";
  bubble.style.position = "fixed";
  bubble.style.zIndex = "3000";
  var cl = function(ev) {
    if (!bubble.contains(ev.target)) {
      bubble.style.display = "none";
      document.removeEventListener("click", cl);
      window.removeEventListener("scroll", sc, true);
    }
  };
  var sc = function() { bubble.style.display = "none"; window.removeEventListener("scroll", sc, true); document.removeEventListener("click", cl); };
  setTimeout(function() { document.addEventListener("click", cl); window.addEventListener("scroll", sc, true); }, 0);
}

function showGhHelp(e) {
  if (!e) e = window.event;
  var btn = e.currentTarget || e.target;
  var bubble = document.getElementById("ghHelpBubble");
  if (bubble.style.display !== "none") {
    bubble.style.display = "none";
    bubble.style.visibility = "hidden";
    requestHostResize();
    return;
  }

  // 先显示再测量真实尺寸，不再用固定的 200px 猜测帮助气泡高度。
  var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
  var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 480;
  bubble.style.maxWidth = Math.max(120, Math.min(300, viewportWidth - 16)) + "px";
  bubble.style.transform = "none";
  bubble.style.visibility = "hidden";
  bubble.style.left = "-9999px";
  bubble.style.top = "-9999px";
  bubble.style.display = "block";

  var rect = btn.getBoundingClientRect();
  var bubbleWidth = bubble.offsetWidth || Math.min(300, viewportWidth - 16);
  var bubbleHeight = bubble.offsetHeight || 180;
  var left = Math.max(8, Math.min(rect.right - bubbleWidth, viewportWidth - bubbleWidth - 8));
  var top = rect.bottom + 8;
  if (top + bubbleHeight > viewportHeight - 8) top = rect.top - bubbleHeight - 8;
  if (top < 8) top = 8;
  bubble.style.left = left + "px";
  bubble.style.top = top + "px";
  bubble.style.visibility = "visible";
  requestHostResize();
  var closeListener = function(ev) {
    if (!bubble.contains(ev.target) && ev.target !== btn) {
      bubble.style.display = "none";
      bubble.style.visibility = "hidden";
      document.removeEventListener("click", closeListener);
      requestHostResize();
    }
  };
  setTimeout(function() { document.addEventListener("click", closeListener); }, 0);
  // 滚动时关闭气泡
  var scrollClose = function() { bubble.style.display = "none"; bubble.style.visibility = "hidden"; document.removeEventListener("click", closeListener); window.removeEventListener("scroll", scrollClose, true); requestHostResize(); };
  setTimeout(function() { window.addEventListener("scroll", scrollClose, true); }, 0);
}

function switchGhTab(tab) {
  const validTabs = ["create", "connect", "clone", "list", "search"];
  if (!validTabs.includes(tab)) tab = "create";
  saveGhTab(tab);
  ensureGhOpen();
  document.querySelectorAll(".gh-tab-content").forEach(el => el.style.display = "none");
  document.querySelectorAll(".gh-tab").forEach(btn => {
    btn.style.background = "var(--hana-surface,#fff)";
    btn.style.color = "var(--hana-fg-muted,#6b7280)";
  });
  const tabEl = document.getElementById("ghTab" + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (tabEl) tabEl.style.display = "";
  const btn = document.querySelector(`.gh-tab[data-tab="${tab}"]`);
  if (btn) { btn.style.background = "var(--hana-accent,#4a8cff)"; btn.style.color = "#fff"; }
  // 切换标签后重算高度，避免上一个标签的 maxHeight 抢占造成内容溢出
  updateGhBodyHeight();
  if (tab === "connect") { loadGhConnectRepos(false); loadLocalRemotes(); }
  if (tab === "list") loadGhList(false);
}

// 重新贴合 ghBody 高度。逻辑：只有在打开状态才设，避免收起时无关赋值
function updateGhBodyHeight() {
  var ghBody = document.getElementById("ghBody");
  if (!ghBody) return;
  if (ghBody.style.maxHeight === "0px" || ghBody.style.maxHeight === "") {
    ghBody.style.maxHeight = "0px";
    return;
  }
  var height = ghBody.scrollHeight;
  ghBody.style.maxHeight = height + "px";
  requestHostResize();
}

function validateGhRepoName(name) {
  if (!name) return "仓库名不能为空";
  if (name.length > 100) return "仓库名不能超过 100 个字符";
  if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) return "仓库名只能包含字母、数字、连字符(-)、下划线(_)和点(.)";
  if (!/[a-zA-Z0-9]$/.test(name)) return "仓库名不能以连字符(-)或点(.)结尾";
  if (/^\./.test(name) || /^\-/.test(name)) return "仓库名不能以连字符(-)或点(.)开头";
  if (/\.\./.test(name)) return "仓库名不能包含连续的点(..)";
  // GitHub 允许 .git 结尾但不推荐
  if (/[.]git$/i.test(name)) return "仓库名不能以 .git 结尾";
  return null;
}

function ghConnectEnter(e) {
  if (e.key === "Enter") ghConnectRepo();
}

function selectGhRepoForConnect(url) {
  ensureGhOpen();
  switchGhTab("connect");
  openRemoteAddModal();
  const input = document.getElementById("ghConnectUrl");
  const select = document.getElementById("ghConnectRepoSelect");
  if (input) input.value = url || "";
  if (select) {
    select.value = "";
    if (select._hanaSelect) select._hanaSelect.sync();
  }
  const result = document.getElementById("ghConnectResult");
  if (result) result.textContent = "已把仓库地址带入关联表单，请确认后点击“关联当前仓库”。";
}

async function loadGhConnectRepos(force) {
  const select = document.getElementById("ghConnectRepoSelect");
  const status = document.getElementById("ghConnectRepoStatus");
  if (!select || select.dataset.loading === "1") return;
  select.dataset.loading = "1";
  if (status) status.textContent = force ? "正在刷新 GitHub 仓库..." : "正在读取 GitHub 仓库...";
  updateGhBodyHeight();
  const cached = !force && ghRepoCache.data;
  if (!cached) {
    select.innerHTML = '<option value="">加载我的 GitHub 仓库...</option>';
    if (select._hanaSelect) select._hanaSelect.replaceOptions(select.options);
  }
  try {
    const data = await requestGhRepos(!!force);
    if (!data.ok || !Array.isArray(data.repos)) throw new Error(data.message || "加载失败");
    select.innerHTML = '<option value="">请选择一个仓库</option>' + data.repos.map(function(repo) {
      const label = (repo.owner?.login ? repo.owner.login + "/" : "") + repo.name + (repo.isPrivate ? " 🔒" : "");
      return '<option value="' + escapeAttr(repo.url || "") + '">' + escapeHtml(label) + '</option>';
    }).join("");
    if (select._hanaSelect) select._hanaSelect.replaceOptions(select.options);
    if (status) status.textContent = "已加载 " + data.repos.length + " 个仓库";
    updateGhBodyHeight();
  } catch (e) {
    const message = e && e.message ? e.message : "未知错误";
    select.innerHTML = '<option value="">仓库列表加载失败</option>';
    if (select._hanaSelect) select._hanaSelect.replaceOptions(select.options);
    if (status) status.textContent = "加载失败：" + message;
    updateGhBodyHeight();
  } finally {
    select.dataset.loading = "0";
  }
}

function onGhConnectRepoSelect() {
  const select = document.getElementById("ghConnectRepoSelect");
  const input = document.getElementById("ghConnectUrl");
  if (select && input && select.value) input.value = select.value;
}

function refreshGhLicenseSelect() {
  const select = document.getElementById("ghLicense");
  if (select && select._hanaSelect) select._hanaSelect.sync();
}
