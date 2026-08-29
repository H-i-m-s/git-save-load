// Git Save/Load Card 前端模块 7/26：remotes.js — 远程卡片渲染与操作、远程地址/名称编辑、添加远程弹窗
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
function remoteButton(label, primary, action, remote, branch, danger) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.remote = remote;
  button.className = "remote-action-btn" + (primary ? " remote-action-primary" : "") + (danger ? " remote-action-danger" : "");
  if (action === "overwrite") button.title = "用当前本地已提交历史覆盖指定远程分支";
  if (branch) button.dataset.remoteBranch = branch;
  return button;
}

function remoteStatusInfo(remoteInfo, detached) {
  if (detached) return { label: "当前处于 detached HEAD", tone: "error", dot: "error", card: "error" };
  if (!remoteInfo.hasRemoteBranch) return { label: "未找到可比较的远程分支", tone: "warn", dot: "warn", card: "" };
  if (remoteInfo.comparisonStatus && remoteInfo.comparisonStatus !== "OK") return { label: "暂时无法比较", tone: "error", dot: "error", card: "error" };

  // 默认获取来源与默认推送目标是两个独立语义：
  // 对 upstream 这类 fetch-only 远程，本地领先只表示本地拥有自有提交，不能显示成“未推送”。
  const fetchOnly = remoteInfo.isDefaultFetch && !remoteInfo.isDefaultPush;
  if (fetchOnly) {
    if (remoteInfo.remoteAhead > 0 && remoteInfo.localAhead > 0) {
      return { label: `远程领先 ${remoteInfo.remoteAhead} 个提交 · 本地另有 ${remoteInfo.localAhead} 个提交`, tone: "warn", dot: "warn", card: "attention" };
    }
    if (remoteInfo.remoteAhead > 0) {
      return { label: `远程领先 ${remoteInfo.remoteAhead} 个提交`, tone: "info", dot: "info", card: "attention" };
    }
    if (remoteInfo.localAhead > 0) {
      return { label: `远程已同步 · 本地另有 ${remoteInfo.localAhead} 个提交`, tone: "ok", dot: "ok", card: "" };
    }
    return { label: "远程已同步", tone: "ok", dot: "ok", card: "" };
  }

  if (remoteInfo.remoteAhead > 0 && remoteInfo.localAhead > 0) return { label: `已分叉 · 远程 ${remoteInfo.remoteAhead} / 本地 ${remoteInfo.localAhead}`, tone: "warn", dot: "warn", card: "attention" };
  if (remoteInfo.remoteAhead > 0) return { label: `远程领先 ${remoteInfo.remoteAhead} 个提交`, tone: "info", dot: "info", card: "attention" };
  if (remoteInfo.localAhead > 0) return { label: `本地领先 ${remoteInfo.localAhead} 个提交`, tone: "info", dot: "info", card: "" };
  return { label: "已同步", tone: "ok", dot: "ok", card: "" };
}

var remoteBranchSelectSeq = 0;

function remoteRoleInfo(remoteInfo) {
  if (remoteInfo.isDefaultPush && remoteInfo.isDefaultFetch) return { label: "推送 · 获取", cls: "remote-role-both" };
  if (remoteInfo.isDefaultPush) return { label: "推送目标", cls: "remote-role-push" };
  if (remoteInfo.isDefaultFetch) return { label: "更新来源", cls: "remote-role-upstream" };
  return { label: "自定义远程", cls: "" };
}

function appendRemoteMoreMenu(button, remoteInfo) {
  button.addEventListener("click", function(e) {
    e.stopPropagation();
    const menu = document.getElementById("remoteCtxMenu");
    if (!menu) return;
    closeAllCtxMenus();
    const url = remoteInfo.fetchUrl || remoteInfo.displayUrl || remoteInfo.pushUrl || "";
    menu.innerHTML = "";
    const addItem = function(label, handler, danger) {
      const item = document.createElement("div");
      item.className = "item" + (danger ? " danger" : "");
      item.textContent = label;
      item.addEventListener("click", function(ev) { ev.stopPropagation(); menu.style.display = "none"; handler(); });
      menu.appendChild(item);
    };
    addItem("复制远程地址", function() { copyGhUrl(url); });
    addItem("在浏览器中打开", function() { openGhUrl(url); });
    addItem("修改远程", function() { editLocalRemote(remoteInfo); });
    addItem(remoteInfo.isDefaultPush ? "取消默认推送目标" : "设为默认推送目标", function() { setRemoteRole(remoteInfo.name, remoteInfo.isDefaultPush ? "other" : "push-target"); });
    addItem(remoteInfo.isDefaultFetch ? "取消默认获取来源" : "设为默认获取来源", function() { setRemoteRole(remoteInfo.name, remoteInfo.isDefaultFetch ? "other" : "update-source"); });
    addItem("移除远程", function() { removeLocalRemote(remoteInfo.name); }, true);
    openCtxMenuWithAnim(menu, e.clientX, e.clientY, 150, 120);
  });
}

function bindLocalRemoteActions(container) {
  container.querySelectorAll("button[data-action]").forEach(function(button) {
    button.addEventListener("click", function(e) {
      e.stopPropagation();
      const remote = button.dataset.remote || "";
      const branch = button.dataset.remoteBranch || "";
      if (button.dataset.action === "fetch") fetchRemoteUpdates(remote, branch);
      else if (button.dataset.action === "merge") mergeRemoteUpdates(remote, branch);
      else if (button.dataset.action === "overwrite") overwriteRemoteFromCard(button, remote, branch);
    });
  });
}

