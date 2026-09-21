// Git Save/Load Card 前端模块 18/26：commit-edit.js — 修改提交说明/版本号、squash、reword、amend
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// ======== 修改提交说明和版本号 ========
let _commitMessageEditInProgress = false;
let _commitEditContext = null;
let _commitEditSelection = new Set();
let _commitEditMessageAuto = true;
let _commitEditMessageAutoValue = "";

function getSelectedCommitMessage(commits) {
  return commits
    .filter(c => _commitEditSelection.has(c.hash))
    .slice()
    .sort((a, b) => commits.indexOf(b) - commits.indexOf(a))
    .map(c => (c.message || "").trim())
    .filter(Boolean)
    .join("+");
}

function syncCommitEditMessageFromSelection(commits) {
  const input = document.getElementById("commitEditMessage");
  if (!input || !_commitEditMessageAuto) return;
  const generated = getSelectedCommitMessage(commits);
  _commitEditMessageAutoValue = generated;
  input.value = generated;
}

function renderCommitEditSelection(commits, selectedHash) {
  const box = document.getElementById("commitEditSelection");
  if (!box) return;
  _commitEditSelection = new Set([selectedHash]);
  _commitEditMessageAuto = true;
  _commitEditMessageAutoValue = "";
  box.innerHTML = commits.map(function(c) {
    const checked = c.hash === selectedHash ? " checked" : "";
    const tag = (c.tag || "").replace(/^v/i, "");
    return `<label style="display:grid;grid-template-columns:32px 72px minmax(0,1fr);align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--hana-border,#e2e5ea);font-size:11px;cursor:pointer;background:var(--hana-surface,#fff)" title="${escapeHtml(c.hash)}\n${escapeHtml(c.date || "")}">
      <span style="text-align:center"><input type="checkbox" data-commit-hash="${escapeHtml(c.hash)}"${checked} style="cursor:pointer"></span>
      <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:${tag ? "#8b5cf6" : "var(--hana-fg-muted,#9ca3af)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(tag || "—")}</span>
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hana-fg,#1a1d24)">${escapeHtml(c.message || "")}</span>
    </label>`;
  }).join("");
  box.querySelectorAll("input[data-commit-hash]").forEach(function(input) {
    input.addEventListener("change", function() {
      const hash = input.getAttribute("data-commit-hash");
      if (input.checked) _commitEditSelection.add(hash);
      else _commitEditSelection.delete(hash);
      const selected = commits.filter(c => _commitEditSelection.has(c.hash));
      if (selected.length === 1) {
        _commitEditMessageAuto = true;
        const messageInput = document.getElementById("commitEditMessage");
        messageInput.value = selected[0].message || "";
        _commitEditMessageAutoValue = messageInput.value;
        document.getElementById("commitEditVersion").value = (selected[0].tag || "").replace(/^v/i, "");
      } else if (selected.length >= 2) {
        syncCommitEditMessageFromSelection(commits);
      }
    });
  });
}

function finishCommitMessageEdit(triggerButton) {
  _commitMessageEditInProgress = false;
  if (triggerButton) {
    triggerButton.disabled = false;
    triggerButton.style.opacity = "";
  }
}

