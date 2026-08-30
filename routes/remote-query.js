// Remote list and role routes.
export function registerRemoteQueryRoutes(app, helpers) {
  const { repoPath, gitExecFile, gitExecFileAsync, listRemoteDetails, readRemoteSettings, applyRemoteSettings, chooseRemoteBranch, getRemoteBranchSnapshot, validateBranchName, commandErrorText, writeRemoteSettings, isValidRemoteName, sanitizeRemoteUrl, parseCommitList, parseNameStatus } = helpers;

  // ======== /api/remotes 的异步并行实现 ========
  // 旧实现走同步 listRemoteDetails + getRemoteBranchSnapshot，每个远程串行
  // 启动 10+ 个 git 子进程（实测 NanaZip 双远程 21 进程串行 1.76s），且同步
  // 调用阻塞事件循环，与其它请求互相排队。
  // 重写后：全局依赖层并行（rev-parse/branch/remote 列表/@{upstream}/配置），
  // 每远程的 url/分支/HEAD 探测全并行，快照内部再并行。实测同仓库 0.6s。
  // 同步版保留给 push/pull/overwrite 路由使用（那些路径含网络操作，非热点）。
  async function g(cwd, args, fallback = null) {
    try { return await gitExecFileAsync(cwd, args, { timeout: 10000 }); }
    catch (e) { if (fallback !== null) return fallback; throw e; }
  }

  async function buildRemotesOverview(path, preferredRemote, preferredBranch) {
    // 层 1：仓库有效性、当前分支、远程名列表 —— 全并行
    const [branchRaw, namesRaw] = await Promise.all([
      g(path, ["rev-parse", "--is-inside-work-tree"]),
      g(path, ["remote"]),
    ]);
    const branch = await g(path, ["branch", "--show-current"], "");
    const names = String(namesRaw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    // 层 2：每远程的地址/分支/HEAD 并行 + upstream（一次，与远程无关）+ 插件配置
    const upstreamP = g(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], "");
    const settingsP = readRemoteSettings(helpers.ctx, path, names).catch(() => null);
    const details = await Promise.all(names.map(async (name) => {
      const [fetchUrl, pushUrlRaw, branchesRaw, pushUrlsRaw, headSym] = await Promise.all([
        g(path, ["remote", "get-url", name], ""),
        g(path, ["remote", "get-url", "--push", name], ""),
        g(path, ["for-each-ref", "--format=%(refname:strip=3)", `refs/remotes/${name}`], ""),
        g(path, ["config", "--get-all", `remote.${name}.pushurl`], ""),
        g(path, ["symbolic-ref", "--short", `refs/remotes/${name}/HEAD`], ""),
      ]);
      const pushUrl = pushUrlRaw || fetchUrl;
      const branches = String(branchesRaw || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(n => n !== "HEAD");
      const prefix = `${name}/`;
      const headBranch = String(headSym || "").startsWith(prefix) ? String(headSym).slice(prefix.length) : "";
      const defaultBranch = headBranch && branches.includes(headBranch)
        ? headBranch
        : (branches.includes("main") ? "main" : (branches.includes("master") ? "master" : (branches[0] || "")));
      return {
        name,
        fetchUrl: sanitizeRemoteUrl(fetchUrl),
        pushUrl: sanitizeRemoteUrl(pushUrl || fetchUrl),
        hasPushUrl: String(pushUrlsRaw || "").split(/\r?\n/).filter(Boolean).length > 0,
        displayUrl: sanitizeRemoteUrl(fetchUrl || pushUrl),
        branches,
        defaultBranch,
        role: "other",
      };
    }));
    const upstream = await upstreamP;
    const settings = await settingsP;

    // 应用插件侧的远程角色配置（推送目标/更新来源）
    const remotes = details;
    if (settings) remotes.forEach(remoteInfo => applyRemoteSettings(remoteInfo, settings));

    // detached HEAD：返回无快照的完整远程列表（与旧实现语义一致）
    if (!branch || !validateBranchName(path, branch)) {
      return { ok: true, path, branch: "", detached: true, pushRemote: settings?.pushRemote, fetchRemote: settings?.fetchRemote, remotes, message: "当前处于 detached HEAD 或尚未检出本地分支" };
    }

    // 层 3：每远程的分支选择 + 快照，全并行；快照内部再并行
    await Promise.all(remotes.map(async (remoteInfo) => {
      const requested = remoteInfo.name === preferredRemote ? preferredBranch : "";
      let remoteBranch;
      if (requested) {
        remoteBranch = remoteInfo.branches.includes(requested) ? requested : null;
      } else {
        const tracked = String(upstream || "").startsWith(`${remoteInfo.name}/`) ? String(upstream).slice(`${remoteInfo.name}/`.length) : "";
        remoteBranch = (tracked && remoteInfo.branches.includes(tracked)) ? tracked : remoteInfo.defaultBranch;
      }
      remoteInfo.targetBranch = branch;
      remoteInfo.remoteBranch = remoteBranch || "";
      if (!remoteBranch) {
        Object.assign(remoteInfo, { hasRemoteBranch: false, comparisonStatus: "REMOTE_BRANCH_MISSING", remoteAhead: 0, localAhead: 0, commits: [], files: [] });
        return;
      }
      const remoteRef = `${remoteInfo.name}/${remoteBranch}`;
      const [remoteHash, targetHash] = await Promise.all([
        g(path, ["rev-parse", "--verify", `${remoteRef}^{commit}`], ""),
        g(path, ["rev-parse", "--verify", `${branch}^{commit}`], ""),
      ]);
      if (!remoteHash) {
        Object.assign(remoteInfo, { remoteRef, remoteBranch, targetBranch: branch, remoteHash: "", hasRemoteBranch: false, comparisonStatus: "REMOTE_BRANCH_MISSING", remoteAhead: 0, localAhead: 0, commits: [], files: [] });
        return;
      }
      if (!targetHash) {
        Object.assign(remoteInfo, { remoteRef, remoteBranch, targetBranch: branch, remoteHash, hasRemoteBranch: true, comparisonStatus: "LOCAL_BRANCH_UNCOMMITTED", remoteAhead: 0, localAhead: 0, commits: [], files: [] });
        return;
      }
      let counts;
      try {
        counts = (await g(path, ["rev-list", "--left-right", "--count", `${remoteRef}...${branch}`])).split(/\s+/).map(Number);
      } catch {
        Object.assign(remoteInfo, { remoteRef, remoteBranch, targetBranch: branch, remoteHash, hasRemoteBranch: true, comparisonStatus: "COMPARE_FAILED", remoteAhead: 0, localAhead: 0, commits: [], files: [] });
        return;
      }
      const remoteAhead = Number.isFinite(counts[0]) ? counts[0] : 0;
      const localAhead = Number.isFinite(counts[1]) ? counts[1] : 0;
      let commits = [];
      let files = [];
      try {
        const [logRaw, diffRaw] = await Promise.all([
          g(path, ["log", "--format=%H|%s", "-n", "20", `${branch}..${remoteRef}`]),
          g(path, ["diff", "--name-status", `${branch}..${remoteRef}`]),
        ]);
        commits = parseCommitList(logRaw);
        files = parseNameStatus(diffRaw);
      } catch {}
      Object.assign(remoteInfo, { remoteRef, remoteBranch, targetBranch: branch, remoteHash, hasRemoteBranch: true, comparisonStatus: "OK", remoteAhead, localAhead, commits, files });
    }));

    return { ok: true, path, branch, detached: false, pushRemote: settings?.pushRemote, fetchRemote: settings?.fetchRemote, remotes };
  }

  app.get("/api/remotes", async (c) => {
    const path = repoPath(c.req.query("path"));
    const preferredRemote = String(c.req.query("remote") || "").trim();
    const preferredBranch = String(c.req.query("remoteBranch") || "").trim();
    try {
      return c.json(await buildRemotesOverview(path, preferredRemote, preferredBranch));
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "读取远程仓库失败" }); }
  });

  app.post("/api/remote-role", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "").trim();
    const role = String(body.role || "").trim();
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });
    if (!["push-target", "update-source", "other"].includes(role)) return c.json({ ok: false, message: "远程角色不正确" });
    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const names = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!names.includes(remote)) return c.json({ ok: false, message: `远程 ${remote} 不存在` });
      const settings = await readRemoteSettings(helpers.ctx, path, names);
      const roles = { ...settings.roles };
      if (role === "push-target") {
        Object.keys(roles).forEach(name => { if (roles[name] === "push-target") roles[name] = "other"; });
        roles[remote] = "push-target"; settings.pushRemote = remote;
      } else if (role === "update-source") {
        Object.keys(roles).forEach(name => { if (roles[name] === "update-source") roles[name] = "other"; });
        roles[remote] = "update-source"; settings.fetchRemote = remote;
      } else {
        if (settings.pushRemote === remote) settings.pushRemote = names.find(name => name !== remote) || "";
        if (settings.fetchRemote === remote) settings.fetchRemote = names.find(name => name !== remote) || "";
        if (roles[remote]) roles[remote] = "other";
      }
      settings.roles = roles;
      await writeRemoteSettings(helpers.ctx, path, settings);
      return c.json({ ok: true, remote, role, pushRemote: settings.pushRemote, fetchRemote: settings.fetchRemote, message: role === "push-target" ? `已将 ${remote} 设为默认推送目标` : (role === "update-source" ? `已将 ${remote} 设为默认获取来源` : `已取消 ${remote} 的特殊角色`) });
    } catch (e) { return c.json({ ok: false, message: `设置远程角色失败：${commandErrorText(e) || "无法保存远程角色"}` }); }
  });
}