async function overwriteRemoteFromCard(button, remote, branch) {
  const p = currentPath || getSavedPath();
  if (!p || !remote || !branch) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "检查中...";
  try {
    const res = await pluginFetch("api/remote-overwrite", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, remote, remoteBranch: branch, confirmed: false }),
    });
    const data = await res.json();
    button.disabled = false;
    button.textContent = original;
    if (!data.ok && data.code === "REMOTE_OVERWRITE_CONFIRM") {
      showConfirm(
        `确定用本地分支覆盖 ${remote}/${branch} 吗？`,
        "⚠️ 覆盖远程分支",
        function(ok) { if (ok) performRemoteOverwrite(button, data); },
        false,
        { title: "本地版本将覆盖远程", detailsHtml: `<div style='margin-bottom:6px'><b>本地分支：</b>${escapeHtml(data.localBranch || "当前分支")}</div><div style='margin-bottom:6px'><b>目标分支：</b>${escapeHtml(data.remote || remote)}/${escapeHtml(data.remoteBranch || branch)}</div><div style='margin-bottom:6px'><b>本地提交：</b><code>${escapeHtml((data.localHash || "").slice(0, 12))}</code></div><div style='margin-bottom:6px'><b>远程提交：</b><code>${escapeHtml((data.remoteHash || "尚未建立").slice(0, 12))}</code></div>${data.dirty ? `<div style='margin-bottom:6px;color:#b45309'><b>注意：</b>工作区有未提交修改；覆盖只推送已提交历史，不会上传这些未提交文件。</div>` : ""}<div style='margin-top:8px;color:#b91c1c;font-weight:600'>远程分支现有历史可能被本地版本替换。此操作不会修改本地工作区。</div>` }
      );
      return;
    }
    if (data.code === "REMOTE_OVERWRITE_PROTECTED") {
      toast("⛔ " + (data.message || "默认获取来源不可覆盖，请改用推送目标"), "err");
    } else {
      toast("❌ " + (data.message || "检查覆盖条件失败"), "err");
    }
  } catch (e) {
    button.disabled = false;
    button.textContent = original;
    toast("覆盖远程失败：" + e.message, "err");
  }
}

async function performRemoteOverwrite(button, context) {
  const p = currentPath || getSavedPath();
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "覆盖中...";
  try {
    const res = await pluginFetch("api/remote-overwrite", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, remote: context.remote, branch: context.localBranch, remoteBranch: context.remoteBranch, expectedLocalHash: context.localHash, expectedRemoteHash: context.remoteHash, confirmed: true }),
    });
    const data = await res.json();
    if (data.ok) {
      button.textContent = "✅ 已覆盖";
      toast("✅ " + data.message, "success");
      invalidateRemoteCache(p);
      setTimeout(function() { loadLocalRemotes(context.remote, context.remoteBranch, undefined, true); }, 500);
      return;
    }
    button.disabled = false;
    button.textContent = original;
    toast("❌ " + (data.message || "覆盖远程失败"), "err");
    if (data.code === "REMOTE_CHANGED" || data.code === "LOCAL_CHANGED") { invalidateRemoteCache(p); loadLocalRemotes(context.remote, context.remoteBranch, undefined, true); }
  } catch (e) {
    button.disabled = false;
    button.textContent = original;
    toast("覆盖远程失败：" + e.message, "err");
  }
}

async function setRemoteRole(remote, role) {
  const p = currentPath || getSavedPath();
  if (!p) return;
  try {
    const res = await pluginFetch("api/remote-role", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, remote, role }),
    });
    const data = await res.json();
    if (!data.ok) { toast("❌ " + (data.message || "设置远程角色失败"), "err"); return; }
    toast("✅ " + data.message, "success");
    invalidateRemoteCache(p);
    loadLocalRemotes(remote, "", undefined, true);
  } catch (e) { toast("设置远程角色失败：" + e.message, "err"); }
}

var _remoteUrlEditRemote = "";
var _remoteUrlEditCurrentUrl = "";
var _remoteUrlEditCurrentPushUrl = "";
var _remoteUrlEditHasPushUrl = false;
var _remoteUrlEditConfirmation = null;

