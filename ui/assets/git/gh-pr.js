// Git Save/Load Card 前端模块：gh-pr.js — GitHub Pull Request 面板
// （列表 / 详情 / 新建 / 合并；合并前走页内二次确认 showConfirm，与删除仓库等危险操作一致）
//
// 依赖（均为前面模块提供的全局函数）：env.js 的 pluginFetch / toast / escapeHtml / escapeAttr /
// notifyApiFailure，gh-repos.js 的 formatGhUpdatedAt，confirm-modal.js 的 showConfirm，
// settings.js 的 setHanaSegActive，gh-panel.js 的 ensureGhOpen / updateGhBodyHeight（switchGhTab 的
// validTabs 已加入 "pr"）。路由基址与其它 gh-* 模块一致，走 pluginFetch("api/gh/pr-*")。
//
// 「PR」标签按钮与 #ghTabPr 内容骨架是 ui/git.html 里的静态标记（与其余五个标签同一形式），
// 本模块只负责绑定已有元素、拉取数据与渲染，不再运行时注入 DOM。
//
// 加载位置：ui/git.html 中紧随 assets/git/gh-repos.js 之后。

var _ghPrState = "open";
var _ghPrDetailNumber = null;

// 取当前仓库路径：与其它 gh-* 模块同一套来源（活动路径 → localStorage）。
function ghPrCurrentPath() {
  try { return currentPath || getSavedPath() || ""; } catch (e) { return ""; }
}

function ghPrStateBadge(state, isDraft) {
  var s = String(state || "").toUpperCase();
  var label = s === "OPEN" ? "未合并" : s === "MERGED" ? "已合并" : s === "CLOSED" ? "已关闭" : (s || "?");
  var color = s === "OPEN" ? "#27ae60" : s === "MERGED" ? "#8e44ad" : s === "CLOSED" ? "#95a5a6" : "#6b7280";
  var badge = '<span style="display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:600;color:#fff;background:' + color + '">' + escapeHtml(label) + '</span>';
  if (isDraft) badge += ' <span style="display:inline-block;padding:0 5px;border-radius:3px;font-size:10px;font-weight:600;color:#6b7280;background:#eef0f3">草稿</span>';
  return badge;
}

// 切换 PR 状态过滤（open/closed/all），与其它 hana-seg 同一交互。
function setPrState(value) {
  if (!["open", "closed", "all"].includes(value)) return;
  _ghPrState = value;
  setHanaSegActive("segGhPrState", value);
  loadPrList(true);
}

function setPrStatus(text) {
  var el = document.getElementById("ghPrStatus");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "" : "none";
}

// ======== 列表 ========
async function loadPrList(force) {
  var el = document.getElementById("ghPrList");
  if (!el) return;
  var p = ghPrCurrentPath();
  if (!p) {
    el.innerHTML = '<div style="padding:8px;text-align:center;font-size:12px;color:var(--hana-fg-muted,#6b7280)">请先在上方「仓库」卡片设置本地仓库路径</div>';
    setPrStatus("");
    updateGhBodyHeight();
    return;
  }
  ensureGhOpen();
  el.innerHTML = '<div style="padding:8px;text-align:center;font-size:12px;color:var(--hana-fg-muted,#6b7280)">加载中…</div>';
  setPrStatus("正在读取 PR…");
  updateGhBodyHeight();
  try {
    var url = "api/gh/pr-list?state=" + encodeURIComponent(_ghPrState) + "&limit=50&path=" + encodeURIComponent(p);
    var res = await pluginFetch(url);
    var data = await res.json();
    renderPrList(data, el);
  } catch (e) {
    notifyApiFailure(e, "PR 列表加载失败");
    el.innerHTML = '<div style="padding:8px;color:#c0392b;font-size:11px">PR 列表加载失败：' + escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
    setPrStatus("");
  }
  updateGhBodyHeight();
}

