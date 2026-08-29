// Git Save/Load Card 前端模块 13/26：branch-actions.js — 分支右键操作、自定义输入弹框、分支增删切换
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
function showBranchCtx(e, branchName) {
  e.preventDefault();
  var menu = document.getElementById("ctxMenu");
  var nameEsc = escapeHtml(branchName);
  var noteKey = (currentPath || getSavedPath() || "default") + ":note:" + branchName;
  var curNote = localStorage.getItem(noteKey) || "";
  var noteLabel = curNote ? "✏ 备注: " + escapeHtml(curNote.slice(0, 20)) : "✏ 添加备注";
  menu.innerHTML = 
    '<div class="has-sub"><div class="item">▶ 创建分支</div><div class="sub">' +
      '<div class="item" data-bc="normal-branch:' + nameEsc + '">普通分支</div>' +
      '<div class="item" data-bc="child:' + nameEsc + '">基于当前创建</div>' +
      '<div class="item" data-bc="commit-branch:' + nameEsc + '">基于 commit...</div>' +
    '</div></div>' +
    '<div class="item" data-bc="switch:' + nameEsc + '">↑ 切换到该分支</div>' +
    (branchName === "master" || branchName === "main" ? '' :
    '<div class="has-sub"><div class="item">🎨 设置颜色</div><div class="sub">' +
      '<div class="item" data-bc="setcolor:default:' + nameEsc + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;border:1px solid var(--hana-border,#d0d5dd);vertical-align:middle;margin-right:5px"></span> 默认</div>' +
      '<div class="item" data-bc="setcolor:#5e6ad2:' + nameEsc + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#5e6ad2;vertical-align:middle;margin-right:5px"></span> 功能</div>' +
      '<div class="item" data-bc="setcolor:#e67e22:' + nameEsc + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#e67e22;vertical-align:middle;margin-right:5px"></span> 修复</div>' +
      '<div class="item" data-bc="setcolor:#e74c3c:' + nameEsc + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#e74c3c;vertical-align:middle;margin-right:5px"></span> 紧急</div>' +
      '<div class="item" data-bc="setcolor:#8b5cf6:' + nameEsc + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#8b5cf6;vertical-align:middle;margin-right:5px"></span> 发布</div>' +
      '<div class="item" data-bc="setcolor:#06b6d4:' + nameEsc + '"><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#06b6d4;vertical-align:middle;margin-right:5px"></span> 开发</div>' +
      '<div class="item" data-bc="color-help:' + nameEsc + '">颜色说明</div>' +
    '</div></div>') +
    '<div class="item" data-bc="note:' + nameEsc + '">' + noteLabel + '</div>' +
    '<div class="item danger" data-bc="delete:' + nameEsc + '">✕ 删除分支</div>';
  openCtxMenuWithAnim(menu, e.clientX, e.clientY, 180, 120);
  // 点击一级菜单项切换二级菜单（不再依赖 hover）
  var openSub = null;
  menu.querySelectorAll(".has-sub > .item").forEach(function(parentItem) {
    parentItem.onclick = function(ev) {
      ev.stopPropagation();
      var hasSub = parentItem.parentElement;
      var sub = hasSub.querySelector(".sub");
      if (!sub) return;
      // 关闭其他子菜单
      if (openSub && openSub !== sub) openSub.style.display = "none";
      // 切换当前子菜单
      if (sub.style.display === "block") {
        sub.style.display = "none";
        openSub = null;
      } else {
        var mr = menu.getBoundingClientRect();
        var sw = 170, sh = 240;
        var subLeft = mr.right + sw > window.innerWidth ? mr.left - sw : mr.right;
        var subTop = mr.top + sh > window.innerHeight ? window.innerHeight - sh : mr.top;
        sub.style.left = subLeft + "px";
        sub.style.top = subTop + "px";
        sub.style.display = "block";
        openSub = sub;
      }
    };
  });
  // 点击子菜单项关闭子菜单（交给事件委托处理）
}

// 画布事件委托
function setupCanvasEvents() {
  // Delete button
  var blocks = document.getElementById("branchBlocks");
  if (!blocks) return;
  blocks.onclick = function(e) {
  };
  blocks.oncontextmenu = function(e) {
    var block = e.target.closest(".bc-block");
    if (block) {
      e.preventDefault();
      var name = block.getAttribute("data-name");
      if (name) showBranchCtx(e, name);
    }
  };
}

// 右键菜单事件委托
// ======== 自定义输入弹框 ========
var _promptCb = null;
function customPrompt(title, defaultValue, cb) {
  document.getElementById("promptTitle").textContent = title;
  document.getElementById("promptInput").value = defaultValue || "";
  _promptCb = cb;
  document.getElementById("promptModal").style.display = "flex";
  setTimeout(function() { document.getElementById("promptInput").focus(); document.getElementById("promptInput").select(); }, 50);
}
function confirmPrompt() {
  var val = document.getElementById("promptInput").value;
  cleanupPrompt();
  var cb = _promptCb;
  _promptCb = null;
  if (cb) cb(val);
}
function cancelPrompt() {
  cleanupPrompt();
  if (_promptCb) _promptCb(null);
  _promptCb = null;
}
function cleanupPrompt() {
  document.getElementById("promptModal").style.display = "none";
  var ol = document.getElementById("commitListOptions");
  if (ol) ol.remove();
  document.getElementById("promptInput").placeholder = "";
}

// 点击其他地方关闭菜单
document.addEventListener("click", function(e) {
  var m = document.getElementById("ctxMenu");
  if (m && m.style.display !== "none" && !m.contains(e.target)) m.style.display = "none";
  var gm = document.getElementById("ghCtxMenu");
  if (gm && gm.style.display !== "none" && !gm.contains(e.target)) gm.style.display = "none";
  var rm = document.getElementById("remoteCtxMenu");
  if (rm && rm.style.display !== "none" && !rm.contains(e.target)) rm.style.display = "none";
});

function setupCtxMenuEvents() {
  var menu = document.getElementById("ctxMenu");
  if (!menu) return;
  menu.onclick = function(e) {
    var item = e.target.closest(".item");
    if (!item) return;
    var bc = item.getAttribute("data-bc");
    if (!bc) return;
    var parts = bc.split(":");
    var action = parts[0];
    var name = parts.slice(1).join(":");
    if (action === "delete") deleteBranch(name);
    else if (action === "switch") switchBranch(name);
    else if (action === "child") createChildBranch(name);
    else if (action === "note") setBranchNote(name);
    else if (action === "normal-branch") createNormalBranch(name);
    else if (action === "commit-branch") createCommitBranch(name);
    else if (action === "color-help") { menu.style.display = "none"; showBranchColorHelp(); }
    else if (action === "setcolor") {
      menu.style.display = "none";
      var parts2 = bc.split(":");
      var color = parts2[1];
      var branch = parts2.slice(2).join(":");
      var key = (currentPath || getSavedPath() || "default") + ":color:" + branch;
      if (color === "default") localStorage.removeItem(key);
      else localStorage.setItem(key, color);
      renderBranchCanvas();
    }
    else menu.style.display = "none";
  };
}

function setBranchNote(name) {
  var key = (currentPath || getSavedPath() || "default") + ":note:" + name;
  var cur = localStorage.getItem(key) || "";
  customPrompt("分支备注（空=删除）:", cur, function(text) {
    if (text === null) return;
    if (text.trim()) localStorage.setItem(key, text.trim());
    else localStorage.removeItem(key);
    renderBranchCanvas();
  });
}

async function deleteBranch(name) {
  var p = currentPath || getSavedPath();
  if (!p) return;
  try {
    var res = await pluginFetch("api/branch/delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, path: p }),
    });
    var data = await res.json();
    if (data.ok) { Bus.emit("branch-delete"); toast("🗑 已删除 " + name, "info"); renderBranchCanvas(); }
    else toast("❌ " + data.message, "err");
  } catch (e) { toast("删除失败：" + e.message, "err"); }
}

