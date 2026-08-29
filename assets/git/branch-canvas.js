// Git Save/Load Card 前端模块 10/26：branch-canvas.js — 分支画布（渲染、拖拽、连线、标注）
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// ======== 分支画布（拖拽流程图） ========
let branchMode = false;
let bcData = null;
let bcBlocks = [];
let bcLabels = {};
let bcPan = { x: 0, y: 0 };
let dragState = null;

function bcKey() { return "bc-layout-v2-" + (currentPath || getSavedPath() || "default"); }
function bcLabelKey() { return "bc-labels-v2-" + (currentPath || getSavedPath() || "default"); }

function toggleBranchTree() {
  branchMode = !branchMode;
  const block = document.getElementById("collapseBlock");
  const panels = document.getElementById("panelsArea");
  const main = document.getElementById("mainInterface");
  if (branchMode) {
    document.querySelector(".header").style.opacity = "0";
    panels.classList.add("collapsing");
    block.classList.add("show");
    block.style.animation = "none";
    void block.offsetHeight;
    block.style.animation = "blockSpawn .3s cubic-bezier(.34,1.56,.64,1) forwards";
    setTimeout(function() {
      main.style.display = "none";
      panels.classList.remove("collapsing");
      renderBranchCanvas();
    }, 350);
  } else {
    main.style.display = "";
    document.querySelector(".header").style.opacity = "";
    panels.style.display = "";
    panels.style.transform = "scale(.1) translateY(-80px)";
    panels.style.opacity = "0";
    block.classList.remove("show");
    requestAnimationFrame(function() { panels.style.transform = ""; panels.style.opacity = ""; });
  }
}

function exitBranchTree() {
  branchMode = false;
  document.getElementById("collapseBlock").classList.remove("show");
  const main = document.getElementById("mainInterface");
  main.style.display = "";
  document.querySelector(".header").style.opacity = "";
  const panels = document.getElementById("panelsArea");
  panels.style.display = "";
  panels.style.transform = "scale(.1) translateY(-80px)";
  panels.style.opacity = "0";
  requestAnimationFrame(function() { panels.style.transform = ""; panels.style.opacity = ""; });
}

async function updateBlockInfo() {
  const p = currentPath || getSavedPath();
  if (!p) return;
  try {
    const res = await pluginFetch("api/branches?path=" + encodeURIComponent(p));
    const data = await res.json();
    if (!data.ok) return;
    var el = document.getElementById("blockBranchCount");
    if (el) el.textContent = (data.branches?.length || 0) + " 个分支";
  } catch {}
}

function bcLoadLayout() {
  try { return JSON.parse(localStorage.getItem(bcKey()) || "null"); } catch { return null; }
}
function bcSaveLayout() {
  var layout = {};
  for (var i = 0; i < bcBlocks.length; i++) {
    layout[bcBlocks[i].name] = { x: parseInt(bcBlocks[i].el.style.left), y: parseInt(bcBlocks[i].el.style.top) };
  }
  localStorage.setItem(bcKey(), JSON.stringify(layout));
  localStorage.setItem(bcLabelKey(), JSON.stringify(bcLabels));
}

