// Git Save/Load Card 前端模块 15/26：status-card.js — 变更文件卡片渲染、时间格式化、版本对比
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
function renderStatus(data) {
  if (!data.ok || data.isRepo === false) {
    document.getElementById("branch").textContent = "✕";
    updateRepoPathDisplay(data.path || currentPath || "");
    document.getElementById("fileList").innerHTML = '<li class="empty-hint">不是 git 仓库<br><span style="font-size:11px;color:var(--hana-fg-muted,#9ca3af)">💡 点顶部「切换」选一个 Git 项目文件夹</span></li>';
    // 显示初始化按钮
    const initArea = document.getElementById("initArea");
    if (initArea) initArea.style.display = "block";
    document.getElementById("fileCard").style.display = "none";
    document.getElementById("commitCard").style.display = "none";
    document.getElementById("logCard").style.display = "none";
    document.getElementById("btnCommit").disabled = true;
    return;
  }

  // 是 git 仓库，隐藏初始化区域
  const initArea = document.getElementById("initArea");
  if (initArea) initArea.style.display = "none";
  document.getElementById("fileCard").style.display = "";
  document.getElementById("commitCard").style.display = "";
  document.getElementById("logCard").style.display = "";

  const previousPath = currentPath;
  currentPath = data.path;
  if (previousPath !== data.path) onCurrentRepoChanged(data.path);
  // 首次打开时自动保存默认路径
  if (!getSavedPath()) {
    savePathToStorage(data.path);
    addRepoHistory(data.path);
  }
  document.getElementById("branch").textContent = data.branch;
  updateRepoPathDisplay(data.path);

  const fl = document.getElementById("fileList");
  fl.innerHTML = "";

  const items = [];
  // 优先用 changedWithStats（带增删统计），否则回退
  const changes = data.changedWithStats || (data.changedFiles || []).map(f => {
    const st = f.slice(0, 2).trim();
    const name = f.slice(2).trim();
    return { raw: f, name, status: st, added: 0, deleted: 0 };
  });
  for (const f of changes) {
    items.push({ status: f.status, name: f.name, added: f.added, deleted: f.deleted });
  }
  for (const f of data.untrackedFiles || []) {
    items.push({ status: "??", name: f });
  }

  if (items.length === 0) {
    fl.innerHTML = '<li class="empty-hint">工作区干净 ✅<br><span style="font-size:11px;color:var(--hana-fg-muted,#9ca3af)">💡 可以点「存档」提交，或从「拉取」获取最新版本</span></li>';
  } else {
    for (const item of items) {
      const li = document.createElement("li");
      const statusClass = item.status === "??" ? "UNTRACKED" : item.status;
      const isConflict = item.status.includes("U");
      // 将 git 状态代码转换为带 emoji 的中文标签
      const statusLabel = (function(st) {
        const s = st.trim();
        if (s === "M" || s.includes("M")) return "🟠 已修改";
        if (s === "A" || s.includes("A")) return "🟢 新增";
        if (s === "D" || s.includes("D")) return "🔴 已删除";
        if (s === "R" || s.includes("R")) return "🔄 重命名";
        if (s === "??" || s === "U") return "⚪ 新文件";
        if (s.includes("U")) return "⚠ 冲突";
        return s;
      })(item.status);
      const statStr = item.added || item.deleted ? `<span style="margin-left:auto;font-size:11px;white-space:nowrap"><span style="color:#27ae60;font-weight:600">+${item.added}</span>/<span style="color:#e74c3c;font-weight:600">-${item.deleted}</span></span>` : '';
      li.innerHTML = `<span class="file-status ${statusClass}">${statusLabel}</span><span onclick="toggleDiff('${escapeHtml(item.name)}', this)" style="cursor:pointer;flex:1;overflow:hidden;text-overflow:ellipsis" title="点击查看 diff">${escapeHtml(item.name)}</span>${statStr}`
        + (isConflict ? `<button onclick="resolveConflict('${escapeHtml(item.name)}')" style="margin-left:auto;padding:1px 6px;border:1px solid #e74c3c;border-radius:4px;font-size:11px;background:transparent;color:#e74c3c;cursor:pointer;white-space:nowrap">解决</button>` : '');
      fl.appendChild(li);
    }
  }

  // 提交按钮状态
  document.getElementById("btnCommit").disabled = !data.hasChanges;
}

