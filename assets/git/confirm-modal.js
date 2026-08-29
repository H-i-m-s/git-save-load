// Git Save/Load Card 前端模块 21/26：confirm-modal.js — 通用确认弹窗
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
let confirmCallback = null;
let selectedResetMode = "soft";

function pickResetMode(mode) {
  selectedResetMode = mode;
  document.querySelectorAll(".reset-mode-option").forEach(el => {
    if (el.dataset.mode === mode) {
      const accent = mode === 'soft' ? '#e67e22' : mode === 'mixed' ? '#3498db' : '#e74c3c';
      el.style.borderColor = accent;
      el.style.boxShadow = '0 0 0 2px rgba(' + (mode === 'soft' ? '230,126,34' : mode === 'mixed' ? '52,152,219' : '231,76,60') + ',.25)';
    } else {
      el.style.borderColor = "var(--hana-border,#e2e5ea)";
      el.style.boxShadow = '';
    }
  });
}

function showConfirm(msg, okText, cb, showMode, options) {
  options = options || {};
  const title = document.getElementById("confirmTitle");
  if (title) title.textContent = options.title || "↩️ 回滚到指定版本";
  document.getElementById("confirmMsg").textContent = msg;
  document.getElementById("confirmOkBtn").textContent = okText || "确定";
  document.getElementById("modeSelector").style.display = showMode ? "" : "none";
  const details = document.getElementById("confirmDetails");
  if (details) {
    details.innerHTML = options.detailsHtml || "";
    details.style.display = options.detailsHtml ? "" : "none";
  }
  if (showMode) pickResetMode("soft");
  confirmCallback = cb;
  document.getElementById("confirmModal").style.display = "";
}

// 切换状态帮助气泡
// 冲突解决状态