async function doEditCommitMessage(commit, triggerButton) {
  if (_commitMessageEditInProgress) {
    toast("已有一个历史提交编辑正在进行", "info");
    return;
  }
  const requestPath = currentPath || getSavedPath();
  if (!requestPath) { toast("请先选择 Git 仓库", "err"); return; }
  const originalPath = requestPath;
  _commitMessageEditInProgress = true;
  if (triggerButton) { triggerButton.disabled = true; triggerButton.style.opacity = "0.5"; }

  let isHead = false;
  try {
    const res = await pluginFetch("api/log?count=1&path=" + encodeURIComponent(requestPath));
    const data = await res.json();
    if (data.ok && data.commits && data.commits.length > 0) {
      const headHash = data.commits[0].hash;
      isHead = headHash.startsWith(commit.hash) || commit.hash.startsWith(headHash);
    }
  } catch (e) {}

  const oldVersion = (commit.tag || "").replace(/^v/i, "");
  let commits = [];
  try {
    const logRes = await pluginFetch("api/log?count=100&path=" + encodeURIComponent(requestPath));
    const logData = await logRes.json();
    if (logData.ok && Array.isArray(logData.commits)) commits = logData.commits;
  } catch (e) {}
  if (!commits.length) commits = [commit];
  _commitEditContext = { commit, triggerButton, originalPath, isHead, oldVersion, commits };
  document.getElementById("commitEditTitle").textContent = isHead ? "编辑提交" : "编辑历史提交";
  document.getElementById("commitEditMessage").value = commit.message || "";
  _commitEditMessageAutoValue = commit.message || "";
  document.getElementById("commitEditVersion").value = oldVersion;
  const messageInput = document.getElementById("commitEditMessage");
  messageInput.oninput = function() {
    if (messageInput.value !== _commitEditMessageAutoValue) _commitEditMessageAuto = false;
  };
  document.getElementById("commitEditResult").textContent = "";
  renderCommitEditSelection(commits, commit.hash);
  document.getElementById("commitEditModal").style.display = "flex";
  setTimeout(function() { document.getElementById("commitEditMessage").focus(); document.getElementById("commitEditMessage").select(); }, 50);
}

function cancelCommitEditModal() {
  document.getElementById("commitEditModal").style.display = "none";
  const ctx = _commitEditContext;
  _commitEditContext = null;
  if (ctx) finishCommitMessageEdit(ctx.triggerButton);
}

