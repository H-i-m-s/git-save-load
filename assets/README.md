# Git Save/Load WebView assets

`git.html` is the no-build WebView entry served by the authenticated `/git` card route. It keeps only the DOM structure and the module load order; styles live in `git.css` and the front-end logic is split into `git/*.js` (26 modules loaded in the original execution order).

Same-plugin API requests go through the local `pluginFetch` helper (`env.js`), which attaches the Hana WebView surface-session header; clipboard and external-open go through the host bridge shim.

The card iframe authenticates with a surface-session credential only, which cannot load host static assets (`/assets/*` requires the `chat` scope, and surface credentials carry no scopes). When rendering the page, the backend rewrites `assets/...` references to the plugin's own `git-asset/...` routes and appends two query params:

- `?v=` — derived from each file's mtime+size; the file URL changes on every edit so the WebView never serves stale cached assets.
- `&token=` — the connection token already present in the iframe document URL, passed through so each subresource request authenticates via the host's query-token channel (the same pattern the host uses for `theme.css`). The proxy strips `pluginSurfaceSession`/`pluginIframeTicket` from forwarded URLs, so the document token is the only credential the page can echo back.

`git.html` itself is re-read whenever its mtime+size signature changes, so page edits take effect without reloading the plugin.