function branchColor(name) {
  // 优先读取自定义颜色
  var custom = localStorage.getItem((currentPath || getSavedPath() || "default") + ":color:" + name);
  if (custom) return custom;
  // 默认按命名约定
  if (name === "master" || name === "main") return "#27a644";
  if (name.startsWith("feature/")) return "#5e6ad2";
  if (name.startsWith("fix/") || name.startsWith("bugfix/")) return "#e67e22";
  if (name.startsWith("hotfix/")) return "#e74c3c";
  if (name.startsWith("release/")) return "#8b5cf6";
  if (name === "develop") return "#06b6d4";
  return "var(--hana-border,#23252a)";
}

async function switchBranch(name) {
  document.getElementById("ctxMenu").style.display = "none";
  var p = currentPath || getSavedPath();
  if (!p) return;
  try {
    var res = await pluginFetch("api/branch/switch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, path: p }),
    });
    var data = await res.json();
    if (data.ok) { Bus.emit("branch-switch"); toast("✅ 已切换到 " + name, "success"); exitBranchTree(); refresh(); }
    else toast("❌ " + data.message, "err");
  } catch (e) { toast("切换失败：" + e.message, "err"); }
}

function createNormalBranch(fromName) {
  customPrompt("新分支名:", "", function(val) {
    if (!val || !val.trim()) return;
    var p = currentPath || getSavedPath();
    if (!p) { toast("请先设置仓库路径", "err"); return; }
    pluginFetch("api/branch/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: val.trim(), path: p }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) { toast("✅ 已创建 " + val.trim(), "success"); renderBranchCanvas(val.trim()); }
      else toast("❌ " + data.message, "err");
    }).catch(function(e) { toast("创建失败：" + e.message, "err"); });
  });
}

