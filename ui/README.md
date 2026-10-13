# Git Save/Load v2 UI 资源说明

`git.html` 是 v2 App 的 WebView 入口，由宿主静态树提供：`/api/apps/git-save-load/ui/git.html`。页面只保留 DOM 结构和模块加载顺序：样式在 `assets/git.css`，前端逻辑在 `assets/git/*.js`（26 个模块，按拆分前的顶层执行顺序加载）。

另有两个 **ES 模块**，不属于那 26 个（那套是原单文件脚本机械切分出来的，别去给它编号）：

- `assets/hana-bridge.js`（原有）：挂 SDK 单例、同步宿主主题、识别功能面板。
- `assets/git/update-banner.js`：卡片顶部那条「有新版本 vX.Y.Z · 查看更新」提示条，
  以及它唤醒的更新说明浮层。它 import 的 `../update-notice.mjs` / `../update-api.mjs`
  与设置页是同一份（与 doc-intake 逐字可 diff），所以必须以 `type="module"` 加载。
  取数走现成的 `/settings/update-check`，后端不另开逻辑。

两处非看不可的约定：

- **浮层取色**：`assets/update-notice.css` 指向设置页那套 `--gs-*`，主卡片没有。
  `git.css` 里在 `body` 上直接覆写了整组 `--tt-*` 指向 `--hana-*`。
  必须写在 `body` 而不是 `:root`，且必须覆写 `--tt-*` 而不是补 `--gs-*`：
  `var()` 在「声明它的那个元素」上就完成替换，所以 `:root` 取不到 `body` 上的主题类，
  在 `body` 补 `--gs-*` 也不会让 `:root` 里那批 `--tt-*` 重算。
- **不自动浮**：浮层默认会在有新版时自己弹。主卡片的形态是「顶部先出提示条，点了才看」，
  所以 `update-banner.js` 装它时传 `autoShow:false`；设置页不传，行为不变。

同一张页面服务两个挂载位：

- 卡片（`contributes.cards[].route`）：整页模式。
- 功能面板（`contributes.cards[].functionPanel`）：`hana-bridge.js` 通过 `hana.surface.getContext().slot === "function-panel"` 识别后给 body 打 `data-hana-widget="1"`，复用原 v1 widget 的窄面板样式。

## 与 v1 的差异

- 静态资源不再由插件路由白名单转发。相对路径（`assets/git.css`、`assets/git/*.js`）继承 App UI 基路径的资源授权，`git-asset` 路由、mtime 版本号与 token 回传机制全部删除。
- API 基址为 `/api/apps/git-save-load/routes/`，iframe URL 上的 `appSurfaceSession` 查询参数经 `X-Hana-App-Surface-Session` 头回传（`assets/git/env.js`）。
- `hana` 单例来自随包的 `assets/sdk.js`（`@hana/app-sdk/ui`），`hana.external.open` / `hana.clipboard.writeText` 受 App 级能力授权；`env.js` 里的 shim 只在 SDK 挂载前兜底。
- 主题：`hana-bridge.js` 把 `hana.theme` 的当前主题名写入 `body[data-hana-theme]`，原有 `getHanaTheme()` / `applyTheme()` 逻辑与 14 套 `theme-*` 样式不变。
