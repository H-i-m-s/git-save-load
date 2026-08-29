# Git Save/Load WebView assets

`git.html` is the no-build WebView entry served by the authenticated `/git` card route. It keeps only the DOM structure and the module load order; styles live in `git.css` and the front-end logic is split into `git/*.js` (26 modules loaded in the original execution order).

Same-plugin API requests go through the local `pluginFetch` helper (`env.js`), which attaches the Hana WebView surface-session header; clipboard and external-open go through the host bridge shim.

Host serves assets under `/api/plugins/<id>/assets/` with a one-year immutable cache. The backend appends a `?v=` token derived from each asset's mtime+size when rendering the page, so edited files get fresh URLs immediately.