function editLocalRemote(remoteInfo) {
  const remote = remoteInfo && remoteInfo.name ? remoteInfo.name : "";
  if (!remote) return;
  _remoteUrlEditRemote = remote;
  _remoteUrlEditCurrentUrl = remoteInfo.displayUrl || remoteInfo.fetchUrl || "";
  _remoteUrlEditCurrentPushUrl = remoteInfo.pushUrl || _remoteUrlEditCurrentUrl;
  _remoteUrlEditHasPushUrl = remoteInfo.hasPushUrl === true;
  _remoteUrlEditConfirmation = null;
  const modal = document.getElementById("remoteUrlEditModal");
  const title = document.getElementById("remoteUrlEditTitle");
  const nameInput = document.getElementById("remoteNameEditInput");
  const input = document.getElementById("remoteUrlEditInput");
  const pushInput = document.getElementById("remotePushUrlEditInput");
  const clearPush = document.getElementById("remoteClearPushUrl");
  const current = document.getElementById("remoteUrlEditCurrent");
  const result = document.getElementById("remoteUrlEditResult");
  const select = document.getElementById("remoteUrlRepoSelect");
  if (!modal || !nameInput || !input || !pushInput) return;
  if (title) title.textContent = `修改远程：${remote}`;
  nameInput.value = remote;
  // 只回填安全、未脱敏的地址；含 *** 的地址只放在状态/placeholder 中，避免把脱敏值写回 Git。
  input.value = canPrefillRemoteUrl(_remoteUrlEditCurrentUrl) ? _remoteUrlEditCurrentUrl : "";
  pushInput.value = _remoteUrlEditHasPushUrl && canPrefillRemoteUrl(_remoteUrlEditCurrentPushUrl) ? _remoteUrlEditCurrentPushUrl : "";
  input.placeholder = _remoteUrlEditCurrentUrl ? `当前：${_remoteUrlEditCurrentUrl}；留空表示保持不变` : "输入新的获取地址";
  pushInput.placeholder = _remoteUrlEditCurrentPushUrl ? `当前：${_remoteUrlEditCurrentPushUrl}；留空表示保持不变` : "留空表示跟随获取地址";
  if (clearPush) clearPush.checked = false;
  syncRemotePushUrlClearState();
  if (current) current.textContent = `当前获取：${_remoteUrlEditCurrentUrl || "未知"}；当前推送：${_remoteUrlEditHasPushUrl ? _remoteUrlEditCurrentPushUrl : "跟随获取"}`;
  if (result) result.textContent = "";
  if (select) { select.value = ""; if (select._hanaSelect) select._hanaSelect.sync(); }
  modal.style.display = "flex";
  loadRemoteUrlRepos();
  setTimeout(function() { nameInput.focus(); nameInput.select(); }, 50);
  updateGhBodyHeight();
}

function closeRemoteUrlEdit(preserveConfirmation) {
  const modal = document.getElementById("remoteUrlEditModal");
  const select = document.getElementById("remoteUrlRepoSelect");
  if (select && select._hanaSelect) {
    select._hanaSelect.close();
    select.value = "";
    select._hanaSelect.sync();
  }
  if (modal) modal.style.display = "none";
  _remoteUrlEditRemote = "";
  _remoteUrlEditCurrentUrl = "";
  _remoteUrlEditCurrentPushUrl = "";
  _remoteUrlEditHasPushUrl = false;
  if (!preserveConfirmation) _remoteUrlEditConfirmation = null;
  updateGhBodyHeight();
}

function canPrefillRemoteUrl(url) {
  const value = String(url || "").trim();
  return !!value && !value.includes("***") && !/[\r\n]/.test(value);
}

function githubRepoIdentity(url) {
  let value = String(url || "").trim();
  if (!value) return "";
  const scp = value.match(/^([^@\s]+)@([^:]+):(.+)$/i);
  if (scp) value = "https://" + scp[2] + "/" + scp[3];
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname || "").toLowerCase().replace(/^www\./, "");
    if (host !== "github.com") return "";
    const path = String(parsed.pathname || "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .toLowerCase();
    return path ? host + "/" + path : "";
  } catch {
    return "";
  }
}

function githubRepoParts(identity) {
  const value = String(identity || "").trim().toLowerCase();
  if (!value.startsWith("github.com/")) return null;
  const parts = value.slice("github.com/".length).split("/").filter(Boolean);
  return parts.length >= 2 ? { owner: parts[0], name: parts[1], identity: value } : null;
}

function githubRepoUrlFromIdentity(identity) {
  const parts = githubRepoParts(identity);
  return parts ? "https://github.com/" + parts.owner + "/" + parts.name : "";
}

async function loadRemoteUrlRepos(force) {
  const select = document.getElementById("remoteUrlRepoSelect");
  if (!select || select.dataset.loading === "1") return;
  select.dataset.loading = "1";
  select.innerHTML = '<option value="">正在加载 GitHub 仓库...</option>';
  if (select._hanaSelect) select._hanaSelect.replaceOptions(select.options);
  try {
    const data = await requestGhRepos(!!force);
    if (!data.ok || !Array.isArray(data.repos)) throw new Error(data.message || "加载失败");
    const currentIdentity = githubRepoIdentity(_remoteUrlEditCurrentUrl);
    let matchedUrl = "";
    let optionsHtml = data.repos.map(function(repo) {
      const owner = repo.owner && repo.owner.login ? repo.owner.login + "/" : "";
      const label = owner + repo.name + (repo.isPrivate ? " 🔒" : "");
      const repoUrl = repo.url || "";
      if (!matchedUrl && currentIdentity && githubRepoIdentity(repoUrl) === currentIdentity) matchedUrl = repoUrl;
      return '<option value="' + escapeAttr(repoUrl) + '">' + escapeHtml(label) + '</option>';
    }).join("");
    // 当前远程可能不在 gh repo list 的前 30 个结果中，仍把已连接的 GitHub 仓库作为安全的临时选项补入。
    const currentParts = githubRepoParts(currentIdentity);
    const viewerLogin = String(data.viewerLogin || "").trim().toLowerCase();
    if (currentParts && !matchedUrl && viewerLogin && currentParts.owner === viewerLogin) {
      const currentUrl = githubRepoUrlFromIdentity(currentIdentity);
      const currentLabel = currentParts.owner + "/" + currentParts.name;
      optionsHtml += '<option value="' + escapeAttr(currentUrl) + '">当前连接：' + escapeHtml(currentLabel) + '</option>';
      matchedUrl = currentUrl;
    }
    select.innerHTML = '<option value="">请选择一个仓库</option>' + optionsHtml;
    if (matchedUrl) select.value = matchedUrl;
    if (select._hanaSelect) {
      select._hanaSelect.replaceOptions(select.options);
      select._hanaSelect.sync();
    }
  } catch (e) {
    select.innerHTML = '<option value="">仓库列表加载失败</option>';
    if (select._hanaSelect) select._hanaSelect.replaceOptions(select.options);
    const result = document.getElementById("remoteUrlEditResult");
    if (result) result.textContent = "加载失败：" + e.message;
  } finally {
    select.dataset.loading = "0";
    updateGhBodyHeight();
  }
}

