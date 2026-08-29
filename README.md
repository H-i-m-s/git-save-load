<div align="center">

# Git Save/Load

**HanaAgent 侧栏里的 Git 存档、读档与远程仓库管理工具**

<p>
  <a href="https://github.com/liliMozi/openhanako"><img src="https://img.shields.io/badge/HanaAgent-Plugin-5e6ad2?style=flat-square" alt="HanaAgent Plugin"></a>
  <a href="https://github.com/H-i-m-s/git-save-load"><img src="https://img.shields.io/badge/version-1.9.0-27a644?style=flat-square" alt="Version 1.9.0"></a>
  <a href="https://git-scm.com/"><img src="https://img.shields.io/badge/Git-required-f05032?style=flat-square&logo=git&logoColor=white" alt="Git required"></a>
  <a href="https://cli.github.com/"><img src="https://img.shields.io/badge/GitHub%20CLI-optional-181717?style=flat-square&logo=github" alt="GitHub CLI optional"></a>
</p>

<p>
  <code>修改文件</code> → <code>存档</code> → <code>检查状态</code> → <code>推送</code>
</p>

</div>

---

## 它解决什么问题

Git Save/Load 是一个运行在 HanaAgent 侧栏中的 Widget，用图形界面把日常 Git 操作集中到一个面板里：

- 查看当前工作区到底改了什么
- 把修改保存成 Git 提交，并可附加版本号 Tag
- 浏览、对比、回滚和整理提交历史
- 管理分支、暂存区和冲突文件
- 将本地已提交历史同步到远程仓库
- 通过 GitHub CLI 创建、关联、克隆、搜索和管理 GitHub 仓库

它适合个人项目、课程作业、实验代码等需要频繁保存阶段性成果的仓库。

## 核心工作流

```text
1. 选择一个本地 Git 仓库
        ↓
2. 修改文件，查看「变更文件」
        ↓
3. 输入提交说明，点击「存档」
        ↓
4. 可选：输入版本号并创建 Git tag
        ↓
5. 确认工作区和提交历史后，点击「推送」同步到远程
```

> **重要：**「存档」和「推送」是两个独立动作。存档会创建本地提交；推送只会同步已经存在的提交，不会自动把尚未存档的工作区修改上传到 GitHub。

---

## 功能总览

| 模块 | 能做什么 |
| --- | --- |
| 仓库 | 选择、切换、记忆多个本地仓库路径，显示仓库名、远程地址和当前分支 |
| 初始化 | 将目录初始化为 Git 仓库，可选择 Node.js、Python、Java `.gitignore` 模板并编辑排除项 |
| 变更文件 | 显示修改、新增、删除、重命名、未跟踪和冲突状态，查看文件 Diff 与增删统计 |
| 存档 | `git add .` + `git commit`，可创建三段式版本号 Tag，并在缺少身份时配置当前仓库的 Git 姓名和邮箱 |
| 提交记录 | 查看日期、消息、增删统计、Hash 和 Tag；支持自动分页、回滚、对比、编辑和连续提交合并 |
| 暂存 | 使用 Git Stash 临时保存当前修改，支持恢复和删除 |
| 分支 | 创建、切换、删除分支，并通过可拖拽的分支画布进行整理 |
| 远程同步 | 检查本地与远程的 ahead/behind 状态，支持推送、拉取和安全覆盖 |
| 冲突解决 | 查看冲突文件和冲突块，逐块选择保留本地或远程内容，并执行 `git add` |
| GitHub | 创建、关联、克隆、列表、搜索、打开、复制、编辑和删除 GitHub 仓库 |
| 主题 | 自动、浅色、深色、暖纸、青夜、沉思等 14 种主题，以及可选纸质纹理 |
| Agent 工具 | 提供状态、存档、历史和回滚等可调用工具 |

---

## 详细功能

### 1. 仓库路径与初始化

顶部「仓库」卡片用于选择当前操作的本地仓库：

- 输入本地 Git 仓库完整路径
- 记录最近使用的仓库路径
- 自动读取仓库名、路径尾部、远程地址和默认分支
- 当前目录不是 Git 仓库时，显示「初始化仓库」卡片
- 初始化时可选择 `.gitignore` 模板，并手动添加、编辑或删除排除项