function renderPrList(data, el) {
  if (!data || !data.ok || !Array.isArray(data.prs)) {
    setPrStatus("");
    el.innerHTML = '<div style="padding:8px;color:#c0392b;font-size:11px">加载失败：' + escapeHtml((data && data.message) || "未知错误") + '</div>'
      + '<button onclick="loadPrList(true)" style="margin-top:4px;padding:3px 8px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;background:transparent;color:var(--hana-accent,#5e6ad2);font-size:10px;cursor:pointer">重新加载</button>';
    return;
  }
  if (data.prs.length === 0) {
    setPrStatus("");
    el.innerHTML = '<div style="padding:8px;text-align:center;font-size:12px;color:var(--hana-fg-muted,#6b7280)">没有匹配的 PR</div>';
    return;
  }
  setPrStatus(data.prs.length + " 条 PR");
  el.innerHTML = data.prs.map(function(pr) {
    var when = formatGhUpdatedAt(pr.updatedAt || pr.createdAt);
    return '<div class="gh-pr-row" data-number="' + escapeAttr(String(pr.number)) + '" style="display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid var(--hana-border,#eef0f2);font-size:12px;cursor:pointer">'
      + '<span style="flex:1;min-width:0;overflow:hidden">'
      +   '<span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><span style="font-weight:600;color:var(--hana-fg-muted,#6b7280)">#' + escapeHtml(String(pr.number)) + '</span> <span style="font-weight:600">' + escapeHtml(pr.title || "(无标题)") + '</span></span>'
      +   '<span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hana-fg-muted,#6b7280);font-size:10px">' + escapeHtml(pr.headRefName || "?") + ' → ' + escapeHtml(pr.baseRefName || "?") + (when ? " · " + escapeHtml(when) : "") + '</span>'
      + '</span>'
      + ghPrStateBadge(pr.state, pr.isDraft)
      + '</div>';
  }).join("");
  el.querySelectorAll(".gh-pr-row").forEach(function(row) {
    row.onclick = function() { openPrDetail(Number(row.getAttribute("data-number"))); };
  });
}

// ======== 详情 ========
async function openPrDetail(number) {
  if (!Number.isInteger(number) || number <= 0) return;
  var box = document.getElementById("ghPrDetail");
  if (!box) return;
  _ghPrDetailNumber = number;
  box.style.display = "";
  box.innerHTML = '<div style="font-size:12px;color:var(--hana-fg-muted,#6b7280)">加载 PR #' + escapeHtml(String(number)) + '…</div>';
  updateGhBodyHeight();
  try {
    var p = ghPrCurrentPath();
    var res = await pluginFetch("api/gh/pr-view?number=" + encodeURIComponent(String(number)) + (p ? "&path=" + encodeURIComponent(p) : ""));
    var data = await res.json();
    if (!data.ok || !data.pr) {
      box.innerHTML = '<div style="font-size:11px;color:#c0392b">加载失败：' + escapeHtml((data && data.message) || "未知错误") + '</div>';
      updateGhBodyHeight();
      return;
    }
    renderPrDetail(data.pr);
  } catch (e) {
    notifyApiFailure(e, "PR 详情加载失败");
    box.innerHTML = '<div style="font-size:11px;color:#c0392b">PR 详情加载失败：' + escapeHtml(e && e.message ? e.message : String(e)) + '</div>';
    updateGhBodyHeight();
  }
}