function onRemoteUrlRepoSelect() {
  const select = document.getElementById("remoteUrlRepoSelect");
  const input = document.getElementById("remoteUrlEditInput");
  if (select && input && select.value) input.value = select.value;
}

function syncRemotePushUrlClearState() {
  const clearPush = document.getElementById("remoteClearPushUrl");
  const pushInput = document.getElementById("remotePushUrlEditInput");
  if (!clearPush || !pushInput) return;
  pushInput.disabled = clearPush.checked;
  if (clearPush.checked) pushInput.value = "";
}

async function submitRemoteUrlEdit() {
  const remote = _remoteUrlEditRemote;
  const nameInput = document.getElementById("remoteNameEditInput");
  const input = document.getElementById("remoteUrlEditInput");
  const pushInput = document.getElementById("remotePushUrlEditInput");
  const clearPush = document.getElementById("remoteClearPushUrl");
  const result = document.getElementById("remoteUrlEditResult");
  const newRemote = nameInput ? nameInput.value.trim() : "";
  const enteredUrl = input ? input.value.trim() : "";
  const enteredPushUrl = pushInput ? pushInput.value.trim() : "";
  // 当前安全地址是预填值，未被用户修改时仍按“保持不变”处理，避免无操作也被当成地址变更。
  const newUrl = enteredUrl && enteredUrl !== _remoteUrlEditCurrentUrl ? enteredUrl : "";
  const newPushUrl = enteredPushUrl && enteredPushUrl !== _remoteUrlEditCurrentPushUrl ? enteredPushUrl : "";
  const clearPushUrl = clearPush ? clearPush.checked : false;
  if (!remote || !newRemote) {
    if (result) result.textContent = "请输入远程名称";
    return;
  }
  if (result) result.textContent = "检查远程配置中...";
  await performEditLocalRemote(remote, newRemote, newUrl, newPushUrl, clearPushUrl, false);
}

async function performEditLocalRemote(oldRemote, newRemote, newUrl, newPushUrl, clearPushUrl, confirmed) {
  const p = currentPath || getSavedPath();
  if (!p) return;
  try {
    const res = await pluginFetch("api/remote-edit", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, oldRemote, newRemote, newUrl, newPushUrl, clearPushUrl: !!clearPushUrl, expectedRevision: _remoteUrlEditConfirmation && _remoteUrlEditConfirmation.revision, confirmationToken: _remoteUrlEditConfirmation && _remoteUrlEditConfirmation.confirmationToken, confirmed: !!confirmed }),
    });
    const data = await res.json();
    if (data.code === "REMOTE_EDIT_CONFIRM") {
      _remoteUrlEditConfirmation = { revision: data.revision, confirmationToken: data.confirmationToken };
      closeRemoteUrlEdit(true);
      const nameChanged = oldRemote !== newRemote;
      const pushSummary = clearPushUrl ? "清除独立推送地址" : (newPushUrl ? escapeHtml(data.newPushUrl || newPushUrl) : (data.pushChanged ? escapeHtml(data.oldPushUrl || "保持当前推送地址") : "保持不变"));
      showConfirm(
        `确定修改远程 ${oldRemote} 吗？`,
        "确认修改远程",
        function(ok) { if (ok) performEditLocalRemote(oldRemote, newRemote, newUrl, newPushUrl, clearPushUrl, true); },
        false,
        { title: "修改远程", detailsHtml: `<div style='margin-bottom:6px'><b>远程名称：</b>${escapeHtml(oldRemote)} ${nameChanged ? `→ <b>${escapeHtml(newRemote)}</b>` : "（保持不变）"}</div><div style='margin-bottom:6px'><b>获取地址：</b>${newUrl ? escapeHtml(data.newUrl || newUrl) : "（保持不变）"}</div><div style='margin-bottom:6px'><b>推送地址：</b>${pushSummary}</div><div style='margin-top:8px;color:var(--hana-fg-muted,#6b7280)'>新的获取/推送地址会分别验证可访问性；失败时名称、地址和默认角色设置都会恢复。</div>` }
      );
      return;
    }
    if (data.code === "REMOTE_CHANGED") {
      _remoteUrlEditConfirmation = null;
      toast("远程配置已变化，请刷新后重新修改", "err");
      loadLocalRemotes();
      return;
    }
    if (!data.ok) {
      const current = document.getElementById("remoteUrlEditResult");
      if (current) current.textContent = data.message || "修改远程失败";
      toast("❌ " + (data.message || "修改远程失败"), "err");
      return;
    }
    _remoteUrlEditConfirmation = null;
    closeRemoteUrlEdit();
    toast("✅ " + (data.message || "远程已更新"), "success");
    invalidateRemoteCache(p);
    loadLocalRemotes(data.newRemote || newRemote, "", undefined, true);
  } catch (e) { toast("修改远程失败：" + e.message, "err"); }
}

