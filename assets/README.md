# Git Save/Load WebView assets

`git.html` is the no-build WebView entry used by the authenticated `/page` and legacy `/widget` route shells.

The page keeps the existing UI implementation while routing same-plugin API requests through the Hana WebView SDK contract (`hana.api.fetch` semantics) and host-mediated clipboard/external-open helpers.
