<div align="center">

<!-- Hero Banner -->
<svg width="800" height="280" viewBox="0 0 800 280" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="800" y2="280" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0f1011"/>
      <stop offset="50%" stop-color="#141516"/>
      <stop offset="100%" stop-color="#0f1011"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="200" y2="0" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#5e6ad2"/>
      <stop offset="100%" stop-color="#8b5cf6"/>
    </linearGradient>
    <linearGradient id="glow" x1="400" y1="100" x2="400" y2="280" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#5e6ad2" stop-opacity="0.15"/>
      <stop offset="100%" stop-color="#5e6ad2" stop-opacity="0"/>
    </linearGradient>
    <filter id="blur">
      <feGaussianBlur stdDeviation="40"/>
    </filter>
  </defs>
  <!-- Background -->
  <rect width="800" height="280" rx="16" fill="url(#bg)"/>
  <!-- Grid dots -->
  <pattern id="dots" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
    <circle cx="12" cy="12" r="0.8" fill="#5e6ad2" opacity="0.15"/>
  </pattern>
  <rect width="800" height="280" rx="16" fill="url(#dots)"/>
  <!-- Glow -->
  <ellipse cx="400" cy="180" rx="200" ry="100" fill="#5e6ad2" opacity="0.08" filter="url(#blur)"/>
  <!-- Git branch tree decoration -->
  <g opacity="0.2" stroke="#5e6ad2" stroke-width="1.5" fill="none">
    <!-- Main line -->
    <path d="M 100 80 L 100 200 L 700 200"/>
    <!-- Branches -->
    <circle cx="100" cy="80" r="4" fill="#5e6ad2"/>
    <path d="M 100 120 C 100 120, 180 120, 220 100"/>
    <circle cx="220" cy="100" r="3" fill="#8b5cf6"/>
    <path d="M 100 140 C 100 140, 160 160, 200 160"/>
    <circle cx="200" cy="160" r="3" fill="#e67e22"/>
    <path d="M 300 200 C 300 200, 350 180, 400 180"/>
    <circle cx="400" cy="180" r="3" fill="#27a644"/>
    <path d="M 500 200 C 500 200, 520 160, 560 160"/>
    <circle cx="560" cy="160" r="3" fill="#e74c3c"/>
    <path d="M 600 200 C 600 200, 620 140, 660 140"/>
    <circle cx="660" cy="140" r="3" fill="#06b6d4"/>
    <!-- Nodes on main line -->
    <circle cx="300" cy="200" r="4" fill="#27a644"/>
    <circle cx="500" cy="200" r="4" fill="#27a644"/>
    <circle cx="600" cy="200" r="4" fill="#27a644"/>
    <circle cx="700" cy="200" r="4" fill="#27a644"/>
  </g>
  <!-- Title -->
  <text x="400" y="52" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="32" font-weight="700" fill="#f7f8f8">
    Git Save/Load
  </text>
  <text x="400" y="76" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="14" fill="#8a8f98">
    HanaAgent 侧栏 Widget · 存档与读档 · 分支管理 · GitHub 集成
  </text>
</svg>

<br/>