function openRemoteAddModal() {
  ensureGhOpen();
  switchGhTab("connect");
  const modal = document.getElementById("remoteAddModal");
  const url = document.getElementById("ghConnectUrl");
  const remote = document.getElementById("ghConnectRemote");
  const result = document.getElementById("ghConnectResult");
  const status = document.getElementById("ghConnectRepoStatus");
  if (url) url.value = "";
  if (remote && !remote.value.trim()) remote.value = "origin";
  if (result) result.textContent = "";
  if (status) status.textContent = "";
  if (modal) modal.style.display = "flex";
  loadGhConnectRepos(false);
  setTimeout(function() { if (url) url.focus(); }, 50);
}

function closeRemoteAddModal() {
  const modal = document.getElementById("remoteAddModal");
  const select = document.getElementById("ghConnectRepoSelect");
  if (select && select._hanaSelect) {
    select._hanaSelect.close();
    select.value = "";
    select._hanaSelect.sync();
  }
  if (modal) modal.style.display = "none";
  updateGhBodyHeight();
}

function toggleRemoteAddForm(forceOpen) {
  if (forceOpen === false) closeRemoteAddModal();
  else openRemoteAddModal();
}

function renderRemoteOverview(data) {
  const branchEl = document.getElementById("ghRemoteCurrentBranch");
  const pushEl = document.getElementById("ghRemotePushTarget");
  const fetchEl = document.getElementById("ghRemoteFetchSource");
  const countEl = document.getElementById("ghRemoteCount");
  if (branchEl) branchEl.textContent = data.detached ? "detached HEAD" : (data.branch || "未检出分支");
  if (pushEl) pushEl.textContent = data.pushRemote || "未设置";
  if (fetchEl) fetchEl.textContent = data.fetchRemote || "未设置";
  if (countEl) countEl.textContent = `${(data.remotes || []).length} 个远程`;
}

function cleanupRemoteBranchSelects() {
  const list = document.getElementById("ghRemoteList");
  if (!list) return;
  list.querySelectorAll("select[id^='ghRemoteBranchSelect']").forEach(function(select) {
    const hs = select._hanaSelect;
    if (hs) {
      hs.close();
      if (hs.trigger && hs.trigger.parentNode) hs.trigger.parentNode.removeChild(hs.trigger);
      if (hs.panel && hs.panel.parentNode) hs.panel.parentNode.removeChild(hs.panel);
      _hanaSelectInstances.delete(select.id);
    }
  });
}

