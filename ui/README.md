# Git Save/Load v2 UI 资源说明

`git.html` 是 v2 App 的 WebView 入口，由宿主静态树提供：`/api/apps/git-save-load/ui/git.html`。页面只保留 DOM 结构和模块加载顺序：样式在 `assets/git.css`，前端逻辑在 `assets/git/*.js`（26 个模块，按拆分前的顶层执行顺序加载）。

同一张页面服务两个挂载位：

- 卡片（`contributes.cards[].route`）：整页模式。
- 功能面板（`contributes.cards[].functionPanel`）：`hana-bridge.js` 通过 `hana.surface.getContext().slot === "function-panel"` 识别后给 body 打 `data-hana-widget="1"`，复用原 v1 widget 的窄面板样式。

## 与 v1 的差异

- 静态资源不再由插件路由白名单转发。相对路径（`assets/git.css`、`assets/git/*.js`）继承 App UI 基路径的资源授权，`git-asset` 路由、mtime 版本号与 token 回传机制全部删除。
- API 基址为 `/api/apps/git-save-load/routes/`，iframe URL 上的 `appSurfaceSession` 查询参数经 `X-Hana-App-Surface-Session` 头回传（`assets/git/env.js`）。
- `hana` 单例来自随包的 `assets/sdk.js`（`@hana/app-sdk/ui`），`hana.external.open` / `hana.clipboard.writeText` 受 App 级能力授权；`env.js` 里的 shim 只在 SDK 挂载前兜底。
- 主题：`hana-bridge.js` 把 `hana.theme` 的当前主题名写入 `body[data-hana-theme]`，原有 `getHanaTheme()` / `applyTheme()` 逻辑与 14 套 `theme-*` 样式不变。