function renderPrDetail(pr) {
  var box = document.getElementById("ghPrDetail");
  if (!box) return;
  var author = pr.author && pr.author.login ? "@" + pr.author.login : "?";
  var body = pr.body != null ? String(pr.body) : "";
  if (body.length > 3000) body = body.slice(0, 3000) + "…";
  var lines = [];
  lines.push('<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">'
    + '<span style="font-weight:600;font-size:13px">#' + escapeHtml(String(pr.number)) + ' ' + escapeHtml(pr.title || "(无标题)") + '</span>'
    + '<span style="flex:1"></span>'
    + '<button onclick="closePrDetail()" title="收起" style="border:0;background:transparent;color:var(--hana-fg-muted,#6b7280);font-size:16px;cursor:pointer;line-height:1">×</button>'
    + '</div>');
  lines.push('<div style="font-size:11px;color:var(--hana-fg-muted,#6b7280);margin-bottom:3px">'
    + ghPrStateBadge(pr.state, pr.isDraft) + ' · '
    + escapeHtml(pr.headRefName || "?") + ' → ' + escapeHtml(pr.baseRefName || "?")
    + ' · 作者 ' + escapeHtml(author) + '</div>');
  lines.push('<div style="font-size:11px;color:var(--hana-fg-muted,#6b7280);margin-bottom:3px">审查：' + escapeHtml(reviewText(pr.reviewDecision)) + ' · 合并：' + escapeHtml(mergeStateText(pr.mergeStateStatus)) + '</div>');
  if (pr.url) {
    lines.push('<div style="font-size:11px;margin-bottom:5px"><button onclick="openGhUrl(\'' + escapeAttr(pr.url) + '\')" style="padding:2px 6px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;font-size:10px;background:transparent;cursor:pointer;color:var(--hana-accent,#4a8cff)">在浏览器打开</button> <button onclick="copyGhUrl(\'' + escapeAttr(pr.url) + '\')" style="padding:2px 6px;border:1px solid var(--hana-border,#d0d5dd);border-radius:4px;font-size:10px;background:transparent;cursor:pointer;color:var(--hana-fg-muted,#6b7280)">复制链接</button></div>');
  }
  if (body) {
    lines.push('<div style="font-size:11px;color:var(--hana-fg);background:var(--hana-bg,#f5f6f8);border:1px solid var(--hana-border,#e2e5ea);border-radius:6px;padding:6px 8px;max-height:160px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;margin-bottom:6px">' + escapeHtml(body) + '</div>');
  }
  // 合并操作区（不可撤销 → 走页内二次确认）
  lines.push('<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
    + '<span style="font-size:11px;color:var(--hana-fg-muted,#6b7280)">合并方式</span>'
    + '<select id="ghPrMergeMethod" style="font-size:11px;padding:3px 6px;border:1px solid var(--hana-border,#d0d5dd);border-radius:6px;background:var(--hana-bg,#f5f6f8);color:var(--hana-fg,#1a1d24)">'
    +   '<option value="merge">merge（保留提交）</option>'
    +   '<option value="squash">squash（压成一个提交）</option>'
    +   '<option value="rebase">rebase（变基）</option>'
    + '</select>'
    + '<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--hana-fg-muted,#6b7280);cursor:pointer"><input type="checkbox" id="ghPrMergeDeleteBranch" style="margin:0"> 合并后删除源分支</label>'
    + '<span style="flex:1"></span>'
    + '<button onclick="confirmMergePr(' + escapeAttr(String(pr.number)) + ')" style="padding:5px 12px;border:0;border-radius:6px;font-size:12px;font-weight:500;background:#e74c3c;color:#fff;cursor:pointer">合并 PR</button>'
    + '</div>'
    + '<div id="ghPrMergeResult" style="font-size:11px;margin-top:6px;word-break:break-word;white-space:pre-line"></div>');
  box.innerHTML = lines.join("");
  updateGhBodyHeight();
}

function closePrDetail() {
  _ghPrDetailNumber = null;
  var box = document.getElementById("ghPrDetail");
  if (box) { box.style.display = "none"; box.innerHTML = ""; }
  updateGhBodyHeight();
}

function reviewText(v) {
  var map = { APPROVED: "已批准", CHANGES_REQUESTED: "请求修改", REVIEW_REQUIRED: "等待审查", COMMENTED: "有评论" };
  if (v === null || v === undefined || v === "") return "无审查数据";
  return map[v] || String(v);
}
function mergeStateText(v) {
  var map = { CLEAN: "可合并", BLOCKED: "被阻断", BEHIND: "落后于目标分支", DIRTY: "有冲突", DRAFT: "草稿", UNSTABLE: "检查未通过", HAS_HOOKS: "含钩子", UNKNOWN: "未知", MERGEABLE: "可合并" };
  if (v === null || v === undefined || v === "") return "无合并状态";
  return map[v] || String(v);
}

// ======== 新建 PR ========
function togglePrCreateForm() {
  var form = document.getElementById("ghPrCreateForm");
  if (!form) return;
  var show = form.style.display === "none";
  form.style.display = show ? "" : "none";
  if (show) {
    var t = document.getElementById("ghPrTitle");
    if (t) t.focus();
  }
  updateGhBodyHeight();
}