内置 `.gitignore` 模板：

- Node.js
- Python
- Java

插件会自动探测 Git 的常见安装位置。即使 Git 没有加入系统 PATH，也会尝试从常见目录寻找 Git 可执行文件。

### 2. 变更文件与 Diff

「变更文件」卡片展示当前工作区状态，包括：

- 🟠 已修改
- 🟢 新增
- 🔴 已删除
- 🔄 重命名
- ⚪ 未跟踪文件
- ⚠ 冲突

每个文件可以显示增删行数。点击文件名可以展开 Diff，并在「详细 / 精简」两种模式之间切换：

- **详细**：显示完整差异内容
- **精简**：只保留更紧凑的差异概览

遇到冲突文件时，行末会出现「解决」入口。

### 3. 存档与版本号

在「存档」卡片输入提交说明后，插件会执行：

```bash
git add .
git commit ...
```

如果输入了版本号，例如 `1.8.0`，提交成功后会在当前提交上创建：

```text
v1.8.0
```

版本号输入框会根据本地已有的最高版本 Tag 自动给出下一个补丁版本建议。例如已有 `v1.8.0` 时，默认建议 `1.8.1`。

提交前如果当前仓库没有配置 `user.name` 或 `user.email`，插件会弹出配置窗口。身份只写入当前仓库，不修改全局 Git 配置。

建议使用清晰的提交说明，例如：

```text
feat: 添加登录页面
fix: 修复分支切换后的刷新问题
chore: 更新配置文件
```

提交前缀只是约定，不会被插件强制识别或自动分类。

### 4. 推送与拉取

#### 推送

「推送」会同步当前分支的本地提交。实际远程由远程卡片中的“默认推送目标”决定：

```bash
git fetch --prune <默认获取远程>
git push <默认推送远程> 当前分支:当前分支
```

推送前插件会检查本地与远程的关系：

- 本地领先：正常推送
- 远程领先：展示远程新增提交和涉及文件，并要求确认
- 本地与远程分叉：展示双方状态，并要求确认是否覆盖远程
- 确认覆盖后：使用绑定确认时远程 Hash 的 `force-with-lease`
- 确认期间远程再次发生变化：停止覆盖并要求重新检查

推送模式可以设置为：

- `normal`：普通推送
- `force-with-lease`：带保护的强制推送
- `force`：强制推送

#### 拉取

主操作区的「拉取」默认从插件设置的默认获取远程的实际 tracking 或默认分支拉取到当前本地分支，支持：

- `merge`：合并远程变化
- `rebase`：将本地提交变基到远程最新提交
- `ff-only`：只允许快进，禁止自动合并

#### 多远程工作流与默认角色

关联页支持管理任意数量的本地远程。`origin` 和 `upstream` 只是 Git 社区常见的默认命名，不是固定要求：

```text
personal → 你的私有仓库，可设为默认推送目标
official → 原作者仓库，可设为默认获取来源
mirror   → 镜像或备份仓库
```

每个远程都可以在更多菜单中：

- 修改远程（可同时修改本地远程名称、获取地址和推送地址；地址支持从已有 GitHub 仓库列表选择或手动输入；获取/推送地址分别验证，失败时恢复原名称、地址和默认角色设置）
- 设为默认推送目标
- 设为默认获取来源
- 取消特殊角色

“修改远程”执行的是当前 clone 内的一次原子配置变更：名称变化会迁移远程跟踪分支和插件保存的默认远程设置；获取地址和推送地址可以分别修改，也可以清除独立推送地址使其跟随获取地址。新地址会分别验证可访问性，但验证通过不等于当前账号具备 push 权限。它不会修改 GitHub 仓库名称、服务端 URL 或提交历史。

关联页会显示每个远程的脱敏地址、实际远程分支、当前本地分支状态，并提供：

- 添加或更新远程关联
- 获取指定远程的最新提交
- 在存在多个远程分支时选择具体分支
- 将任意远程分支合并到当前本地分支
- 用当前本地已提交历史覆盖指定远程分支（使用 `force-with-lease`，覆盖前二次确认）
- 移除本地远程关联（不会删除 GitHub 上的仓库）

插件会优先使用当前分支已有的 tracking 远程分支；没有 tracking 配置时使用远程 HEAD、`main`、`master` 或远程列表中的第一个分支。

