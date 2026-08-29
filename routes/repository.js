// Repository path, metadata, init and version routes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function registerRepositoryRoutes(app, { ctx, repoPath, readRepoPath, writeRepoPath, gitExecFile, gitExecFileAsync, extractBasename, extractParentTail, parseOriginUrl, readRemoteSettings }) {
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
  // 返回 basename / path tail / 远程信息 / 默认分支，路径不论是否 git 仓库都返回。
  // 内部用异步 git 调用，多个请求并发到达时不再在事件循环上串行排队。
  async function buildRepoInfo(path) {
    const out = {
      ok: false,
      path,
      basename: extractBasename(path),
      parentTail: extractParentTail(path),
      isGit: false,
      origin: "",
      defaultBranch: ""
    };
    if (!path) return out;

    // 判断是否为 git 仓库
    try {
      await gitExecFileAsync(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      out.isGit = true;
    } catch {
      return out; // 不是 git 仓库，basename 仍可用
    }

    // 仓库名片仍保留兼容字段 origin，但优先读取默认推送远程的地址。
    // remote 列表与插件配置读取并行；拿到远程名后 get-url 与 symbolic-ref 并行。
    try {
      const remoteNamesP = gitExecFileAsync(path, ["remote"], { timeout: 10000 })
        .then(raw => raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean))
        .catch(() => []);
      const remoteSettingsP = remoteNamesP.then(names => readRemoteSettings(ctx, path, names)).catch(() => null);
      const remoteNames = await remoteNamesP;
      const remoteSettings = await remoteSettingsP;
      const remote = remoteSettings.pushRemote || remoteNames[0] || "";
      if (remote) {
        const [urlRaw, sym] = await Promise.all([
          gitExecFileAsync(path, ["remote", "get-url", remote], { timeout: 10000 }).catch(() => ""),
          gitExecFileAsync(path, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { timeout: 10000 }).catch(() => ""),
        ]);
        out.origin = parseOriginUrl(urlRaw);
        out.defaultBranch = (sym || "").replace(new RegExp(`^${remote}/`), "");
      }
    } catch {}
    if (!out.defaultBranch) {
      try { out.defaultBranch = await gitExecFileAsync(path, ["config", "init.defaultBranch"], { timeout: 10000 }).catch(() => "") || "main"; } catch { out.defaultBranch = "main"; }
      if (!out.defaultBranch) out.defaultBranch = "main";
    }

    out.ok = true;
    return out;
  }

  app.get("/api/repo-info", async (c) => {
    const path = repoPath(c.req.query("path"));
    return c.json(await buildRepoInfo(path));
  });

  // ======== API: 批量读取仓库元信息（仓库历史列表一次请求全部拉齐） ========
  // 前端仓库历史最多 20 条，逐条请求会叠加进程开销；批量 + 内部全并行 +
  // 规范化路径去重后，总耗时约等于最慢单条。返回的 infos 以请求时的原始
  // 路径为键（同一仓库的多个写法共享同一次探测结果），前端直接对应。
  app.post("/api/repo-info-batch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const rawPaths = Array.isArray(body.paths) ? body.paths.map(p => String(p)).filter(Boolean).slice(0, 30) : [];
    // 规范化路径去重：同一仓库只探测一次，所有原始写法共享结果
    const byNormalized = new Map();
    for (const raw of rawPaths) {
      const norm = repoPath(raw);
      if (!byNormalized.has(norm)) byNormalized.set(norm, { promise: buildRepoInfo(norm), raws: [] });
      byNormalized.get(norm).raws.push(raw);
    }
    const out = {};
    for (const { promise, raws } of byNormalized.values()) {
      const info = await promise;
      for (const raw of raws) out[raw] = info;
    }
    return c.json({ ok: true, infos: out });
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
