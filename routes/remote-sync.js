// Remote synchronization routes.
export function registerRemoteSyncRoutes(app, helpers) {
  const {
    ctx, repoPath, gitExecFile, listRemoteBranches, readRemoteSettings,
    chooseRemoteBranch, getRemoteBranchSnapshot, validateBranchName,
    sanitizeRemoteUrl, commandErrorText, isValidRemoteName, getGitOperationState,
    writeRemoteSettings,
  } = helpers;

  app.post("/api/sync-status", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const requestedRemoteBranch = String(body.remoteBranch || "").trim();
    try {
      const names = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const settings = await readRemoteSettings(ctx, path, names);
      const remote = String(body.remote || settings.fetchRemote || "").trim();
      if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "当前没有可用的默认获取远程，请先在远程卡片中设置" });
      const targetBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!targetBranch || !validateBranchName(path, targetBranch)) return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到本地分支" });
      const remoteUrl = gitExecFile(path, ["remote", "get-url", remote], { timeout: 10000 });
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const branches = listRemoteBranches(path, remote);
      const remoteBranch = chooseRemoteBranch(path, remote, targetBranch, branches, requestedRemoteBranch);
      if (!remoteBranch) return c.json({ ok: true, branch: targetBranch, targetBranch, remote, remoteBranch: requestedRemoteBranch, remoteUrl: sanitizeRemoteUrl(remoteUrl), hasUpstream: false, ahead: 0, behind: 0, diverged: false, comparisonStatus: "REMOTE_BRANCH_MISSING", branches, message: "远程分支尚未建立" });
      const snapshot = getRemoteBranchSnapshot(path, remote, remoteBranch, targetBranch);
      return c.json({ ok: true, branch: targetBranch, targetBranch, remote, remoteBranch, remoteUrl: sanitizeRemoteUrl(remoteUrl), remoteHash: snapshot.remoteHash, hasUpstream: snapshot.hasRemoteBranch, ahead: snapshot.localAhead, behind: snapshot.remoteAhead, diverged: snapshot.localAhead > 0 && snapshot.remoteAhead > 0, comparisonStatus: snapshot.comparisonStatus, commits: snapshot.commits, files: snapshot.files });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "获取远程状态失败" }); }
  });

  app.post("/api/remote-fetch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "").trim();
    const requestedBranch = String(body.remoteBranch || body.branch || "").trim();
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });
    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const targetBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!targetBranch || !validateBranchName(path, targetBranch)) return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到本地分支" });
      const remoteUrl = gitExecFile(path, ["remote", "get-url", remote], { timeout: 10000 });
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const branches = listRemoteBranches(path, remote);
      const remoteBranch = chooseRemoteBranch(path, remote, targetBranch, branches, requestedBranch);
      if (requestedBranch && !remoteBranch) return c.json({ ok: false, code: "REMOTE_BRANCH_MISSING", remote, remoteBranch: requestedBranch, targetBranch, branches, message: `远程分支 ${remote}/${requestedBranch} 不存在` });
      const snapshot = remoteBranch ? getRemoteBranchSnapshot(path, remote, remoteBranch, targetBranch) : { hasRemoteBranch: false, comparisonStatus: "REMOTE_BRANCH_MISSING", remoteBranch: "", targetBranch, remoteAhead: 0, localAhead: 0, commits: [], files: [] };
      return c.json({ ok: true, remote, remoteUrl: sanitizeRemoteUrl(remoteUrl), targetBranch, branches, ...snapshot, message: snapshot.hasRemoteBranch ? `已获取 ${remote} 的最新更新` : `已获取 ${remote}，但没有可比较的远程分支` });
    } catch (e) { return c.json({ ok: false, message: `获取更新失败：${commandErrorText(e) || "无法访问远程仓库"}` }); }
  });

  app.post("/api/remote-merge", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "").trim();
    const requestedBranch = String(body.remoteBranch || body.branch || "").trim();
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });
    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const targetBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!targetBranch || !validateBranchName(path, targetBranch)) return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到本地分支" });
      const operationState = getGitOperationState(path);
      if (operationState) return c.json({ ok: false, code: "GIT_OPERATION_IN_PROGRESS", message: `当前 Git 正在进行 ${operationState} 操作，请先完成或终止它` });
      if (gitExecFile(path, ["status", "--porcelain"], { timeout: 10000 })) return c.json({ ok: false, code: "DIRTY", message: "当前工作区有未提交修改，请先存档、暂存或清理后再合并上游更新" });
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const branches = listRemoteBranches(path, remote);
      const remoteBranch = chooseRemoteBranch(path, remote, targetBranch, branches, requestedBranch);
      if (!remoteBranch) return c.json({ ok: false, code: "REMOTE_BRANCH_MISSING", remote, remoteBranch: requestedBranch, targetBranch, branches, message: requestedBranch ? `远程分支 ${remote}/${requestedBranch} 不存在` : `远程 ${remote} 没有可用的默认分支` });
      const remoteRef = `${remote}/${remoteBranch}`;
      gitExecFile(path, ["rev-parse", "--verify", `${remoteRef}^{commit}`], { timeout: 10000 });
      const raw = gitExecFile(path, ["merge", "--no-edit", remoteRef], { timeout: 120000 });
      if (getGitOperationState(path) === "MERGE_HEAD") return c.json({ ok: false, code: "MERGE_CONFLICT", requiresResolution: true, remote, remoteBranch, targetBranch, sourceRef: remoteRef, message: "合并产生冲突，请先解决冲突" });
      return c.json({ ok: true, remote, remoteBranch, targetBranch, sourceRef: remoteRef, message: raw.includes("Already up to date") ? "已经是最新" : `已将 ${remoteRef} 合并到本地 ${targetBranch}` });
    } catch (e) {
      const stderr = commandErrorText(e);
      if (getGitOperationState(path) === "MERGE_HEAD") return c.json({ ok: false, code: "MERGE_CONFLICT", requiresResolution: true, remote, message: "合并产生冲突，请先解决冲突" });
      const errLine = stderr.split("\n").find(l => l.includes("error:") || l.includes("fatal:"));
      return c.json({ ok: false, message: errLine ? errLine.replace(/^(error:|fatal:)\s*/, "").trim() : `合并失败：${stderr || "无法合并远程更新"}` });
    }
  });

  app.post("/api/remote-remove", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "").trim();
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });
    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const operationState = getGitOperationState(path);
      if (operationState) return c.json({ ok: false, code: "GIT_OPERATION_IN_PROGRESS", message: `当前 Git 正在进行 ${operationState} 操作，请先完成或终止它` });
      const currentUrl = gitExecFile(path, ["remote", "get-url", remote], { timeout: 10000 });
      const names = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const settings = await readRemoteSettings(ctx, path, names);
      const isDefaultPush = settings.pushRemote === remote;
      const isDefaultFetch = settings.fetchRemote === remote;
      const isProtected = remote === "origin" || remote === "upstream" || isDefaultPush || isDefaultFetch;
      if (isProtected && body.confirmed !== true) {
        const impacts = [];
        if (isDefaultPush || remote === "origin") impacts.push("默认推送");
        if (isDefaultFetch || remote === "upstream") impacts.push("默认获取");
        return c.json({ ok: false, code: "REMOTE_REMOVE_CONFIRM", requiresConfirmation: true, remote, currentUrl: sanitizeRemoteUrl(currentUrl), isDefaultPush, isDefaultFetch, message: `移除 ${remote} 会影响${impacts.join("和")}流程，请确认` });
      }
      gitExecFile(path, ["remote", "remove", remote], { timeout: 10000 });
      if (isDefaultPush || isDefaultFetch || settings.roles[remote]) {
        const nextSettings = { ...settings, pushRemote: isDefaultPush ? "" : settings.pushRemote, fetchRemote: isDefaultFetch ? "" : settings.fetchRemote, roles: { ...settings.roles } };
        delete nextSettings.roles[remote];
        await writeRemoteSettings(ctx, path, nextSettings);
      }
      return c.json({ ok: true, remote, message: `已移除远程 ${remote}` });
    } catch (e) { return c.json({ ok: false, message: `移除远程失败：${commandErrorText(e) || "远程不存在"}` }); }
  });
}
