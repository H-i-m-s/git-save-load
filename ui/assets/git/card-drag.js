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

  // ======== 指示线的收与放 ========
  // 粉线表示“松手后卡片会落到这里”，是一个纯临时状态。临时状态全靠事件来收，
  // 而结束事件是会丢的：松手落在这个 iframe 外面时容器收不到 drop，
  // 被拖的节点在拖拽期间被重建时 dragend 也送不到。信号一丢，线就永远留在版面上。
  // 所以这里不把任何单一事件当成唯一出口。
  var LINE_IDLE_MS = 1000;   // 拖拽活着时浏览器会持续发 dragover，静默超过这个时长就当它已经结束
  var DRAG_IDLE_MS = 4000;   // 更长的静默：连拖拽状态一起收，防止卡片一直停在半透明
  var lineTimer = null;
  var dragTimer = null;

  // 软收：只收线，不动拖拽来源。
  // 为什么不连 _dragSrc 一起清：万一是真实拖拽中浏览器短暂没发 dragover，
  // 把来源清掉会让后续的落点全部作废，卡片就拖不动了。
  function hideDropLine() {
    dropLine.style.display = "none";
    _dropTarget = null;
    _dropPos = "";
    if (lineTimer) { clearTimeout(lineTimer); lineTimer = null; }
  }

  // 硬收：连线带拖拽状态一起清，只在确定已经结束时用
  function clearDragState() {
    hideDropLine();
    container.querySelectorAll(".card").forEach(function(c) { c.classList.remove("dragging"); });
    _dragSrc = null;
    if (dragTimer) { clearTimeout(dragTimer); dragTimer = null; }
  }

  // 还在拖就续命；超时先软收线，再久一点才硬收状态
  function keepLineAlive() {
    if (lineTimer) clearTimeout(lineTimer);
    lineTimer = setTimeout(function() {
      lineTimer = null;
      hideDropLine();
      container.querySelectorAll(".card").forEach(function(c) { c.classList.remove("dragging"); });
    }, LINE_IDLE_MS);
    if (dragTimer) clearTimeout(dragTimer);
    dragTimer = setTimeout(function() { dragTimer = null; clearDragState(); }, DRAG_IDLE_MS);
  }
  // 元素级事件
  container.addEventListener("dragstart", function(e) {
    // 兑底：即使 mousedown 拦截失效，也要阻止 input 上的 drag
    if (e.target.closest('input, textarea, select, [contenteditable], .commit-tooltip')) {
      e.preventDefault();
      return;
    }
    var card = e.target.closest(".card");
    if (!card) return;
    hideDropLine();   // 上一次若没收拾干净，新一次拖拽先把线收掉，不带着残留走
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
    clearDragState();
  });
  container.addEventListener("dragover", function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // 不是从卡片里发起的拖拽（比如从资源管理器拖文件进来）不该出现插入提示
    if (!_dragSrc) return;
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
        keepLineAlive();
        return;
      }
      if (e.clientY > lastRect.bottom) {
        // 最下方
        container.appendChild(dropLine);
        dropLine.style.display = "block";
        _dropTarget = cards[cards.length - 1]; _dropPos = "after";
        keepLineAlive();
        return;
      }
    }
    var target = e.target.closest(".card");
    // 停在被拖卡片自己身上、或停在卡片之外的空地上：没有有效落点。
    // 这里必须收线并清掉旧落点，否则松手会拿上一次的 _dropTarget 把卡片挪到别处。
    if (!target || target === _dragSrc) { hideDropLine(); return; }
    _dropTarget = target;
    var rect = target.getBoundingClientRect();
    _dropPos = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (_dropPos === "before") {
      container.insertBefore(dropLine, target);
    } else {
      container.insertBefore(dropLine, target.nextSibling);
    }
    dropLine.style.display = "block";
    keepLineAlive();
  });
  container.addEventListener("drop", function(e) {
    e.preventDefault();
    // 先把落点取下来再收线：hideDropLine 会清掉 _dropTarget
    var src = _dragSrc, target = _dropTarget, pos = _dropPos;
    hideDropLine();
    if (!src || !target || src === target) { _dragSrc = null; return; }
    if (pos === "before") {
      container.insertBefore(src, target);
    } else {
      container.insertBefore(src, target.nextSibling);
    }
    _dragSrc = null;
    saveCardOrder();
  });
  // 兜底一：松手落在 iframe 外面时，容器收不到 drop，dragend 也可能送不到。
  // 挂在 document 的冒泡阶段，保证容器自己的处理先跑完，
  // 否则 _dropTarget 被提前清掉，卡片就不移动了。
  document.addEventListener("drop", function() { clearDragState(); });
  document.addEventListener("dragend", function() { clearDragState(); });
  // 兜底二：指针真的离开了卡片区域，插入位置已经没有意义。
  // 不用 relatedTarget 判断：真实拖拽里它经常是 null（浏览器实现不一），
  // 一旦为 null 就会在容器内部迁移时误收，线会闪。用坐标最稳。
  container.addEventListener("dragleave", function(e) {
    if (typeof e.clientX !== "number" || (e.clientX === 0 && e.clientY === 0)) return;
    var r = container.getBoundingClientRect();
    var inside = e.clientX >= r.left && e.clientX <= r.right &&
                 e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) clearDragState();
  });
  // 兜底三：窗口失焦，拖拽基本已经结束
  window.addEventListener("blur", function() { clearDragState(); });

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