async function submitPrCreate() {
  var p = ghPrCurrentPath();
  if (!p) { toast("请先设置本地仓库路径", "err"); return; }
  var base = (document.getElementById("ghPrBase") || {}).value || "";
  var title = (document.getElementById("ghPrTitle") || {}).value || "";
  var bodyText = (document.getElementById("ghPrBody") || {}).value || "";
  var draft = !!(document.getElementById("ghPrDraft") || {}).checked;
  var btn = document.getElementById("ghPrCreateBtn");
  var el = document.getElementById("ghPrCreateResult");
  var original = btn ? btn.textContent : "创建";
  if (btn) { btn.disabled = true; btn.textContent = "创建中…"; btn.style.opacity = "0.7"; btn.style.cursor = "wait"; }
  if (el) { el.style.color = "var(--hana-fg-muted,#6b7280)"; el.textContent = "正在创建 PR…（网络操作可能需要一点时间）"; }
  updateGhBodyHeight();
  try {
    var res = await pluginFetch("api/gh/pr-create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, base: base.trim(), title: title.trim(), body: bodyText, draft: draft }),
    });
    var data = await res.json();
    if (data.ok) {
      if (el) { el.style.color = "#27ae60"; el.textContent = "✅ " + (data.message || "PR 已创建") + (data.url ? "：" + data.url : ""); }
      document.getElementById("ghPrTitle").value = "";
      document.getElementById("ghPrBody").value = "";
      document.getElementById("ghPrBase").value = "";
      document.getElementById("ghPrDraft").checked = false;
      loadPrList(true);
    } else if (el) {
      el.style.color = "#c0392b";
      el.textContent = "❌ " + (data.message || "创建失败");
    }
  } catch (e) {
    if (el) { el.style.color = "#c0392b"; el.textContent = "❌ " + (e && e.message ? e.message : String(e)); }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; btn.style.opacity = ""; btn.style.cursor = "pointer"; }
    updateGhBodyHeight();
  }
}

// ======== 合并 PR（页内二次确认） ========
function confirmMergePr(number) {
  var p = ghPrCurrentPath();
  if (!p) { toast("请先设置本地仓库路径", "err"); return; }
  var methodSel = document.getElementById("ghPrMergeMethod");
  var method = methodSel ? methodSel.value : "merge";
  var deleteBranch = !!(document.getElementById("ghPrMergeDeleteBranch") || {}).checked;
  var methodLabel = method === "squash" ? "squash（压成一个提交）" : method === "rebase" ? "rebase（变基）" : "merge（保留提交）";
  showConfirm(
    "确定要合并 PR #" + number + " 吗？此操作不可撤销。",
    "合并 PR",
    function(ok) { if (ok) doMergePr(number, method, deleteBranch); },
    false,
    {
      title: "⚠️ 合并 Pull Request",
      detailsHtml: "<div style='margin-bottom:4px'><b>PR：</b>#" + escapeHtml(String(number)) + "</div>"
        + "<div style='margin-bottom:4px'><b>合并方式：</b>" + escapeHtml(methodLabel) + "</div>"
        + "<div><b>源分支：</b>" + (deleteBranch ? "合并后删除" : "保留") + "</div>",
    }
  );
}

async function doMergePr(number, method, deleteBranch) {
  var p = ghPrCurrentPath();
  var el = document.getElementById("ghPrMergeResult");
  if (el) { el.style.color = "var(--hana-fg-muted,#6b7280)"; el.textContent = "合并中…"; }
  updateGhBodyHeight();
  try {
    var res = await pluginFetch("api/gh/pr-merge", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, number: number, method: method, deleteBranch: !!deleteBranch }),
    });
    var data = await res.json();
    if (data.ok) {
      toast("✅ " + (data.message || "PR 已合并"), "success");
      if (el) { el.style.color = "#27ae60"; el.textContent = "✅ " + (data.message || "已合并"); }
      loadPrList(true);
      openPrDetail(number);
    } else if (el) {
      el.style.color = "#c0392b";
      el.textContent = "❌ " + (data.message || "合并失败");
    }
  } catch (e) {
    if (el) { el.style.color = "#c0392b"; el.textContent = "❌ " + (e && e.message ? e.message : String(e)); }
  }
  updateGhBodyHeight();
}
