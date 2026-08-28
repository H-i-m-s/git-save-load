// Remote list and role routes.
export function registerRemoteQueryRoutes(app, helpers) {
  const { repoPath, gitExecFile, listRemoteDetails, readRemoteSettings, applyRemoteSettings, chooseRemoteBranch, getRemoteBranchSnapshot, validateBranchName, commandErrorText, writeRemoteSettings, isValidRemoteName } = helpers;

  app.get("/api/remotes", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const branch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      const preferredRemote = String(c.req.query("remote") || "").trim();
      const preferredBranch = String(c.req.query("remoteBranch") || "").trim();
      const remotes = listRemoteDetails(path);
      const settings = await readRemoteSettings(helpers.ctx, path, remotes.map(remoteInfo => remoteInfo.name));
      remotes.forEach(remoteInfo => applyRemoteSettings(remoteInfo, settings));
      if (!branch || !validateBranchName(path, branch)) {
        return c.json({ ok: true, path, branch: "", detached: true, pushRemote: settings.pushRemote, fetchRemote: settings.fetchRemote, remotes, message: "当前处于 detached HEAD 或尚未检出本地分支" });
      }
      for (const remoteInfo of remotes) {
        const requested = remoteInfo.name === preferredRemote ? preferredBranch : "";
        const remoteBranch = chooseRemoteBranch(path, remoteInfo.name, branch, remoteInfo.branches, requested);
        remoteInfo.targetBranch = branch;
        remoteInfo.remoteBranch = remoteBranch || "";
        if (remoteBranch) Object.assign(remoteInfo, getRemoteBranchSnapshot(path, remoteInfo.name, remoteBranch, branch));
        else Object.assign(remoteInfo, { hasRemoteBranch: false, comparisonStatus: "REMOTE_BRANCH_MISSING", remoteAhead: 0, localAhead: 0, commits: [], files: [] });
      }
      return c.json({ ok: true, path, branch, detached: false, pushRemote: settings.pushRemote, fetchRemote: settings.fetchRemote, remotes });
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