建议工作流（命令行示例）：

```bash
git fetch official
git merge official/main
git push personal main
```

插件会读取远程实际分支列表和远程 HEAD；如果本地分支是 `feature/login`，也可以选择 `official/main` 合并到当前的 `feature/login`。插件界面中「获取更新」只执行 fetch，不会修改当前文件；「合并到当前分支」才会改变本地分支；「覆盖远程」只推送当前本地分支已经提交的历史，不会上传未提交文件，但可能改写远程分支历史。覆盖前会检查本地分支和远程提交是否仍与确认时一致。仅承担「默认获取来源」角色、未承担「默认推送目标」角色的远程不会显示覆盖按钮，后端接口也会拒绝覆盖请求；如确实需要覆盖，必须先明确将它设置为推送目标。合并前要求工作区干净，产生冲突时使用现有的冲突解决面板处理。

如果仍使用传统命名，也可以直接使用：

```bash
git fetch upstream
git merge upstream/main
git push origin main
```

如果从原作者仓库克隆后，可以保留传统的 `origin` / `upstream` 命名，也可以在远程卡片中把它们重命名为 `personal` / `official` 等名称，再分别设置默认推送目标和默认获取来源。不要把原作者地址误设为默认推送目标后直接推送。

#### 推送边界

推送只同步 Git 已经提交的对象和当前分支引用：

```text
工作区未存档修改  ──不会直接推送──> GitHub
本地已提交历史    ──可以推送──> GitHub
```

当前推送按钮主要推送分支，不会替你执行 `git add` 或 `git commit`。版本号输入框中的下一个版本建议也不会因为点击推送而生效。

版本 Tag 是独立的 Git 引用。若需要明确同步 Tag，应在命令行单独执行，并将远程名称替换为“默认推送目标”：

```bash
git push <默认推送远程> v1.8.0
git push <默认推送远程> --tags
```

### 5. 提交记录

提交记录列表显示：

- 提交日期
- 提交说明
- 文件增删统计
- Hash
- 版本 Tag

支持的交互：

- 点击日期或 Hash：选择回滚
- 切换 `tag / hash` 显示
- 开启「对比」后选择两个提交进行 Diff 对比
- 悬停查看完整提交信息
- 按住 Shift 可锁定提示块并复制内容
- 右键或编辑入口：修改提交说明和版本号

提交记录采用滚动加载：

- 首屏加载最近 20 条
- 距离底部约 64px 时自动加载下一批
- 后续记录直接追加，不清空已加载内容
- 刷新、切换仓库或切换分支时重置分页

### 6. 回滚

支持三种 Git Reset 模式：

| 模式 | 行为 | 风险 |
| --- | --- | --- |
| `soft` | 移动 HEAD，保留工作区和暂存区 | 低 |
| `mixed` | 移动 HEAD，清空暂存区，保留工作区文件 | 中 |
| `hard` | 移动 HEAD，同时还原工作区和暂存区 | 高 |

`hard` 会丢弃目标提交之后的未提交修改。执行前请确认重要文件已经存档或暂存。

回滚后，插件会检查失效的版本 Tag，并清理已经不再位于当前 HEAD 历史中的 Tag。

### 7. 编辑提交说明、版本号与历史

点击提交记录中的编辑入口，可以：

- 修改最近一次提交说明
- 修改历史提交说明
- 新增、修改、删除 lightweight Git tag
- 将已经存在于旧历史的版本号移动到当前提交
- 选择多条连续提交并合并为一条提交
- 自动使用选中提交说明拼接合并后的说明，也可以手动修改

历史重写前会检查：

- 当前必须处于明确的本地分支，不能是 detached HEAD
- 工作区必须干净
- 不能有未完成的 rebase、merge、cherry-pick、revert 或 bisect
- 当前仓库必须配置 Git 身份
- 目标提交必须属于当前分支历史
- 合并提交暂不支持历史重写
- 合并的提交必须连续，不能跳过中间提交
- 版本号必须通过冲突检查

历史重写会：

- 使用仓库级并发锁，避免多个危险操作同时执行
- 创建备份引用
- 失败时尝试自动恢复
- 重新计算后续提交 Hash
- 对已推送到远程的历史给出 `force-with-lease` 提示

