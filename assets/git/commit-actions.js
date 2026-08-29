// Git Save/Load Card 前端模块 17/26：commit-actions.js — 存档、推送、拉取、Stash
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
async function doCommit() {
  const msg = document.getElementById("commitMsg").value.trim();
  if (!msg) { toast("请输入提交消息", "err"); return; }

  const version = document.getElementById("versionInput").value.trim();
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
    toast("版本号格式错误，正确格式如 0.1.0", "err");
    return;
  }
  const p = currentPath || getSavedPath();
  if (!p) { toast("请先设置仓库路径", "err"); return; }
  const btn = document.getElementById("btnCommit");
  btn.disabled = true;
  btn.textContent = "提交中...";

  try {
    const res = await pluginFetch("api/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, version, path: currentPath }),
    });
    const data = await res.json();

    if (data.ok) {
      if (data.nothingToCommit) {
        toast("没有需要提交的变更", "info");
      } else {
        invalidateRepoCaches(p);
        cacheClear();
        Bus.emit("commit");
        const tagInfo = data.tag ? ` v${version}` : "";
        toast(`✅ ${data.commit}${tagInfo}`, "success");
        document.getElementById("commitMsg").value = "";
        loadNextVersion();
        refresh();
      }
    } else if (data.code === "NO_IDENTITY") {
      // 未配置 git 身份，弹出配置弹窗
      showIdentitySetup(msg, version);
    } else {
      toast("❌ " + data.message, "err");
    }
  } catch (e) {
    toast("提交失败：" + e.message, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "存档";
  }
}

// ======== 推送 ========
function syncDetailHtml(data) {
  const commitHtml = (data.commits || []).length
    ? "<div style='font-weight:600;margin-bottom:4px'>远程新增提交：</div>" + data.commits.map(c => `<div>• <code>${escapeHtml(c.hash)}</code> ${escapeHtml(c.subject || "")}</div>`).join("")
    : "<div>远程有提交变化，但没有可展示的提交摘要。</div>";
  const fileHtml = (data.files || []).length
    ? "<div style='font-weight:600;margin:8px 0 4px'>远程涉及文件：</div>" + data.files.map(f => `<div>• <code>${escapeHtml(f.status)}</code> ${escapeHtml(f.name)}</div>`).join("")
    : "";
  return commitHtml + fileHtml;
}

// 推送 / 拉取的视觉宽度与换行宽度分离：
// 槽位按所有状态中的最长按钮占位，按钮本体再向左收回空出的视觉宽度。
var _commitActionLayoutFrame = 0;
var _commitActionLayoutObserver = null;

function measureCommitActionWidth(button, states) {
  var maxWidth = button.offsetWidth || 0;
  var probe = button.cloneNode(false);
  probe.style.position = "absolute";
  probe.style.left = "-10000px";
  probe.style.top = "0";
  probe.style.width = "max-content";
  probe.style.minWidth = "0";
  probe.style.flex = "none";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  for (var i = 0; i < states.length; i++) {
    probe.textContent = states[i];
    maxWidth = Math.max(maxWidth, probe.offsetWidth || 0);
  }
  probe.remove();
  return Math.ceil(maxWidth);
}

function syncCommitActionLayout() {
  if (_commitActionLayoutFrame) return;
  _commitActionLayoutFrame = requestAnimationFrame(function() {
    _commitActionLayoutFrame = 0;
    var area = document.querySelector(".commit-area");
    var slots = [
      { el: document.getElementById("commitActionSlot"), states: ["存档", "存档中...", "提交中...", "✅ 已存档"] },
      { el: document.getElementById("pushActionSlot"), states: ["📤 推送", "检查中...", "覆盖中...", "✅ 已推送", "✅ 已覆盖"] },
      { el: document.getElementById("pullActionSlot"), states: ["📥 拉取", "拉取中...", "✅ 已拉取"] },
    ];
    if (!area || slots.some(function(item) { return !item.el || !item.el.querySelector("button"); })) return;

    // 先清除视觉位移，确保下面拿到的是未变换的真实换行结果。
    slots.forEach(function(item) {
      item.el.style.setProperty("--commit-slot-shift", "0px");
    });
    slots.forEach(function(item) {
      var button = item.el.querySelector("button");
      var width = measureCommitActionWidth(button, item.states);
      item.el.style.setProperty("--commit-slot-width", width + "px");
    });

    // 强制一次布局，让 flex 根据最长状态槽位重新决定换行。
    area.offsetHeight;
    var areaRect = area.getBoundingClientRect();
    var children = Array.prototype.slice.call(area.children);
    var rects = new Map(children.map(function(child) {
      return [child, child.getBoundingClientRect()];
    }));
    var gap = parseFloat(getComputedStyle(area).columnGap) || 0;

    // 每个动作槽只在自己所在行内向前收回空白，不影响 flex 的换行判定。
    var previousInRow = null;
    children.forEach(function(child) {
      var rect = rects.get(child);
      var isSlot = child.classList && child.classList.contains("commit-action-slot");
      if (isSlot) {
        var button = child.querySelector("button");
        var buttonWidth = button ? button.offsetWidth : 0;
        var sameRow = previousInRow && Math.abs(rect.top - previousInRow.rect.top) < 1;
        var desiredLeft = sameRow ? previousInRow.right + gap : areaRect.left;
        var shift = desiredLeft - rect.left;
        child.style.setProperty("--commit-slot-shift", shift.toFixed(2) + "px");
        previousInRow = { rect: rect, right: desiredLeft + buttonWidth };
      } else {
        previousInRow = { rect: rect, right: rect.right };
      }
    });
    requestHostResize();
  });
}

