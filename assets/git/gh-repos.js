// Git Save/Load Card 前端模块 9/26：gh-repos.js — GitHub 仓库列表、右键编辑/删除、搜索；末尾 savePath 按原加载顺序保留在此
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// escapeAttr 已上移至 env.js。
function copyTextFallback(text) {
  const value = String(text || "");
  if (!value) return false;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand("copy"); } catch {}
  textarea.remove();
  return copied;
}

async function copyGhUrl(url) {
  const value = String(url || "").trim();
  if (!value) return;
  let copied = false;
  try {
    if (hana.clipboard && typeof hana.clipboard.writeText === "function") {
      await hana.clipboard.writeText(value);
      copied = true;
    }
  } catch {}
  if (!copied) copied = copyTextFallback(value);
  if (copied) {
    toast("✅ 已复制仓库地址", "success");
    return;
  }
  // 最后的可见手动复制入口，避免用户只能看到一个无上下文的失败提示。
  try {
    window.prompt("复制失败，请手动复制下面的仓库地址：", value);
  } catch {}
  toast("复制失败，请手动复制", "err");
}

function openGhUrl(url) {
  if (!url) return;
  const mode = getHanaSegValue("segGhOpen") || "internal";
  if (mode === "external") hana.external.open(url);
  else window.open(url, "_blank");
}

function formatGhUpdatedAt(value) {
  if (!value) return "";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch { return ""; }
}

function bindGhRepoActions(container) {
  container.querySelectorAll(".gh-open-btn").forEach(function(btn) {
    btn.onclick = function(e) { e.stopPropagation(); openGhUrl(btn.getAttribute("data-url") || ""); };
  });
  container.querySelectorAll(".gh-copy-btn").forEach(function(btn) {
    btn.onclick = function(e) { e.stopPropagation(); copyGhUrl(btn.getAttribute("data-url") || ""); };
  });
}

function renderGhRepoList(data, el) {
  if (!data || !data.ok || !Array.isArray(data.repos)) {
    el.innerHTML = '<div style="padding:8px;color:#c0392b;font-size:11px">加载失败：' + escapeHtml((data && data.message) || "未知错误") + '</div><button onclick="loadGhList(true)" style="margin-top:4px;padding:3px 8px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;background:transparent;color:var(--hana-accent,#5e6ad2);font-size:10px;cursor:pointer">重新加载</button>';
    return;
  }
  document.getElementById("ghNotInstalled").style.display = "none";
  ghRepoData = {};
  data.repos.forEach(function(r) { ghRepoData[((r.owner && r.owner.login) || "") + "/" + r.name] = r; });
  if (data.repos.length === 0) { el.innerHTML = '<div style="padding:8px;text-align:center;font-size:12px;color:var(--hana-fg-muted,#6b7280)">暂无仓库</div>'; return; }
  el.innerHTML = data.repos.map(function(r) {
    var repoName = ((r.owner && r.owner.login) || "") + "/" + r.name;
    return '<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--hana-border,#eef0f2);font-size:12px" oncontextmenu="showGhCtxMenu(event,\'' + escapeAttr(repoName) + '\')">'
      + '<span style="flex:1;min-width:0;overflow:hidden"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="font-weight:600">' + escapeHtml(r.name) + '</span><span style="color:var(--hana-fg-muted,#6b7280);margin-left:4px">' + escapeHtml(r.owner?.login || '') + '</span>' + (r.isPrivate ? '<span style="font-size:10px;color:#e67e22">🔒</span>' : '') + '</span><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hana-fg-muted,#6b7280);font-size:10px">' + escapeHtml(r.description || "无描述") + (formatGhUpdatedAt(r.updatedAt) ? " · 更新于 " + escapeHtml(formatGhUpdatedAt(r.updatedAt)) : "") + '</span></span>'
      + '<button class="gh-open-btn" data-url="' + escapeAttr(r.url || '') + '" style="padding:2px 6px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;font-size:10px;background:transparent;cursor:pointer;color:var(--hana-accent,#4a8cff);white-space:nowrap">打开</button>'
      + '<button class="gh-copy-btn" data-url="' + escapeAttr(r.url || '') + '" style="padding:2px 6px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;font-size:10px;background:transparent;cursor:pointer;color:var(--hana-fg-muted,#6b7280);white-space:nowrap">复制地址</button></div>';
  }).join('');
  bindGhRepoActions(el);
  var ghBody = document.getElementById("ghBody");
  if (ghBody && ghBody.style.maxHeight !== "0px" && ghBody.style.maxHeight !== "") updateGhBodyHeight();
}

async function loadGhList(force) {
  const el = document.getElementById("ghRepoList");
  if (!el) return;
  if (!force && ghRepoCache.data) { renderGhRepoList(ghRepoCache.data, el); return; }
  el.innerHTML = "加载中...";
  try {
    renderGhRepoList(await requestGhRepos(!!force), el);
  } catch (e) {
    renderGhRepoList({ ok: false, message: e && e.message ? e.message : "未知错误" }, el);
  }
}

