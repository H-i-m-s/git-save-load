// Git Save/Load Card 前端模块 5/26：settings.js — 设置面板、分段控件、主题与纹理、配置保存、容器高度同步
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// ======== 设置 ========
function toggleSettings() {
  var body = document.getElementById("settingsBody");
  var toggle = document.getElementById("settingsToggle");
  if (!body) return;
  var open = body.style.maxHeight !== "0px" && body.style.maxHeight !== "";
  if (open) {
    body.style.maxHeight = "0px";
    if (toggle) toggle.textContent = "▸";
  } else {
    loadSettingsUI();
    body.style.maxHeight = body.scrollHeight + "px";
    if (toggle) toggle.textContent = "▾";
  }
  requestHostResize();
}

// === 分段按钮助手（HanaSegments） ===
// 设当前选中（按 data-value 匹配）
function setHanaSegActive(seg, value) {
  if (typeof seg === "string") seg = document.getElementById(seg);
  if (!seg || !value) return;
  seg.querySelectorAll(".hana-seg-btn").forEach(function(btn) {
    btn.classList.toggle("active", btn.getAttribute("data-value") === value);
  });
}
// 读当前选中值
function getHanaSegValue(seg) {
  if (typeof seg === "string") seg = document.getElementById(seg);
  if (!seg) return "";
  var a = seg.querySelector(".hana-seg-btn.active");
  return a ? a.getAttribute("data-value") : "";
}
// 绑定点击；指定 configKey 后默认调 saveSetting，否则走 onChange
function bindHanaSeg(id, configKey, onChange) {
  var seg = document.getElementById(id);
  if (!seg) return;
  seg.querySelectorAll(".hana-seg-btn").forEach(function(btn) {
    btn.onclick = function() {
      var v = btn.getAttribute("data-value");
      if (btn.classList.contains("active")) return;
      setHanaSegActive(seg, v);
      if (typeof onChange === "function") onChange(v);
      else if (configKey) saveSetting(configKey, v);
    };
  });
}
// 初始化三个分段控件的点击逻辑（只需调用一次）
function initAllHanaSegs() {
  bindHanaSeg("segDiffMode", "defaultDiffMode");
  bindHanaSeg("segGhOpen", "ghOpenMode");
  bindHanaSeg("segGhPrivacy");   // ghPrivacy 不需持久化，默认 公开
}

async function loadSettingsUI() {
  try {
    const res = await pluginFetch("api/config");
    const data = await res.json();
    if (!data.ok || !data.config) return;
    const c = data.config;
    const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    set("cfgStashMode", c.stashMode);
    set("cfgPushMode", c.pushMode);
    set("cfgPullMode", c.pullMode);
    // 新分段控件：从后端拉来的值用于点亮初始状态
    setHanaSegActive("segDiffMode", c.defaultDiffMode || "detail");
    setHanaSegActive("segGhOpen", c.ghOpenMode || "internal");
    var textureEl = document.getElementById("cfgTexture");
    if (textureEl) textureEl.checked = (c.paperTexture === "on");
  } catch {}
  // 后端值写到隐藏 select 后，让对应的 HanaSelect 触发器刷新 label
  syncHanaSelects();
  // 应用保存的主题
  var savedTheme = localStorage.getItem("git-sl-theme");
  if (savedTheme) {
    applyTheme(savedTheme);
    var themeSel = document.getElementById("cfgTheme");
    if (themeSel) themeSel.value = savedTheme;
    syncHanaSelects();
  }
  // 应用保存的纸质纹理
  var savedTexture = localStorage.getItem("git-sl-texture");
  if (savedTexture) {
    applyTexture(savedTexture === "on");
    var textureEl = document.getElementById("cfgTexture");
    if (textureEl) textureEl.checked = (savedTexture === "on");
  }
}

function switchTheme(val) {
  applyTheme(val);
  localStorage.setItem("git-sl-theme", val);
  saveSetting("theme", val);
}

function toggleTexture(checked) {
  var val = checked ? "on" : "off";
  localStorage.setItem("git-sl-texture", val);
  applyTexture(checked);
  saveSetting("paperTexture", val, true);
}

function applyTexture(on) {
  document.body.classList.toggle("paper-texture", on);
}