function setupCommitActionLayout() {
  if (_commitActionLayoutObserver) return;
  var area = document.querySelector(".commit-area");
  if (!area) return;
  var buttons = area.querySelectorAll("#commitActionSlot button, #pushActionSlot button, #pullActionSlot button");
  var textObserver = new MutationObserver(syncCommitActionLayout);
  buttons.forEach(function(button) {
    textObserver.observe(button, { childList: true, characterData: true, subtree: true });
  });
  var resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(syncCommitActionLayout) : null;
  if (resizeObserver) resizeObserver.observe(area);
  _commitActionLayoutObserver = { text: textObserver, resize: resizeObserver };
  window.addEventListener("resize", syncCommitActionLayout);
  syncCommitActionLayout();
}

async function refreshDefaultRemoteLabels(remoteData) {
  const p = currentPath || getSavedPath();
  if (!p) return;
  try {
    const data = remoteData || await loadLocalRemotes(undefined, undefined, p, false);
    if (!data || !data.ok) return;
    const pushBtn = document.getElementById("btnPush");
    const pullBtn = document.getElementById("btnPull");
    if (pushBtn) pushBtn.title = `把本地存档推送到 ${data.pushRemote || "默认"} 远程仓库`;
    if (pullBtn) pullBtn.title = `从 ${data.fetchRemote || "默认"} 远程仓库拉取最新存档`;
  } catch {}
}

async function doPush(btn, forceContext) {
  const p = currentPath || getSavedPath();
  if (!p) { toast("请先设置仓库路径", "err"); return; }
  const orig = btn.textContent;
  btn.disabled = true; btn.style.opacity = ".5"; btn.textContent = forceContext ? "覆盖中..." : "检查中...";
  const safeTimer = setTimeout(() => { btn.disabled = false; btn.style.opacity = ""; btn.textContent = orig; }, 180000);
  try {
    const body = { path: p };
    if (forceContext) {
      body.force = true;
      body.expectedRemoteHash = forceContext.remoteHash;
      body.remote = forceContext.remote || "";
      body.branch = forceContext.branch || "";
    }
    const res = await pluginFetch("api/push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    clearTimeout(safeTimer);
    if (data.ok) {
      invalidateRepoCaches(p);
      cacheClear();
      Bus.emit("push");
      btn.textContent = forceContext ? "✅ 已覆盖" : "✅ 已推送";
      btn.style.opacity = ""; btn.disabled = false;
      setTimeout(() => { btn.textContent = orig; }, 2500);
      refresh();
    } else if (data.code === "REMOTE_AHEAD" && !forceContext) {
      btn.disabled = false; btn.style.opacity = ""; btn.textContent = orig;
      const relation = data.diverged ? "本地和远程已经分叉" : "远程包含本地没有的提交";
      showConfirm(
        `检测到当前仓库的本地版本与云端版本不一致：${relation}。`,
        "以本地覆盖远程",
        function(ok) { if (ok) doPush(btn, data); },
        false,
        {
          title: "⚠️ 本地版本将覆盖云端",
          detailsHtml: `<div style='margin-bottom:6px'><b>本地仓库：</b>${escapeHtml(p)}</div><div style='margin-bottom:6px'><b>远程仓库：</b>${escapeHtml(data.remote || "默认推送远程")}/${escapeHtml(data.branch || "")}</div>${syncDetailHtml(data)}<div style='margin-top:10px;color:#b91c1c;font-weight:600'>确认后，远程新增提交及其文件变化将被本地版本覆盖。</div>`
        }
      );
    } else {
      btn.disabled = false; btn.style.opacity = ""; btn.textContent = orig;
      toast("❌ " + (data.message || "推送失败").split("\n")[0], "err");
    }
  } catch (e) {
    clearTimeout(safeTimer);
    btn.disabled = false; btn.style.opacity = ""; btn.textContent = orig;
    toast("推送失败：" + e.message, "err");
  }
}

// ======== 拉取 ========
function getSavedPullMode() {
  const el = document.getElementById("cfgPullMode");
  return el ? el.value : "merge";
}

async function doPull(btn) {
  const p = currentPath || getSavedPath();
  if (!p) { toast("请先设置仓库路径", "err"); return; }
  const orig = btn.textContent;
  btn.disabled = true; btn.style.opacity = ".5"; btn.textContent = "拉取中...";
  try {
    const res = await pluginFetch("api/pull", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, remoteBranch: "", mode: getSavedPullMode() }),
    });
    const data = await res.json();
    btn.disabled = false; btn.style.opacity = ""; btn.textContent = orig;
    if (data.ok) {
      invalidateRepoCaches(p);
      cacheClear();
      Bus.emit("pull");
      toast("✅ " + data.message, "success");
      refresh();
    } else toast("❌ " + data.message, "err");
  } catch (e) { btn.disabled = false; btn.style.opacity = ""; btn.textContent = orig; toast("拉取失败", "err"); }
}