// GitHub 右键菜单
let ghCtxRepo = null;
// 列表仓库数据缓存（编辑弹窗预填用）
let ghRepoData = {};


function showGhCtxMenu(e, repoName) {
  e.preventDefault();
  ghCtxRepo = repoName;
  const menu = document.getElementById("ghCtxMenu");
  menu.innerHTML = `
    <div class="item" onclick="ghEditRepo()">✏️ 编辑仓库</div>
    <div class="item danger" onclick="ghDeleteRepo()">✕ 删除 ${escapeHtml(repoName)}</div>
  `;
  openCtxMenuWithAnim(menu, e.clientX, e.clientY, 180, 90);
}

// ======== GitHub 仓库编辑 ========
let ghEditCtx = null;
function ghEditRepo() {
  const menu = document.getElementById("ghCtxMenu");
  if (menu) menu.style.display = "none";
  if (!ghCtxRepo) return;
  const data = ghRepoData[ghCtxRepo] || {};
  const parts = ghCtxRepo.split("/");
  ghEditCtx = {
    full: ghCtxRepo,
    owner: (data.owner && data.owner.login) || parts[0] || "",
    repo: data.name || parts[1] || "",
  };
  document.getElementById("ghEditRepoLabel").textContent = ghCtxRepo;
  document.getElementById("ghEditName").value = ghEditCtx.repo;
  document.getElementById("ghEditDesc").value = data.description || "";
  document.getElementById("ghEditLicense").value = (data.licenseInfo && data.licenseInfo.key) || "";
  document.getElementById("ghEditVisibility").value = data.isPrivate ? "private" : "public";
  syncHanaSelects();
  document.getElementById("ghEditResult").textContent = "";
  document.getElementById("ghEditModal").style.display = "flex";
  setTimeout(function() { document.getElementById("ghEditName").focus(); }, 50);
}
function closeGhEdit() {
  document.getElementById("ghEditModal").style.display = "none";
}
async function submitGhEdit() {
  if (!ghEditCtx) return;
  const newName = document.getElementById("ghEditName").value.trim();
  if (!newName) { toast("仓库名不能为空", "err"); return; }
  const desc = document.getElementById("ghEditDesc").value;
  const license = document.getElementById("ghEditLicense").value;
  const visibility = document.getElementById("ghEditVisibility").value;
  const el = document.getElementById("ghEditResult");
  el.textContent = "保存中...";
  el.style.color = "var(--hana-fg-muted,#6b7280)";
  try {
    const res = await pluginFetch("api/gh/edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ghEditCtx.full, newName: newName, description: desc, license: license, visibility: visibility }),
    });
    const data = await res.json();
    if (data.ok) {
      closeGhEdit();
      if (data.localRemote) {
        showConfirm(
          `本地仓库 ${data.localRemote.localPath} 的远程 ${data.localRemote.remote} 还指向旧地址，是否同步更新？`,
          "同步远程地址",
          function(ok) {
            if (ok) syncLocalRemote(data.localRemote);
            else toast("已跳过，可在关联页手动重新关联", "info");
          },
          false,
          { title: "⚠️ 同步本地远程地址", detailsHtml: `<div style='margin-bottom:6px'><b>本地仓库：</b>${escapeHtml(data.localRemote.localPath)}</div><div style='margin-bottom:6px'><b>远程名称：</b>${escapeHtml(data.localRemote.remote)}</div><div style='margin-bottom:6px'><b>旧地址：</b>${escapeHtml(data.localRemote.oldUrl)}</div><div><b>新地址：</b>${escapeHtml(data.localRemote.newUrl)}</div>` }
        );
      } else {
        toast("✅ " + (data.message || "仓库信息已更新"), "success");
      }
      invalidateGhRepoCache();
      loadGhList(true);
    } else {
      el.style.color = "#c0392b";
      el.textContent = "❌ " + (data.message || "保存失败");
    }
  } catch (e) {
    el.style.color = "#c0392b";
    el.textContent = "❌ " + e.message;
  }
}

// 同步本地仓库 remote 地址（远程仓库改名后）
async function syncLocalRemote(info) {
  try {
    const res = await pluginFetch("api/gh/sync-local-remote", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(info),
    });
    const data = await res.json();
    if (data.ok) { toast("✅ " + data.message, "success"); refresh(); }
    else toast("❌ " + data.message, "err");
  } catch (e) { toast("同步失败：" + e.message, "err"); }
}

