// Stash routes.
export function registerStashRoutes(app, { repoPath, gitExecFile, commandErrorText }) {
  app.get("/api/stash/list", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      const raw = gitExecFile(path, ["stash", "list"]);
      if (!raw) return c.json({ ok: true, stashes: [] });
      const stashes = raw.split("\n").filter(Boolean).map((line, i) => {
        const idx = line.match(/stash@\{(\d+)\}/);
        const msg = line.replace(/^stash@\{\d+\}:[^:]*:\s*/, "");
        return { index: parseInt(idx?.[1] ?? i), message: msg || line };
      });
      return c.json({ ok: true, stashes });
    } catch { return c.json({ ok: true, stashes: [] }); }
  });

  app.post("/api/stash/push", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const msg = String(body.message || "").trim();
    try {
      const args = ["stash", "push", "-u"];
      if (msg) args.push("-m", msg);
      gitExecFile(path, args);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "暂存失败" }); }
  });

  for (const action of ["pop", "drop"]) {
    app.post(`/api/stash/${action}`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const path = repoPath(body.path);
      const idx = parseInt(body.index);
      if (!Number.isInteger(idx) || idx < 0) return c.json({ ok: false, message: "暂存索引无效" });
      try {
        gitExecFile(path, ["stash", action, `stash@{${idx}}`]);
        return c.json({ ok: true });
      } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || (action === "pop" ? "恢复暂存失败" : "删除暂存失败") }); }
    });
  }
}
