// git-tools / routes / git.js
// 公共函数/依赖装配 + 各模块注册。
// v2：页面与静态资源改由宿主 ui/ 树提供（/api/apps/<appId>/ui/*），本文件不再
// serve HTML 与资产，只保留 /api/* 业务路由。
// 各功能路由已按职责拆分到 routes/*.js，本文件不再定义业务端点。

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execSync, execFileSync, execFile } from "node:child_process";

import { readConfig, writeConfig, readRepoPath, writeRepoPath, validateConfigPatch, registerConfigRoutes } from "./config.js";
import { registerLocalGitRoutes } from "./local-git.js";
import { registerHistoryRoutes } from "./history.js";
import { registerHistoryEditRoutes } from "./history-edit.js";
import { registerDiffConflictRoutes } from "./diff-conflicts.js";
import { registerRepositoryRoutes } from "./repository.js";
import { registerGitHubRoutes } from "./github.js";
import { registerRemoteEditRoutes } from "./remote-edit.js";
import { registerRemoteQueryRoutes } from "./remote-query.js";
import { registerRemoteSyncRoutes } from "./remote-sync.js";
import { registerBranchRoutes } from "./branch.js";
import { registerRemotePushRoutes } from "./remote-push.js";
import { registerStashRoutes } from "./stash.js";
import { registerMiscRoutes } from "./misc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, "..");

// Node Permission Model 下，existsSync 对安装目录/dataDir 之外的路径会直接抛
// ERR_ACCESS_DENIED（不是返回 false）。探测类调用统一走 safeExists。
function safeExists(p) {
  try { return existsSync(p); } catch { return false; }
}

function gitPathExists(cwd, name) {
  try {
    const gitPath = gitExecFile(cwd, ["rev-parse", "--git-path", name], { timeout: 10000 });
    return safeExists(resolve(cwd, gitPath));
  } catch {
    return false;
  }
}

// 仓库内 .git 状态文件的存在性检查在 v2 走宿主 ResourceIO 门（app/resources.read），
 // 由 export default 里用 ctx.resources.stat 构造后注入；默认退回 safeExists。
async function getGitOperationState(cwd, pathExists = safeExists) {
  const names = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
    "BISECT_LOG",
  ];
  for (const name of names) {
    let gitPath = "";
    try {
      gitPath = gitExecFile(cwd, ["rev-parse", "--git-path", name], { timeout: 10000 });
    } catch { continue; }
    if (!gitPath) continue;
    if (await pathExists(resolve(cwd, gitPath))) return name;
  }
  return "";
}

