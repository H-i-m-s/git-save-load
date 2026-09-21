// Git Save/Load Card 前端模块 3/26：card-drag.js — 卡片拖拽排序
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// ======== 卡片拖拽排序 ========
var CARD_ORDER_KEY = "gsl-card-order";
var _dragSrc = null;
var _dropTarget = null;
var _dropPos = ""; // "before" or "after"
// 历史列表里"点选预期"的仓库路径；空表示交由 currentPath 决定高亮。
var _highlightedPath = "";

function initCardDrag() {
  var container = document.getElementById("panelsArea");
  if (!container) return;
  // 先把 ghCard 移入 panelsArea（如果不在里面）
  var ghCard = document.getElementById("ghCard");
  if (ghCard && ghCard.parentElement !== container) {
    var refCard = document.getElementById("settingsCard");
    if (refCard && refCard.nextSibling) { container.insertBefore(ghCard, refCard.nextSibling); }
    else { container.appendChild(ghCard); }
    ghCard.draggable = true;
    var ghHdr = ghCard.querySelector(".card-title");
    if (ghHdr && !ghHdr.querySelector(".drag-handle")) {
      var ghHandle = document.createElement("span");
      ghHandle.className = "drag-handle";
      ghHandle.textContent = "\u2630";
      ghHandle.style.cssText = "cursor:grab;color:var(--hana-fg-subtle,#62666d);font-size:11px;flex-shrink:0;user-select:none;margin-right:4px";
      ghHdr.insertBefore(ghHandle, ghHdr.firstChild);
    }
  }
  // 恢复保存的顺序
  try {
    var order = JSON.parse(localStorage.getItem(CARD_ORDER_KEY));
    if (order && order.length > 0) {
      var cardMap = {};
      container.querySelectorAll(".card").forEach(function(c) { cardMap[c.id] = c; });
      order.forEach(function(id) { if (cardMap[id]) container.appendChild(cardMap[id]); });
    }
  } catch {}
  // 创建指示线
  var dropLine = document.createElement("div");
  dropLine.id = "dragDropLine";
  dropLine.style.cssText = "display:none;height:2px;background:var(--hana-accent,#5e6ad2);margin:2px 0;border-radius:1px;pointer-events:none;position:relative;z-index:10";
  container.appendChild(dropLine);
  // 元素级事件
  container.addEventListener("dragstart", function(e) {
    // 兑底：即使 mousedown 拦截失效，也要阻止 input 上的 drag
    if (e.target.closest('input, textarea, select, [contenteditable], .commit-tooltip')) {
      e.preventDefault();
      return;
    }
    var card = e.target.closest(".card");
    if (!card) return;
    _dragSrc = card;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  // 根本修复：mousedown 捕获阶段把所属卡片临时关掉 draggable，
  // 让浏览器在决定"拖卡片"或"文本选择"时走文本选择路径。
  // 注意用捕获阶段，保证发生在浏览器默认判定之前。
  container.addEventListener("mousedown", function(e) {
    if (!e.target.closest('input, textarea, select, [contenteditable], .commit-tooltip')) return;
    var card = e.target.closest('.card');
    if (!card || !card.getAttribute('draggable')) return;
    card.setAttribute('draggable', 'false');
    var restore = function() {
      card.setAttribute('draggable', 'true');
      document.removeEventListener('mouseup', restore, true);
      document.removeEventListener('mouseleave', restore, true);
    };
    document.addEventListener('mouseup', restore, true);
    document.addEventListener('mouseleave', restore, true);
  }, true);
  container.addEventListener("dragend", function(e) {
    dropLine.style.display = "none";
    container.querySelectorAll(".card").forEach(function(c) { c.classList.remove("dragging"); });
    _dragSrc = null; _dropTarget = null;
  });
  container.addEventListener("dragover", function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    var cr = container.getBoundingClientRect();
    var cards = container.querySelectorAll(".card:not(.dragging)");
    // 检查是否在最上方或最下方
    if (cards.length > 0) {
      var firstRect = cards[0].getBoundingClientRect();
      var lastRect = cards[cards.length - 1].getBoundingClientRect();
      if (e.clientY < firstRect.top) {
        // 最上方
        container.insertBefore(dropLine, cards[0]);
        dropLine.style.display = "block";
        _dropTarget = cards[0]; _dropPos = "before";
        return;
      }
      if (e.clientY > lastRect.bottom) {
        // 最下方
        container.appendChild(dropLine);
        dropLine.style.display = "block";
        _dropTarget = cards[cards.length - 1]; _dropPos = "after";
        return;
      }
    }
    var target = e.target.closest(".card");
    if (!target || target === _dragSrc) return;
    _dropTarget = target;
    var rect = target.getBoundingClientRect();
    _dropPos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (_dropPos === "before") {
      container.insertBefore(dropLine, target);
    } else {
      container.insertBefore(dropLine, target.nextSibling);
    }
    dropLine.style.display = "block";
  });
  container.addEventListener("drop", function(e) {
    e.preventDefault();
    dropLine.style.display = "none";
    if (!_dragSrc || !_dropTarget || _dragSrc === _dropTarget) return;
    if (_dropPos === "before") {
      container.insertBefore(_dragSrc, _dropTarget);
    } else {
      container.insertBefore(_dragSrc, _dropTarget.nextSibling);
    }
    saveCardOrder();
  });
  // 每个卡片加拖拽把手
  container.querySelectorAll(".card").forEach(function(c) {
    c.draggable = true;
    var hdr = c.querySelector(".card-title");
    if (hdr && !hdr.querySelector(".drag-handle")) {
      var handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "\u2630";
      handle.style.cssText = "cursor:grab;color:var(--hana-fg-subtle,#62666d);font-size:11px;flex-shrink:0;user-select:none;margin-right:4px";
      hdr.insertBefore(handle, hdr.firstChild);
    }
  });
}

function saveCardOrder() {
  var container = document.getElementById("panelsArea");
  if (!container) return;
  var ids = [];
  container.querySelectorAll(".card").forEach(function(c) { ids.push(c.id); });
  try { localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(ids)); } catch {}
}
