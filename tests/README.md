# tests/ — git-save-load 自动化测试

零新增依赖，只用 Node 内置模块。一条命令跑全部用例：

```pwsh
node tests/run.mjs            # 全部用例
node tests/run.mjs 04 05      # 只跑文件名含 "04"/"05" 的用例
```

退出码：全通过 0；有失败 1。

## 受限模式

`run.mjs` 为每个用例文件 spawn 一个独立子进程，参数形如：

```
node --permission \
  --allow-fs-read=<APP> --allow-fs-read=<TMP> --allow-fs-write=<TMP> \
  --allow-child-process <case.mjs>
```

贴近 App 在 Node Permission Model 下的真实运行环境：安装目录只读、临时目录可写，
越界 fs 会抛 `ERR_ACCESS_DENIED`。runner 收集子进程退出码与输出，逐个打印 PASS / FAIL，
末尾打印 `N passed, M failed` 与总耗时。

## 布局

| 文件 | 覆盖 |
| --- | --- |
| `run.mjs` | 一键 runner：发现 `cases/*.mjs`，受限模式 spawn，汇总结果 |
| `lib/harness.mjs` | 极简断言（`check/eq/deepEq/contains/matches`），失败定位到「用例名 :: 断言点」 |
| `lib/fixture.mjs` | 临时目录 / 临时 git 仓库 / 裸远端夹具，进程退出统一清理 |
| `lib/stub.mjs` | 宿主侧桩：v2 入口上下文（`tools.register` 返回 `{ ready: Promise }` 回执）、路由 app/ctx |
| `cases/01-structure.mjs` | spawn `release/selfcheck.mjs`，断言退出码 0 |
| `cases/02-entry-wiring.mjs` | `index.js` 注册 8 个工具且名字集合一致；`routes/git.js` 装配 PR / 令牌 / 更新说明端点 |
| `cases/03-config-whitelist.mjs` | `POST /api/config` 白名单回归：白名单内键写入、白名单外键不被写入 |
| `cases/04-tools-behavior.mjs` | `git_exec` 返回值；`git_push` 无远端错误 / 裸远端成功 / `--force-with-lease` 语义 |
| `cases/05-secret.mjs` | 令牌加密往返、`credential.json` 不含明文、`alg` 不匹配时 `readable=false` |
| `cases/06-update-check.mjs` | 更新说明数据层（版本比较 / atom 解析 / 间隔校验）、`REPO_SLUG` 与 `release/config.json` 一致、`/settings/update-check` 端点行为 |
| `cases/07-settings-first-paint.mjs` | 设置页首屏不被网络拖住：`/settings/local` 只読本地（用一个没 network 的 ctx 柱证明）、`/settings/gh` 才是联网那一趟 |
| `cases/08-card-update-banner.mjs` | 主卡片顶部更新提示条与浮层接线（静态检查）：module 加载与次序、四个 id 逐字对应、`autoShow:false`、`markLocal` 会广播、`body` 层覆写 `--tt-*`、取数走 `/settings/update-check` |
| `cases/09-file-list-anim.mjs` | 变更列表动效层（`ui/assets/git/list-anim.mjs`）：纯函数（`statParts` / `diffFileItems` / `digitOffset`）+ 最小 DOM 桩跑真渲染，验「同名行复用同一个 li、新增/离场只动那一行、换仓库整体重置」，并要求 `DIGIT_H` 与 CSS `--digit-h` 相等 |

## 边界

用例只在 `GSL_TMP_DIR`（runner 创建的临时根）下建夹具并清理，不读写用户真实仓库，
也不写真实 App 数据目录 `C:\Users\SSS\.hanako\app-data\git-save-load`。
