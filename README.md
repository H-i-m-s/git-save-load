<div align="center">

# Git Save/Load

**HanaAgent 侧栏里的 Git 存档、读档与远程仓库管理工具**

<p>
  <a href="https://github.com/liliMozi/openhanako"><img src="https://img.shields.io/badge/HanaAgent-Plugin-5e6ad2?style=flat-square" alt="HanaAgent Plugin"></a>
  <a href="https://github.com/H-i-m-s/git-save-load"><img src="https://img.shields.io/badge/version-3.0.0-27a644?style=flat-square" alt="Version 3.0.0"></a>
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
| PR | 查看、创建、合并 Pull Request，按状态筛选，合并前二次确认 |
| 提交签名 | 隔离 GPG 密钥环与签名提交，支持查看 / 复制公钥；GitHub 令牌可选加密存放（DPAPI） |
| 主题 | 自动、浅色、深色、暖纸、青夜、沉思等 14 种主题，以及可选纸质纹理 |
| Agent 工具 | 8 个可调用工具：状态、存档、历史、回滚，以及 git / gh 子命令透传、语义化推送与 PR 生命周期 |

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

面板包含六个标签：

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

#### PR

查看、创建和合并当前仓库的 Pull Request：

- 按状态筛选（未合并 / 已关闭 / 全部）并刷新列表
- 展开单个 PR 查看详情：标题、状态、源分支与目标分支、审查与合并状态、正文
- 新建 PR：可选目标分支、标题（留空取当前分支 HEAD 提交首行）、正文，以及是否创建为草稿
- 合并 PR：可选合并方式（merge / squash / rebase）与是否删除源分支；合并不可撤销，先弹页内二次确认

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

- HanaAgent `0.978.0` 或更高版本（v2 App）
- Git
- GitHub CLI `gh`：仅 GitHub 面板需要
- 如果要执行提交，需要为当前仓库配置 Git 姓名和邮箱

Git 身份可以在插件第一次提交时配置，也可以手动执行：

```bash
git config user.name "Your Name"
git config user.email "you@example.com"
```

### 通过 HanaAgent 安装

本目录是 manifestVersion 2 的 Hana App，位于 `<HANA_HOME>/apps/git-save-load`。重启 HanaAgent 后，到市场「已安装」页 App 类目的「待批准」区块批准它。首次批准时会对以下能力一次性确认：

| 能力 | 用途 |
| --- | --- |
| `app/process.spawn` | 运行 git / gh 子进程 |
| `app/tools.expose-to-model` | 四个 Agent 工具进入模型工具循环 |
| `app/ui.open-external` | 在系统浏览器打开 GitHub 链接 |
| `app/ui.clipboard-write` | 复制仓库地址 |
| `app/resources.read` / `app/resources.write` | 冲突解决、.gitignore、LICENSE 等仓库文件读写（经宿主 ResourceIO 门） |

之后可在设置窗「安全」页的「应用能力」面板单独开关。

### 从 v1 插件迁移

v1 插件（`plugins/git-save-load`）可继续运行；v2 App 与它互不影响。仓库路径、主题、远程角色等配置已从 v1 的 `plugin-data/git-save-load/config.json` 迁到本 App 的 `app-data/git-save-load/config.json`，首次读取时生效，之后以 v2 配置存储为准。确认 v2 版本工作正常后，可在插件管理里停用 v1 插件。

---

## Agent 可调用工具

模型可调用的工具共 8 个，分两类。语义化动作：

| 工具 | 作用 | 权限档 |
| --- | --- | --- |
| `git_status` | 查看仓库路径、当前分支、已修改文件和未跟踪文件 | 只读 |
| `git_commit` | 暂存所有变更并创建提交；隔离签名开启时签名提交，可追加 Co-authored-by 尾注 | 送审 |
| `git_log` | 查看最近提交的 Hash、消息、作者和日期 | 只读 |
| `git_reset` | 以 soft、mixed 或 hard 模式回滚到指定提交 | 送审 |
| `git_push` | 语义化推送；`force` 只接受 `with-lease`（映射 `--force-with-lease`），任何输入都不会产生裸 `--force` | 送审 |
| `gh_pr` | PR 生命周期：`create` / `list` / `view` / `merge`（merge 不可撤销） | 送审 |

透传类：

