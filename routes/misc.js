// Small compatibility routes.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export function registerMiscRoutes(app, { pluginDir }) {
  app.get("/api/open-external", async (c) => {
    // Kept for compatibility with the existing UI. New UI code should prefer
    // hana.external.open(), which is capability-gated by the host.
    const url = String(c.req.query("url") || "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return c.json({ ok: false, message: "只允许打开 http/https 链接" });
    try { execFileSync("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, timeout: 10000 }); return c.json({ ok: true }); }
    catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.get("/api/plugin-version", async (c) => {
    try {
      const manifest = JSON.parse(await readFile(join(pluginDir, "manifest.json"), "utf8"));
      return c.json({ ok: true, version: manifest.version || "unknown" });
    } catch { return c.json({ ok: false, version: "unknown" }); }
  });
}
