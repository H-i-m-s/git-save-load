// GitHub CLI integration routes.
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function ghEnvironment() {
  const env = { ...process.env };
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  return env;
}

// 定位 gh 可执行文件。插件进程的 PATH 可能不包含 GitHub CLI 安装目录
// （例如仅安装了 GitHub Desktop 或 PATH 被修改过），因此探测常见安装位置并缓存。
let _cachedGhPath = null;
function resolveGhPath() {
  if (_cachedGhPath) return _cachedGhPath;
  const candidates = [
    "gh",
    "C:\\Program Files\\GitHub CLI\\gh.exe",
    join(process.env.LOCALAPPDATA || "", "Programs", "GitHub CLI", "gh.exe"),
    join(process.env.LOCALAPPDATA || "", "GitHubDesktop", "bin", "gh.exe"),
    join(process.env.USERPROFILE || "", ".local", "bin", "gh.exe"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      // 裸命令交给 PATH 解析；绝对路径直接检查存在性
      if (candidate === "gh") {
        execFileSync("gh", ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, env: ghEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      } else if (existsSync(candidate)) {
        execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, env: ghEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      } else {
        continue;
      }
      _cachedGhPath = candidate;
      return candidate;
    } catch {}
  }
  _cachedGhPath = "gh";
  return _cachedGhPath;
}

const LICENSE_OPTIONS = new Set(["MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause", "LGPL-3.0", "MPL-2.0", "Unlicense"]);

function normalizeLicense(value) {
  const license = String(value || "").trim();
  return license && LICENSE_OPTIONS.has(license) ? license : "";
}

function hasHeadCommit(cwd, gitExecFile) {
  try {
    gitExecFile(cwd, ["rev-parse", "--verify", "HEAD"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function getGitIdentity(cwd, gitExecFile) {
  try {
    const name = gitExecFile(cwd, ["config", "user.name"], { timeout: 10000 });
    const email = gitExecFile(cwd, ["config", "user.email"], { timeout: 10000 });
    return name && email ? { name, email } : null;
  } catch {
    return null;
  }
}

function readLicenseFile(cwd, license, ghExec) {
  try {
    const output = ghExec(["repo", "license", "view", license], { timeout: 30000, cwd });
    return output;
  } catch {
    return "";
  }
}

function applyLicenseToLocalRepo(cwd, license, gitExecFile, ghExec) {
  if (!license) return { applied: false, existing: false, committed: false };
  const licensePath = join(cwd, "LICENSE");
  if (existsSync(licensePath)) return { applied: false, existing: true, committed: false };
  const content = readLicenseFile(cwd, license, ghExec);
  if (!content) throw new Error("无法获取许可证模板，请检查 GitHub CLI 是否支持该许可证");
  const identity = getGitIdentity(cwd, gitExecFile);
  if (!identity) throw new Error("当前仓库还没有配置 Git 姓名和邮箱，无法自动提交许可证");
  const year = String(new Date().getFullYear());
  const normalized = content
    .replace(/\[year\]/gi, year)
    .replace(/\[fullname\]/gi, identity.name);
  writeFileSync(licensePath, normalized + "\n", "utf8");
  return { applied: true, existing: false, committed: false };
}

export function registerGitHubRoutes(app, { ctx, gitExecFile, commandErrorText, validateBranchName, isValidRemoteName, isValidRemoteUrl, sanitizeRemoteUrl, readRemoteSettings, readRepoPath }) {
  // ======== API: GitHub 管理 ========
  // gh 自己会读取 GitHub CLI 的登录配置。不要把 Git 的用户级代理强行注入 gh，
  // 否则可能与 gh 的网络实现或本机代理状态冲突，导致 GraphQL 返回 EOF。
  function ghExec(args, opts = {}) {
    const env = ghEnvironment();
    const options = {
      encoding: "utf8",
      timeout: opts.timeout || 30000,
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (opts.cwd) options.cwd = opts.cwd;
    return execFileSync(resolveGhPath(), args, options).trim();
  }

  app.post("/api/gh/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const privacy = body.private ? "--private" : "--public";
    const description = String(body.description || "").trim();
    const license = normalizeLicense(body.license);
    const localPath = String(body.localPath || "").trim();
    if (!name) return c.json({ ok: false, message: "请输入仓库名" });

    try {
      let localLicense = { applied: false, existing: false, committed: false };
      let localHasCommit = false;
      if (localPath) {
        gitExecFile(localPath, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
        localHasCommit = hasHeadCommit(localPath, gitExecFile);
        if (license && localHasCommit) {
          localLicense = applyLicenseToLocalRepo(localPath, license, gitExecFile, ghExec);
          if (localLicense.applied) {
            const status = gitExecFile(localPath, ["status", "--porcelain", "--", "LICENSE"], { timeout: 10000 });
            if (status) {
              gitExecFile(localPath, ["add", "--", "LICENSE"], { timeout: 10000 });
              gitExecFile(localPath, ["commit", "-m", `chore: add ${license} license`], { timeout: 30000 });
              localLicense.committed = true;
            }
          }
        }
      }

      const args = ["repo", "create", name, privacy];
      if (description) args.push("--description", description);
      // 已有本地提交时，许可证已经在本地生成并提交，远程必须保持空初始化，避免产生分叉。
      if (license && !localHasCommit) args.push("--license", license);
      const url = ghExec(args);

      if (localPath) {
        try {
          const existingRemotes = gitExecFile(localPath, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
          const remoteSettings = await readRemoteSettings(ctx, localPath, existingRemotes);
          const targetRemote = remoteSettings.pushRemote || "origin";
          try {
            gitExecFile(localPath, ["remote", "get-url", targetRemote], { timeout: 10000 });
            gitExecFile(localPath, ["remote", "set-url", targetRemote, url], { timeout: 10000 });
          } catch {
            gitExecFile(localPath, ["remote", "add", targetRemote, url], { timeout: 10000 });
          }
          if (localHasCommit) {
            const branch = gitExecFile(localPath, ["branch", "--show-current"], { timeout: 10000 });
            if (branch && validateBranchName(localPath, branch)) {
              gitExecFile(localPath, ["push", "--set-upstream", targetRemote, `${branch}:${branch}`], { timeout: 120000 });
            }
          }
        } catch (e) {
          return c.json({ ok: false, url, license, message: `GitHub 仓库已创建，但本地关联或首次推送失败：${commandErrorText(e)}` });
        }
      }
      const details = localLicense.committed ? `，已在本地提交 ${license} 许可证` : (license ? `，已选择 ${license} 许可证` : "");
      return c.json({ ok: true, url, license, localLicense, message: `已创建并关联：${url}${details}` });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "创建失败" }); }
  });

  app.post("/api/gh/clone", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url || "").trim();
    const dir = String(body.dir || "").trim();
    if (!url) return c.json({ ok: false, message: "请输入仓库 URL" });
    if (!isValidRemoteUrl(url)) return c.json({ ok: false, message: "仓库 URL 格式不正确" });
    try {
      const args = ["repo", "clone", url];
      if (dir) args.push(dir);
      ghExec(args, { timeout: 120000 });
      return c.json({ ok: true, message: "克隆成功" });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "克隆失败" }); }
  });

  app.get("/api/gh/list", async (c) => {
    const owner = String(c.req.query("owner") || "").trim();
    try {
      const args = ["repo", "list"];
      if (owner) args.push(owner);
      args.push("--limit", "30", "--json", "name,owner,description,url,isPrivate,updatedAt,licenseInfo");
      const raw = ghExec(args);
      const repos = JSON.parse(raw);
      let viewerLogin = "";
      try { viewerLogin = ghExec(["api", "user", "--jq", ".login"]); } catch {}
      return c.json({ ok: true, repos, viewerLogin });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "获取仓库列表失败" }); }
  });

  app.post("/api/gh/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定仓库名" });
    if (!body.confirmed) return c.json({ ok: false, code: "CONFIRM_REQUIRED", message: "删除 GitHub 仓库需要二次确认" });
    try {
      ghExec(["repo", "delete", name, "--yes"]);
      return c.json({ ok: true, message: `已删除：${name}` });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "删除失败" }); }
  });

  // ======== API: 编辑 GitHub 仓库（改名 / 描述 / 可见性 / 许可证） ========
  app.post("/api/gh/edit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const newName = String(body.newName || "").trim();
    // description 为 null 表示不修改；为字符串（可能为空）表示明确设置/清空
    const description = (body.description === null || body.description === undefined) ? null : String(body.description);
    const visibility = String(body.visibility || "").trim();
    const license = normalizeLicense(body.license);

    if (!name) return c.json({ ok: false, message: "请指定仓库名" });
    if (!name.includes("/")) return c.json({ ok: false, message: "请使用 owner/repo 格式指定仓库" });
    const repoBase = name.split("/").pop() || "";
    if (!/^[A-Za-z0-9_.-]+$/.test(repoBase)) return c.json({ ok: false, message: "仓库名格式不正确" });
    if (newName && !/^[A-Za-z0-9_.-]+$/.test(newName)) return c.json({ ok: false, message: "新仓库名只能包含字母、数字、横线、下划线和点" });
    if (visibility && !["public", "private"].includes(visibility)) return c.json({ ok: false, message: "可见性只能是 public 或 private" });

    try {
      const parts = name.split("/");
      const owner = parts[0];
      const repo = parts.length > 1 ? parts.slice(1).join("/") : name;
      let current = name;
      const actions = [];

      // 1. 描述 / 可见性（用当前仓库名）
      if (description !== null || visibility) {
        const args = ["repo", "edit", current];
        if (description !== null) args.push("--description", description);
        if (visibility) {
          args.push("--visibility", visibility);
          // gh 要求改可见性时必须显式接受后果
          args.push("--accept-visibility-change-consequences");
        }
        ghExec(args);
        actions.push("描述/可见性");
      }

      // 2. 改名（改名后后续操作统一用新名）
      let localRemote = null;
      if (newName && newName !== repo) {
        ghExec(["repo", "rename", newName, "--repo", current]);
        current = `${owner}/${newName}`;
        actions.push("仓库名");
        // 检测插件配置的本地仓库是否关联了被改名的远程（匹配 owner/repo 后缀）
        try {
          const localPath = await readRepoPath(ctx);
          if (localPath) {
            const remotes = gitExecFile(localPath, ["remote"], { timeout: 10000 });
            const oldSuffix = `${owner}/${repo}`;
            for (const rn of remotes.split("\n").filter(Boolean)) {
              let url = "";
              try { url = gitExecFile(localPath, ["remote", "get-url", rn], { timeout: 10000 }); } catch {}
              if (url && url.includes(oldSuffix)) {
                localRemote = { localPath, remote: rn, oldUrl: sanitizeRemoteUrl(url), newUrl: sanitizeRemoteUrl(url.replace(oldSuffix, `${owner}/${newName}`)) };
                break;
              }
            }
          }
        } catch {}
      }

      // 3. 许可证：GitHub 仓库的许可证由仓库内的 LICENSE 文件决定，
      //    通过 contents API 直接写入/更新 LICENSE 文件。
      if (license) {
        let branch = "main";
        try { branch = ghExec(["api", `repos/${current}`, "--jq", ".default_branch"]); } catch {}
        const raw = readLicenseFile(process.cwd(), license, ghExec);
        if (!raw) throw new Error(`无法获取 ${license} 许可证模板，请检查 GitHub CLI 支持情况`);
        const year = String(new Date().getFullYear());
        const normalized = raw
          .replace(/\[year\]/gi, year)
          .replace(/\[fullname\]/gi, owner);
        const content64 = Buffer.from(normalized, "utf8").toString("base64");
        let sha = "";
        try { sha = ghExec(["api", `repos/${current}/contents/LICENSE`, "--jq", ".sha"]); } catch {}
        const putArgs = [
          "api", "-X", "PUT", `repos/${current}/contents/LICENSE`,
          "-f", `message=chore: update license to ${license}`,
          "-f", `content=${content64}`,
          "-f", `branch=${branch}`,
        ];
        if (sha) putArgs.push("-f", `sha=${sha}`);
        ghExec(putArgs);
        actions.push("许可证");
      }

      return c.json({ ok: true, name: current, actions, localRemote, message: `已更新：${actions.length ? actions.join("、") : "未修改任何内容"}` });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "编辑仓库失败" }); }
  });

  // ======== API: 同步本地仓库的远程地址（仓库改名后） ========
  app.post("/api/gh/sync-local-remote", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const localPath = String(body.localPath || "").trim();
    const remote = String(body.remote || "").trim();
    const newUrl = String(body.newUrl || "").trim();
    if (!localPath || !remote || !newUrl) return c.json({ ok: false, message: "参数不完整" });
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });
    if (!isValidRemoteUrl(newUrl)) return c.json({ ok: false, message: "远程地址格式不正确" });
    try {
      gitExecFile(localPath, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const names = gitExecFile(localPath, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const settings = await readRemoteSettings(ctx, localPath, names);
      const targetRemote = names.includes(remote) ? remote : (settings.fetchRemote || remote);
      gitExecFile(localPath, ["remote", "set-url", targetRemote, newUrl], { timeout: 10000 });
      return c.json({ ok: true, remote: targetRemote, message: `已同步本地远程地址（${targetRemote}）` });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "同步失败" }); }
  });

  app.get("/api/gh/search", async (c) => {
    const q = String(c.req.query("q") || "").trim();
    if (!q) return c.json({ ok: true, repos: [] });
    try {
      const raw = ghExec(["search", "repos", q, "--limit", "20", "--json", "name,owner,description,url,isPrivate,updatedAt,licenseInfo"]);
      const repos = JSON.parse(raw);
      return c.json({ ok: true, repos });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "搜索仓库失败" }); }
  });

  // ======== API: 将当前本地仓库关联到已有远程仓库 ========
  app.post("/api/gh/connect", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const localPath = String(body.localPath || "").trim();
    const remoteUrl = String(body.remoteUrl || "").trim();
    const remote = String(body.remote || "origin").trim() || "origin";

    if (!localPath) return c.json({ ok: false, message: "请先选择本地仓库" });
    if (!remoteUrl || !isValidRemoteUrl(remoteUrl)) return c.json({ ok: false, message: "GitHub 仓库 URL 格式不正确" });
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });

    try {
      gitExecFile(localPath, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      let previousUrl = "";
      try { previousUrl = gitExecFile(localPath, ["remote", "get-url", remote], { timeout: 10000 }); } catch {}
      if (previousUrl && !body.confirmed) {
        return c.json({ ok: false, code: "REMOTE_REPLACE_CONFIRM", requiresConfirmation: true, remote, previousUrl: sanitizeRemoteUrl(previousUrl), nextUrl: sanitizeRemoteUrl(remoteUrl), message: "当前远程名称已经存在，需要确认是否替换" });
      }
      if (previousUrl) {
        gitExecFile(localPath, ["remote", "set-url", remote, remoteUrl], { timeout: 10000 });
      } else {
        gitExecFile(localPath, ["remote", "add", remote, remoteUrl], { timeout: 10000 });
      }
      gitExecFile(localPath, ["fetch", "--prune", remote], { timeout: 120000 });
      let currentBranch = "";
      try { currentBranch = gitExecFile(localPath, ["branch", "--show-current"], { timeout: 10000 }); } catch {}
      return c.json({
        ok: true,
        remote,
        remoteUrl: sanitizeRemoteUrl(remoteUrl),
        previousUrl: sanitizeRemoteUrl(previousUrl),
        branch: currentBranch,
        message: previousUrl ? "已更新远程仓库关联" : "已关联远程仓库",
      });
    } catch (e) {
      return c.json({ ok: false, message: `关联失败：${commandErrorText(e) || "无法访问远程仓库"}` });
    }
  });
}
