// Remote push / pull / overwrite routes.
export function registerRemotePushRoutes(app, { ctx, repoPath, gitExecFile, commandErrorText, readConfig, readRemoteSettings, isValidRemoteName, validateBranchName, listRemoteBranches, chooseRemoteBranch, parseCommitList, parseNameStatus }) {
  // ======== API: 拉取远程 ========
  app.post("/api/pull", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const requestedRemoteBranch = String(body.remoteBranch || "").trim();
    try {
      const names = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const settings = await readRemoteSettings(ctx, path, names);
      const remote = String(body.remote || settings.fetchRemote || "").trim();
      if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "当前没有可用的默认获取远程，请先在远程卡片中设置" });
      const targetBranch = String(body.branch || "").trim() || gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!validateBranchName(path, targetBranch)) return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到本地分支" });
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const branches = listRemoteBranches(path, remote);
      const remoteBranch = chooseRemoteBranch(path, remote, targetBranch, branches, requestedRemoteBranch);
      if (!remoteBranch) return c.json({ ok: false, code: "REMOTE_BRANCH_MISSING", remote, targetBranch, branches, message: `远程 ${remote} 没有可用的目标分支` });
      const config = await readConfig(ctx);
      const pullMode = ["merge", "rebase", "ff-only"].includes(body.mode) ? body.mode : (["merge", "rebase", "ff-only"].includes(config.pullMode) ? config.pullMode : "merge");
      const pullArgs = ["pull"];
      if (pullMode === "rebase") pullArgs.push("--rebase");
      else if (pullMode === "ff-only") pullArgs.push("--ff-only");
      else pullArgs.push("--no-rebase");
      pullArgs.push(remote, remoteBranch);
      const raw = gitExecFile(path, pullArgs, { timeout: 120000 });
      const alreadyUpToDate = raw.includes("Already up to date") || raw.includes("Already-up-to-date");
      return c.json({ ok: true, mode: pullMode, remote, remoteBranch, targetBranch, message: alreadyUpToDate ? "已经是最新" : `已从 ${remote}/${remoteBranch} 拉取到 ${targetBranch}` });
    } catch (e) {
      const stderr = commandErrorText(e);
      const errLine = stderr.split("\n").find(l => l.includes("error:") || l.includes("fatal:"));
      return c.json({ ok: false, message: errLine ? errLine.replace(/^(error:|fatal:)\s*/, "").trim() : "拉取失败" });
    }
  });

  // ======== API: 推送 ========
  app.post("/api/push", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const requestedBranch = String(body.branch || "").trim();
    const force = body.force === true;
    const expectedRemoteHash = String(body.expectedRemoteHash || "").trim();
    try {
      const names = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const settings = await readRemoteSettings(ctx, path, names);
      const remote = String(body.remote || settings.pushRemote || "").trim();
      if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "当前没有可用的默认推送远程，请先在远程卡片中设置" });
      const actualBranch = requestedBranch || gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!validateBranchName(path, actualBranch)) return c.json({ ok: false, message: "当前分支名无效" });
      const config = await readConfig(ctx);
      const pushMode = ["normal", "force-with-lease", "force"].includes(body.mode) ? body.mode : (["normal", "force-with-lease", "force"].includes(config.pushMode) ? config.pushMode : "normal");

      // 推送前先获取远程状态。确认覆盖必须绑定到用户确认时看到的远程 hash。
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const remoteRef = `${remote}/${actualBranch}`;
      let remoteHash = "";
      try { remoteHash = gitExecFile(path, ["rev-parse", remoteRef], { timeout: 10000 }); } catch {}
      if (remoteHash) {
        const counts = gitExecFile(path, ["rev-list", "--left-right", "--count", `${remoteRef}...${actualBranch}`], { timeout: 10000 }).split(/\s+/).map(Number);
        const behind = Number.isFinite(counts[0]) ? counts[0] : 0;
        const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
        if (behind > 0 && !force) {
          const commits = parseCommitList(gitExecFile(path, ["log", "--format=%H|%s", "-n", "20", `${actualBranch}..${remoteRef}`], { timeout: 10000 }))
            .map((item) => ({ hash: item.hash.slice(0, 12), subject: item.subject }));
          const files = parseNameStatus(gitExecFile(path, ["diff", "--name-status", `${actualBranch}..${remoteRef}`], { timeout: 10000 }));
          return c.json({
            ok: false,
            code: "REMOTE_AHEAD",
            requiresConfirmation: true,
            remoteHash,
            ahead,
            behind,
            diverged: ahead > 0,
            branch: actualBranch,
            remote,
            commits,
            files,
            message: ahead > 0 ? "本地与远程已分叉" : "远程包含本地没有的提交",
          });
        }
        if (force && expectedRemoteHash && expectedRemoteHash !== remoteHash) {
          return c.json({ ok: false, code: "REMOTE_CHANGED", message: "确认后远程仓库又发生了变化，请重新检查后再覆盖" });
        }
      }

      const pushArgs = ["push"];
      if (force) {
        // 二次确认后的覆盖只允许安全强推，并锁定用户确认时看到的远程提交。
        pushArgs.push(expectedRemoteHash ? `--force-with-lease=refs/heads/${actualBranch}:${expectedRemoteHash}` : "--force-with-lease");
      } else if (pushMode === "force") pushArgs.push("--force");
      else if (pushMode === "force-with-lease") pushArgs.push("--force-with-lease");
      pushArgs.push(remote, `${actualBranch}:${actualBranch}`);
      const raw = gitExecFile(path, pushArgs, { timeout: 120000 });
      const upToDate = raw.includes("up-to-date") || raw.includes("Everything up-to-date");
      return c.json({ ok: true, mode: force ? "force-with-lease" : pushMode, message: upToDate ? "没有新提交需要推送" : (force ? "已按本地版本覆盖远程" : "推送成功") });
    } catch (e) {
      const stderr = commandErrorText(e);
      let cn = "";
      if (stderr.includes("non-fast-forward")) cn = "推送被拒绝：远程包含本地没有的提交";
      else if (stderr.includes("Could not read from remote")) cn = "无法连接远程仓库，请检查网络或仓库地址";
      else if (stderr.includes("Repository not found")) cn = "远程仓库不存在，请检查仓库地址";
      else if (stderr.includes("Permission denied")) cn = "权限不足，请检查 GitHub 登录状态";
      else if (stderr.includes("unable to access")) cn = "无法访问远程仓库，请检查网络连接";
      else {
        const errLine = stderr.split("\n").find(l => l.includes("error:") || l.includes("fatal:"));
        cn = errLine ? "推送失败：" + errLine.replace(/^(error:|fatal:)\s*/, "").trim() : "推送失败";
      }
      return c.json({ ok: false, message: cn });
    }
  });

  // ======== API: 用当前本地分支安全覆盖指定远程分支 ========
  app.post("/api/remote-overwrite", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "").trim();
    const requestedLocalBranch = String(body.branch || "").trim();
    const requestedRemoteBranch = String(body.remoteBranch || "").trim();
    const expectedRemoteHash = String(body.expectedRemoteHash || "").trim();
    const expectedLocalHash = String(body.expectedLocalHash || "").trim();
    const confirmed = body.confirmed === true;
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });
    if (requestedLocalBranch && !validateBranchName(path, requestedLocalBranch)) return c.json({ ok: false, message: "本地分支名无效" });
    if (requestedRemoteBranch && !validateBranchName(path, requestedRemoteBranch)) return c.json({ ok: false, message: "远程分支名无效" });

    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const names = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!names.includes(remote)) return c.json({ ok: false, message: `远程 ${remote} 不存在` });
      const settings = await readRemoteSettings(ctx, path, names);
      const isFetchOnly = settings.fetchRemote === remote && settings.pushRemote !== remote;
      if (isFetchOnly) {
        return c.json({
          ok: false,
          code: "REMOTE_OVERWRITE_PROTECTED",
          protectedRole: "update-source",
          remote,
          pushRemote: settings.pushRemote,
          fetchRemote: settings.fetchRemote,
          message: `远程 ${remote} 当前是默认获取来源，只允许获取或合并更新，不能覆盖远程分支；请改用 ${settings.pushRemote || "默认推送目标"}`,
        });
      }

      const localBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!localBranch || !validateBranchName(path, localBranch)) return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到本地分支" });
      if (requestedLocalBranch && requestedLocalBranch !== localBranch) {
        return c.json({ ok: false, code: "LOCAL_CHANGED", message: "当前本地分支已变化，请刷新后重新确认" });
      }
      const remoteBranch = requestedRemoteBranch || localBranch;
      if (!validateBranchName(path, remoteBranch)) return c.json({ ok: false, message: "远程分支名无效" });

      // 只更新远程跟踪引用，不修改工作区；覆盖前的远程 hash 由此得到。
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const remoteRef = `refs/remotes/${remote}/${remoteBranch}`;
      let remoteHash = "";
      try { remoteHash = gitExecFile(path, ["rev-parse", "--verify", `${remoteRef}^{commit}`], { timeout: 10000 }); } catch {}
      let localHash = "";
      try { localHash = gitExecFile(path, ["rev-parse", "--verify", `${localBranch}^{commit}`], { timeout: 10000 }); } catch {}
      if (!localHash) return c.json({ ok: false, message: "当前本地分支还没有可推送的提交" });
      const statusShort = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--short"], { timeout: 10000 });
      const dirty = Boolean(statusShort.trim());

      if (!confirmed) {
        return c.json({
          ok: false,
          code: "REMOTE_OVERWRITE_CONFIRM",
          requiresConfirmation: true,
          remote,
          localBranch,
          remoteBranch,
          localHash,
          remoteHash,
          dirty,
          message: remoteHash ? "远程分支已有提交，确认后将由当前本地分支覆盖" : "远程分支尚未建立，确认后将推送当前本地分支",
        });
      }

      if (expectedLocalHash !== localHash || (requestedLocalBranch && requestedLocalBranch !== localBranch)) {
        return c.json({ ok: false, code: "LOCAL_CHANGED", message: "确认后本地分支或提交发生了变化，请重新检查后再覆盖" });
      }
      if (expectedRemoteHash !== remoteHash) {
        return c.json({ ok: false, code: "REMOTE_CHANGED", message: "确认后远程分支又发生了变化，请重新检查后再覆盖" });
      }

      const pushArgs = ["push", `--force-with-lease=refs/heads/${remoteBranch}:${remoteHash}`, remote, `${localBranch}:${remoteBranch}`];
      const raw = gitExecFile(path, pushArgs, { timeout: 120000 });
      const upToDate = raw.includes("up-to-date") || raw.includes("Everything up-to-date");
      return c.json({ ok: true, remote, localBranch, remoteBranch, mode: "force-with-lease", dirty, message: upToDate ? "远程已经与本地一致" : `已用本地 ${localBranch} 覆盖 ${remote}/${remoteBranch}` });
    } catch (e) {
      const stderr = commandErrorText(e);
      const errLine = stderr.split("\n").find(l => l.includes("error:") || l.includes("fatal:"));
      return c.json({ ok: false, message: errLine ? errLine.replace(/^(error:|fatal:)\s*/, "").trim() : `覆盖远程失败：${stderr || "未知错误"}` });
    }
  });
}