> 修改历史提交或合并提交不是普通的文本编辑，它会改变该提交及后续提交的 Hash。已经推送到远程的分支需要谨慎处理。

### 8. 暂存区 Stash

暂存卡片支持：

- 输入可选备注
- 暂存当前修改
- 恢复指定 Stash
- 删除指定 Stash

当前暂存操作使用：

```bash
git stash push -u
```

因此未跟踪文件也会被包含在暂存操作中。恢复暂存后，插件会重新读取工作区状态。

### 9. 分支管理与分支画布

分支功能支持：

- 查看本地分支及最近提交
- 创建普通分支
- 基于当前分支创建子分支
- 基于指定提交创建分支
- 切换分支
- 删除本地分支
- 查看当前分支和分支数量

分支画布支持：

- 拖拽分支方块
- 拖拽空白区域平移画布
- 自动绘制分支之间的连接线
- 右键创建、切换、删除分支
- 为分支设置颜色
- 为分支添加备注
- 编辑连接线标注
- 按仓库分别保存画布布局

画布中的父子关系主要根据分支命名约定推断，例如：

```text
main
├── feature/login
├── fix/header
└── release/1.9
```

它是一个辅助可视化视图，不替代 Git 本身的提交拓扑。

### 10. 冲突解决

当拉取或其他 Git 操作产生冲突时，插件可以：

1. 检测冲突文件
2. 读取冲突标记块
3. 展示当前分支内容和对方内容
4. 对每个冲突块选择保留本地或远程内容
5. 写回文件并执行 `git add`

冲突解决完成后，仍可能需要由用户继续完成提交或合并流程。

### 11. GitHub 仓库管理

GitHub 面板依赖本机安装并登录 GitHub CLI：

```bash
gh auth login
gh auth status
```

面板包含五个标签：

#### 创建

创建公开或私有 GitHub 仓库，可填写：

- 仓库名
- 描述
- 可见性
- MIT、Apache-2.0、GPL-3.0、BSD-3-Clause、LGPL-3.0、MPL-2.0、Unlicense 等许可证

如果当前本地仓库已经有提交，选择许可证时插件会先在本地生成 `LICENSE` 并提交，再创建远程仓库并关联，避免远程单独产生初始提交造成分叉。

#### 关联 / 远程

管理当前本地仓库的多个远程地址：

- 查看 `origin`、`upstream` 和其他远程
- 显示远程地址、角色和当前分支同步状态
- 输入远程 URL，指定远程名称后添加或更新
- 从自己的 GitHub 仓库列表中选择地址
- 如果远程名称已经存在，先显示旧地址并要求确认是否替换
- 修改已有远程时可分别编辑 fetch 地址和 push 地址，也可清除独立 push 地址
- 修改确认会绑定远程配置快照；确认期间远程发生变化时拒绝执行并要求重新确认
- fetch/push 地址分别验证可访问性；验证通过不代表当前账号具备 push 权限
- 添加或更新后执行 fetch，检查远程是否可访问
- 对指定远程执行获取更新
- 对任意远程的指定分支执行合并到当前分支
- 移除本地远程关联；不会删除远程平台上的仓库

#### 克隆

从 GitHub URL 克隆仓库。目标目录可以手动填写；留空时会根据当前仓库路径所在目录和远程仓库名推断。

#### 列表

查看自己的 GitHub 仓库，并支持：

- 打开仓库
- 复制仓库地址
- 查看描述、可见性、更新时间和许可证
- 右键编辑仓库
- 右键删除仓库

删除远程仓库需要二次确认，删除后无法通过此操作恢复。

#### 搜索

搜索公开 GitHub 仓库，并支持：

- 查看搜索结果
- 打开仓库
- 将结果 URL 带入「关联」表单

#### 编辑仓库

支持编辑：

- 仓库名
- 描述
- 公开 / 私有状态
- 许可证

仓库改名后，如果插件检测到本地远程地址仍指向旧地址，会询问是否同步更新本地 remote URL。

### 12. 主题、布局与交互

插件采用卡片式侧栏布局，支持：