// 缓存用户级代理环境变量，避免每次 git 调用都查询 Windows 注册表
let _cachedUserProxy = null;
function getUserProxy() {
  if (_cachedUserProxy) return _cachedUserProxy;
  _cachedUserProxy = {};
  try {
    // 必须带 -NoProfile：否则 Windows PowerShell 会先加载用户 profile（例如 conda init 块），
    // 连带拉起 conda/python，并把新建的控制台交给 Windows Terminal，弹出多余窗口。
    // 用 -NoLogo 去横幅，命令串内只用单引号，避免 Node 传参时与 PowerShell 的引号解析打架。
    const userHttps = execFileSync("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", "[System.Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'User')"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    const userHttp = execFileSync("powershell.exe", ["-NoProfile", "-NoLogo", "-Command", "[System.Environment]::GetEnvironmentVariable('HTTP_PROXY', 'User')"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (userHttps) _cachedUserProxy.HTTPS_PROXY = userHttps;
    if (userHttp) _cachedUserProxy.HTTP_PROXY = userHttp;
  } catch {}
  return _cachedUserProxy;
}

// 执行 git 命令的辅助函数
function gitEnv() {
  const env = { ...process.env, ...getUserProxy() };
  // Windows 上 HOME 通常未设置，OpenSSH 靠它找 .ssh/config 和 known_hosts
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  // 当 PATH 解析不到 git 时，把探测到的安装目录补进去（仅此时注入，避免版本不一致）
  const gitDir = resolveGitDir();
  if (gitDir) env.PATH = gitDir + (env.PATH ? ";" + env.PATH : "");
  return env;
}

// 定位 git 可执行文件所在目录并缓存。
// 仅当 PATH 本身无法解析 git（ENOENT）时才探测常见安装位置。
let _cachedGitDir = null;
function resolveGitDir() {
  if (_cachedGitDir !== null) return _cachedGitDir;
  // 先看 PATH 是否已有 git（用无注入的环境探测，避免递归）
  try {
    const bare = { ...process.env };
    if (!bare.HOME && bare.USERPROFILE) bare.HOME = bare.USERPROFILE;
    execFileSync("git", ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, env: bare, stdio: ["ignore", "pipe", "pipe"] });
    _cachedGitDir = "";
    return "";
  } catch {}
  // PATH 里没有，探测常见安装位置
  const candidates = [
    "C:\\Program Files\\Git\\cmd",
    join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd"),
    join(process.env.LOCALAPPDATA || "", "Programs", "HanaAgent", "resources", "git", "cmd"),
    join(process.env.LOCALAPPDATA || "", "GitHubDesktop", "bin"),
    join(process.env.USERPROFILE || "", "scoop", "apps", "git", "current", "cmd"),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const exe = join(dir, "git.exe");
    if (!safeExists(exe)) continue;
    try {
      execFileSync(exe, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
      _cachedGitDir = dir;
      return dir;
    } catch {}
  }
  _cachedGitDir = "";
  return "";
}

// 返回 git 可执行文件的绝对路径；PATH 可用时返回 "git" 交给系统解析
// resolveExecutable（宿主侧探测）的结果通过 setGitExecutableOverride 注入优先使用。
let _gitExecutableOverride = "";
function setGitExecutableOverride(absPath) {
  const value = String(absPath || "").trim();
  if (value) _gitExecutableOverride = value;
}
function resolveGitPath() {
  if (_gitExecutableOverride) return _gitExecutableOverride;
  const dir = resolveGitDir();
  return dir ? join(dir, "git.exe") : "git";
}

// Git 调用统一使用参数数组，避免用户输入经过 shell 解释。
// 对用户输入敏感的 Git 调用使用 execFileSync，避免经过 shell 解释。
function gitExecFile(cwd, args, opts = {}) {
  const timeout = opts.timeout || 60000;
  return execFileSync(resolveGitPath(), args, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    // 与异步版 gitExecFileAsync 保持一致：大仓库单次提交可能包含数千文件，
    // git log --numstat 输出可超 1MB（Node 默认 maxBuffer），不足时报 ENOBUFS。
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  }).trim();
}

// 异步版本：与 gitExecFile 同参，但不阻塞事件循环，供热点读路径并行执行。
// 多个请求并发到达时，同步版本会在事件循环上排队串行，这是历史列表/状态刷新
// 观感慢的根源；异步版本让 git 子进程真正并行。
function gitExecFileAsync(cwd, args, opts = {}) {
  const timeout = opts.timeout || 60000;
  return new Promise((resolveP, rejectP) => {
    execFile(resolveGitPath(), args, {
      cwd,
      encoding: "utf8",
      timeout,
      windowsHide: true,
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) rejectP(err);
      else resolveP(String(stdout || "").trim());
    });
  });
}

// 历史重写需要在不打开外部编辑器的情况下为 Git 注入临时编辑器环境。
function gitExecFileWithEnv(cwd, args, extraEnv = {}, opts = {}) {
  const timeout = opts.timeout || 60000;
  return execFileSync(resolveGitPath(), args, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: { ...gitEnv(), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  }).trim();
}

function commandErrorText(error) {
  const parts = [error?.stderr, error?.stdout, error?.message];
  return parts
    .filter(Boolean)
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value))
    .join("\n")
    .trim();
}

function isValidRemoteName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function isValidRemoteUrl(url) {
  return /^(?:https?|ssh|file):\/\/[^\s]+$/.test(url) || /^git@[^\s:]+:[^\s]+$/.test(url);
}

