// git-tools / routes / git.js
// 页面入口 + 公共函数/依赖装配 + 各模块注册。
// 各功能路由已按职责拆分到 routes/*.js，本文件不再定义业务端点。

import { readFile } from "node:fs/promises";
import { existsSync, statSync, readFileSync } from "node:fs";
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
// Static WebView entry is kept under assets/ so the plugin follows the current
// Hana asset boundary. The route remains the authenticated document entry.
const htmlPath = join(__dirname, "..", "assets", "git.html");
let cachedHtml = null;
let cachedHtmlSig = "";

function gitPathExists(cwd, name) {
  try {
    const gitPath = gitExecFile(cwd, ["rev-parse", "--git-path", name], { timeout: 10000 });
    return existsSync(resolve(cwd, gitPath));
  } catch {
    return false;
  }
}

function getGitOperationState(cwd) {
  const names = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
    "BISECT_LOG",
  ];
  return names.find(name => gitPathExists(cwd, name)) || "";
}

async function loadHtml() {
  // 按文件签名（mtime+size）自动重读：开发时改完 git.html 无需重载插件即可生效。
  const st = statSync(htmlPath);
  const sig = `${Math.floor(st.mtimeMs)}-${st.size}`;
  if (!cachedHtml || cachedHtmlSig !== sig) {
    cachedHtml = await readFile(htmlPath, "utf8");
    cachedHtmlSig = sig;
  }
  return cachedHtml;
}

// 静态资源由宿主以 immutable 策略（max-age=31536000）缓存。返回页面前给 HTML 里
// 引用的 assets 资源 URL 追加基于 mtime+size 的版本参数，文件变更后 URL 随之变化，
// WebView 立即拿到新内容，避免旧缓存导致的行为不一致。
function assetVersionToken(relPath) {
  if (!relPath || relPath.includes("..")) return "0";
  try {
    const st = statSync(join(__dirname, "..", "assets", relPath));
    return Math.floor(st.mtimeMs).toString(36) + "." + st.size.toString(36);
  } catch {
    return "0";
  }
}

// 兼容性静态资源路由：桌面本地模式的卡片 iframe 仅携带 surface session 凭证，
// 宿主不为它派发资产 cookie，且 /assets/* 的授权策略要求 chat scope（surface
// 凭证无 scope），导致 <link>/<script> 子资源必然 403。改为由插件自身路由
// 提供同一批文件：plugin_route 策略允许匹配插件的 surface session 凭证，
// 与卡片内 /api/* 请求同一权限模型。文件仍以 assets/ 为源，严格白名单无路径拼接。
const GIT_ASSET_BASE = join(__dirname, "..", "assets");
const GIT_ASSET_FILES = [
  { route: "git.css", file: "git.css", type: "text/css; charset=utf-8" },
  ...[
    "env", "state", "card-drag", "repo-path", "settings", "gh-panel", "remotes",
    "gh-connect", "gh-repos", "branch-canvas", "ctx-menu", "hana-select",
    "branch-actions", "refresh", "status-card", "log-view", "commit-actions",
    "commit-edit", "reset", "diff-view", "confirm-modal", "conflicts",
    "repo-init", "walkthrough", "identity", "main",
  ].map((name) => ({ route: `git/${name}.js`, file: `git/${name}.js`, type: "text/javascript; charset=utf-8" })),
];

function serveGitAsset(c, info) {
  let text;
  try {
    text = readFileSync(join(GIT_ASSET_BASE, info.file), "utf8");
  } catch {
    return c.body("/* asset unavailable */", 404, { "Content-Type": "text/plain; charset=utf-8" });
  }
  c.header("Content-Type", info.type);
  c.header("Cache-Control", "public, max-age=31536000, immutable");
  return c.body(text);
}