- 卡片拖拽排序，顺序持久化保存
- 自动跟随 HanaAgent 主题
- 浅色、深色、暖纸、青夜、沉思、珊瑚等 14 种主题
- 可选纸质纹理
- 提交记录和操作按钮的响应式布局
- 推送、拉取按钮按最长状态预留换行空间，状态文案变化时避免布局跳动
- GitHub 面板动态展开和高度同步
- 首次使用引导与三步保存流程提示

---

## 安装

### 前置条件

- HanaAgent `0.82.0` 或更高版本
- Git
- GitHub CLI `gh`：仅 GitHub 面板需要
- 如果要执行提交，需要为当前仓库配置 Git 姓名和邮箱

Git 身份可以在插件第一次提交时配置，也可以手动执行：

```bash
git config user.name "Your Name"
git config user.email "you@example.com"
```

### 通过 HanaAgent 安装

在 HanaAgent 中打开：

```text
设置 → 插件 → 搜索 git-save-load → 安装并启用
```

### 手动安装

```bash
git clone https://github.com/H-i-m-s/git-save-load.git "$env:USERPROFILE\.hanako\plugins\git-save-load"
```

安装后重启 HanaAgent，或通过插件管理界面重新加载插件。

---

## Agent 可调用工具

插件同时提供基础 Git 工具：

| 工具 | 作用 |
| --- | --- |
| `git_status` | 查看仓库路径、当前分支、已修改文件和未跟踪文件 |
| `git_commit` | 暂存所有变更并创建提交 |
| `git_log` | 查看最近提交的 Hash、消息、作者和日期 |
| `git_reset` | 以 soft、mixed 或 hard 模式回滚到指定提交 |

工具默认使用输入中的 `path`；未传路径时使用当前工作目录。历史查询默认返回 20 条，最多 100 条。

---

## 配置项

| 配置项 | 可选值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `repoPath` | 本地路径 | 空 | 当前管理的 Git 仓库 |
| `stashMode` | `normal` / `untracked` / `all` | `untracked` | 暂存模式选项；当前暂存动作固定包含未跟踪文件 |
| `pushMode` | `normal` / `force-with-lease` / `force` | `normal` | 推送模式 |
| `pullMode` | `merge` / `rebase` / `ff-only` | `merge` | 拉取模式 |
| `defaultDiffMode` | `detail` / `simple` | `detail` | 默认 Diff 展示方式 |
| `theme` | 14 种主题 | `auto` | 主题选择 |
| `paperTexture` | `on` / `off` | `off` | 纸质纹理 |
| `ghOpenMode` | `internal` / `external` | `internal` | GitHub 链接打开方式 |

---

## 安全边界与注意事项

### 工作区与远程仓库是两套状态

Git Save/Load 不会把本地工作区当作远程文件直接上传。推荐始终按下面的顺序操作：

```text
查看变更 → 存档 → 检查提交 → 推送
```

点击「推送」前，如果工作区还有未存档修改，GitHub 仍然只会看到最近一次已提交的内容。

### 危险操作会要求确认

以下操作会改变或删除已有状态：

- `hard` 回滚
- 覆盖远程分支
- 修改历史提交说明
- 合并连续提交
- 移动版本 Tag
- 删除 GitHub 仓库
- 替换已有远程地址
- 删除本地分支

### 历史重写限制

当前历史编辑和连续提交合并主要针对干净的线性历史：

- 不支持 detached HEAD
- 不支持包含 merge commit 的历史重写
- 不支持跳过中间提交的非连续合并
- 工作区必须干净
- 已推送历史重写后通常需要 `git push --force-with-lease`

### 版本号是 Git Tag

版本号不是 GitHub Release，也不会自动生成 GitHub Release 页面。插件创建的是本地 lightweight tag，例如：

```text
v1.8.0 → 指向某一个具体提交
```

如需在远程保留这个 Tag，请明确推送 Tag：

```bash
git push origin v1.8.0
# 或
git push origin --tags
```

---

## 项目结构

