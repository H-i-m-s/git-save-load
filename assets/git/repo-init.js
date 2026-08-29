// Git Save/Load Card 前端模块 23/26：repo-init.js — 初始化仓库、.gitignore 模板与排除项（IGNORE_TEMPLATES 自原 diff 区块移入，仅运行时引用）
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// escapeHtml 已上移至 env.js。
const IGNORE_TEMPLATES = {
  node: ["node_modules/", "npm-debug.log*", "yarn-debug.log*", "yarn-error.log*", ".vite/", "dist/", ".env*"],
  python: ["__pycache__/", "*.py[cod]", "*.so", "venv/", ".venv/", "*.egg-info/", "dist/", "build/"],
  java: ["target/", "*.class", "*.jar", "*.war", "*.log", ".settings/", ".project", ".classpath", ".idea/", "*.iml"],
};

let currentIgnores = [];

// 渲染排除项表格
function renderIgnoreTable() {
  const el = document.getElementById("ignoreList");
  if (currentIgnores.length === 0) {
    el.innerHTML = '<div style="padding:12px;text-align:center;font-size:12px;color:var(--hana-fg-muted,#6b7280)">暂无排除项</div>';
    return;
  }
  el.innerHTML = currentIgnores.map((item, i) =>
    `<div style="display:flex;align-items:center;padding:4px 8px;border-bottom:1px solid var(--hana-border,#e2e5ea);font-size:12px;font-family:monospace">
      <input value="${escapeHtml(item)}" onchange="editIgnoreItem(${i}, this.value)" style="flex:1;border:0;background:transparent;color:var(--hana-fg,#1a1d24);outline:none;font-family:monospace;font-size:12px">
      <button onclick="removeIgnoreItem(${i})" style="padding:2px 6px;border:0;background:transparent;color:#e74c3c;cursor:pointer;font-size:14px">×</button>
    </div>`
  ).join("");
}

// 选择模板时填充表格
function applyTemplate() {
  const key = document.getElementById("gitignoreSelect").value;
  if (key && IGNORE_TEMPLATES[key]) {
    currentIgnores = [...IGNORE_TEMPLATES[key]];
  } else {
    currentIgnores = [];
  }
  renderIgnoreTable();
}

// 编辑排除项
function editIgnoreItem(index, value) {
  currentIgnores[index] = value.trim();
}

// 删除排除项
function removeIgnoreItem(index) {
  currentIgnores.splice(index, 1);
  renderIgnoreTable();
}

// 添加排除项
function addIgnoreItem() {
  const input = document.getElementById("newIgnoreInput");
  const val = input.value.trim();
  if (!val) return;
  currentIgnores.push(val);
  input.value = "";
  renderIgnoreTable();
  // 滚动到底部
  const list = document.getElementById("ignoreList");
  list.scrollTop = list.scrollHeight;
}

// 初始化仓库
async function doInit() {
  const btn = document.querySelector("#initArea button:last-of-type");
  btn.disabled = true;
  btn.textContent = "初始化中...";
  document.getElementById("initResult").textContent = "";

  // 从表格收集排除项
  const gitignore = currentIgnores.filter(Boolean).join("\n");
  const p = currentPath || getSavedPath();

  if (!p) { toast("请先设置仓库路径", "err"); btn.disabled = false; btn.textContent = "初始化仓库"; return; }

  try {
    const res = await pluginFetch("api/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, gitignore }),
    });
    const data = await res.json();

    if (data.ok) {
      document.getElementById("initResult").innerHTML = `✅ 已初始化，分支：${escapeHtml(data.branch)}<br><span style="font-size:11px;color:var(--hana-fg-muted,#9ca3af)">💡 现在可以改文件后在「存档」卡片提交了</span>`;
      document.getElementById("initResult").style.color = "var(--hana-accent,#4a8cff)";
      // 保存路径
      savePathToStorage(data.path);
      addRepoHistory(data.path);
      saveConfigPath(data.path);
      currentPath = data.path;
      onCurrentRepoChanged(data.path);
      // 手动切换 UI
      document.getElementById("initArea").style.display = "none";
      document.getElementById("fileCard").style.display = "";
      document.getElementById("commitCard").style.display = "";
      document.getElementById("logCard").style.display = "";
      toast("仓库初始化成功！", "success");
      // 带路径刷新
      setTimeout(() => refreshWithPath(data.path), 600);
    } else {
      document.getElementById("initResult").textContent = "❌ " + data.message;
      document.getElementById("initResult").style.color = "#e74c3c";
    }
  } catch (e) {
    document.getElementById("initResult").textContent = "❌ " + e.message;
    document.getElementById("initResult").style.color = "#e74c3c";
  } finally {
    btn.disabled = false;
    btn.textContent = "初始化仓库";
  }
}

// 加载下一个版本号
async function loadNextVersion() {
  const p = currentPath || getSavedPath();
  if (!p) return;
  try {
    const res = await pluginFetch("api/version?path=" + encodeURIComponent(p));
    const data = await res.json();
    if (data.ok) document.getElementById("versionInput").value = data.next;
  } catch {}
}