async function renderBranchCanvas(focusBranch) {
  var container = document.getElementById("branchBlocks");
  var canvas = document.getElementById("branchCanvas");
  var inner = document.getElementById("bcInner");
  var p = currentPath || getSavedPath();
  if (!p) { if (container) container.textContent = ""; return; }
  try {
    var res = await pluginFetch("api/branches?path=" + encodeURIComponent(p));
    var data = await res.json();
    if (!data.ok) { if (container) container.innerHTML = "<div style='padding:20px;text-align:center;color:#e74c3c;font-size:12px'>" + escapeHtml(data.message) + "</div>"; return; }
    if (!data.branches || data.branches.length === 0) { if (container) container.innerHTML = "<div style='padding:20px;text-align:center;color:var(--hana-fg-muted,#6b7280);font-size:12px'>暂无分支</div>"; return; }

    bcData = data;
    var current = data.branches.find(function(b) { return b.current; }) || data.branches[0];
    var others = data.branches.filter(function(b) { return b.name !== current.name; });
    var allBranches = [current].concat(others);
    
    var el = document.getElementById("blockBranchCount");
    if (el) el.textContent = allBranches.length + " 个分支";

    var savedLayout = bcLoadLayout();
    try { bcLabels = JSON.parse(localStorage.getItem(bcLabelKey()) || "{}"); } catch { bcLabels = {}; }

    var blockW = 160, blockH = 48, gapX = 30, gapY = 20;
    var cols = Math.min(allBranches.length, 3);
    var cw = 300, ch = 300;

    container.innerHTML = allBranches.map(function(b, i) {
      var col = i % cols, row = Math.floor(i / cols);
      var x, y;
      if (savedLayout && savedLayout[b.name]) {
        x = savedLayout[b.name].x; y = savedLayout[b.name].y;
      } else {
        x = 10 + col * (blockW + gapX);
        y = 10 + row * (blockH + gapY);
      }
      cw = Math.max(cw, x + blockW + 20);
      ch = Math.max(ch, y + blockH + 20);
      var bc = branchColor(b.name);
      var cls = "bc-block" + (b.name === current.name ? " current" : "");
      var isCurrent = b.name === current.name;
      return '<div class="' + cls + '" style="left:' + x + 'px;top:' + y + 'px" data-name="' + escapeHtml(b.name) + '">' +
        '<div class="bc-name" title="' + escapeHtml(b.name) + '">' + escapeHtml(b.name) + '</div>' +
        '<div class="bc-meta">' + escapeHtml((b.lastCommit || "").slice(0, 24)) + '</div>' +
        (localStorage.getItem((currentPath || getSavedPath() || "default") + ":note:" + b.name) ? '<div class="bc-note">' + escapeHtml(localStorage.getItem((currentPath || getSavedPath() || "default") + ":note:" + b.name).slice(0, 30)) + '</div>' : '') +
        (isCurrent ? '' : '<div class="bc-tri" style="border-color:transparent ' + bc + ' transparent transparent"></div>') +
        '</div>';
    }).join("");

    bcBlocks = allBranches.map(function(b) {
      var el = container.querySelector('.bc-block[data-name="' + CSS.escape(b.name) + '"]');
      return el ? { name: b.name, el: el } : null;
    }).filter(function(b) { return b; });

    container.style.width = (cw + 200) + "px";
    container.style.height = (ch + 200) + "px";

    // Bind block drag
    for (var bi = 0; bi < bcBlocks.length; bi++) {
      (function(block) {
        if (!block || !block.el) return;
        block.el.onmousedown = function(e) {
          e.stopPropagation();
          dragState = { type: "block", block: block, startX: e.clientX, startY: e.clientY, origX: parseInt(block.el.style.left), origY: parseInt(block.el.style.top) };
          block.el.classList.add("dragging");
        };
      })(bcBlocks[bi]);
    }

    // Canvas drag (pan)
    canvas.onmousedown = function(e) {
      // 点击方块或删除按钮不触发画布拖拽
      if (e.target.closest(".bc-block")) return;
      e.preventDefault();
      dragState = { type: "canvas", startX: e.clientX, startY: e.clientY, origX: bcPan.x, origY: bcPan.y, moved: false };
      canvas.style.cursor = "grabbing";
    };

    // Global mousemove/mouseup
    document.onmousemove = function(e) {
      if (!dragState) return;
      var dx = e.clientX - dragState.startX;
      var dy = e.clientY - dragState.startY;
      if (dragState.type === "block") {
        dragState.block.el.style.left = Math.max(0, dragState.origX + dx) + "px";
        dragState.block.el.style.top = Math.max(0, dragState.origY + dy) + "px";
      } else if (dragState.type === "canvas") {
        bcPan.x = dragState.origX + dx;
        bcPan.y = dragState.origY + dy;
        inner.style.transform = "translate(" + bcPan.x + "px," + bcPan.y + "px)";
      }
      drawConnections();
    };

    document.onmouseup = function() {
      if (dragState) {
        if (dragState.type === "block") {
          dragState.block.el.classList.remove("dragging");
          bcSaveLayout();
        } else if (dragState.type === "canvas") {
          canvas.style.cursor = "";
        }
        dragState = null;
      }
    };

    // Apply saved pan
    inner.style.transform = "translate(" + bcPan.x + "px," + bcPan.y + "px)";

    drawConnections();
    setupCanvasEvents();
    // 创建分支后自动聚焦
    if (focusBranch) {
      var fbEl = container.querySelector('.bc-block[data-name="' + CSS.escape(focusBranch) + '"]');
      if (fbEl) {
        var cr2 = canvas.getBoundingClientRect();
        var fbX = parseInt(fbEl.style.left), fbY = parseInt(fbEl.style.top);
        bcPan.x = cr2.width / 2 - fbX - 80;
        bcPan.y = cr2.height / 2 - fbY - 24;
        inner.style.transform = "translate(" + bcPan.x + "px," + bcPan.y + "px)";
        drawConnections();
      }
    }
  } catch (e) {
    if (container) container.innerHTML = "<div style='padding:20px;text-align:center;color:#e74c3c;font-size:12px'>加载失败</div>";
  }
}