function createCommitBranch(fromName) {
  var p = currentPath || getSavedPath();
  if (!p) { toast("请先设置仓库路径", "err"); return; }
  // 先获取最近 commit 列表
  pluginFetch("api/log?count=15&path=" + encodeURIComponent(p)).then(function(r) { return r.json(); }).then(function(data) {
    var commits = (data.ok && data.commits) ? data.commits : [];
    // 显示 commit 选择弹框
    var modal = document.getElementById("promptModal");
    var title = document.getElementById("promptTitle");
    var input = document.getElementById("promptInput");
    title.textContent = "选择 commit 作为起点";
    input.value = "";
    input.placeholder = "或手动输入 hash...";
    // 在 modal 里添加 commit 列表
    var listDiv = document.createElement("div");
    listDiv.id = "commitListOptions";
    listDiv.style.cssText = "max-height:200px;overflow-y:auto;margin:8px 0;border:1px solid var(--hana-border,#e2e5ea);border-radius:6px";
    if (commits.length === 0) {
      listDiv.innerHTML = "<div style='padding:8px;font-size:11px;color:var(--hana-fg-muted,#6b7280);text-align:center'>暂无 commit 记录</div>";
    } else {
      listDiv.innerHTML = commits.map(function(c) {
        return '<div class="ci-item" data-hash="' + c.hash + '" style="padding:5px 8px;font-size:11px;font-family:monospace;cursor:pointer;border-bottom:1px solid var(--hana-border,#eef0f2);display:flex;gap:6px">' +
          '<span style="color:var(--hana-accent,#4a8cff);flex-shrink:0">' + escapeHtml(c.hash) + '</span>' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hana-fg,#1a1d24)">' + escapeHtml(c.message || "") + '</span></div>';
      }).join("");
      // 点击选中
      setTimeout(function() {
        listDiv.querySelectorAll(".ci-item").forEach(function(el) {
          el.onclick = function() {
            input.value = el.getAttribute("data-hash");
            listDiv.querySelectorAll(".ci-item").forEach(function(e) { e.style.background = ""; e.style.color = ""; e.querySelectorAll("*").forEach(function(c) { c.style.color = ""; }); });
            el.style.background = "var(--hana-accent,#4a8cff)";
            el.style.color = "#fff";
            var hashSpan = el.querySelector("span");
            if (hashSpan) hashSpan.style.color = "#fff";
          };
        });
      }, 50);
    }
    // 移除旧的列表
    var oldList = document.getElementById("commitListOptions");
    if (oldList) oldList.remove();
    // 插入到 input 后面
    input.parentNode.insertBefore(listDiv, input.nextSibling);
    modal.style.display = "flex";
    setTimeout(function() { input.focus(); }, 50);
    // 重写确认/取消
    _promptCb = function(hash) {
      if (!hash || !hash.trim()) return;
      // 清理列表
      var ol = document.getElementById("commitListOptions");
      if (ol) ol.remove();
      input.placeholder = "";
      // 第二步：输入分支名
      customPrompt("新分支名:", "", function(name) {
        if (!name || !name.trim()) return;
        var repo = currentPath || getSavedPath();
        pluginFetch("api/branch/create", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), path: repo, startPoint: hash.trim() }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.ok) { toast("✅ 已创建 " + name.trim(), "success"); renderBranchCanvas(name.trim()); }
          else toast("❌ " + d.message, "err");
        }).catch(function(e) { toast("创建失败：" + e.message, "err"); });
      });
    };
  }).catch(function(e) { toast("获取 commit 列表失败：" + e.message, "err"); });
}

async function createChildBranch(parentName) {
  customPrompt("子分支名（无需包含父路径）:", "", function(child) {
    if (!child || !child.trim()) return;
    var name = parentName + "-" + child.trim();
    var p = currentPath || getSavedPath();
    pluginFetch("api/branch/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, path: p }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.ok) { toast("✅ 已创建 " + name, "success"); renderBranchCanvas(name); }
      else toast("❌ " + data.message, "err");
    }).catch(function(e) { toast("创建失败：" + e.message, "err"); });
  });
}

// 提交记录分页加载