async function submitCommitEditModal() {
  const ctx = _commitEditContext;
  if (!ctx) return;
  const result = document.getElementById("commitEditResult");
  const trimmed = document.getElementById("commitEditMessage").value.trim();
  const version = document.getElementById("commitEditVersion").value.trim().replace(/^v/i, "");
  const selectedCommits = ctx.commits.filter(c => _commitEditSelection.has(c.hash));
  const autoMergedMessage = getSelectedCommitMessage(ctx.commits);
  const finalMessage = selectedCommits.length >= 2 && _commitEditMessageAuto ? autoMergedMessage : trimmed;
  if (!finalMessage) { result.textContent = "提交消息不能为空"; return; }
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) { result.textContent = "版本号格式错误，正确格式如 1.2.3"; return; }
  if (selectedCommits.length < 1) { result.textContent = "至少选择一条提交"; return; }
  const selectedIndexes = selectedCommits.map(c => ctx.commits.indexOf(c)).sort((a, b) => a - b);
  if (selectedIndexes.some((index, i) => i > 0 && index !== selectedIndexes[i - 1] + 1)) { result.textContent = "请选择连续的提交，不能跳过中间提交"; return; }
  if (selectedCommits.length === 1 && trimmed === (ctx.commit.message || "").trim() && version === ctx.oldVersion) { result.textContent = "未修改"; return; }
  document.getElementById("commitEditModal").style.display = "none";
  if ((currentPath || getSavedPath()) !== ctx.originalPath) {
    toast("仓库路径已改变，请重新选择要修改的提交", "err");
    finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; return;
  }
  const selectedHashes = selectedCommits.map(c => c.hash);
  if (selectedCommits.length >= 2) {
    showConfirm(
      `确定要合并选中的 ${selectedCommits.length} 条连续提交吗？合并后这些提交会变成一个新提交，后续提交 hash 也会变化。`,
      "确认合并",
      async function(ok) {
        if (!ok) { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; return; }
        try {
          const body = { message: finalMessage, messageAuto: _commitEditMessageAuto, version, selectedCommits: selectedHashes, expectedHead: ctx.commits[0]?.hash || "", path: ctx.originalPath };
          const res = await pluginFetch("api/commit-squash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const data = await res.json();
          if (data.code === "OLD_TAG_EXISTS" && data.conflict) {
            showConfirm(
              `版本号 ${version} 已存在于旧历史，是否移动到合并后的提交？`,
              "移动并合并",
              async function(move) {
                if (!move) { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; return; }
                try {
                  const retryBody = { ...body, allowMove: true };
                  const retry = await pluginFetch("api/commit-squash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(retryBody) });
                  const retryData = await retry.json();
                  if (retryData.ok) { toast("✅ " + retryData.message, "success"); cacheClear(); refresh(); }
                  else toast("❌ " + (retryData.message || "合并失败"), "err");
                } catch (e) { toast("❌ 合并失败：" + e.message, "err"); }
                finally { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; }
              },
              false,
              { title: "⚠️ 移动旧版本号并合并", detailsHtml: `<div><b>版本号：</b>${escapeHtml(version)}</div><div style="margin-top:4px"><b>旧提交：</b><code>${escapeHtml(data.conflict.existingCommit)}</code></div><div style="margin-top:8px;color:#b91c1c">确认后会移动版本号并执行合并。</div>` }
            );
            return;
          }
          if (data.ok) { toast("✅ " + data.message, "success"); cacheClear(); refresh(); }
          else toast("❌ " + (data.message || "合并失败"), "err");
        } catch (e) { toast("❌ 合并失败：" + e.message, "err"); }
        finally { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; }
      },
      false,
      { title: "⚠️ 合并连续提交", detailsHtml: selectedCommits.slice().sort((a, b) => ctx.commits.indexOf(b) - ctx.commits.indexOf(a)).map(c => `<div><code>${escapeHtml(c.hash)}</code>　${escapeHtml(c.message)}</div>`).join("") + `<div style="margin-top:8px"><b>合并后说明：</b>${escapeHtml(finalMessage)}</div><div><b>合并后版本号：</b>${escapeHtml(version || "无")}</div>` }
    );
    return;
  }
  showConfirm(
    "修改提交说明或版本号。版本号实际是 Git tag；修改历史提交会重写该提交及其后续提交的 hash。",
    "开始修改",
    async function(ok) {
      if (!ok) { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; return; }
      try {
        const messageChanged = finalMessage !== (ctx.commit.message || "").trim();
        const endpoint = messageChanged ? "/api/commit-reword" : "/api/tag-edit";
        const body = messageChanged
          ? { message: finalMessage, version, currentTag: ctx.commit.tag || "", path: ctx.originalPath, expectedHash: ctx.commit.hash }
          : { version, currentTag: ctx.commit.tag || "", commit: ctx.commit.hash, path: ctx.originalPath };
        const res = await pluginFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await res.json();
        if (data.code === "OLD_TAG_EXISTS" && data.conflict) {
          showConfirm(
            `版本号 ${version} 已经存在于旧历史，是否移动到当前提交？`,
            "移动版本号",
            async function(move) {
              if (!move) { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; return; }
              try {
                const retryBody = { ...body, allowMove: true };
                const retry = await pluginFetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(retryBody) });
                const retryData = await retry.json();
                if (retryData.ok) { toast("✅ " + retryData.message, "success"); cacheClear(); refresh(); }
                else toast("❌ " + (retryData.message || "移动版本号失败"), "err");
              } catch (e) { toast("❌ 移动版本号失败：" + e.message, "err"); }
              finally { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; }
            },
            false,
            { title: "⚠️ 移动已有版本号", detailsHtml: `<div><b>版本号：</b>${escapeHtml(version)}</div><div style="margin-top:4px"><b>旧提交：</b><code>${escapeHtml(data.conflict.existingCommit)}</code></div><div style="margin-top:4px"><b>目标提交：</b><code>${escapeHtml(data.conflict.targetCommit)}</code></div><div style="margin-top:8px;color:#b91c1c;font-weight:600">确认后，版本号会从旧提交移动到当前提交。</div>` }
          );
          return;
        }
        if (data.ok) { toast("✅ " + data.message, "success"); cacheClear(); refresh(); }
        else toast("❌ " + (data.message || "修改提交失败"), "err");
      } catch (e) { toast("❌ 修改提交失败：" + e.message, "err"); }
      finally { finishCommitMessageEdit(ctx.triggerButton); _commitEditContext = null; }
    },
    false,
    {
      title: "⚠️ 修改提交和版本号",
      detailsHtml: `<div><b>目标提交：</b><code>${escapeHtml(ctx.commit.hash)}</code></div><div style="margin-top:4px"><b>原说明：</b>${escapeHtml(ctx.commit.message || "")}</div><div style="margin-top:4px"><b>原版本号：</b>${escapeHtml(ctx.oldVersion || "无")}</div><div style="margin-top:4px"><b>新版本号：</b>${escapeHtml(version || "删除")}</div>${ctx.isHead ? "" : "<div style='margin-top:8px;color:#b91c1c;font-weight:600'>该提交之后的提交 hash 也会变化；如果已推送远程，后续需要 force-with-lease。</div>"}`,
    }
  );
}