```text
git-save-load/
├── manifest.json          # HanaAgent 插件清单与配置项
├── routes/
│   ├── git.js             # Card 页面入口、公共辅助和路由装配
│   ├── local-git.js       # 状态、提交、身份和回滚
│   ├── history.js         # 提交历史查询
│   ├── history-edit.js    # amend、tag、squash、reword
│   ├── diff-conflicts.js  # diff、版本对比和冲突处理
│   ├── repository.js      # 仓库路径、信息、初始化和版本
│   ├── github.js          # GitHub CLI 管理
│   ├── remote-query.js    # 远程列表和角色
│   ├── remote-sync.js     # 远程状态、fetch、merge、remove
│   ├── remote-edit.js     # 远程名称和地址编辑
│   ├── remote-push.js     # pull、push 和远程覆盖
│   ├── branch.js          # 分支管理
│   ├── stash.js           # Stash 管理
│   ├── config.js          # 配置读写
│   └── misc.js            # 兼容接口
├── assets/
│   ├── git.html            # Card 入口（DOM 结构 + 模块加载顺序）
│   ├── git.css             # 全部样式
│   └── git/                # 前端 JS 模块（26 个）
├── views/
│   └── git.html           # 历史遗留视图，当前入口不使用
├── tools/
│   ├── _helpers.js        # Git 路径探测与命令辅助
│   ├── git_status.js      # Agent：查看状态
│   ├── git_commit.js      # Agent：创建提交
│   ├── git_log.js         # Agent：查看历史
│   └── git_reset.js       # Agent：回滚提交
├── docs/
│   ├── 简易使用文档.md
│   ├── 架构文档.md
│   └── 踩坑记录.md
├── DESIGN.md              # 设计规范
└── README.md
```

插件采用前端单页面 Card + Node.js 路由的结构。当前页面入口为 `assets/git.html`（DOM 结构与模块加载顺序），样式拆分在 `assets/git.css`，前端逻辑拆分在 `assets/git/*.js`（26 个模块，按拆分前的顶层执行顺序加载）；后端路由按职责拆分到多个 `routes/*.js` 模块；界面内部通过事件总线刷新文件状态、提交记录和 Stash 卡片。Git 命令使用参数数组执行，尽量避免 shell 字符串拼接带来的注入和转义问题。

> 桌面本地模式下卡片 iframe 仅携带 surface session 凭证，无法加载宿主静态资产（`/assets/*` 要求 chat scope）。后端返回页面前会把 `assets/...` 引用重写为插件路由 `git-asset/...`，并追加两个查询参数：基于文件 mtime+size 的 `?v=`（文件一变 URL 就变，缓存立即失效）和文档 URL 自带的 `token=`（回传后子资源经主鉴权 queryToken 通道放行，与宿主给 theme.css 的处理一致）。文件更新后 WebView 立即拿到新内容。

---

## 开发

```bash
git clone https://github.com/H-i-m-s/git-save-load.git
cd git-save-load
```

插件主体没有独立的前端构建步骤，主要修改文件为：

- `assets/git.html`：Card 入口（DOM 结构与模块加载顺序）
- `assets/git.css`：全部样式
- `assets/git/*.js`：前端功能模块，加载顺序即拆分前顶层执行顺序，勿随意调整
- `routes/*.js`：按职责拆分的 Git、GitHub CLI 和配置后端路由
- `routes/git.js`：页面入口、前端资源服务路由（git-asset）、公共辅助函数和模块装配
- `views/git.html`：历史遗留文件，当前运行入口不使用
- `assets/git-api.js`：历史遗留请求封装，当前页面未引用
- `tools/*.js`：Agent 可调用工具
- `manifest.json`：插件元数据与配置

在 HanaAgent 中使用插件开发工具加载本地插件后，修改页面或路由并重新加载插件即可验证。

---

## 当前版本

```text
v2.2.0
```

1.9.0 重点更新：

- 提交记录首屏加载 20 条，接近底部自动加载更早记录
- 提交记录分页接口增加 `skip` 与 `hasMore`
- 改善已有记录追加时的滚动体验
- 完善推送、拉取按钮在不同状态文案下的换行布局
- 延续提交历史编辑、版本号管理和连续提交合并能力

---

## 相关项目

- [HanaAgent](https://github.com/liliMozi/openhanako) — HanaAgent 平台
- [Git](https://git-scm.com/) — 分布式版本控制系统
- [GitHub CLI](https://cli.github.com/) — GitHub 官方命令行工具

## 许可证

当前仓库目录中未发现 `LICENSE` 文件。发布前请补充明确的许可证文件，并将此处说明与实际许可证保持一致。
