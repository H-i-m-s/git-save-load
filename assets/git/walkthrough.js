// Git Save/Load Card 前端模块 24/26：walkthrough.js — 新手引导与工作流程提示
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// ======== 新手引导弹窗 ========
const WT_STEPS = [
  {
    icon: "👋",
    title: "欢迎使用 Git Save/Load",
    desc: "这是一个帮你管理 Git 仓库的小工具。Git 可以把代码的每一次修改都存档,随时可以回退到之前。下面用 6 步带你走完核心功能。",
    box: "⏱ 约 2 分钟可看完 · 随时可点跳过引导",
    target: null,
  },
  {
    icon: "📁",
    title: "第一步:告诉插件你的项目在哪",
    desc: "点击「📁仓库」卡片里的「切换」按钮,选你电脑上的项目文件夹。之后插件会一直盯这个文件夹里的文件变化。",
    box: "💡 如果项目还没被 Git 管理过,下面会冒出「初始化仓库」按钮帮你一键启动。",
    target: "#repoPathDisplay",
  },
  {
    icon: "📄",
    title: "第二步:看清你改了哪些文件",
    desc: "「变更文件」区域会列出你所有改动。带颜色的标签代表不同含义。",
    box: "🟠 已修改 · 🟢 新增 · 🔴 删除 · ⚪ 未跟踪的新文件",
    target: "#fileCard",
  },
  {
    icon: "💾",
    title: "第三步:点击「存档」保存进度",
    desc: "在「存档」卡片的输入框里写一句说明(例:feat: 添加了登录页),然后点「存档」按钮。这一步是把修改保存到本地 Git。",
    box: "🎮 类比:这就像在游戏里存了一个档,以后随时可以读回来。",
    target: "#btnCommit",
  },
  {
    icon: "📤",
    title: "第四步(可选):推送到云端",
    desc: "「推送」按钮会把你的存档发送到 GitHub(云端服务器)。如果你只是本地玩,不点这个也可以。",
    box: "📌 「拉取」是从 GitHub 拉取别人发的新存档回来。推送/拉取都是多人协作时使用。",
    target: "button[onclick*='doPush']",
  },
  {
    icon: "📜",
    title: "第五步:查看历史 / 随时回退",
    desc: "「提交记录」区域列出所有存档。点「回滚」按钮可以退回到以前的某个版本。",
    box: "🛟 回滚默认不会丢未保存的修改;只有「硬重置」才丢,请谨慎。",
    target: "#logCard",
  },
];

let wtCurrentStep = 0;
const WT_DONE_KEY = "git-sl-walkthrough-done";
const WT_GUIDE_KEY = "git-sl-workflow-guide-dismissed";

function renderWalkthrough() {
  const step = WT_STEPS[wtCurrentStep];
  document.getElementById("wtIcon").textContent = step.icon;
  document.getElementById("wtTitle").textContent = step.title;
  document.getElementById("wtDesc").textContent = step.desc;
  document.getElementById("wtBox").textContent = step.box;
  document.getElementById("wtStepLabel").textContent = (wtCurrentStep + 1) + " / " + WT_STEPS.length;
  document.querySelectorAll(".wt-dot").forEach(function(d, i) {
    d.style.background = i <= wtCurrentStep ? "var(--hana-accent,#5e6ad2)" : "var(--hana-border,#e2e5ea)";
  });
  document.getElementById("wtPrevBtn").style.display = wtCurrentStep === 0 ? "none" : "";
  document.getElementById("wtNextBtn").textContent = wtCurrentStep === WT_STEPS.length - 1 ? "🎉 开始使用" : "下一步 →";

  // 清除旧高亮
  document.querySelectorAll(".wt-highlight-target").forEach(function(el) { el.classList.remove("wt-highlight-target"); });
  const spot = document.getElementById("walkthroughSpotlight");
  const spotEl = document.getElementById("walkthroughSpot");
  if (step.target) {
    const target = document.querySelector(step.target);
    if (target) {
      target.classList.add("wt-highlight-target");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(function() {
        const r = target.getBoundingClientRect();
        spot.style.display = "block";
        spotEl.style.left = (r.left - 4) + "px";
        spotEl.style.top = (r.top - 4) + "px";
        spotEl.style.width = (r.width + 8) + "px";
        spotEl.style.height = (r.height + 8) + "px";
      }, 250);
    } else {
      spot.style.display = "none";
    }
  } else {
    spot.style.display = "none";
  }
}

function showWalkthrough() {
  wtCurrentStep = 0;
  renderWalkthrough();
  document.getElementById("walkthroughModal").style.display = "flex";
}

function hideWalkthrough() {
  document.getElementById("walkthroughModal").style.display = "none";
  document.getElementById("walkthroughSpotlight").style.display = "none";
  document.querySelectorAll(".wt-highlight-target").forEach(function(el) { el.classList.remove("wt-highlight-target"); });
}

function nextWalkthroughStep() {
  if (wtCurrentStep < WT_STEPS.length - 1) {
    wtCurrentStep++;
    renderWalkthrough();
  } else {
    completeWalkthrough();
  }
}

function prevWalkthroughStep() {
  if (wtCurrentStep > 0) {
    wtCurrentStep--;
    renderWalkthrough();
  }
}

function dismissWalkthrough() {
  hideWalkthrough();
  try { localStorage.setItem(WT_DONE_KEY, "1"); } catch {}
}

function completeWalkthrough() {
  hideWalkthrough();
  try { localStorage.setItem(WT_DONE_KEY, "1"); } catch {}
  toast("🎉 引导完成！可以开始使用了", "success");
}

function showWorkflowGuide() {
  const el = document.getElementById("workflowGuide");
  if (el) el.style.display = "block";
}

function dismissWorkflowGuide() {
  const el = document.getElementById("workflowGuide");
  if (el) el.style.display = "none";
  try { localStorage.setItem(WT_GUIDE_KEY, "1"); } catch {}
}

function maybeShowWorkflowGuide() {
  try {
    if (localStorage.getItem(WT_GUIDE_KEY) === "1") return;
  } catch {}
  showWorkflowGuide();
}

function maybeShowWalkthrough() {
  try {
    if (localStorage.getItem(WT_DONE_KEY) === "1") return;
  } catch {}
  setTimeout(function() { showWalkthrough(); }, 600);
}
