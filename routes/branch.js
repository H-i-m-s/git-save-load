// Local branch management routes.
export function registerBranchRoutes(app, { repoPath, gitExecFile, validateBranchName }) {
  app.get("/api/branches", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      const current = gitExecFile(path, ["branch", "--show-current"]);
      const raw = gitExecFile(path, ["branch"]);
      const branches = raw.split("\n").filter(Boolean).map(line => ({
        name: line.replace(/^\*?\s*/, "").trim(),
        current: line.trimStart().startsWith("*"),
      }));
      for (const b of branches) {
        try {
          b.lastCommit = gitExecFile(path, ["log", "-1", "--format=%s", b.name], { timeout: 10000 }) || "";
          b.lastHash = gitExecFile(path, ["log", "-1", "--format=%h", b.name], { timeout: 10000 });
        } catch { b.lastCommit = ""; b.lastHash = ""; }
      }
      return c.json({ ok: true, branches, current });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  app.post("/api/branch/switch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定分支名" });
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      gitExecFile(path, ["checkout", name]);
      return c.json({ ok: true, branch: name });
    } catch (e) { return c.json({ ok: false, message: `切换失败：${e.message}` }); }
  });

  app.post("/api/branch/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定新分支名" });
    const startPoint = String(body.startPoint || "").trim();
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      const args = ["branch", name];
      if (startPoint) args.push(startPoint);
      gitExecFile(path, args);
      return c.json({ ok: true, branch: name });
    } catch (e) { return c.json({ ok: false, message: `创建失败：${e.message}` }); }
  });

  app.post("/api/branch/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定分支名" });
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      gitExecFile(path, ["branch", "-D", name]);
      return c.json({ ok: true, branch: name });
    } catch (e) { return c.json({ ok: false, message: `删除失败：${e.message}` }); }
  });
}