function applyTheme(theme) {
  // 移除所有主题类
  document.body.classList.remove("theme-dark", "theme-warm-paper", "theme-midnight", "theme-high-contrast", "theme-grass-aroma", "theme-contemplation", "theme-absolutely", "theme-delve", "theme-deep-think", "theme-new-warm-paper", "theme-midnight-contrast", "theme-coral");
  // 自动模式：读取Hana当前主题
  if (theme === "auto") {
    theme = getHanaTheme();
  }
  // 应用主题
  document.body.classList.add("theme-" + theme);
  // 设置颜色方案（深色主题用深色方案）
  var darkThemes = ["dark", "midnight", "midnight-contrast"];
  document.documentElement.style.colorScheme = darkThemes.indexOf(theme) >= 0 ? "dark" : "light";
  // 应用纸质纹理
  var textureEnabled = localStorage.getItem("git-sl-texture") === "on";
  applyTexture(textureEnabled);
}

// 获取Hana当前主题
function getHanaTheme() {
  // 优先：读取 body 上的 data-hana-theme（Hana 平台通过 URL 参数传递）
  var fromAttr = document.body.getAttribute("data-hana-theme");
  if (fromAttr && fromAttr !== "") {
    var themeMap = {
      "warm-paper": "warm-paper", "new-warm-paper": "new-warm-paper",
      "midnight": "midnight", "midnight-contrast": "midnight-contrast",
      "high-contrast": "high-contrast", "grass-aroma": "grass-aroma",
      "contemplation": "contemplation", "absolutely": "absolutely",
      "delve": "delve", "deep-think": "deep-think", "coral": "coral"
    };
    if (themeMap[fromAttr]) return themeMap[fromAttr];
  }

  // 备选：读 localStorage
  try {
    var stored = localStorage.getItem("hana-theme");
    if (stored && stored !== "auto" && stored !== "") {
      var themeMap2 = {
        "warm-paper": "warm-paper", "new-warm-paper": "new-warm-paper",
        "midnight": "midnight", "midnight-contrast": "midnight-contrast",
        "high-contrast": "high-contrast", "grass-aroma": "grass-aroma",
        "contemplation": "contemplation", "absolutely": "absolutely",
        "delve": "delve", "deep-think": "deep-think", "coral": "coral"
      };
      return themeMap2[stored] || "warm-paper";
    }
    if (stored === "auto") {
      var isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      return isDark ? "midnight" : "warm-paper";
    }
  } catch {}

  // 兜底：计算样式
  try {
    var bg = getComputedStyle(document.body).backgroundColor;
    var bgMap = {
      "248, 244, 237": "warm-paper", "245, 239, 228": "new-warm-paper",
      "59, 74, 84": "midnight", "38, 52, 61": "midnight-contrast",
      "250, 248, 247": "high-contrast", "245, 248, 243": "grass-aroma",
      "243, 245, 247": "contemplation", "244, 243, 238": "absolutely",
      "255, 255, 255": "delve", "252, 252, 253": "deep-think",
      "253, 246, 236": "coral", "1, 1, 2": "dark", "15, 16, 17": "dark"
    };
    return bgMap[bg] || "warm-paper";
  } catch {}
  return "warm-paper";
}

async function saveSetting(key, val, silent) {
  try {
    await pluginFetch("api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: val }),
    });
    if (!silent) toast("✅ 设置已保存", "success");
  } catch { if (!silent) toast("保存失败", "err"); }
}

// ======== 容器高度同步 ========
var _lastHostHeight = 0;
function requestHostResize() {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(function() {
    var doc = document.documentElement;
    var body = document.body;
    var contentHeight = Math.max(260, doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0);
    var height = contentHeight;
    var help = document.getElementById("ghHelpBubble");
    if (help && help.style.display !== "none") {
      var helpRect = help.getBoundingClientRect();
      height = Math.max(height, helpRect.bottom + 12);
    }
    height = Math.min(height, contentHeight + 320);
    if (Math.abs(height - _lastHostHeight) < 2) return;
    _lastHostHeight = height;
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "resize-request", payload: { height: height } }, "*");
      }
    } catch {}
  });
}