[![HanaAgent](https://img.shields.io/badge/HanaAgent-Plugin-5e6ad2?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0id2hpdGUiPjxwYXRoIGQ9Ik0xMiAyQzYuNDggMiAyIDYuNDggMiAxMnM0LjQ4IDEwIDEwIDEwIDEwLTQuNDggMTAtMTBTMTcuNTIgMiAxMiAyem0tMiAxNS01LTUtMS40MSAxLjQxTDEwIDE5bDMtMyAxLjQxIDEuNDEtNC00em00LTgtMyAzLTEuNDEtMS40MUwxMiA2bC0zIDMgMS40MSAxLjQxTDEzIDlsMy0zIDEuNDEgMS40MUwxMyA5bDMtMyAxLjQxIDEuNDEtNC00eiIvPjwvc3ZnPg==)](https://github.com/liliMozi/openhanako)
[![Version](https://img.shields.io/badge/version-1.0.0-27a644?style=flat-square)](https://github.com/H-i-m-s/doc-intake)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

</div>

---

## ✨ 特性

<table>
<tr>
<td width="50%">

### 🎯 核心功能
- **一键存档** — 提交消息 + 可选版本号 Tag
- **提交历史** — 时间线浏览，点击回滚（soft / mixed / hard）
- **分支管理** — 创建、切换、删除、可视化画布
- **暂存管理** — 临时存放修改，随时恢复

</td>
<td width="50%">

### 🚀 GitHub 集成
- **创建仓库** — 一键在 GitHub 建仓并关联本地
- **克隆仓库** — 从 URL 克隆到本地
- **仓库列表** — 查看你的 GitHub 仓库
- **搜索仓库** — 搜索 GitHub 公开项目

</td>
</tr>
<tr>
<td>

### 🎨 主题系统
- 自动跟随 HanaAgent 主题
- 14 种内置主题（浅色 / 深色 / 暖纸 / 青夜 等）
- 纸质纹理效果（SVG 噪声叠加）

</td>
<td>

### 🧩 灵活配置
- 多种推送模式（普通 / 安全强制 / 强制）
- 多种拉取模式（合并 / 变基 / 仅快进）
- 暂存模式（仅跟踪 / 包含未跟踪 / 全部）
- 卡片顺序自由拖拽排列

</td>
</tr>
</table>

---

## 📦 安装

### 前置条件

- [HanaAgent](https://github.com/liliMozi/openhanako) ≥ 0.3.0
- [Git](https://git-scm.com/) 已安装并在 PATH 中
- [GitHub CLI](https://cli.github.com/)（可选，仅 GitHub 功能需要）

### 方式一：通过 HanaAgent 安装

```
在 HanaAgent 设置 → 插件 → 搜索 "git-save-load" → 安装
```

### 方式二：手动安装

```bash
cd ~/.hanako/plugins
git clone https://github.com/H-i-m-s/doc-intake.git git-save-load
```

重启 HanaAgent 后在侧栏即可看到。

---

## 🚀 快速开始

```
1. 打开侧栏 → Git Save/Load
2. 输入你的 Git 仓库路径 → 回车
3. 修改文件 → 写提交消息 → 点「存档」
4. 需要远程备份 → 点「推送」
5. 需要回退 → 点提交记录中的 hash → 选回滚模式
```

---

## 🖼 界面预览

<div align="center">

```
┌─────────────────────────────────────────┐
│  📁 D:/Projects/my-app                  │
│  分支: main                              │
│                                         │
│  💾 存档                                 │
│  ┌─────────────────────────────┐        │
│  │ 例：feat: 添加了登录页      │        │
│  └─────────────────────────────┘        │
│  [0.0.1] [存档] [📤 推送] [📥 拉取]     │
│                                         │
│  📦 暂存                                │
│  [暂存当前修改]                          │
│                                         │
│  📜 提交记录                    [tag][对比]│
│  ┌─ a1b2c3d  07-18 23:08  feat: xxx    │
│  ├─ e4f5g6h  07-18 22:15  fix: yyy     │
│  └─ i7j8k9l  07-18 21:30  chore: init  │
│                                         │
│  ⚙ 设置                                 │
│  ─────────────────────────────          │
│  主题 [自动 ▾]  纸质纹理 [OFF]           │
│  暂存模式 [包含未跟踪 ▾]                 │
│  推送模式 [普通推送 ▾]                   │
└─────────────────────────────────────────┘
```

</div>

---

## 🎨 分支画布

点击顶部 `🌳` 按钮进入可视化分支视图：

- **方块** = 每个分支
- **颜色** = 按分支类型自动着色
  - 🟢 `master / main` — 稳定主分支
  - 🟣 `feature/*` — 新功能开发
  - 🟠 `fix/* / bugfix/*` — Bug 修复
  - 🔴 `hotfix/*` — 紧急修复
  - 🔵 `develop` — 日常开发
- **连线** = 分支继承关系
- **拖拽** = 自由排列，布局自动保存
- **右键** = 创建子分支、切换、删除、改颜色

---

## ⚙ 配置项

| 配置 | 选项 | 默认值 |
|------|------|--------|
| 暂存模式 | 仅跟踪 / 包含未跟踪 / 全部 | 包含未跟踪 |
| 推送模式 | 普通 / 安全强制 / 强制覆盖 | 普通 |
| 拉取模式 | 合并 / 变基 / 仅快进 | 合并 |
| Diff 模式 | 详细 / 精简 | 详细 |
| 主题 | 自动 / 浅色 / 深色 / 14种主题 | 自动 |
| 纸质纹理 | 开 / 关 | 关 |
| GitHub 打开方式 | 内部窗口 / 外部浏览器 | 内部窗口 |

---

## 📁 项目结构

```
git-save-load/
├── manifest.json          # 插件清单
├── routes/
│   └── git.js             # 后端路由（Git / GitHub CLI 封装）
├── tools/                 # Agent 工具定义
│   ├── git_commit.js
│   ├── git_log.js
│   ├── git_reset.js
│   └── git_status.js
├── views/
│   └── git.html           # 前端界面（单文件，内联 CSS+JS）
└── docs/
    ├── 简易使用文档.md
    ├── 架构文档.md
    └── 踩坑记录.md
```

---

## 🔧 开发

```bash
# 克隆仓库
git clone https://github.com/H-i-m-s/doc-intake.git
cd doc-intake

# 本地开发：将插件目录软链到 HanaAgent 插件目录
# Windows
mklink /D "%USERPROFILE%\.hanako\plugins\git-save-load" "本仓库路径"

# 重启 HanaAgent 后即可看到插件
# 修改 views/git.html 或 routes/git.js 后刷新侧栏即可热更新
```

---

## 📝 提交规范

插件支持以下提交前缀（存档时自动识别）：

| 前缀 | 用途 |
|------|------|
| `feat:` | 新功能 |
| `fix:` | Bug 修复 |
| `chore:` | 杂务（构建、工具等） |
| `docs:` | 文档 |
| `style:` | 代码格式 |
| `refactor:` | 重构 |
| `test:` | 测试 |

---

## 🤝 相关项目

- [HanaAgent](https://github.com/liliMozi/openhanako) — 开源 AI Agent 平台
- [GitHub CLI](https://cli.github.com/) — GitHub 官方命令行工具
- [Git](https://git-scm.com/) — 分布式版本控制系统

---

## 📄 License

[MIT](LICENSE)