| 工具 | 作用 | 权限档 |
| --- | --- | --- |
| `git_exec` | 任意 git 子命令透传（args 数组直喂，绝不过 shell） | 送审 |
| `gh_exec` | 任意 gh 子命令透传（`repo` 转 `-R`） | 送审 |

透传工具会在权限摘要里写清将要执行的确切命令行；命中危险子命令（`push -f/--force`、`reset --hard`、`clean -f`、`branch -D`、`tag -d`、`filter-branch`、`update-ref -d`、`reflog expire`、`gc --prune`，以及 `gh repo delete`、`gh pr merge` 等）时额外标注「危险，可能丢数据」。

工具默认使用输入中的 `path`；未传路径时用配置里的仓库路径，再缺省当前工作目录。历史查询默认返回 20 条，最多 100 条。

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
| `remoteSettings` | 对象 | `{}` | 按仓库保存的远程角色（默认推送目标 / 默认获取来源） |

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
├── manifest.json          # v2 App 清单（manifestVersion 2）、设置 schema、卡片与功能面板声明
├── index.js               # defineApp 入口：注册 8 个 Agent 工具
├── lib/
│   └── secret.js          # GitHub 令牌的本地加密存放（DPAPI，后端可插拔）
├── assets/
│   ├── icon.svg           # App 身份图标（manifest.icon）
│   └── icon.png           # 同一图标的位图版本
├── ui/                    # 宿主静态树（/api/apps/git-save-load/ui/*），App 级资源鉴权
│   ├── git.html           # 卡片与功能面板共用的页面入口
│   └── assets/
│       ├── icon.png       # 卡片封面（face.image）
│       ├── sdk.js         # @hana/app-sdk/ui 浏览器单例
│       ├── hana-bridge.js # 主题/挂载位桥接（ESM）
│       ├── git.css        # 全部样式
│       └── git/           # 前端 JS 模块（27 个）
├── routes/                # 后端路由（Hono 目录形式，前缀 /api/apps/git-save-load/routes/）
│   ├── git.js             # 公共辅助函数与各模块装配
│   ├── local-git.js       # 状态、提交、身份和回滚
│   ├── history.js         # 提交历史查询
│   ├── history-edit.js    # amend、tag、squash、reword
│   ├── diff-conflicts.js  # diff、版本对比和冲突处理
│   ├── repository.js      # 仓库路径、信息、初始化和版本
│   ├── github.js          # GitHub CLI 管理
│   ├── pr.js              # PR 面板端点（/api/gh/pr-*）
│   ├── remote-query.js    # 远程列表和角色
│   ├── remote-sync.js     # 远程状态、fetch、merge、remove
│   ├── remote-edit.js     # 远程名称和地址编辑
│   ├── remote-push.js     # pull、push 和远程覆盖
│   ├── branch.js          # 分支管理
│   ├── stash.js           # Stash 管理
│   ├── config.js          # 配置读写（v2 config + dataDir 遗留文件回退）
│   └── misc.js            # 兼容接口
├── tools/                 # Agent 可调用工具的实现模块
│   ├── _helpers.js        # git / gh 路径探测与命令辅助
│   ├── git_status.js      # 工作区状态（只读）
│   ├── git_commit.js      # 暂存并提交（支持隔离签名）
│   ├── git_log.js         # 提交历史（只读）
│   ├── git_reset.js       # 回滚
│   ├── git_exec.js        # 任意 git 子命令透传
│   ├── gh_exec.js         # 任意 gh 子命令透传
│   ├── git_push.js        # 语义化推送（force 仅 force-with-lease）
│   └── gh_pr.js           # PR 生命周期（create/list/view/merge）
├── scripts/               # 开发脚本（自检 / 出包 / 发版）；打包时整目录排除
│   ├── selfcheck.mjs
│   ├── pack.mjs
│   └── release.ps1
├── tests/                 # 自动化测试（受限模式运行）；打包时整目录排除
│   ├── run.mjs            # 一键 runner
│   ├── cases/             # 5 个用例
│   └── lib/               # 断言骨架、夹具、宿主桩
├── sdk/                   # 随包分发的 @hana/app-sdk 运行时闭包（离线装载，不依赖 npm）
├── docs/
├── .gitignore
├── LICENSE
├── DESIGN.md
└── README.md
```

### v2 相对 v1 的关键变化

- **页面与静态资源**：v1 由插件路由 serve HTML 并白名单转发 `assets/`（token 回传 + mtime 版本号）；v2 页面与资源全部来自 `ui/` 静态树，由宿主按 App 级票据鉴权，`git-asset` 机制已删除。
- **侧栏 Widget**：v1 的 `contributes.widget` 在 v2 没有对应贡献点，改为卡片的 `functionPanel`（同一张 `git.html`，由 `hana.surface.getContext().slot` 识别后套用原 widget 窄面板样式）。
- **文件系统边界**：App 进程运行在 Node Permission Model 下（安装目录只读、`app-data/git-save-load` 可写）。仓库内文件读写改走 `ctx.resources`（`app/resources.read` / `app/resources.write`），临时文件（commit 消息、rebase 编辑器脚本）落 `dataDir`，`.git` 状态文件的存在性检查走宿主 `resources.stat`。git / gh 子进程不受该限制（需 `app/process.spawn`）。
- **配置**：`contributes.configuration` → `contributes.settings.schema`；`ctx.config` 为异步读写。
- **工具**：`tools/*.js` 模块不变，由 `index.js` 包一层执行上下文后经 `sdk.tools.register` 注册；模型可调用需 `app/tools.expose-to-model` 授权。
- **前端 API 基址**：`/api/plugins/git-save-load/` → `/api/apps/git-save-load/routes/`，凭证头 `X-Hana-Plugin-Surface-Session` → `X-Hana-App-Surface-Session`（env.js 一处）。
- **主题**：宿主主题名经 `hana.theme` 订阅写入 `body[data-hana-theme]`，原有 14 套主题逻辑不变。

---

## 当前版本

```text
v3.0.0
```

v3.0.0 重点更新：

- 新增四个模型工具：`git_exec` / `gh_exec` 子命令透传、`git_push` 语义化推送（force 仅映射 `--force-with-lease`）、`gh_pr` PR 生命周期
- `git_commit` 支持隔离 GPG 签名提交，并在提交后回收 `gpg-agent`
- 新增 GitHub 令牌加密存放（Windows DPAPI，后端可插拔，绝不明文回退）；令牌不进宿主设置表
- GitHub 面板新增「PR」标签页（列表 / 新建 / 合并）
- 新增 `scripts/` 下的结构自检（`selfcheck.mjs`）与零依赖出包脚本（`pack.mjs`）

v2 App 迁移（2.4.0）：

- 从 HanaAgent v1 插件迁移为 manifestVersion 2 的 App
- 侧栏 Widget 改为卡片 functionPanel
- 仓库文件读写改走宿主 ResourceIO 门，临时文件落 App dataDir
- 主题跟随改用 `hana.theme` 订阅

历史重点更新：

- 1.9.0：提交记录首屏加载 20 条，接近底部自动加载更早记录；分页接口增加 `skip` 与 `hasMore`；改善追加滚动体验；完善推送、拉取按钮换行布局；延续提交历史编辑、版本号管理和连续提交合并能力

---

## 开发

```bash
# 目录位于 <HANA_HOME>/apps/git-save-load，改完在 App 详情页点「重新加载」
```

主要修改文件：

- `manifest.json`：清单、设置 schema、卡片与功能面板声明
- `index.js`：工具注册（`defineApp`）
- `ui/git.html`：页面入口（DOM 结构与模块加载顺序）
- `ui/assets/git/*.js`：前端功能模块，加载顺序即拆分前顶层执行顺序，勿随意调整
- `ui/assets/hana-bridge.js`：v2 桥接（主题、function-panel 识别、App SDK 单例）
- `routes/*.js`：后端路由；`routes/git.js` 是公共辅助与模块装配
- `tools/*.js`：Agent 工具

改完后校验（在 Hana 检出树或已安装的 author tools 下执行）：

```bash
node scripts/validate-app.mjs --dir <HANA_HOME>/apps/git-save-load --json
node scripts/validate-app.mjs --dir <HANA_HOME>/apps/git-save-load --smoke --json
```

`--smoke` 需要独立 Electron 运行时（`HANA_APP_ELECTRON` 指向 Electron 二进制）。

### 测试

`tests/` 下有 5 个用例，一条命令跑完：

```bash
node tests/run.mjs            # 全部用例
node tests/run.mjs 03 05      # 只跑指定编号的用例
```

runner 会为每个用例 spawn 一个**受限模式**子进程（`--permission`，只开放 App 目录与临时目录的读写，另加 `--allow-child-process`），尽量贴近 App 的真实运行环境。用例自建夹具（临时 git 仓库、临时 dataDir），跑完清理，不触碰你的真实仓库与 App 数据目录。

覆盖范围：结构自检、入口装配（8 个工具 + 路由端点）、`POST /api/config` 白名单回归、`git_exec` / `git_push` 行为（含 force 语义）、令牌加密存取与解密失败语义。失败会逐条定位到用例名与断言点，并以非零码退出。用例清单见 [`tests/README.md`](./tests/README.md)。

测试与 `scripts/` 一样**不进安装包**。

### 打包与自检脚本

`scripts/` 下三个开发脚本，都不进安装包（打包时整目录排除）：

| 脚本 | 用途 |
| --- | --- |
| `selfcheck.mjs` | 结构自检：manifest 必备字段、entry / icon 存在、entry 与 `routes/` 与 `tools/` 全量 JS 语法、`ui/*.html` 引用的本地资源是否存在、manifest 声明的 route 对应页面是否存在 |
| `pack.mjs` | 零依赖出包（自带最小 ZIP 写入器，不调外部 zip / tar，不用 npm 库）；出包前先跑 selfcheck |
| `release.ps1` | 出包与发版：默认只出包（调 `pack.mjs`，产物落 `dist`）；加 `-Publish` 才走发布门禁并创建 GitHub Release |

**结构自检**

```bash
node scripts/selfcheck.mjs            # 人类可读；不通过时非零退出
node scripts/selfcheck.mjs --json     # { ok, errors, warnings }
```

**本地出包**

```bash
node scripts/pack.mjs                     # 产物落 <app>/dist
node scripts/pack.mjs --out <dir>         # 自定义输出目录
node scripts/pack.mjs --publisher <name>  # 指定 entry.json 的 publisher（默认 manifest.id）
```

产物三个文件：`git-save-load-v<version>.zip`、同名 `.sha256`、`git-save-load-v<version>.entry.json`。zip 内所有条目带顶层 `git-save-load/` 前缀（宿主安装时自动剥壳），条目名一律用正斜杠（宿主解压器 yauzl 拒绝反斜杠条目）。

打包排除项：任意层级的 `.git`、`.github`、`node_modules`、`dist`、`scripts`、`tests`；按文件名排除 `.DS_Store`、`Thumbs.db`、`desktop.ini`、`._*`、`*.tmp` / `.temp` / `.swp` / `.swo` / `.log` / `.bak`、`*~`；符号链接一律跳过。

**出包与发版**

默认只出包：

```powershell
.\scripts\release.ps1                                   # 只出包（默认）：跑完 dist 就有三件产物，不联网
```

要发布到 GitHub Release，加 `-Publish`：

```powershell
.\scripts\release.ps1 -Publish                           # 出包并发布
.\scripts\release.ps1 -Publish -Notes "- 修复xxx`n- 新增yyy"   # 附带发布说明
.\scripts\release.ps1 -Publish -SkipCleanCheck            # 发布时跳过工作区干净检查
```

不带 `-Publish` 时是纯本地操作：不查工作区、不联网、不碰 gh。加 `-Publish` 才会在出包之后走发布门禁：工作区干净、本地提交已推送到 `origin/master`、gh 已登录、该 tag 的 Release 不存在（防同版本发两次不同内容）、`manifest.json` 的 version 与 tag 强绑定。任一没过就停在发布之前，已出好的包不受影响。`-PackageOnly` 是历史写法，等同于默认行为。

---

## 相关项目

- [HanaAgent](https://github.com/liliMozi/openhanako) — HanaAgent 平台
- [Git](https://git-scm.com/) — 分布式版本控制系统
- [GitHub CLI](https://cli.github.com/) — GitHub 官方命令行工具

## 许可证

[Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/)（MPL-2.0），全文见仓库根目录的 [`LICENSE`](./LICENSE)。

Copyright (c) 2026 H-i-m-s

MPL-2.0 是文件级的弱著佐权：可以把本项目与闭源代码组合、用于商业用途；但被 MPL 覆盖的源文件若被修改并再分发，该文件的源码需继续以 MPL-2.0 公开。
