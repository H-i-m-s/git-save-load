# Git Save/Load WebView 资源说明

`git.html` 是由认证路由 `/git` 服务的无构建 WebView 入口。页面只保留 DOM 结构和模块加载顺序：样式在 `git.css`，前端逻辑在 `git/*.js`（26 个模块，按拆分前的顶层执行顺序加载）。

插件 API 请求通过本地 `pluginFetch` 助手（`env.js`）发出，自动附带 Hana WebView 的 surface session 请求头；剪贴板和外部打开走宿主桥接 shim。

卡片 iframe 仅携带 surface session 凭证，无法加载宿主静态资产（`/assets/*` 要求 `chat` scope，而 surface 凭证不带任何 scope）。因此后端在返回页面时，把 `assets/...` 引用重写为插件自身路由 `git-asset/...`，并追加两个查询参数：

- `?v=`：由文件 mtime+size 计算的版本号；文件每次修改 URL 随之变化，WebView 永远不会用到旧缓存。
- `&token=`：iframe 文档 URL 中自带的连接令牌，原样回传后子资源经主鉴权 queryToken 通道放行（与宿主给 `theme.css` 的处理方式一致）。代理层会剥离转发 URL 中的 `pluginSurfaceSession` 和 `pluginIframeTicket`，所以文档里的 token 是页面唯一能回传的凭证。

`git.html` 本身按 mtime+size 签名自动重读，修改页面后无需重载插件即可生效。
