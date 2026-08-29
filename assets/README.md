# Git Save/Load WebView assets

`git.html` is the no-build WebView entry served by the authenticated `/git` card route. It keeps only the DOM structure and the module load order; styles live in `git.css` and the front-end logic is split into `git/*.js` (26 modules loaded in the original execution order).

Same-plugin API requests go through the local `pluginFetch` helper (`env.js`), which attaches the Hana WebView surface-session header; clipboard and external-open go through the host bridge shim.

The card iframe authenticates with a surface-session credential only, which cannot load host static assets (`/assets/*` requires the `chat` scope). When rendering the page, the backend rewrites `assets/...` references to the plugin's own `git-asset/...` routes (same permission model as the card's API calls), appending a `?v=` token derived from each file's mtime+size for cache busting.