function compactRemoteUrl(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  const scp = value.match(/^(?:[^@\s]+)@([^:\s]+):(.+)$/);
  if (scp) {
    const host = scp[1].toLowerCase();
    const path = scp[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return host === "github.com" ? path : host + ":" + path;
  }
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname || "").toLowerCase().replace(/^www\./, "");
    const path = String(parsed.pathname || "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (host === "github.com" && path) return path;
    return host + (path ? "/" + path : "");
  } catch {
    return value.replace(/^https?:\/\//i, "").replace(/\.git$/i, "");
  }
}

function setRemoteListActivity(message, isError) {
  const el = document.getElementById("ghRemoteList");
  if (!el) return;
  let activity = el.querySelector(".remote-list-activity");
  if (!message) {
    if (activity) activity.remove();
    return;
  }
  if (!activity) {
    activity = document.createElement("div");
    activity.className = "remote-list-activity";
    el.appendChild(activity);
  }
  activity.classList.toggle("error", !!isError);
  activity.textContent = message;
}

function setRemoteCardBusy(remote, busy, message) {
  const el = document.getElementById("ghRemoteList");
  if (!el) return;
  const card = Array.from(el.querySelectorAll(".remote-card")).find(function(item) { return item.dataset.remote === remote; });
  if (!card) return;
  card.classList.toggle("remote-card-busy", !!busy);
  card.querySelectorAll("button[data-action]").forEach(function(button) {
    button.disabled = !!busy;
  });
  let hint = card.querySelector(".remote-card-action-hint");
  if (!hint) {
    const actions = card.querySelector(".remote-card-actions");
    if (!actions) return;
    hint = document.createElement("div");
    hint.className = "remote-card-action-hint";
    actions.appendChild(hint);
  }
  if (!hint.dataset.defaultText) hint.dataset.defaultText = hint.textContent || "";
  const wasBusy = hint.classList.contains("remote-card-busy-status");
  if (busy) {
    hint.textContent = message || "处理中...";
    hint.classList.add("remote-card-busy-status");
    hint.style.color = "";
  } else if (wasBusy) {
    hint.textContent = hint.dataset.defaultText;
    hint.classList.remove("remote-card-busy-status");
    hint.style.color = "";
  }
}

function setRemoteCardHint(remote, message, isError) {
  const el = document.getElementById("ghRemoteList");
  if (!el) return;
  const card = Array.from(el.querySelectorAll(".remote-card")).find(function(item) { return item.dataset.remote === remote; });
  if (!card) return;
  const hint = card.querySelector(".remote-card-action-hint");
  if (!hint) return;
  if (!hint.dataset.defaultText) hint.dataset.defaultText = hint.textContent || "";
  hint.textContent = message || hint.dataset.defaultText;
  hint.style.color = isError ? "#c0392b" : "";
}

function renderLocalRemotes(data) {
  const el = document.getElementById("ghRemoteList");
  if (!el) return;
  cleanupRemoteBranchSelects();
  renderRemoteOverview(data || {});
  if (!data || !data.ok) {
    el.textContent = "";
    const error = document.createElement("div");
    error.className = "remote-empty";
    error.style.color = "#c0392b";
    error.textContent = "读取失败：" + ((data && data.message) || "未知错误");
    el.appendChild(error);
    updateGhBodyHeight();
    return;
  }
  if (!data.remotes || data.remotes.length === 0) {
    el.textContent = "";
    const empty = document.createElement("div");
    empty.className = "remote-empty";
    empty.textContent = "当前还没有远程仓库";
    el.appendChild(empty);
    updateGhBodyHeight();
    return;
  }
  el.textContent = "";
  data.remotes.forEach(function(remoteInfo) {
    const branch = remoteInfo.remoteBranch || remoteInfo.defaultBranch || "";
    const overwriteBranch = branch || data.branch || "";
    const status = remoteStatusInfo(remoteInfo, data.detached);
    const role = remoteRoleInfo(remoteInfo);
    const card = document.createElement("div");
    card.className = "remote-card" + (status.card ? " remote-card-" + status.card : "");
    card.dataset.remote = remoteInfo.name;

    const header = document.createElement("div");
    header.className = "remote-card-head";
    const dot = document.createElement("span");
    dot.className = "remote-card-dot remote-dot-" + status.dot;
    const name = document.createElement("span");
    name.className = "remote-card-name";
    name.textContent = remoteInfo.name;
    name.title = remoteInfo.name;
    const badge = document.createElement("span");
    badge.className = "remote-role-badge " + role.cls;
    badge.textContent = role.label;
    const more = document.createElement("button");
    more.type = "button";
    more.className = "remote-more-btn";
    more.textContent = "⋯";
    more.title = "更多操作";
    more.setAttribute("aria-label", `${remoteInfo.name} 更多操作`);
    appendRemoteMoreMenu(more, remoteInfo);
    header.append(dot, name, badge, more);
    card.appendChild(header);

    const urlRow = document.createElement("div");
    urlRow.className = "remote-card-url";
    const fullUrl = remoteInfo.fetchUrl || remoteInfo.displayUrl || remoteInfo.pushUrl || "";
    const urlText = document.createElement("span");
    urlText.className = "remote-card-url-text";
    urlText.textContent = compactRemoteUrl(fullUrl) || "未设置地址";
    urlText.title = fullUrl || "未设置地址";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "remote-copy-btn";
    copy.textContent = "⧉";
    copy.title = "复制完整远程地址";
    copy.addEventListener("click", function(e) { e.stopPropagation(); copyGhUrl(fullUrl); });
    urlRow.append(urlText, copy);
    card.appendChild(urlRow);

    const statusRow = document.createElement("div");
    statusRow.className = "remote-status-row";
    const statusBadge = document.createElement("span");
    statusBadge.className = "remote-status-badge remote-status-" + status.tone;
    statusBadge.textContent = status.label;
    statusRow.appendChild(statusBadge);
    card.appendChild(statusRow);

    const relation = document.createElement("div");
    relation.className = "remote-card-relation";
    if (data.detached) relation.textContent = "请先切换到本地分支，再比较或合并远程更新";
    else {
      const source = document.createElement("code");
      source.textContent = branch ? `${remoteInfo.name}/${branch}` : "未找到远程分支";
      const arrow = document.createTextNode("  →  ");
      const target = document.createElement("code");
      target.textContent = data.branch || "当前分支";
      relation.append(source, arrow, target);
    }
    card.appendChild(relation);

    const branches = Array.isArray(remoteInfo.branches) ? remoteInfo.branches : [];
    let remoteBranchSelectId = "";
    if (branches.length > 1) {
      const branchRow = document.createElement("div");
      branchRow.className = "remote-branch-row";
      const label = document.createElement("span");
      label.className = "remote-branch-label";
      label.textContent = "源分支";
      const select = document.createElement("select");
      select.id = "ghRemoteBranchSelect" + (++remoteBranchSelectSeq);
      remoteBranchSelectId = select.id;
      select.setAttribute("aria-label", `${remoteInfo.name} 远程源分支`);
      branches.forEach(function(branchName) {
        const option = document.createElement("option");
        option.value = branchName;
        option.textContent = `${remoteInfo.name}/${branchName}`;
        option.selected = branchName === branch;
        select.appendChild(option);
      });
      branchRow.append(label, select);
      card.appendChild(branchRow);
    } else {
      const branchRow = document.createElement("div");
      branchRow.className = "remote-branch-row";
      const label = document.createElement("span");
      label.className = "remote-branch-label";
      label.textContent = "源分支";
      const value = document.createElement("code");
      value.className = "remote-branch-value";
      value.textContent = branch ? `${remoteInfo.name}/${branch}` : "未找到";
      branchRow.append(label, value);
      card.appendChild(branchRow);
    }

    const actions = document.createElement("div");
    actions.className = "remote-card-actions";
    const actionButtons = document.createElement("div");
    actionButtons.className = "remote-card-action-buttons";
    const fetchButton = remoteButton("获取远程更新", remoteInfo.isDefaultFetch, "fetch", remoteInfo.name, branch);
    fetchButton.title = "只获取远程最新提交，不修改当前本地分支";
    actionButtons.appendChild(fetchButton);
    if (remoteInfo.hasRemoteBranch && remoteInfo.remoteAhead > 0 && branch && !data.detached) {
      const mergeButton = remoteButton(`合并到当前分支（${remoteInfo.remoteAhead}）`, true, "merge", remoteInfo.name, branch);
      mergeButton.title = "把该远程分支合并到当前本地分支，会修改本地文件和提交历史";
      actionButtons.appendChild(mergeButton);
    }
    const fetchOnly = remoteInfo.isDefaultFetch && !remoteInfo.isDefaultPush;
    if (overwriteBranch && !data.detached && !fetchOnly) {
      const overwriteButton = remoteButton("覆盖远程", false, "overwrite", remoteInfo.name, overwriteBranch, true);
      overwriteButton.title = "用当前本地已提交历史改写目标远程分支，需二次确认";
      actionButtons.appendChild(overwriteButton);
    }
    actions.appendChild(actionButtons);
    const hint = document.createElement("div");
    hint.className = "remote-card-action-hint";
    hint.textContent = status.tone === "error"
      ? "请检查当前分支或远程状态。"
      : (status.tone === "warn" && remoteInfo.comparisonStatus === "REMOTE_BRANCH_MISSING"
        ? "请先获取远程更新，或选择已有的远程源分支。"
        : (fetchOnly
          ? "默认获取来源不可覆盖；获取只更新远程引用，合并才会修改当前分支。"
          : "获取只更新远程引用；合并才会修改当前分支。"));
    actions.appendChild(hint);
    card.appendChild(actions);
    el.appendChild(card);
    // 必须在 card 插入文档后初始化，否则 getElementById 找不到动态创建的 select，最终会退回原生下拉。
    if (remoteBranchSelectId && typeof replaceSelectWithHanaSelect === "function") {
      replaceSelectWithHanaSelect(remoteBranchSelectId, { fullWidth: true, onChange: function(value) { fetchRemoteUpdates(remoteInfo.name, value); } });
    }
  });
  bindLocalRemoteActions(el);
  updateGhBodyHeight();
}

function onCurrentRepoChanged(path) {
  const normalized = String(path || "").trim();
  _remotePanelPath = normalized;
  invalidateRemoteCache(normalized);
  _remoteLoadGeneration++;
  const el = document.getElementById("ghRemoteList");
  if (el) el.innerHTML = normalized
    ? '<div style="font-size:10px;color:var(--hana-fg-muted,#6b7280)">正在切换远程仓库...</div>'
    : '<div style="font-size:10px;color:#c0392b">请先选择本地仓库</div>';
  if (normalized) loadLocalRemotes(undefined, undefined, normalized, false);
  else renderRemoteOverview({ remotes: [], branch: "", pushRemote: "", fetchRemote: "" });
}

async function loadLocalRemotes(preferredRemote, preferredBranch, requestedPath, force, quiet) {
  const p = String(requestedPath || currentPath || getSavedPath()).trim();
  _remotePanelPath = p;
  const el = document.getElementById("ghRemoteList");
  if (!p) { if (el) el.innerHTML = '<div style="font-size:10px;color:#c0392b">请先选择本地仓库</div>'; return; }
  const cacheKey = remoteCacheKey(p, preferredRemote, preferredBranch);
  const cached = remoteDataCache.get(cacheKey);
  // 同一远程请求已经在进行时直接复用，不能递增 generation 把原请求的渲染判成过期。
  if (!force && cached && cached.promise) return cached.promise;
  const generation = ++_remoteLoadGeneration;
  if (!force && cached && cached.data) {
    renderLocalRemotes(cached.data);
    refreshDefaultRemoteLabels(cached.data);
    if (Date.now() - cached.fetchedAt < REMOTE_CACHE_TTL) return cached.data;
    if (!quiet) setRemoteListActivity("正在更新远程状态…");
  } else if (el && p === currentPath && !el.querySelector(".remote-card")) {
    el.innerHTML = '<div style="font-size:10px;color:var(--hana-fg-muted,#6b7280)">正在读取本地远程...</div>';
  } else if (el && p === currentPath && el.querySelector(".remote-card")) {
    if (!quiet) setRemoteListActivity("正在更新远程状态…");
  }
  try {
    const query = "/api/remotes?path=" + encodeURIComponent(p)
      + (preferredRemote ? "&remote=" + encodeURIComponent(preferredRemote) : "")
      + (preferredBranch ? "&remoteBranch=" + encodeURIComponent(preferredBranch) : "");
    const request = pluginFetch(query).then(function(res) { return res.json(); });
    remoteDataCache.set(cacheKey, { promise: request, fetchedAt: cached && cached.fetchedAt || 0, data: cached && cached.data || null });
    const data = await request;
    if (generation !== _remoteLoadGeneration || p !== currentPath || p !== _remotePanelPath) return data;
    remoteDataCache.set(cacheKey, { data: data, fetchedAt: Date.now(), promise: null });
    renderLocalRemotes(data);
    if (!quiet) setRemoteListActivity("");
    refreshDefaultRemoteLabels(data);
    return data;
  } catch (e) {
    remoteDataCache.delete(cacheKey);
    if (generation !== _remoteLoadGeneration || p !== currentPath || p !== _remotePanelPath) return null;
    if (el && el.querySelector(".remote-card")) {
      if (!quiet) setRemoteListActivity("远程状态更新失败：" + (e.message || "未知错误"), true);
      return null;
    }
    renderLocalRemotes({ ok: false, message: e.message });
    refreshDefaultRemoteLabels();
    return null;
  }
}

async function fetchRemoteUpdates(remote, remoteBranch) {
  const p = currentPath || getSavedPath();
  if (!p) return;
  setRemoteCardBusy(remote, true, `正在获取 ${remote} 更新…`);
  try {
    const res = await pluginFetch("api/remote-fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, remote, remoteBranch: remoteBranch || "" }) });
    const data = await res.json();
    invalidateRemoteCache(p);
    if (data.ok) {
      toast(`✅ ${remote} 已更新`, "success");
      await loadLocalRemotes(remote, data.remoteBranch || remoteBranch || "", undefined, true, true);
    } else {
      await loadLocalRemotes(undefined, undefined, undefined, true, true);
      setRemoteCardHint(remote, "获取失败：" + (data.message || "未知错误"), true);
      toast("❌ " + data.message, "err");
    }
  } catch (e) {
    invalidateRemoteCache(p);
    await loadLocalRemotes(undefined, undefined, undefined, true, true);
    setRemoteCardHint(remote, "获取失败：" + e.message, true);
    toast("获取更新失败：" + e.message, "err");
  } finally {
    setRemoteCardBusy(remote, false);
  }
}

function removeLocalRemote(remote) {
  const p = currentPath || getSavedPath();
  if (!p) return;
  showConfirm(
    `确定移除本地远程 ${remote} 吗？这只会删除本地关联，不会删除 GitHub 仓库。`,
    "移除远程关联",
    function(ok) { if (ok) performRemoveLocalRemote(remote, false); },
    false,
    { title: "移除远程仓库", detailsHtml: "移除后不会删除远程平台上的仓库和代码。" }
  );
}

async function performRemoveLocalRemote(remote, confirmed) {
  const p = currentPath || getSavedPath();
  invalidateRemoteCache(p);
  try {
    const res = await pluginFetch("api/remote-remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, remote, confirmed: !!confirmed }) });
    const data = await res.json();
    if (data.code === "REMOTE_REMOVE_CONFIRM") {
      showConfirm(
        `远程 ${remote} 当前地址为：${data.currentUrl || "未知"}。移除后默认推送或默认获取流程可能失效，继续吗？`,
        "确认移除远程",
        function(ok) { if (ok) performRemoveLocalRemote(remote, true); },
        false,
        { title: "⚠️ 移除关键远程", detailsHtml: data.message || "该远程当前承担默认推送或默认获取角色。" }
      );
      return;
    }
    if (data.ok) toast("✅ " + data.message, "success");
    else toast("❌ " + data.message, "err");
    invalidateRemoteCache(p);
    loadLocalRemotes(undefined, undefined, undefined, true);
  } catch (e) { invalidateRemoteCache(p); toast("移除失败：" + e.message, "err"); }
}

function mergeRemoteUpdates(remote, remoteBranch) {
  const p = currentPath || getSavedPath();
  if (!p) return;
  showConfirm(
    `确定将 ${remote}/${remoteBranch || "默认分支"} 合并到当前本地分支吗？`,
    "合并远程更新",
    function(ok) { if (ok) performRemoteMerge(remote, remoteBranch); },
    false,
    { title: "合并远程更新", detailsHtml: "这会修改当前本地分支；如果代码有冲突，需要随后手动解决。" }
  );
}

async function performRemoteMerge(remote, remoteBranch) {
  const p = currentPath || getSavedPath();
  invalidateRemoteCache(p);
  setRemoteCardBusy(remote, true, `正在合并 ${remote} 更新…`);
  try {
    const res = await pluginFetch("api/remote-merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, remote, remoteBranch: remoteBranch || "" }) });
    const data = await res.json();
    if (data.ok) {
      toast(`✅ 已合并 ${remote}/${data.remoteBranch || remoteBranch || "远程更新"}`, "success");
      invalidateRemoteCache(p);
      refresh();
      switchGhTab("connect");
      await loadLocalRemotes(remote, data.remoteBranch || remoteBranch || "", undefined, true, true);
    } else if (data.code === "MERGE_CONFLICT") {
      toast("⚠️ 合并产生冲突，请在变更文件中解决", "err");
      invalidateRemoteCache(p);
      refresh();
      switchGhTab("connect");
      await loadLocalRemotes(remote, remoteBranch || "", undefined, true, true);
    } else {
      toast("❌ " + data.message, "err");
      invalidateRemoteCache(p);
      await loadLocalRemotes(remote, remoteBranch || "", undefined, true, true);
      setRemoteCardHint(remote, "合并失败：" + (data.message || "未知错误"), true);
    }
  } catch (e) {
    toast("合并失败：" + e.message, "err");
    invalidateRemoteCache(p);
    await loadLocalRemotes(remote, remoteBranch || "", undefined, true, true);
    setRemoteCardHint(remote, "合并失败：" + e.message, true);
  } finally {
    setRemoteCardBusy(remote, false);
  }
}
