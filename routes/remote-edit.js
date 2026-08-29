// Atomic remote rename / URL edit route with confirmation tokens.
import { createHash } from "node:crypto";

export function registerRemoteEditRoutes(app, { ctx, repoPath, gitExecFile, commandErrorText, readConfig, writeConfig, readRemoteSettings, writeRemoteSettings, isValidRemoteName, isValidRemoteUrl, sanitizeRemoteUrl, configuredRemoteUrls, getGitOperationState }) {
  function restoreConfiguredRemoteUrls(cwd, remote, urls, push = false) {
    const key = `remote.${remote}.${push ? "pushurl" : "url"}`;
    try { gitExecFile(cwd, ["config", "--unset-all", key], { timeout: 10000 }); } catch {}
    for (const url of urls) gitExecFile(cwd, ["config", "--add", key, url], { timeout: 10000 });
  }

  function hashRemoteEditValue(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  function remoteEditRevision(names, remote, fetchUrls, pushUrls, settings) {
    const roles = {};
    Object.keys(settings?.roles || {}).sort().forEach((name) => { roles[name] = settings.roles[name]; });
    return hashRemoteEditValue({
      names: [...names].sort(),
      remote,
      fetchUrls: [...fetchUrls],
      pushUrls: [...pushUrls],
      settings: {
        pushRemote: settings?.pushRemote || "",
        fetchRemote: settings?.fetchRemote || "",
        roles,
      },
    });
  }

  function remoteEditToken(revision, oldRemote, newRemote, newUrl, newPushUrl, clearPushUrl) {
    return hashRemoteEditValue({ revision, oldRemote, newRemote, newUrl, newPushUrl, clearPushUrl: Boolean(clearPushUrl) });
  }

  function remoteUrlList(cwd, remote, push = false) {
    try {
      const args = ["remote", "get-url"];
      if (push) args.push("--push");
      args.push("--all", remote);
      return gitExecFile(cwd, args, { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function readRemoteEditState(ctx, path, remote) {
    gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
    const names = gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!names.includes(remote)) throw new Error(`远程 ${remote} 不存在`);
    const fetchUrls = configuredRemoteUrls(path, remote, false);
    const pushUrls = configuredRemoteUrls(path, remote, true);
    const fetchEffectiveUrls = fetchUrls.length ? fetchUrls : remoteUrlList(path, remote, false);
    const pushEffectiveUrls = pushUrls.length ? pushUrls : remoteUrlList(path, remote, true);
    const oldFetchUrl = fetchEffectiveUrls[0] || "";
    const oldPushUrl = pushEffectiveUrls[0] || oldFetchUrl;
    const settings = await readRemoteSettings(ctx, path, names);
    const revision = remoteEditRevision(names, remote, fetchUrls, pushUrls, settings);
    return { names, fetchUrls, pushUrls, fetchEffectiveUrls, pushEffectiveUrls, oldFetchUrl, oldPushUrl, settings, revision };
  }

  // ======== API: 原子修改本地远程名称和地址 ========
  app.post("/api/remote-edit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const oldRemote = String(body.oldRemote || "").trim();
    const newRemote = String(body.newRemote || oldRemote).trim();
    const newUrl = String(body.newUrl || "").trim();
    const newPushUrl = String(body.newPushUrl || "").trim();
    const clearPushUrl = body.clearPushUrl === true;
    if (!isValidRemoteName(oldRemote) || !isValidRemoteName(newRemote)) return c.json({ ok: false, message: "远程名称格式不正确" });
    if (newUrl && !isValidRemoteUrl(newUrl)) return c.json({ ok: false, message: "新的获取地址格式不正确" });
    if (newPushUrl && !isValidRemoteUrl(newPushUrl)) return c.json({ ok: false, message: "新的推送地址格式不正确" });
    if (newPushUrl && clearPushUrl) return c.json({ ok: false, message: "不能同时填写新的推送地址并清除独立推送地址" });
    if (oldRemote !== newRemote && oldRemote.toLowerCase() === newRemote.toLowerCase()) return c.json({ ok: false, message: "新旧远程名称不能只改变大小写" });

    let renamed = false;
    let gitChanged = false;
    let originalConfig = null;
    let oldFetchUrls = [];
    let oldPushUrls = [];
    let oldFetchEffective = "";
    let oldPushEffective = "";
    let settings = null;
    let revision = "";
    try {
      const operationState = getGitOperationState(path);
      if (operationState) return c.json({ ok: false, code: "GIT_OPERATION_IN_PROGRESS", message: `当前 Git 正在进行 ${operationState} 操作，请先完成或终止它` });
      const state = await readRemoteEditState(ctx, path, oldRemote);
      const names = state.names;
      if (oldRemote !== newRemote && names.includes(newRemote)) return c.json({ ok: false, code: "REMOTE_NAME_EXISTS", message: `远程 ${newRemote} 已经存在，请换一个名称` });
      oldFetchUrls = state.fetchUrls;
      oldPushUrls = state.pushUrls;
      oldFetchEffective = state.oldFetchUrl;
      oldPushEffective = state.oldPushUrl;
      settings = state.settings;
      revision = state.revision;
      originalConfig = await readConfig(ctx);
      const fetchChanged = Boolean(newUrl);
      const pushChanged = Boolean(newPushUrl) || clearPushUrl;
      const effectiveNewUrl = newUrl || oldFetchEffective;
      const effectiveNewPushUrl = newPushUrl || (clearPushUrl ? "" : oldPushEffective);
      if (!effectiveNewUrl || !isValidRemoteUrl(effectiveNewUrl)) return c.json({ ok: false, message: "当前获取地址无法读取，请输入新的获取地址" });
      if (clearPushUrl && !oldPushUrls.length) return c.json({ ok: false, message: "当前远程没有独立推送地址可清除" });
      const confirmationToken = remoteEditToken(revision, oldRemote, newRemote, newUrl, newPushUrl, clearPushUrl);

      if (body.confirmed !== true) {
        return c.json({
          ok: false,
          code: "REMOTE_EDIT_CONFIRM",
          requiresConfirmation: true,
          oldRemote,
          newRemote,
          oldUrl: sanitizeRemoteUrl(oldFetchEffective),
          oldPushUrl: sanitizeRemoteUrl(oldPushEffective),
          fetchChanged,
          pushChanged,
          clearPushUrl,
          newUrl: sanitizeRemoteUrl(effectiveNewUrl),
          newPushUrl: sanitizeRemoteUrl(effectiveNewPushUrl),
          revision,
          confirmationToken,
          pushRemote: settings.pushRemote,
          fetchRemote: settings.fetchRemote,
          role: settings.roles[oldRemote] || "other",
          message: "将一次性更新本地远程名称和地址，并验证新的获取/推送地址",
        });
      }
      if (body.expectedRevision !== revision || body.confirmationToken !== confirmationToken) {
        return c.json({ ok: false, code: "REMOTE_CHANGED", requiresReconfirmation: true, message: "远程配置在确认期间发生了变化，请刷新后重新确认" });
      }

      if (oldRemote !== newRemote) {
        gitExecFile(path, ["remote", "rename", oldRemote, newRemote], { timeout: 10000 });
        renamed = true;
        gitChanged = true;
      }
      const activeRemote = newRemote;
      if (fetchChanged) {
        gitChanged = true;
        gitExecFile(path, ["remote", "set-url", activeRemote, effectiveNewUrl], { timeout: 10000 });
      }
      if (newPushUrl) {
        restoreConfiguredRemoteUrls(path, activeRemote, [newPushUrl], true);
        gitChanged = true;
      } else if (clearPushUrl) {
        restoreConfiguredRemoteUrls(path, activeRemote, [], true);
        gitChanged = true;
      }

      if (fetchChanged) {
        try {
          gitExecFile(path, ["ls-remote", "--heads", activeRemote], { timeout: 120000 });
        } catch (verifyError) {
          throw Object.assign(new Error(`新的获取地址验证失败：${commandErrorText(verifyError) || "无法访问远程仓库"}`), { code: "REMOTE_FETCH_URL_VERIFY_FAILED" });
        }
      }
      if (newPushUrl) {
        try {
          gitExecFile(path, ["ls-remote", "--heads", newPushUrl], { timeout: 120000 });
        } catch (verifyError) {
          throw Object.assign(new Error(`新的推送地址验证失败：${commandErrorText(verifyError) || "无法访问远程仓库"}`), { code: "REMOTE_PUSH_URL_VERIFY_FAILED" });
        }
      }

      const nextSettings = {
        pushRemote: settings.pushRemote === oldRemote ? newRemote : settings.pushRemote,
        fetchRemote: settings.fetchRemote === oldRemote ? newRemote : settings.fetchRemote,
        roles: { ...settings.roles },
      };
      if (oldRemote !== newRemote && Object.prototype.hasOwnProperty.call(nextSettings.roles, oldRemote)) {
        nextSettings.roles[newRemote] = nextSettings.roles[oldRemote];
        delete nextSettings.roles[oldRemote];
      }
      await writeRemoteSettings(ctx, path, nextSettings);
      return c.json({
        ok: true,
        oldRemote,
        newRemote,
        oldUrl: sanitizeRemoteUrl(oldFetchEffective),
        oldPushUrl: sanitizeRemoteUrl(oldPushEffective),
        newUrl: sanitizeRemoteUrl(effectiveNewUrl),
        pushUrl: sanitizeRemoteUrl(newPushUrl || (clearPushUrl ? effectiveNewUrl : oldPushEffective)),
        pushRemote: nextSettings.pushRemote,
        fetchRemote: nextSettings.fetchRemote,
        role: nextSettings.roles[newRemote] || "other",
        message: oldRemote === newRemote
          ? ((fetchChanged || pushChanged) ? `已更新远程 ${newRemote} 的地址` : `已保留远程 ${newRemote} 的配置`)
          : ((fetchChanged || pushChanged) ? `已将远程 ${oldRemote} 修改为 ${newRemote}` : `已将远程 ${oldRemote} 重命名为 ${newRemote}`),
      });
    } catch (e) {
      let rollbackError = "";
      try {
        if (gitChanged) {
          if (renamed) gitExecFile(path, ["remote", "rename", newRemote, oldRemote], { timeout: 10000 });
          restoreConfiguredRemoteUrls(path, oldRemote, oldFetchUrls.length ? oldFetchUrls : (oldFetchEffective ? [oldFetchEffective] : []), false);
          restoreConfiguredRemoteUrls(path, oldRemote, oldPushUrls, true);
        }
        if (originalConfig) await writeConfig(ctx, originalConfig);
      } catch (rollbackErrorValue) {
        rollbackError = commandErrorText(rollbackErrorValue) || rollbackErrorValue.message || "回滚失败";
      }
      const prefix = e.code === "REMOTE_FETCH_URL_VERIFY_FAILED" ? "新的获取地址验证失败" : (e.code === "REMOTE_PUSH_URL_VERIFY_FAILED" ? "新的推送地址验证失败" : "修改远程失败");
      return c.json({ ok: false, code: e.code || "REMOTE_EDIT_FAILED", rolledBack: !rollbackError, message: `${prefix}，${rollbackError ? `回滚也失败：${rollbackError}` : "已恢复原远程配置"}：${commandErrorText(e) || e.message || "未知错误"}` });
    }
  });
}
