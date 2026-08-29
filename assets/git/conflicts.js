// Git Save/Load Card 前端模块 22/26：conflicts.js — 冲突解决弹窗、hash/tag 显示切换
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
let conflictFile = "";
let conflictBlocks = [];
let conflictPicks = [];

// hash/tag 显示切换
let showTag = localStorage.getItem("git-sl-show-tag") === "1";
try { document.getElementById("toggleHashBtn").textContent = showTag ? "hash" : "tag"; } catch {}

function toggleHashDisplay() {
  showTag = !showTag;
  document.getElementById("toggleHashBtn").textContent = showTag ? "hash" : "tag";
  localStorage.setItem("git-sl-show-tag", showTag ? "1" : "0");
  const cl = document.getElementById("commitList");
  const commits = cl._commits;
  if (commits) renderLog({ ok: true, commits });
}

// 打开冲突解决弹窗
async function resolveConflict(file) {
  conflictFile = file;
  const p = currentPath || getSavedPath();
  try {
    const res = await pluginFetch("api/conflicts?path=" + encodeURIComponent(p));
    const data = await res.json();
    if (!data.ok) { toast("获取冲突信息失败", "err"); return; }
    const cf = data.conflicts.find(c => c.file === file);
    if (!cf || !cf.blocks.length) { toast("该文件没有冲突", "info"); return; }
    conflictBlocks = cf.blocks;
    conflictPicks = cf.blocks.map((_, i) => ({ blockIndex: i, side: "head" }));
    renderConflictDialog(file);
    document.getElementById("conflictModal").style.display = "";
  } catch (e) {
    toast("获取冲突信息失败：" + e.message, "err");
  }
}

function closeConflictModal() {
  document.getElementById("conflictModal").style.display = "none";
}

// 渲染冲突解决弹窗内容
function renderConflictDialog(file) {
  document.getElementById("conflictFileName").textContent = file;
  const el = document.getElementById("conflictBlocks");
  el.innerHTML = conflictBlocks.map((block, i) => `
    <div style="margin-bottom:10px;border:1px solid var(--hana-border,#e2e5ea);border-radius:6px;overflow:hidden">
      <div style="padding:6px 10px;font-size:11px;font-weight:600;background:var(--hana-bg,#f5f6f8);border-bottom:1px solid var(--hana-border,#e2e5ea)">
        冲突块 ${i+1}
      </div>
      <div style="display:flex">
        <div onclick="pickSide(${i},'head')" id="block${i}Head" style="flex:1;padding:8px;cursor:pointer;border-right:1px solid var(--hana-border,#e2e5ea);background:var(--hana-bg,#f5f6f8)">
          <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:var(--hana-accent,#4a8cff)">⬅ ${escapeHtml(block.headLabel)}</div>
          <pre style="margin:0;font-size:11px;font-family:monospace;white-space:pre-wrap;word-break:break-all;color:var(--hana-fg-muted,#6b7280)">${escapeHtml(block.headContent.trim() || "(空)")}</pre>
        </div>
        <div onclick="pickSide(${i},'their')" id="block${i}Their" style="flex:1;padding:8px;cursor:pointer;background:var(--hana-bg,#f5f6f8)">
          <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:#e74c3c">➡ ${escapeHtml(block.theirLabel)}</div>
          <pre style="margin:0;font-size:11px;font-family:monospace;white-space:pre-wrap;word-break:break-all;color:var(--hana-fg-muted,#6b7280)">${escapeHtml(block.theirContent.trim() || "(空)")}</pre>
        </div>
      </div>
    </div>
  `).join("");
  // 默认选中 head
  conflictBlocks.forEach((_, i) => highlightPick(i));
}

// 选择某一侧
function pickSide(index, side) {
  conflictPicks[index] = { blockIndex: index, side };
  highlightPick(index);
}

// 高亮当前选择
function highlightPick(index) {
  const pick = conflictPicks[index];
  if (!pick) return;
  const headEl = document.getElementById(`block${index}Head`);
  const theirEl = document.getElementById(`block${index}Their`);
  [headEl, theirEl].forEach(el => {
    if (el) el.style.outline = "none";
  });
  const selected = pick.side === "head" ? headEl : theirEl;
  if (selected) selected.style.outline = "2px solid var(--hana-accent,#4a8cff)";
}

// 应用冲突解决
async function applyConflictResolve() {
  const p = currentPath || getSavedPath();
  const btn = document.getElementById("btnResolve");
  btn.disabled = true; btn.textContent = "处理中...";
  document.getElementById("conflictResult").textContent = "";

  try {
    const res = await pluginFetch("api/conflict-resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, file: conflictFile, picks: conflictPicks }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById("conflictResult").textContent = "✅ " + data.message;
      document.getElementById("conflictResult").style.color = "var(--hana-accent,#4a8cff)";
      setTimeout(() => { closeConflictModal(); refresh(); }, 800);
    } else {
      document.getElementById("conflictResult").textContent = "❌ " + data.message;
      document.getElementById("conflictResult").style.color = "#e74c3c";
    }
  } catch (e) {
    document.getElementById("conflictResult").textContent = "❌ " + e.message;
    document.getElementById("conflictResult").style.color = "#e74c3c";
  } finally {
    btn.disabled = false; btn.textContent = "应用选择";
  }
}

// 当前排除项数组