// 缓存用户级代理环境变量，避免每次 git 调用都查询 Windows 注册表
let _cachedUserProxy = null;
function getUserProxy() {
  if (_cachedUserProxy) return _cachedUserProxy;
  _cachedUserProxy = {};
  try {
    const userHttps = execSync('[System.Environment]::GetEnvironmentVariable("HTTPS_PROXY", "User")', { encoding: 'utf8', shell: 'powershell', windowsHide: true }).trim();
    const userHttp = execSync('[System.Environment]::GetEnvironmentVariable("HTTP_PROXY", "User")', { encoding: 'utf8', shell: 'powershell', windowsHide: true }).trim();
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
    if (!existsSync(exe)) continue;
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
function resolveGitPath() {
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
  // ======== 页面 ========
  // Route declared by the WebView card contribution.
  // 生成页面 HTML 字符串（主题注入 + 资源重写 + 凭证回传），供 /git 与 /widget 共用。
  const buildSurfaceHtml = async (c) => {
    const html = await loadHtml();
    // 读取 Hana 传递的主题参数
    const requestedTheme = String(c.req.query("hana-theme") || "auto");
    const allowedThemes = new Set(["auto", "light", "dark", "warm-paper", "new-warm-paper", "midnight", "midnight-contrast", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "coral"]);
    const theme = allowedThemes.has(requestedTheme) ? requestedTheme : "auto";
    // 主题只接受白名单值，避免把查询参数直接写入 HTML 属性。
    // 子资源凭证回传：桌面本地模式 iframe 文档 URL 携带 ?token=（loopback_token
    // 凭证），代理层会删除 pluginSurfaceSession/iframeTicket 但保留 token。把
    // token 原样回传到子资源 URL 上，主鉴权 queryToken 通道即可放行（与宿主给
    // theme.css 的处理方式一致）；非本地模式由资产 cookie 兑底，无需后缀。
    const queryToken = String(c.req.query("token") || "");
    const sessionSuffix = queryToken
      ? `&token=${encodeURIComponent(queryToken)}`
      : "";
    const versioned = html.replace(
      /assets\/([A-Za-z0-9._/-]+\.(?:js|css))(?![\w.$-])/g,
      (match, relPath) => `git-asset/${relPath}?v=${assetVersionToken(relPath)}${sessionSuffix}`,
    );
    const patched = versioned.replace(
      /<body([^>]*)>/,
      `<body data-hana-theme="${theme}"$1>`
    );
    return patched;
  };

  const renderSurface = async (c) => c.html(await buildSurfaceHtml(c));

  // Route declared by the WebView card contribution.
  app.get("/git", renderSurface);

  // Route declared by the legacy widget contribution（经典界面右侧工作台面板）。
  // 复用同一张页面的 HTML 与模块，通过 body 上的 data-hana-widget 标记让
  // 前端进入窄面板模式：隐藏大页面专属区块，仅保留存档/读档主卡片。
  app.get("/widget", async (c) => {
    const patched = await buildSurfaceHtml(c);
    const withWidgetFlag = patched.replace(
      /<body([^>]*)>/,
      (m, attrs) => `<body${attrs} data-hana-widget="1">`,
    );
    return c.html(withWidgetFlag);
  });

  // 兼容性静态资源路由（严格白名单，逐个注册，无通配无拼接）。
  for (const info of GIT_ASSET_FILES) {
    app.get("/git-asset/" + info.route, (c) => serveGitAsset(c, info));
  }

  // ======== 模块注册 ========
  registerLocalGitRoutes(app, { repoPath, gitExecFile, gitExecFileAsync, commandErrorText });
  registerHistoryRoutes(app, { repoPath, gitExecFile });
  registerHistoryEditRoutes(app, { repoPath, gitExecFile, gitExecFileWithEnv, commandErrorText, getGitOperationState });
  registerDiffConflictRoutes(app, { repoPath, gitExecFile });
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
    getGitOperationState,
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
    getGitOperationState,
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
  registerMiscRoutes(app, { pluginDir: join(__dirname, "..") });
}