// ======== Stash ========
async function doStashPush() {
  const msg = document.getElementById("stashMsg")?.value?.trim() || "";
  const btn = document.getElementById("btnStashPush");
  btn.disabled = true; btn.textContent = "暂存中...";
  try {
    const res = await pluginFetch("api/stash/push", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: msg, path: currentPath }),
    });
    const data = await res.json();
    if (data.ok) {
      toast("📦 已暂存", "success");
      document.getElementById("stashMsg").value = "";
      refresh();
    } else toast("❌ " + data.message, "err");
  } catch (e) { toast("暂存失败：" + e.message, "err"); }
  finally { btn.disabled = false; btn.textContent = "暂存"; }
}

async function doStashPop(index) {
  try {
    const res = await pluginFetch("api/stash/pop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, path: currentPath }),
    });
    const data = await res.json();
    if (data.ok) { toast("♻️ 已恢复", "success"); refresh(); }
    else toast("❌ " + data.message, "err");
  } catch (e) { toast("恢复失败：" + e.message, "err"); }
}

async function doStashDrop(index) {
  try {
    const res = await pluginFetch("api/stash/drop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index, path: currentPath }),
    });
    const data = await res.json();
    if (data.ok) { toast("🗑️ 已删除", "info"); refresh(); }
    else toast("❌ " + data.message, "err");
  } catch (e) { toast("删除失败：" + e.message, "err"); }
}

async function loadStash() {
  const list = document.getElementById("stashList");
  const count = document.getElementById("stashCount");
  if (!list) return;
  const p = currentPath || getSavedPath();
  if (!p) { list.style.display = "none"; count.textContent = ""; return; }
  try {
    const res = await pluginFetch("api/stash/list?path=" + encodeURIComponent(p));
    const data = await res.json();
    if (data.ok && data.stashes && data.stashes.length > 0) {
      list.style.display = "";
      count.textContent = data.stashes.length + " 条";
      list.innerHTML = data.stashes.map(s =>
        `<li style="display:flex;align-items:center;gap:4px;padding:4px 0;border-bottom:1px solid var(--hana-border,#eef0f2);font-size:12px">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(s.message)}">${escapeHtml(s.message || "(无备注)")}</span>
          <button onclick="doStashPop(${s.index})" style="padding:1px 8px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;background:var(--hana-surface,#fff);cursor:pointer;font-size:10px;color:#27ae60">恢复</button>
          <button onclick="doStashDrop(${s.index})" style="padding:1px 8px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;background:var(--hana-surface,#fff);cursor:pointer;font-size:10px;color:#e74c3c">删除</button>
        </li>`
      ).join("");
    } else {
      list.style.display = "none";
      count.textContent = "";
    }
  } catch { list.style.display = "none"; count.textContent = ""; }
}