function configuredRemoteUrls(cwd, remote, push = false) {
  try {
    const key = `remote.${remote}.${push ? "pushurl" : "url"}`;
    return gitExecFile(cwd, ["config", "--get-all", key], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function sanitizeRemoteUrl(value) {
  const url = String(value || "").trim();
  if (!url) return "";
  // SCP-like SSH 地址中的 git 是协议固定用户，不是凭据；保留它有助于识别和回填 GitHub SSH 地址。
  const scp = url.match(/^([^@\s]+)@([^:\s]+):(.+)$/);
  if (scp) {
    const user = scp[1];
    const host = scp[2];
    const path = scp[3];
    return user.toLowerCase() === "git" ? `git@${host}:${path}` : `***@${host}:${path}`;
  }
  try {
    if (/^(?:https?|ssh):\/\//i.test(url)) {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        if (parsed.username.toLowerCase() === "git" && !parsed.password) parsed.username = "git";
        else {
          parsed.username = "***";
          parsed.password = "";
        }
      }
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {}
  return url;
}

function listRemoteBranches(cwd, remote) {
  try {
    const raw = gitExecFile(cwd, ["for-each-ref", "--format=%(refname:strip=3)", `refs/remotes/${remote}`], { timeout: 10000 });
    return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).filter(name => name !== "HEAD");
  } catch {
    return [];
  }
}

function getRemoteHeadBranch(cwd, remote, branches) {
  try {
    const symbolic = gitExecFile(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], { timeout: 10000 });
    const prefix = `${remote}/`;
    if (symbolic.startsWith(prefix)) {
      const branch = symbolic.slice(prefix.length);
      if (branches.includes(branch)) return branch;
    }
  } catch {}
  return branches.includes("main") ? "main" : (branches.includes("master") ? "master" : (branches[0] || ""));
}

function getTrackedRemoteBranch(cwd, localBranch, remote) {
  if (!localBranch) return "";
  try {
    const tracked = gitExecFile(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { timeout: 10000 });
    const prefix = `${remote}/`;
    if (tracked.startsWith(prefix)) return tracked.slice(prefix.length);
  } catch {}
  return "";
}

function chooseRemoteBranch(cwd, remote, localBranch, branches, requestedBranch = "") {
  if (requestedBranch) {
    if (!branches.includes(requestedBranch)) return null;
    return requestedBranch;
  }
  const tracked = getTrackedRemoteBranch(cwd, localBranch, remote);
  if (tracked && branches.includes(tracked)) return tracked;
  return getRemoteHeadBranch(cwd, remote, branches);
}

function listRemoteDetails(cwd) {
  const names = gitExecFile(cwd, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return names.map((name) => {
    let fetchUrl = "";
    let pushUrl = "";
    try { fetchUrl = gitExecFile(cwd, ["remote", "get-url", name], { timeout: 10000 }); } catch {}
    try { pushUrl = gitExecFile(cwd, ["remote", "get-url", "--push", name], { timeout: 10000 }); } catch { pushUrl = fetchUrl; }
    const branches = listRemoteBranches(cwd, name);
    const defaultBranch = getRemoteHeadBranch(cwd, name, branches);
    return {
      name,
      fetchUrl: sanitizeRemoteUrl(fetchUrl),
      pushUrl: sanitizeRemoteUrl(pushUrl || fetchUrl),
      hasPushUrl: configuredRemoteUrls(cwd, name, true).length > 0,
      displayUrl: sanitizeRemoteUrl(fetchUrl || pushUrl),
      branches,
      defaultBranch,
      role: "other",
    };
  });
}

function getRemoteBranchSnapshot(cwd, remote, remoteBranch, targetBranch) {
  const remoteRef = `${remote}/${remoteBranch}`;
  let remoteHash = "";
  try { remoteHash = gitExecFile(cwd, ["rev-parse", "--verify", `${remoteRef}^{commit}`], { timeout: 10000 }); } catch {}
  if (!remoteHash) {
    return { remoteRef, remoteBranch, targetBranch, remoteHash: "", hasRemoteBranch: false, comparisonStatus: "REMOTE_BRANCH_MISSING", remoteAhead: 0, localAhead: 0, commits: [], files: [] };
  }
  let targetHash = "";
  try { targetHash = gitExecFile(cwd, ["rev-parse", "--verify", `${targetBranch}^{commit}`], { timeout: 10000 }); } catch {}
  if (!targetHash) {
    return { remoteRef, remoteBranch, targetBranch, remoteHash, hasRemoteBranch: true, comparisonStatus: "LOCAL_BRANCH_UNCOMMITTED", remoteAhead: 0, localAhead: 0, commits: [], files: [] };
  }

  let counts;
  try {
    counts = gitExecFile(cwd, ["rev-list", "--left-right", "--count", `${remoteRef}...${targetBranch}`], { timeout: 10000 }).split(/\s+/).map(Number);
  } catch {
    return { remoteRef, remoteBranch, targetBranch, remoteHash, hasRemoteBranch: true, comparisonStatus: "COMPARE_FAILED", remoteAhead: 0, localAhead: 0, commits: [], files: [] };
  }
  const remoteAhead = Number.isFinite(counts[0]) ? counts[0] : 0;
  const localAhead = Number.isFinite(counts[1]) ? counts[1] : 0;
  let commits = [];
  let files = [];
  try {
    commits = parseCommitList(gitExecFile(cwd, ["log", "--format=%H|%s", "-n", "20", `${targetBranch}..${remoteRef}`], { timeout: 10000 }))
      .map((item) => ({ hash: item.hash.slice(0, 12), subject: item.subject }));
    files = parseNameStatus(gitExecFile(cwd, ["diff", "--name-status", `${targetBranch}..${remoteRef}`], { timeout: 10000 }));
  } catch {
    return { remoteRef, remoteBranch, targetBranch, remoteHash, hasRemoteBranch: true, comparisonStatus: "COMPARE_FAILED", remoteAhead, localAhead, commits: [], files: [] };
  }
  return { remoteRef, remoteBranch, targetBranch, remoteHash, hasRemoteBranch: true, comparisonStatus: "OK", remoteAhead, localAhead, commits, files };
}

function validateBranchName(cwd, branch) {
  if (!branch || branch.startsWith("-")) return false;
  try {
    gitExecFile(cwd, ["check-ref-format", `refs/heads/${branch}`], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function parseNameStatus(raw) {
  return String(raw || "").split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return { status: parts[0] || "?", name: parts.slice(1).join("\t") || parts[0] || "" };
  });
}

function parseCommitList(raw) {
  return String(raw || "").split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("|");
    if (separator < 0) return { hash: line, subject: "" };
    return { hash: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}

// 路径辅助函数
function extractBasename(p) {
  if (!p) return "";
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || p;
}

function extractParentTail(p, depth = 2) {
  if (!p) return "";
  const segs = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return segs.slice(-depth).join("/");
}

// 解析 git remote URL，统一成 "owner/repo" 形式用于显示
function parseOriginUrl(url) {
  if (!url) return "";
  // https://host/owner/repo(.git)  /  ssh://git@host/owner/repo(.git)  /  file:///path
  let m = url.match(/^(?:https?|ssh|file):\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (m) return m[1].replace(/\.git$/, "");
  // git@host:owner/repo(.git)
  m = url.match(/^[^@/]+@[^:]+:(.+?)(?:\.git)?\/?$/);
  if (m) return m[1].replace(/\.git$/, "");
  return url;
}

function repoPath(input) {
  return (input && String(input).trim()) || process.cwd();
}

function remoteSettingsKey(path) {
  return resolve(path).replace(/[\\/]+$/, "").toLowerCase();
}

function resolveRemoteSettings(config, path, names) {
  const remoteNames = Array.isArray(names) ? names.filter(isValidRemoteName) : [];
  const key = remoteSettingsKey(path);
  const saved = config && config.remoteSettings && config.remoteSettings[key] && typeof config.remoteSettings[key] === "object"
    ? config.remoteSettings[key]
    : {};
  const roles = { ...(saved.roles && typeof saved.roles === "object" ? saved.roles : {}) };
  if (!roles.origin && remoteNames.includes("origin")) roles.origin = "push-target";
  if (!roles.upstream && remoteNames.includes("upstream")) roles.upstream = "update-source";

  const firstByRole = (role) => Object.keys(roles).find((name) => remoteNames.includes(name) && roles[name] === role) || "";
  const pushRemote = remoteNames.includes(saved.pushRemote)
    ? saved.pushRemote
    : (remoteNames.includes("origin") ? "origin" : (firstByRole("push-target") || remoteNames[0] || ""));
  const fetchRemote = remoteNames.includes(saved.fetchRemote)
    ? saved.fetchRemote
    : (remoteNames.includes("upstream") ? "upstream" : (remoteNames.includes("origin") ? "origin" : (firstByRole("update-source") || remoteNames[0] || "")));

  return { pathKey: key, pushRemote, fetchRemote, roles };
}

async function readRemoteSettings(ctx, path, names) {
  const config = await readConfig(ctx);
  const remoteNames = names || gitExecFile(path, ["remote"], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return resolveRemoteSettings(config, path, remoteNames);
}

async function writeRemoteSettings(ctx, path, settings) {
  const current = await readConfig(ctx);
  const remoteSettings = { ...(current.remoteSettings && typeof current.remoteSettings === "object" ? current.remoteSettings : {}) };
  remoteSettings[remoteSettingsKey(path)] = {
    pushRemote: settings.pushRemote || "",
    fetchRemote: settings.fetchRemote || "",
    roles: { ...(settings.roles || {}) },
  };
  await writeConfig(ctx, { ...current, remoteSettings });
}

function applyRemoteSettings(remoteInfo, settings) {
  remoteInfo.isDefaultPush = remoteInfo.name === settings.pushRemote;
  remoteInfo.isDefaultFetch = remoteInfo.name === settings.fetchRemote;
  remoteInfo.role = remoteInfo.isDefaultPush && remoteInfo.isDefaultFetch
    ? "both"
    : (remoteInfo.isDefaultPush ? "push-target" : (remoteInfo.isDefaultFetch ? "update-source" : (settings.roles[remoteInfo.name] || "other")));
  return remoteInfo;
}

export default function (app, ctx) {
  // ======== v2 边界适配 ========
  // App 进程运行在 Node Permission Model 下：安装目录只读、dataDir 可写，
  // 仓库内文件的直接读写改走宿主 ResourceIO 门（app/resources.read|write 授权），
  // 临时文件（commit -F 消息、GIT_SEQUENCE_EDITOR 脚本）落 dataDir。
  const dataDir = ctx && ctx.dataDir ? String(ctx.dataDir) : "";

  async function readTextFile(absPath) {
    const res = await ctx.resources.read({ kind: "local-file", path: absPath });
    const content = res && typeof res === "object" && "content" in res ? res.content : res;
    if (content == null) return "";
    return Buffer.isBuffer(content) ? content.toString("utf8")
      : content instanceof Uint8Array ? Buffer.from(content).toString("utf8")
      : String(content);
  }

  async function writeTextFile(absPath, text) {
    await ctx.resources.write({ kind: "local-file", path: absPath }, String(text));
  }

  function tmpFile(prefix, ext) {
    const name = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || ""}`;
    return dataDir ? join(dataDir, name) : join(tmpdir(), name);
  }

  // 仓库内路径的存在性检查：宿主侧 stat，dataDir 内不查账本，盘外读需要
  // app/resources.read（清单已声明）。
  const pathExists = async (absPath) => {
    try {
      await ctx.resources.stat({ kind: "local-file", path: absPath });
      return true;
    } catch {
      return false;
    }
  };
  const gitOperationState = (cwd) => getGitOperationState(cwd, pathExists);

  // PATH 解析不到 git 时，用宿主侧的 resolveExecutable 探测常见安装位置
  // （AppHost 内直接 stat 外部路径会被 Permission Model 拒绝）。
  if (ctx && ctx.process && typeof ctx.process.resolveExecutable === "function") {
    ctx.process.resolveExecutable({
      candidates: [
        "git",
        "C:\\Program Files\\Git\\cmd\\git.exe",
        join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd", "git.exe"),
        join(process.env.LOCALAPPDATA || "", "Programs", "HanaAgent", "resources", "git", "cmd", "git.exe"),
        join(process.env.USERPROFILE || "", "scoop", "apps", "git", "current", "cmd", "git.exe"),
      ].filter(Boolean),
    }).then((info) => {
      if (info && info.path) setGitExecutableOverride(info.path);
    }).catch(() => {});
  }

  // ======== 模块注册 ========
  registerLocalGitRoutes(app, { repoPath, gitExecFile, gitExecFileAsync, commandErrorText, tmpFile });
  registerHistoryRoutes(app, { repoPath, gitExecFile });
  registerHistoryEditRoutes(app, { repoPath, gitExecFile, gitExecFileWithEnv, commandErrorText, getGitOperationState: gitOperationState, tmpFile, readTextFile });
  registerDiffConflictRoutes(app, { repoPath, gitExecFile, readTextFile, writeTextFile });
  registerRepositoryRoutes(app, {
    ctx,
    repoPath,
    readRepoPath,
    writeRepoPath,
    gitExecFile,
    gitExecFileAsync,
    extractBasename,
    extractParentTail,
    parseOriginUrl,
    readRemoteSettings,
    writeTextFile,
  });
  registerGitHubRoutes(app, {
    ctx,
    gitExecFile,
    commandErrorText,
    validateBranchName,
    isValidRemoteName,
    isValidRemoteUrl,
    sanitizeRemoteUrl,
    readRemoteSettings,
    readRepoPath,
    writeTextFile,
    pathExists,
  });
  registerRemoteEditRoutes(app, {
    ctx,
    repoPath,
    gitExecFile,
    commandErrorText,
    readConfig,
    writeConfig,
    readRemoteSettings,
    writeRemoteSettings,
    isValidRemoteName,
    isValidRemoteUrl,
    sanitizeRemoteUrl,
    configuredRemoteUrls,
    getGitOperationState: gitOperationState,
  });
  registerRemoteQueryRoutes(app, {
    ctx,
    repoPath,
    gitExecFile,
    gitExecFileAsync,
    listRemoteDetails,
    readRemoteSettings,
    applyRemoteSettings,
    chooseRemoteBranch,
    getRemoteBranchSnapshot,
    validateBranchName,
    commandErrorText,
    writeRemoteSettings,
    isValidRemoteName,
    sanitizeRemoteUrl,
    parseCommitList,
    parseNameStatus,
  });
  registerRemoteSyncRoutes(app, {
    ctx,
    repoPath,
    gitExecFile,
    listRemoteBranches,
    readRemoteSettings,
    chooseRemoteBranch,
    getRemoteBranchSnapshot,
    validateBranchName,
    sanitizeRemoteUrl,
    commandErrorText,
    isValidRemoteName,
    getGitOperationState: gitOperationState,
    writeRemoteSettings,
  });
  registerConfigRoutes(app, { ctx, readConfig, writeConfig, validateConfigPatch });
  registerBranchRoutes(app, { repoPath, gitExecFile, validateBranchName });
  registerRemotePushRoutes(app, {
    ctx,
    repoPath,
    gitExecFile,
    commandErrorText,
    readConfig,
    readRemoteSettings,
    isValidRemoteName,
    validateBranchName,
    listRemoteBranches,
    chooseRemoteBranch,
    parseCommitList,
    parseNameStatus,
  });
  registerStashRoutes(app, { repoPath, gitExecFile, commandErrorText });
  registerMiscRoutes(app, { pluginDir: PLUGIN_DIR });
}