async function ghDeleteRepo() {
  document.getElementById("ghCtxMenu").style.display = "none";
  if (!ghCtxRepo) return;
  const target = ghCtxRepo;
  showConfirm(
    `确定要删除 GitHub 仓库 ${target} 吗？此操作不可撤销。`,
    "删除仓库",
    async function(ok) {
      if (!ok) return;
      toast("删除中...", "info");
      try {
        const res = await pluginFetch("api/gh/delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: target, confirmed: true }),
        });
        const data = await res.json();
        if (data.ok) { toast(`已删除 ${target}`, "success"); invalidateGhRepoCache(); loadGhList(true); }
        else toast("❌ " + data.message, "err");
      } catch (e) { toast("❌ " + e.message, "err"); }
    },
    false,
    { title: "⚠️ 删除 GitHub 仓库", detailsHtml: "删除后远程仓库及其历史将无法通过此操作恢复。" }
  );
}

function ensureGhOpen() {
  var body = document.getElementById("ghBody");
  var toggle = document.getElementById("ghToggle");
  if (!body) return;
  if (body.style.maxHeight === "0px" || body.style.maxHeight === "") {
    body.style.maxHeight = body.scrollHeight + "px";
    if (toggle) toggle.textContent = "▾";
    requestHostResize();
  }
}

function ghSearchEnter(e) {
  if (e.key === "Enter") ghSearch();
}

var _searchCount = 0;
async function ghSearch() {
  _searchCount++;
  console.log("[search #" + _searchCount + "] start, ghBody maxHeight:", (document.getElementById("ghBody")||{}).style?.maxHeight);
  ensureGhOpen();
  switchGhTab("search");
  console.log("[search #" + _searchCount + "] after switchGhTab, ghBody maxHeight:", (document.getElementById("ghBody")||{}).style?.maxHeight);
  const q = document.getElementById("ghSearchQuery").value.trim();
  if (!q) { toast("请输入搜索关键词", "err"); return; }
  var st = document.getElementById("ghSearchStatus");
  var el = document.getElementById("ghSearchResult");
  st.textContent = "搜索中..."; st.style.display = "";
  el.innerHTML = "";
  // 等待浏览器渲染状态文字后再发起请求
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => setTimeout(r, 50));
  try {
    const res = await pluginFetch("api/gh/search?q=" + encodeURIComponent(q));
    const data = await res.json();
    if (!data.ok || !data.repos) { el.innerHTML = "搜索失败"; st.style.display = "none"; return; }
    if (data.repos.length === 0) { el.innerHTML = '<div style="padding:8px;text-align:center;font-size:12px;color:var(--hana-fg-muted,#6b7280)">未找到匹配的仓库</div>'; st.style.display = "none"; return; }
    el.innerHTML = data.repos.map(r =>
      `<div style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--hana-border,#eef0f2);font-size:12px">
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          <span style="font-weight:600">${escapeHtml(r.name)}</span>
          <span style="color:var(--hana-fg-muted,#6b7280);margin-left:4px">${escapeHtml(r.owner?.login || '')}</span>
        </span>
        <button class="gh-select-btn" data-url="${escapeAttr(r.url || '')}" style="padding:1px 6px;border:1px solid var(--hana-accent,#4a8cff);border-radius:4px;font-size:10px;background:none;cursor:pointer;color:var(--hana-accent,#4a8cff);font-family:inherit">带入关联</button>
        <button class="gh-open-btn" data-url="${escapeAttr(r.url || '')}" style="padding:1px 6px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;font-size:10px;background:none;cursor:pointer;color:var(--hana-accent,#4a8cff);font-family:inherit">打开</button>
      </div>`
    ).join('');
    st.style.display = "none";
    el.querySelectorAll(".gh-select-btn").forEach(function(b) {
      b.onclick = function(e) { e.stopPropagation(); selectGhRepoForConnect(b.getAttribute("data-url") || ""); };
    });
    el.querySelectorAll(".gh-open-btn").forEach(function(b) {
      b.onclick = function(e) { e.stopPropagation(); openGhUrl(b.getAttribute("data-url") || ""); };
    });
  } catch { el.innerHTML = "搜索失败"; st.style.display = "none"; }
  // 搜索结果渲染后重新计算 ghBody 高度
  var ghBody = document.getElementById("ghBody");
  if (ghBody && ghBody.style.maxHeight !== "0px" && ghBody.style.maxHeight !== "") {
    updateGhBodyHeight();
  }
  // 聚焦输入框
  var inp = document.getElementById("ghSearchQuery");
  if (inp) { inp.focus(); inp.select(); }
}

function savePath() {
  const p = document.getElementById("pathInput").value.trim();
  if (!p) { toast("请输入仓库路径", "err"); return; }
  compareCleanup();
  addRepoHistory(p);
  savePathToStorage(p);
  saveConfigPath(p);
  currentPath = p;
  _highlightedPath = p;            // 点击后的“预期”路径已成为事实
  onCurrentRepoChanged(p);
  cancelEditPath();
  refresh();
}