function calcEdges() {
  var branches = bcBlocks.map(function(b) { return b.name; });
  var ed = [];
  // 按前缀推断（支持 / 和 - 分隔）
  for (var ei = 0; ei < branches.length; ei++) {
    var name = branches[ei];
    var found = false;
    // 先试 / 分隔
    var parts = name.split("/");
    if (parts.length > 1) {
      for (var pi = parts.length - 1; pi > 0; pi--) {
        var parent = parts.slice(0, pi).join("/");
        if (branches.indexOf(parent) >= 0) {
          ed.push({ from: parent, to: name });
          found = true; break;
        }
      }
    }
    if (found) continue;
    // 再试 - 分隔
    var dashParts = name.split("-");
    if (dashParts.length > 1) {
      for (var di = dashParts.length - 1; di > 0; di--) {
        var dashParent = dashParts.slice(0, di).join("-");
        if (branches.indexOf(dashParent) >= 0) {
          ed.push({ from: dashParent, to: name });
          break;
        }
      }
    }
  }
  // 剩下的连到根（master/main）
  var root = branches.indexOf("master") >= 0 ? "master" : (branches.indexOf("main") >= 0 ? "main" : (branches[0] || ""));
  for (var ei2 = 0; ei2 < branches.length; ei2++) {
    if (branches[ei2] === root) continue;
    if (!ed.some(function(e) { return e.to === branches[ei2]; })) {
      ed.push({ from: root, to: branches[ei2] });
    }
  }
  return ed;
}

function drawConnections() {
  var container = document.getElementById("branchBlocks");
  var svg = document.getElementById("branchSvg");
  if (!svg || !bcBlocks || bcBlocks.length === 0) return;

  var edges = calcEdges();
  var cr = container.getBoundingClientRect();
  svg.setAttribute("viewBox", "0 0 " + cr.width + " " + cr.height);
  svg.style.width = cr.width + "px";
  svg.style.height = cr.height + "px";

  var pathsHtml = "";
  for (var ei2 = 0; ei2 < edges.length; ei2++) {
    var edge = edges[ei2];
    var fromEl = container.querySelector('.bc-block[data-name="' + CSS.escape(edge.from) + '"]');
    var toEl = container.querySelector('.bc-block[data-name="' + CSS.escape(edge.to) + '"]');
    if (!fromEl || !toEl) continue;

    var fromR = fromEl.getBoundingClientRect();
    var toR = toEl.getBoundingClientRect();
    var x1 = fromR.left - cr.left + fromR.width / 2;
    var y1 = fromR.bottom - cr.top;
    var x2 = toR.left - cr.left + toR.width / 2;
    var y2 = toR.top - cr.top;

    var dd = Math.abs(y2 - y1) * 0.4;
    var pathD = "M " + x1 + " " + y1 + " C " + x1 + " " + (y1 + dd) + ", " + x2 + " " + (y2 - dd) + ", " + x2 + " " + y2;
    pathsHtml += '<path class="conn-path" d="' + pathD + '" fill="none" stroke="var(--hana-border,#d0d5dd)" stroke-width="1.5" stroke-linecap="round"/>';

    // Label
    var labelKey = edge.from + "->" + edge.to;
    var labelText = bcLabels[labelKey] || "";
    if (labelText) {
      var mx = (x1 + x2) / 2;
      var my = (y1 + y2) / 2;
      pathsHtml += '<g class="conn-label" data-from="' + escapeHtml(edge.from) + '" data-to="' + escapeHtml(edge.to) + '" onclick="editLabel(this.dataset.from,this.dataset.to)">';
      pathsHtml += '<rect x="' + (mx - 60) + '" y="' + (my - 9) + '" width="120" height="18"/>';
      pathsHtml += '<text x="' + mx + '" y="' + my + '">' + escapeHtml(labelText) + "</text></g>";
    }
  }
  svg.innerHTML = pathsHtml;
}

function editLabel(from, to) {
  var key = from + "->" + to;
  var cur = bcLabels[key] || "";
  var text = prompt("编辑连线标注（空=删除）:", cur);
  if (text === null) return;
  if (text.trim()) bcLabels[key] = text.trim();
  else delete bcLabels[key];
  bcSaveLayout();
  drawConnections();
}
