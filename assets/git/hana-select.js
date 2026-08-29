// Git Save/Load Card 前端模块 12/26：hana-select.js — 自绘下拉（HanaSelect）
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// === HanaSelect 自绘下拉 ===
// 背后的原生 <select> 仍是状态源；HanaSelect 只负责视觉与交互
const _hanaSelectInstances = new Map();
function replaceSelectWithHanaSelect(selectId, opts) {
  opts = opts || {};
  var sel = document.getElementById(selectId);
  if (!sel || sel._hanaSelectReplaced) return;
  sel._hanaSelectReplaced = true;
  sel.style.display = "none";

  var options = opts.options;
  if (!options && sel.options) {
    options = Array.prototype.slice.call(sel.options).map(function(o) {
      return { value: o.value, label: o.text };
    });
  }
  if (!options) return;

  // 触发器
  var trigger = document.createElement("div");
  trigger.className = "hana-select";
  trigger.setAttribute("role", "button");
  trigger.setAttribute("tabindex", "0");
  var label = document.createElement("span");
  label.className = "hana-select-label";
  trigger.appendChild(label);
  var chevron = document.createElement("span");
  chevron.className = "hana-select-chevron";
  trigger.appendChild(chevron);

  // 面板
  var panel = document.createElement("div");
  panel.className = "hana-select-panel";
  panel.setAttribute("role", "listbox");
  panel.style.display = "none";
  document.body.appendChild(panel);

  var state = {
    open: false,
    currentValue: sel.value != null ? sel.value : (options[0] ? options[0].value : "")
  };

  function getLabel(v) {
    for (var i = 0; i < options.length; i++) if (options[i].value == v) return options[i].label;
    return "";
  }
  function refresh() {
    label.textContent = getLabel(state.currentValue);
    var cEls = panel.children;
    for (var i = 0; i < cEls.length; i++) {
      var cls = cEls[i].classList;
      cls.toggle("selected", cEls[i].dataset.value == state.currentValue);
    }
  }
  function openPanel() {
    closeAllHanaSelects();
    // 默认贴在触发器下面；只有普通下拉在下方空间不足时才反向到上面。
    var tr = trigger.getBoundingClientRect();
    var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 480;
    var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 320;
    var gap = 4;
    var viewportPadding = 8;
    panel.style.minWidth = Math.max(140, tr.width) + "px";
    panel.style.maxHeight = "240px";
    panel.style.left = tr.left + "px";
    panel.style.top = (tr.bottom + gap) + "px";
    panel.style.display = "block";

    var ph = panel.offsetHeight;
    if (opts.preferBelow) {
      // 编辑仓库弹窗中的下拉固定从选项框下方展开；空间不足时缩短并滚动，绝不上翻。
      var spaceBelow = Math.max(1, viewportHeight - tr.bottom - viewportPadding - gap);
      panel.style.maxHeight = Math.min(240, spaceBelow) + "px";
      panel.style.top = (tr.bottom + gap) + "px";
    } else if (tr.bottom + gap + ph > viewportHeight - viewportPadding) {
      panel.style.top = (tr.top - ph - gap) + "px";
    }
    if (tr.left + panel.offsetWidth > viewportWidth - viewportPadding) {
      panel.style.left = Math.max(viewportPadding, viewportWidth - panel.offsetWidth - viewportPadding) + "px";
    }
    panel.classList.add("open");
    trigger.classList.add("open");
    state.open = true;
  }
  function closePanel() {
    panel.classList.remove("open");
    trigger.classList.remove("open");
    state.open = false;
    setTimeout(function(){ if (!state.open) panel.style.display = "none"; }, 130);
  }
  function setValue(v, fire) {
    if (state.currentValue == v) return;
    state.currentValue = v;
    sel.value = v;
    refresh();
    if (fire && typeof opts.onChange === "function") opts.onChange(v);
  }

  options.forEach(function(opt) {
    var optEl = document.createElement("div");
    optEl.className = "hana-select-option";
    optEl.setAttribute("role", "option");
    optEl.dataset.value = opt.value;
    optEl.textContent = opt.label;
    optEl.addEventListener("click", function(e) {
      e.stopPropagation();
      setValue(opt.value, true);
      closePanel();
    });
    panel.appendChild(optEl);
  });

  trigger.addEventListener("click", function(e) {
    e.stopPropagation();
    if (state.open) closePanel(); else openPanel();
  });
  trigger.addEventListener("keydown", function(e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (state.open) closePanel(); else openPanel(); }
  });

  panel._trigger = trigger;
  refresh();

  sel.parentNode.insertBefore(trigger, sel.nextSibling);
  if (opts.fullWidth || (sel.parentNode && sel.parentNode.id === "ghLicenseWrap")) {
    trigger.style.width = "100%";
    trigger.style.boxSizing = "border-box";
  }

  function replaceOptions(nextOptions) {
    options = Array.prototype.slice.call(nextOptions || []).map(function(o) {
      return { value: o.value, label: o.text };
    });
    panel.innerHTML = "";
    options.forEach(function(opt) {
      var optEl = document.createElement("div");
      optEl.className = "hana-select-option";
      optEl.setAttribute("role", "option");
      optEl.dataset.value = opt.value;
      optEl.textContent = opt.label;
      optEl.addEventListener("click", function(e) {
        e.stopPropagation();
        setValue(opt.value, true);
        closePanel();
      });
      panel.appendChild(optEl);
    });
    state.currentValue = sel.value || (options[0] ? options[0].value : "");
    refresh();
  }

  sel._hanaSelect = {
    refresh: refresh,
    close: closePanel,
    replaceOptions: replaceOptions,
    trigger: trigger,
    panel: panel,
    sync: function() { state.currentValue = sel.value; refresh(); }
  };
  _hanaSelectInstances.set(selectId, sel._hanaSelect);
}
function closeAllHanaSelects() {
  document.querySelectorAll(".hana-select-panel.open").forEach(function(p) {
    p.classList.remove("open");
    if (p._trigger) p._trigger.classList.remove("open");
    p.style.display = "none";
  });
}
function syncHanaSelects() {
  _hanaSelectInstances.forEach(function(hs, id) { hs.sync(); });
}
function initHanaSelects() {
  replaceSelectWithHanaSelect("ghLicense", { fullWidth: true });
  replaceSelectWithHanaSelect("ghEditLicense", { fullWidth: true, preferBelow: true });
  replaceSelectWithHanaSelect("ghEditVisibility", { fullWidth: true, preferBelow: true });
  replaceSelectWithHanaSelect("ghConnectRepoSelect", {
    onChange: function(v) { onGhConnectRepoSelect(); }
  });
  replaceSelectWithHanaSelect("remoteUrlRepoSelect", {
    onChange: function(v) { onRemoteUrlRepoSelect(); }
  });
  // cfgStashMode
  replaceSelectWithHanaSelect("cfgStashMode", {
    onChange: function(v) { saveSetting("stashMode", v); }
  });
  // cfgPushMode
  replaceSelectWithHanaSelect("cfgPushMode", {
    onChange: function(v) { saveSetting("pushMode", v); }
  });
  // cfgPullMode
  replaceSelectWithHanaSelect("cfgPullMode", {
    onChange: function(v) { saveSetting("pullMode", v); }
  });
  // cfgTheme
  replaceSelectWithHanaSelect("cfgTheme", {
    onChange: function(v) { switchTheme(v); }
  });
  // gitignoreSelect（不调用 onChange，依赖原 onchange="applyTemplate()"
  // 但原 onchange 是原生 select 的机制，隐藏后不再 fire。需手动调 applyTemplate）
  replaceSelectWithHanaSelect("gitignoreSelect", {
    onChange: function() { applyTemplate(); }
  });
}

// 右键菜单：创建分支、删除