// 格式化提交时间
function formatCommitDate(dateStr) {
  if (!dateStr) return "";
  // "2026-06-10 20:46:55 +0800" → 手拆
  const pts = dateStr.split(/\D+/).filter(Boolean).map(Number);
  if (pts.length < 5) return dateStr.slice(0, 10);
  const d = new Date(pts[0], pts[1] - 1, pts[2], pts[3], pts[4]);
  if (isNaN(d)) return dateStr.slice(0, 10);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const dayBefore = new Date(today - 2 * 86400000);
  const pad = n => String(n).padStart(2, "0");
  if (d >= today) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d >= yesterday) return "昨天";
  if (d >= dayBefore) return "前天";
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 始终显示完整日期时间（主标识用）：今天显示 HH:MM，昨天显示"昨天 HH:MM"，本年显示 MM-DD HH:MM，更早显示 YYYY-MM-DD
function formatCommitDateFull(dateStr) {
  if (!dateStr) return "";
  const pts = dateStr.split(/\D+/).filter(Boolean).map(Number);
  if (pts.length < 5) return dateStr.slice(0, 10);
  const d = new Date(pts[0], pts[1] - 1, pts[2], pts[3], pts[4]);
  if (isNaN(d)) return dateStr.slice(0, 10);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today - 86400000);
  const dayBefore = new Date(today - 2 * 86400000);
  const pad = n => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d >= today) return `今天 ${hm}`;
  if (d >= yesterday) return `昨天 ${hm}`;
  if (d >= dayBefore) return `前天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ======== 版本对比 ========
let compareMode = false;
let compareFrom = null;
let compareTo = null;

function toggleCompareMode() {
  compareMode = !compareMode;
  compareFrom = null;
  compareTo = null;
  document.getElementById("compareToggleBtn").textContent = compareMode ? "取消" : "对比";
  document.getElementById("compareResult").style.display = "none";
  const cl = document.getElementById("commitList");
  const commits = cl._commits;
  if (commits) renderLog({ ok: true, commits });
}

function pickCompare(hash) {
  if (!compareFrom) {
    compareFrom = hash;
  } else if (!compareTo && hash !== compareFrom) {
    compareTo = hash;
    doCompare();
  } else {
    // 重新选第一个
    compareFrom = hash;
    compareTo = null;
  }
  const cl = document.getElementById("commitList");
  const commits = cl._commits;
  if (commits) renderLog({ ok: true, commits });
}

async function doCompare() {
  const p = currentPath || getSavedPath();
  const el = document.getElementById("compareOutput");
  const label = document.getElementById("compareLabel");
  // from 是旧版本，to 是新版本，确保方向正确
  const older = compareFrom;
  const newer = compareTo;
  label.textContent = `对比 ${older}..${newer}`;
  el.textContent = "加载中...";
  document.getElementById("compareResult").style.display = "";
  try {
    const res = await pluginFetch(`api/compare?path=${encodeURIComponent(p)}&from=${older}&to=${newer}`);
    const data = await res.json();
    if (data.ok) {
      const lines = (data.detail || '').split('\n');
      // 检测连续高亮块
      const isHl = lines.map(l => l.startsWith('+') || l.startsWith('-') || l.startsWith('@@'));
      const blocks = [];
      let bi = 0;
      while (bi < lines.length) {
        if (isHl[bi]) {
          const start = bi;
          while (bi < lines.length && isHl[bi]) bi++;
          blocks.push({ start, end: bi - 1 });
        } else { bi++; }
      }
      const colored = lines.map((line, idx) => {
        let cls = '';
        let sty = '';
        if (line.startsWith('+')) { cls = 'diff-add'; sty = 'padding:0 2px'; }
        else if (line.startsWith('-')) { cls = 'diff-del'; sty = 'padding:0 2px'; }
        else if (line.startsWith('@@')) { cls = 'diff-hunk'; sty = 'padding:0 2px'; }
        for (const b of blocks) {
          if (idx === b.start && idx === b.end) { sty += ';border-radius:5px'; break; }
          else if (idx === b.start) { sty += ';border-radius:5px 5px 0 0'; break; }
          else if (idx === b.end) { sty += ';border-radius:0 0 5px 5px'; break; }
        }
        const esc = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<div style="${sty}" class="${cls}">${esc}</div>`;
      }).join('');
      el.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(data.stat)}</div>\n${colored}`;
    } else {
      el.textContent = "❌ " + data.message;
    }
  } catch (e) {
    el.textContent = "加载失败：" + e.message;
  }
}

function closeCompare() {
  document.getElementById("compareResult").style.display = "none";
}

function compareCleanup() {
  compareMode = false;
  compareFrom = null;
  compareTo = null;
  const btn = document.getElementById("compareToggleBtn");
  if (btn) btn.textContent = "对比";
  const r = document.getElementById("compareResult");
  if (r) r.style.display = "none";
}

// 渲染提交历史
