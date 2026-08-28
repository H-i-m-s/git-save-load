// Shared request boundary for the Git Save/Load Card.
// This file deliberately keeps the browser's native fetch untouched.
const _nativeFetch = window.fetch.bind(window);

function pluginFetch(path, init) {
  const params = new URLSearchParams(window.location.search);
  const session = params.get("pluginSurfaceSession");
  const headers = new Headers((init && init.headers) || {});
  if (session) headers.set("X-Hana-Plugin-Surface-Session", session);
  return _nativeFetch(
    "/api/plugins/git-save-load/" + String(path || "").replace(/^\/+/, ""),
    Object.assign({}, init || {}, { headers }),
  );
}