// ======== 修改最新提交说明（git commit --amend） ========
async function doAmendMessage(commit, requestPath, triggerButton) {
  requestPath = requestPath || currentPath || getSavedPath();
  // 调后端检查这条 commit 是不是当前 HEAD（防用户点错）
  let isHead = false;
  try {
    const res = await pluginFetch("api/log?count=1&path=" + encodeURIComponent(requestPath));
    const data = await res.json();
    if (data.ok && data.commits && data.commits.length > 0) {
      const headHash = data.commits[0].hash;
      isHead = headHash.startsWith(commit.hash) || commit.hash.startsWith(headHash);
    }
  } catch (e) {}

  if (!isHead) {
    finishCommitMessageEdit(triggerButton);
    toast("⚠️ 只能修改最近一条提交。\n这条提交不是最新的，如需修改请在终端用 git rebase -i （高级操作）", "err");
    return;
  }

  // 弹输入框预填原消息
  customPrompt("修改这条提交的说明", commit.message, async function(newMsg) {
    if (newMsg === null) { finishCommitMessageEdit(triggerButton); return; } // 用户取消
    if ((currentPath || getSavedPath()) !== requestPath) {
      finishCommitMessageEdit(triggerButton);
      toast("仓库路径已改变，请重新选择要修改的提交", "err");
      return;
    }
    const trimmed = newMsg.trim();
    if (!trimmed) { finishCommitMessageEdit(triggerButton); toast("提交消息不能为空", "err"); return; }
    if (trimmed === (commit.message || "").trim()) {
      finishCommitMessageEdit(triggerButton);
      toast("未修改", "info");
      return;
    }
    try {
      const res = await pluginFetch("api/commit-amend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, path: requestPath, expectedHash: commit.hash }),
      });
      const data = await res.json();
      if (data.ok) {
        toast(`✅ ${data.commit}`, "success");
        refresh();
      } else if (data.code === "NO_IDENTITY") {
        // 未配置身份：复用已有的弹窗；当前按钮锁先释放，身份弹窗完成后由原流程重试。
        finishCommitMessageEdit(triggerButton);
        showIdentitySetupForAmend(trimmed, commit.hash, requestPath);
      } else if (data.code === "NOT_HEAD") {
        toast("⚠️ " + data.message, "err");
      } else if (data.code === "DIRTY") {
        toast("⚠️ " + data.message, "err");
      } else {
        toast("❌ " + data.message, "err");
      }
    } catch (e) {
      toast("❌ " + e.message, "err");
    } finally {
      finishCommitMessageEdit(triggerButton);
    }
  });
}

// 修改提交说明时的身份配置（复用 showIdentitySetup 的逻辑，但完成后重试 amend）
function showIdentitySetupForAmend(message, hash, requestPath) {
  _pendingAmendMsg = message;
  _pendingAmendHash = hash;
  _pendingAmendPath = requestPath || currentPath || getSavedPath();
  document.getElementById("identitySetupResult").textContent = "";
  document.getElementById("identitySetupResult").style.color = "";
  document.getElementById("identityName").value = "";
  document.getElementById("identityEmail").value = "";
  document.getElementById("identitySetupModal").style.display = "flex";
  setTimeout(function() { document.getElementById("identityName").focus(); }, 50);
  // 身份设置完后，走 amend 路径（而不是 commit 路径）
  window._identitySetupAfter = "amend";
}

let _pendingAmendMsg = "";
let _pendingAmendHash = "";
let _pendingAmendPath = "";
