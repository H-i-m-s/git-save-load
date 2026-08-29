// Repository path, metadata, init and version routes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function registerRepositoryRoutes(app, { ctx, repoPath, readRepoPath, writeRepoPath, gitExecFile, extractBasename, extractParentTail, parseOriginUrl, readRemoteSettings }) {
  // ======== API: 读写仓库路径配置 ========
  app.get("/api/repo", async (c) => {
    const configuredPath = await readRepoPath(ctx);
    return c.json({ ok: true, repoPath: configuredPath });
  });

  app.post("/api/repo", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = String(body.repoPath || "").trim();
    await writeRepoPath(ctx, path);
    return c.json({ ok: true, repoPath: path });
  });

  // ======== API: 读取仓库元信息（用于库列表面板） ========
  // 返回 basename / path tail / 远程信息 / 默认分支，路径不论是否 git 仓库都返回
  app.get("/api/repo-info", async (c) => {
    const path = repoPath(c.req.query("path"));
    const out = {
      ok: false,
      path,
      basename: extractBasename(path),
      parentTail: extractParentTail(path),
      isGit: false,
      origin: "",
      defaultBranch: ""
    };
    if (!path) return c.json(out);

    // 判断是否为 git 仓库
    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"]);
      out.isGit = true;
    } catch {
      return c.json(out); // 不是 git 仓库，basename 仍可用
    }

    // 仓库名片仍保留兼容字段 origin，但优先读取默认推送远程的地址。
    try {
      const remoteNames = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const remoteSettings = await readRemoteSettings(ctx, path, remoteNames);
      const remote = remoteSettings.pushRemote || remoteNames[0] || "";
      if (remote) out.origin = parseOriginUrl(gitExecFile(path, ["remote", "get-url", remote], { timeout: 10000 }));
      if (remote) {
        const sym = gitExecFile(path, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { timeout: 10000 });
        out.defaultBranch = (sym || "").replace(new RegExp(`^${remote}/`), "");
      }
    } catch {}
    if (!out.defaultBranch) {
      try { out.defaultBranch = gitExecFile(path, ["config", "init.defaultBranch"]) || "main"; } catch {}
      if (!out.defaultBranch) out.defaultBranch = "main";
    }

    out.ok = true;
    return c.json(out);
  });

  // ======== API: 初始化 git 仓库 ========
  app.post("/api/init", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = String(body.path || "").trim();
    const gitignore = String(body.gitignore || "").trim();

    if (!path) return c.json({ ok: false, message: "请指定目录路径" });

    try {
      gitExecFile(path, ["init"]);

      // 有 .gitignore 模板就写入
      if (gitignore) {
        writeFileSync(join(path, ".gitignore"), gitignore, "utf8");
      }

      const branch = gitExecFile(path, ["branch", "--show-current"]);
      return c.json({ ok: true, path, branch: branch || "master" });
    } catch (e) {
      return c.json({ ok: false, message: `初始化失败：${e.message}` });
    }
  });

  // ======== API: 获取当前版本号（最新 tag） ========
  app.get("/api/version", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      const tags = gitExecFile(path, ["tag", "--sort=-version:refname"]).split("\n").filter(Boolean);
      const latest = tags.length > 0 ? tags[0].replace(/^v/, "") : "0.0.0";
      const parts = latest.split(".").map(Number);
      const next = `${parts[0] || 0}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;
      return c.json({ ok: true, current: latest, next, tags });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });
}
