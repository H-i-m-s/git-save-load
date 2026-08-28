// git-tools / routes / git.js
// 提供后端 API + 页面渲染。

import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readConfig, writeConfig, readRepoPath, writeRepoPath } from "./config.js";
import { registerHistoryRoutes } from "./history.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Static WebView entry is kept under assets/ so the plugin follows the current
// Hana asset boundary. The route remains the authenticated document entry.
const htmlPath = join(__dirname, "..", "assets", "git.html");
let cachedHtml = null;

// 历史重写是仓库级别的危险操作。同一 HanaAgent 进程内，同一仓库只能同时执行一个 reword。
const rewordLocks = new Set();

function rewordLockKey(cwd) {
  return resolve(cwd).replace(/[\\/]+$/, "").toLowerCase();
}

function tryAcquireRewordLock(cwd) {
  const key = rewordLockKey(cwd);
  if (rewordLocks.has(key)) return null;
  rewordLocks.add(key);
  return () => rewordLocks.delete(key);
}

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

function getRebaseIdentity(cwd) {
  for (const kind of ["rebase-merge", "rebase-apply"]) {
    try {
      const dir = resolve(cwd, gitExecFile(cwd, ["rev-parse", "--git-path", kind], { timeout: 10000 }));
      if (!existsSync(dir)) continue;
      let headName = "";
      let originalHead = "";
      try { headName = readFileSync(join(dir, "head-name"), "utf8").trim(); } catch {}
      try { originalHead = readFileSync(join(dir, "orig-head"), "utf8").trim(); } catch {}
      return { kind, dir, headName, originalHead };
    } catch {}
  }
  return null;
}

async function loadHtml() {
  if (cachedHtml) return cachedHtml;
  cachedHtml = await readFile(htmlPath, "utf8");
  return cachedHtml;
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

function isValidRemoteName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function isValidRemoteUrl(url) {
  return /^(?:https?|ssh|file):\/\/[^\s]+$/.test(url) || /^git@[^\s:]+:[^\s]+$/.test(url);
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

function configuredRemoteUrls(cwd, remote, push = false) {
  try {
    const key = `remote.${remote}.${push ? "pushurl" : "url"}`;
    return gitExecFile(cwd, ["config", "--get-all", key], { timeout: 10000 }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function restoreConfiguredRemoteUrls(cwd, remote, urls, push = false) {
  const key = `remote.${remote}.${push ? "pushurl" : "url"}`;
  try { gitExecFile(cwd, ["config", "--unset-all", key], { timeout: 10000 }); } catch {}
  for (const url of urls) gitExecFile(cwd, ["config", "--add", key, url], { timeout: 10000 });
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

function normalizeVersionTag(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const version = raw.replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : null;
}

function getTagCommit(cwd, tag) {
  if (!tag) return "";
  return gitExecFile(cwd, ["rev-parse", `${tag}^{commit}`], { timeout: 10000 });
}

function inspectTagConflict(cwd, tag, targetCommit, allowedExisting = "") {
  if (!tag) return null;
  let existing = "";
  try { existing = getTagCommit(cwd, tag); } catch {}
  if (!existing || tag === allowedExisting) return null;
  let onCurrentBranch = false;
  try { gitExecFile(cwd, ["merge-base", "--is-ancestor", existing, "HEAD"], { timeout: 10000 }); onCurrentBranch = true; } catch {}
  return {
    tag,
    existingCommit: existing,
    targetCommit,
    oldHistory: !onCurrentBranch,
    message: onCurrentBranch
      ? `版本号 ${tag.replace(/^v/, "")} 已经存在，请换一个版本号`
      : `版本号 ${tag.replace(/^v/, "")} 已存在于旧历史，是否移动到当前提交？`,
  };
}

function moveLightweightTag(cwd, fromTag, toTag, commit) {
  // 先写入新 tag，再删除旧 tag，避免删除成功而写入新 tag 失败时造成版本号丢失。
  if (toTag) {
    gitExecFile(cwd, ["update-ref", `refs/tags/${toTag}`, commit], { timeout: 10000 });
  }
  if (fromTag && fromTag !== toTag) {
    gitExecFile(cwd, ["update-ref", "-d", `refs/tags/${fromTag}`], { timeout: 10000 });
  }
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

const LICENSE_OPTIONS = new Set(["MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause", "LGPL-3.0", "MPL-2.0", "Unlicense"]);

function normalizeLicense(value) {
  const license = String(value || "").trim();
  return license && LICENSE_OPTIONS.has(license) ? license : "";
}

function hasHeadCommit(cwd) {
  try {
    gitExecFile(cwd, ["rev-parse", "--verify", "HEAD"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function getGitIdentity(cwd) {
  try {
    const name = gitExecFile(cwd, ["config", "user.name"], { timeout: 10000 });
    const email = gitExecFile(cwd, ["config", "user.email"], { timeout: 10000 });
    return name && email ? { name, email } : null;
  } catch {
    return null;
  }
}

function readLicenseFile(cwd, license) {
  try {
    const output = execFileSync(resolveGhPath(), ["repo", "license", "view", license], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: ghEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output;
  } catch {
    return "";
  }
}

function applyLicenseToLocalRepo(cwd, license) {
  if (!license) return { applied: false, existing: false, committed: false };
  const licensePath = join(cwd, "LICENSE");
  if (existsSync(licensePath)) return { applied: false, existing: true, committed: false };
  const content = readLicenseFile(cwd, license);
  if (!content) throw new Error("无法获取许可证模板，请检查 GitHub CLI 是否支持该许可证");
  const identity = getGitIdentity(cwd);
  if (!identity) throw new Error("当前仓库还没有配置 Git 姓名和邮箱，无法自动提交许可证");
  const year = String(new Date().getFullYear());
  const normalized = content
    .replace(/\[year\]/gi, year)
    .replace(/\[fullname\]/gi, identity.name);
  writeFileSync(licensePath, normalized + "\n", "utf8");
  return { applied: true, existing: false, committed: false };
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
  const renderSurface = async (c) => {
    const html = await loadHtml();
    // 读取 Hana 传递的主题参数
    const theme = c.req.query("hana-theme") || "";
    // 在 body 上设置 data-hana-theme 属性，供前端读取
    const patched = html.replace(
      /<body([^>]*)>/,
      `<body data-hana-theme="${theme}"$1>`
    );
    return c.html(patched);
  };

  // Route declared by the WebView card contribution.
  app.get("/git", renderSurface);

  // ======== API: 获取状态 ========
  app.get("/api/status", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      const branch = gitExecFile(path, ["branch", "--show-current"]);
      const statusShort = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--short"]);
      // git log 在空仓库（无 commit）会失败，单独处理
      let recentCommits = [];
      try {
        const logRaw = gitExecFile(path, ["log", "--format=%H %s", "--numstat", "-n", "5"]);
        // 解析 log --numstat 输出
        const lines = logRaw.split("\n");
        let current = null;
        for (const line of lines) {
          if (!line.trim()) { if (current) { recentCommits.push(current); current = null; } continue; }
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && /^[0-9a-f]{40}$/i.test(parts[0])) {
            if (current) recentCommits.push(current);
            current = { hash: parts[0].slice(0, 7), subject: parts.slice(1).join(" "), added: 0, deleted: 0 };
          } else if (current && parts.length >= 2 && /^\d+$/.test(parts[0])) {
            current.added += parseInt(parts[0]) || 0;
            current.deleted += parseInt(parts[1]) || 0;
          }
        }
        if (current) recentCommits.push(current);
      } catch {}

      let changed = [];
      let untracked = [];
      if (statusShort) {
        for (const line of statusShort.split("\n")) {
          const t = line.trim();
          if (t.startsWith("??")) untracked.push(t.slice(2).trim());
          else changed.push(t);
        }
      }

      // 获取每个文件的增删统计
      const numstat = {};
      try {
        const raw = gitExecFile(path, ["-c", "core.quotepath=false", "diff", "--numstat"]);
        for (const line of raw.split("\n").filter(Boolean)) {
          const [added, deleted, ...nameParts] = line.split("\t");
          const name = nameParts.join("\t");
          if (name && added !== "-") numstat[name] = { added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
        }
      } catch {}

      // 增强 changedFiles，带上统计
      const changedWithStats = changed.map(line => {
        const name = line.slice(2).trim();
        const st = line.slice(0, 2).trim();
        const stats = numstat[name] || { added: 0, deleted: 0 };
        return { raw: line, name, status: st, added: stats.added, deleted: stats.deleted };
      });

      return c.json({
        ok: true,
        branch,
        path,
        isRepo: true,
        hasChanges: changed.length > 0 || untracked.length > 0,
        changedFiles: changed,
        changedWithStats,
        untrackedFiles: untracked,
        recentCommits,
        changedCount: changed.length,
        untrackedCount: untracked.length,
      });
    } catch (e) {
      return c.json({ ok: false, isRepo: false, path, message: e.message });
    }
  });

  // ======== API: 提交 ========
  app.post("/api/commit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const message = String(body.message || "").trim();

    if (!message) {
      return c.json({ ok: false, message: "提交消息不能为空" });
    }

    // 提交前检测身份配置（使用本地仓库配置，不读 global，避免泄漏全局状态）
    try {
      const localName = gitExecFile(path, ["config", "user.name"]);
      const localEmail = gitExecFile(path, ["config", "user.email"]);
      if (!localName || !localEmail) {
        return c.json({
          ok: false,
          code: "NO_IDENTITY",
          message: "Git 还未设置你的姓名和邮箱（用来标识谁提交了这次修改）",
          needIdentity: true,
        });
      }
    } catch (e) {
      return c.json({
        ok: false,
        code: "NO_IDENTITY",
        message: "Git 还未设置你的姓名和邮箱（用来标识谁提交了这次修改）",
        needIdentity: true,
      });
    }

    let msgFile = null;
    try {
      gitExecFile(path, ["add", "."]);

      try {
        // 用系统临时目录存提交消息文件，用完 unlink，避免污染 .git/COMMIT_EDITMSG
        msgFile = join(tmpdir(), "git-sl-msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".txt");
        writeFileSync(msgFile, message, "utf8");
        gitExecFile(path, ["commit", "-F", msgFile]);
      } catch (e) {
        if (e.message.includes("nothing to commit") || e.message.includes("nothing added")) {
          return c.json({ ok: true, nothingToCommit: true, message: "没有需要提交的变更" });
        }
        throw e;
      }

      const last = gitExecFile(path, ["log", "--oneline", "-n", "1"]);

      // 如果有版本号，打 tag
      let tag = "";
      const version = String(body.version || "").trim();
      if (version) {
        tag = `v${version.replace(/^v/, "")}`;
        gitExecFile(path, ["tag", tag]);
      }

      return c.json({ ok: true, commit: last, message, tag });
    } catch (e) {
      return c.json({ ok: false, message: `提交失败：${e.message}` });
    } finally {
      // 清理临时文件
      if (msgFile) {
        try { unlinkSync(msgFile); } catch {}
      }
    }
  });

  // ======== API: 配置 git 身份（仅写入当前仓库，不污染全局） ========
  app.post("/api/git-config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    if (!name) return c.json({ ok: false, message: "姓名不能为空" });
    if (!email) return c.json({ ok: false, message: "邮箱不能为空" });
    // 邮箱格式粗校验（不验证可达性）
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, message: "邮箱格式不正确，请检查（例：xx@example.com）" });
    }
    try {
      gitExecFile(path, ["config", "user.name", name]);
      gitExecFile(path, ["config", "user.email", email]);
      return c.json({ ok: true, message: "身份配置成功" });
    } catch (e) {
      return c.json({ ok: false, message: `配置失败：${e.message}` });
    }
  });

  // ======== API: 修改最近一次提交的消息（git commit --amend） ========
  app.post("/api/commit-amend", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const message = String(body.message || "").trim();
    const expectedHash = String(body.expectedHash || "").trim();

    if (!message) return c.json({ ok: false, message: "提交消息不能为空" });

    // 身份检查（与 commit 路由一致）
    try {
      const localName = gitExecFile(path, ["config", "user.name"]);
      const localEmail = gitExecFile(path, ["config", "user.email"]);
      if (!localName || !localEmail) {
        return c.json({
          ok: false,
          code: "NO_IDENTITY",
          message: "Git 还未设置你的姓名和邮箱",
          needIdentity: true,
        });
      }
    } catch (e) {
      return c.json({
        ok: false,
        code: "NO_IDENTITY",
        message: "Git 还未设置你的姓名和邮箱",
        needIdentity: true,
      });
    }

    // hash 校验：用户点的必须是当前 HEAD
    if (!expectedHash) {
      return c.json({ ok: false, message: "内部错误：缺少预期 hash" });
    }
    let currentHash = "";
    try {
      currentHash = gitExecFile(path, ["rev-parse", "HEAD"]);
    } catch (e) {
      return c.json({ ok: false, message: "读取 HEAD 失败：" + e.message });
    }
    if (currentHash.slice(0, expectedHash.length) !== expectedHash) {
      return c.json({
        ok: false,
        code: "NOT_HEAD",
        message: "只能修改最近一条提交。这条提交已经不是最新了，如需修改请在终端使用 git rebase -i （高级操作）。",
      });
    }

    // 检查工作区是否干净（--amend 不能有未提交修改，否则会混入）
    try {
      const status = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--porcelain"]);
      if (status) {
        return c.json({
          ok: false,
          code: "DIRTY",
          message: "当前有未提交的修改，请先存档或丢弃这些修改，再修改提交说明。",
        });
      }
    } catch (e) {}

    let msgFile = null;
    try {
      msgFile = join(tmpdir(), "git-sl-amend-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".txt");
      writeFileSync(msgFile, message, "utf8");
      gitExecFile(path, ["commit", "--amend", "-F", msgFile]);
      const last = gitExecFile(path, ["log", "--oneline", "-n", "1"]);
      return c.json({ ok: true, message: "已修改最近一次提交说明", commit: last });
    } catch (e) {
      return c.json({ ok: false, message: `修改失败：${e.message}` });
    } finally {
      if (msgFile) { try { unlinkSync(msgFile); } catch {} }
    }
  });

  // ======== API: 修改提交版本号（只操作 lightweight Git tag，不重写提交历史） ========
  app.post("/api/tag-edit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const commit = String(body.commit || "").trim();
    const currentTagRaw = String(body.currentTag || "").trim();
    const currentTag = currentTagRaw ? normalizeVersionTag(currentTagRaw) : "";
    const requestedVersion = normalizeVersionTag(body.version);
    const allowMove = body.allowMove === true;

    if (!commit) return c.json({ ok: false, message: "请指定提交 hash" });
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) return c.json({ ok: false, message: "提交 hash 格式不正确" });
    if (currentTagRaw && currentTag === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "当前版本号格式不正确" });
    if (requestedVersion === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "版本号格式错误，正确格式如 1.2.3" });

    const releaseLock = tryAcquireRewordLock(path);
    if (!releaseLock) return c.json({ ok: false, code: "REWORD_IN_PROGRESS", message: "当前仓库正在进行历史提交编辑，请等待当前操作完成" });
    try {
      const targetHash = gitExecFile(path, ["rev-parse", "--verify", `${commit}^{commit}`], { timeout: 10000 });
      if (currentTag) {
        if (getTagCommit(path, currentTag) !== targetHash) {
          return c.json({ ok: false, code: "TAG_CHANGED", message: "当前版本号已经不再指向这条提交，请刷新后重试" });
        }
        if (gitExecFile(path, ["cat-file", "-t", `refs/tags/${currentTag}`], { timeout: 10000 }) !== "commit") {
          return c.json({ ok: false, code: "ANNOTATED_TAG", message: "当前版本号是 annotated tag，暂不支持在插件内修改" });
        }
      }
      const conflict = inspectTagConflict(path, requestedVersion, targetHash, currentTag);
      if (conflict && !(conflict.oldHistory && allowMove)) {
        return c.json({ ok: false, code: conflict.oldHistory ? "OLD_TAG_EXISTS" : "TAG_EXISTS", conflict, message: conflict.message });
      }
      moveLightweightTag(path, currentTag, requestedVersion, targetHash);
      return c.json({ ok: true, tag: requestedVersion || "", message: requestedVersion ? `版本号已更新为 ${requestedVersion.replace(/^v/, "")}` : "版本号已删除" });
    } catch (e) {
      return c.json({ ok: false, message: `版本号修改失败：${commandErrorText(e) || "无法更新 Git tag"}` });
    } finally {
      releaseLock();
    }
  });

  // ======== API: 合并连续历史提交（非交互式 git rebase -i / squash） ========
  app.post("/api/commit-squash", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const requestedMessage = String(body.message || "").trim();
    const messageAuto = body.messageAuto === true;
    const requestedVersion = normalizeVersionTag(body.version);
    const selectedRaw = Array.isArray(body.selectedCommits) ? body.selectedCommits.map(v => String(v || "").trim()).filter(Boolean) : [];
    const expectedHead = String(body.expectedHead || "").trim();
    const allowMove = body.allowMove === true;

    if (!requestedMessage && !messageAuto) return c.json({ ok: false, message: "提交消息不能为空" });
    if (requestedVersion === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "版本号格式错误，正确格式如 1.2.3" });
    if (selectedRaw.length < 2) return c.json({ ok: false, code: "TOO_FEW_COMMITS", message: "至少选择两条提交才能合并" });
    if (selectedRaw.some(hash => !/^[0-9a-f]{4,64}$/i.test(hash))) {
      return c.json({ ok: false, message: "提交 hash 格式不正确" });
    }

    const releaseLock = tryAcquireRewordLock(path);
    if (!releaseLock) return c.json({ ok: false, code: "REWORD_IN_PROGRESS", message: "当前仓库正在进行历史重写，请等待当前操作完成" });

    let backupRef = "";
    let originalHead = "";
    let rebaseStarted = false;
    let rebaseCompleted = false;
    let sequenceEditorFile = null;
    let messageEditorFile = null;
    let messageContentFile = null;
    let startBranch = "";
    let startHead = "";
    let startGitDir = "";

    const cleanupTempEditors = () => {
      for (const file of [sequenceEditorFile, messageEditorFile, messageContentFile]) {
        if (file) { try { unlinkSync(file); } catch {} }
      }
    };

    const recoverAfterFailure = () => {
      if (!rebaseStarted || !originalHead) return "";
      try {
        const currentBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
        const currentGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
        const rebaseIdentity = getRebaseIdentity(path);
        const currentBranchMatches = currentBranch === startBranch || !currentBranch;
        const belongsToThisRequest = currentBranchMatches
          && currentGitDir === startGitDir
          && rebaseIdentity
          && rebaseIdentity.headName === `refs/heads/${startBranch}`
          && rebaseIdentity.originalHead === startHead;
        if (!belongsToThisRequest) return `未自动恢复：仓库状态已发生变化，请检查当前 Git 状态；原始备份引用为 ${backupRef}`;
        gitExecFile(path, ["rebase", "--abort"], { timeout: 30000 });
        const restoredHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
        if (restoredHead !== originalHead) return `rebase 已终止但 HEAD 未回到原位置，请使用备份引用 ${backupRef} 恢复`;
        return "";
      } catch (e) {
        return `自动恢复失败，请使用备份引用 ${backupRef} 恢复：${commandErrorText(e)}`;
      }
    };

    try {
      const branch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!branch) return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到一个本地分支" });
      const operationState = getGitOperationState(path);
      if (operationState) return c.json({ ok: false, code: "GIT_OPERATION_IN_PROGRESS", message: `当前 Git 正在进行 ${operationState} 操作，请先完成或终止它` });
      const status = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"], { timeout: 10000 });
      if (status) return c.json({ ok: false, code: "DIRTY", message: "当前工作区不干净，请先提交或暂存这些修改后再合并历史提交" });
      const localName = gitExecFile(path, ["config", "user.name"], { timeout: 10000 });
      const localEmail = gitExecFile(path, ["config", "user.email"], { timeout: 10000 });
      if (!localName || !localEmail) return c.json({ ok: false, code: "NO_IDENTITY", message: "Git 还未设置你的姓名和邮箱" });

      originalHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
      startBranch = branch;
      startHead = originalHead;
      startGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
      if (expectedHead) {
        if (!/^[0-9a-f]{4,64}$/i.test(expectedHead)) return c.json({ ok: false, code: "HEAD_CHANGED", message: "提交列表状态无效，请刷新后重试" });
        const expectedFull = gitExecFile(path, ["rev-parse", "--verify", `${expectedHead}^{commit}`], { timeout: 10000 });
        if (expectedFull !== originalHead) return c.json({ ok: false, code: "HEAD_CHANGED", message: "仓库在编辑期间发生了变化，请刷新提交记录后重试" });
      }

      const history = gitExecFile(path, ["rev-list", "--reverse", "HEAD"], { timeout: 30000 }).split("\n").filter(Boolean);
      const selected = [];
      const selectedSet = new Set();
      for (const raw of selectedRaw) {
        const full = gitExecFile(path, ["rev-parse", "--verify", `${raw}^{commit}`], { timeout: 10000 });
        if (selectedSet.has(full)) return c.json({ ok: false, code: "DUPLICATE_COMMITS", message: "不能重复选择同一条提交" });
        selected.push(full);
        selectedSet.add(full);
      }
      const indexes = selected.map(hash => history.indexOf(hash));
      if (indexes.some(index => index < 0)) return c.json({ ok: false, code: "NOT_REACHABLE", message: "选择的提交不在当前分支历史中" });
      const minIndex = Math.min(...indexes);
      const maxIndex = Math.max(...indexes);
      if (maxIndex - minIndex + 1 !== selected.length) return c.json({ ok: false, code: "NON_CONTIGUOUS", message: "请选择连续的提交，不能跳过中间提交" });
      const selectedOrdered = history.slice(minIndex, maxIndex + 1);
      const selectedSubjects = selectedOrdered.map(hash => gitExecFile(path, ["show", "-s", "--format=%s", hash], { timeout: 10000 }).trim()).filter(Boolean);
      const generatedMessage = selectedSubjects.join("+");
      const message = messageAuto ? generatedMessage : requestedMessage;
      if (!message) return c.json({ ok: false, message: "选中提交没有可用的提交说明" });
      const earliest = selectedOrdered[0];
      const rangeSpec = minIndex === 0 ? "HEAD" : `${earliest}^..HEAD`;
      const rangeCommits = gitExecFile(path, ["rev-list", "--reverse", rangeSpec], { timeout: 30000 }).split("\n").filter(Boolean);
      const commitParents = gitExecFile(path, ["rev-list", "--parents", rangeSpec], { timeout: 30000 }).split("\n").filter(Boolean);
      if (commitParents.some(line => line.trim().split(/\s+/).length > 2)) {
        return c.json({ ok: false, code: "MERGE_HISTORY", message: "当前版本暂不支持包含 merge commit 的历史，请先在纯线性分支上操作" });
      }

      // 读取所有 tag，准备在 rebase 成功后把 lightweight tag 映射到新提交。
      const tagInfos = [];
      let tagRaw = "";
      try { tagRaw = gitExecFile(path, ["for-each-ref", "refs/tags", "--format=%(refname:short)|%(objecttype)|%(objectname)"], { timeout: 10000 }); } catch {}
      for (const line of tagRaw.split("\n").filter(Boolean)) {
        const parts = line.split("|");
        const name = parts[0] || "";
        const type = parts[1] || "";
        if (!name) continue;
        let commit = "";
        try { commit = getTagCommit(path, name); } catch {}
        tagInfos.push({ name, type, commit });
      }
      const rewrittenSet = new Set(rangeCommits);
      const selectedVersionTags = tagInfos.filter(info => selectedSet.has(info.commit) && normalizeVersionTag(info.name));
      const requestedInfo = requestedVersion ? tagInfos.find(info => info.name === requestedVersion) : null;
      if (requestedInfo) {
        if (requestedInfo.type !== "commit") return c.json({ ok: false, code: "ANNOTATED_TAG", message: `版本号 ${requestedVersion.replace(/^v/, "")} 是 annotated tag，当前暂不自动改写` });
        const isSelectedTag = selectedSet.has(requestedInfo.commit);
        const isRewrittenLaterTag = rewrittenSet.has(requestedInfo.commit) && !isSelectedTag;
        if (!isSelectedTag && !isRewrittenLaterTag) {
          let onCurrentBranch = false;
          try { gitExecFile(path, ["merge-base", "--is-ancestor", requestedInfo.commit, originalHead], { timeout: 10000 }); onCurrentBranch = true; } catch {}
          const conflict = { tag: requestedVersion, existingCommit: requestedInfo.commit, targetCommit: earliest, oldHistory: !onCurrentBranch };
          if (!(conflict.oldHistory && allowMove)) return c.json({ ok: false, code: conflict.oldHistory ? "OLD_TAG_EXISTS" : "TAG_EXISTS", conflict, message: conflict.message || `版本号 ${requestedVersion.replace(/^v/, "")} 已经存在` });
        }
        if (isRewrittenLaterTag) return c.json({ ok: false, code: "TAG_EXISTS", message: `版本号 ${requestedVersion.replace(/^v/, "")} 位于合并范围之后的提交，不能覆盖` });
      }
      for (const info of tagInfos) {
        if (rewrittenSet.has(info.commit) && info.type !== "commit") {
          return c.json({ ok: false, code: "ANNOTATED_TAG", message: `提交 ${info.commit.slice(0, 7)} 上存在 annotated tag ${info.name}，当前暂不自动改写` });
        }
      }

      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      backupRef = `refs/backup/git-save-load/squash-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
      gitExecFile(path, ["update-ref", backupRef, originalHead], { timeout: 10000 });

      sequenceEditorFile = join(tmpdir(), `git-sl-squash-sequence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      messageEditorFile = join(tmpdir(), `git-sl-squash-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      writeFileSync(sequenceEditorFile, [
        "const fs = require('node:fs');",
        "const todo = process.argv[2];",
        "const selected = new Set(String(process.env.GIT_SAVE_LOAD_SQUASH_SELECTED || '').split(',').filter(Boolean).map(v => v.toLowerCase()));",
        "let text = fs.readFileSync(todo, 'utf8');",
        "let selectedSeen = 0;",
        "text = text.split(/\\r?\\n/).map(line => {",
        "  const m = line.match(/^(\\s*)(pick|reword|edit|squash|fixup)\\s+([0-9a-f]+)(\\s+.*)?$/i);",
        "  if (!m) return line;",
        "  const hash = m[3].toLowerCase();",
        "  if (!selected.has(hash) && !Array.from(selected).some(target => target.startsWith(hash) || hash.startsWith(target))) return line;",
        "  selectedSeen += 1;",
        "  return m[1] + (selectedSeen === 1 ? 'pick ' : 'squash ') + m[3] + (m[4] || '');",
        "}).join('\\n');",
        "if (selectedSeen !== selected.size) { console.error('selected commit not found in rebase todo'); process.exit(2); }",
        "fs.writeFileSync(todo, text, 'utf8');",
        "",
      ].join("\n"), "utf8");
      writeFileSync(messageEditorFile, [
        "const fs = require('node:fs');",
        "const target = process.argv[2];",
        "const source = process.env.GIT_SAVE_LOAD_SQUASH_MESSAGE_FILE;",
        "if (!target || !source) process.exit(2);",
        "fs.copyFileSync(source, target);",
        "",
      ].join("\n"), "utf8");
      const quoteCommandPath = value => `"${String(value).replace(/"/g, '\\\"')}"`;
      messageContentFile = join(tmpdir(), `git-sl-squash-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      writeFileSync(messageContentFile, message, "utf8");
      const editorEnv = {
        GIT_SAVE_LOAD_SQUASH_SELECTED: selectedOrdered.join(","),
        GIT_SAVE_LOAD_SQUASH_MESSAGE_FILE: messageContentFile,
        GIT_SEQUENCE_EDITOR: `${quoteCommandPath(process.execPath)} ${quoteCommandPath(sequenceEditorFile)}`,
        GIT_EDITOR: `${quoteCommandPath(process.execPath)} ${quoteCommandPath(messageEditorFile)}`,
      };
      const upstream = minIndex === 0 ? "" : gitExecFile(path, ["rev-parse", `${earliest}^`], { timeout: 10000 });
      const rebaseArgs = ["rebase", "-i"];
      if (minIndex === 0) rebaseArgs.push("--root"); else rebaseArgs.push(upstream);
      rebaseStarted = true;
      gitExecFileWithEnv(path, rebaseArgs, editorEnv, { timeout: 300000 });
      rebaseCompleted = true;

      const newHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
      const newRangeSpec = minIndex === 0 ? "HEAD" : `${upstream}..HEAD`;
      const newRangeCommits = gitExecFile(path, ["rev-list", "--reverse", newRangeSpec], { timeout: 30000 }).split("\n").filter(Boolean);
      const rangeStartIndex = minIndex === 0 ? 0 : minIndex;
      const selectedStartInRange = minIndex - rangeStartIndex;
      const newSquashed = newRangeCommits[selectedStartInRange] || "";
      if (!newSquashed) throw new Error("无法定位合并后的提交");
      const newIndexByOld = new Map();
      for (let i = 0; i < rangeCommits.length; i++) {
        const newIndex = i < selectedStartInRange
          ? i
          : i < selectedStartInRange + selectedOrdered.length
            ? selectedStartInRange
            : i - selectedOrdered.length + 1;
        newIndexByOld.set(rangeCommits[i], newRangeCommits[newIndex] || "");
      }
      let tagUpdateError = "";
      try {
        for (const info of tagInfos) {
          if (!rewrittenSet.has(info.commit)) continue;
          const newTarget = newIndexByOld.get(info.commit);
          if (!newTarget) continue;
          const selectedTag = selectedSet.has(info.commit);
          const versionTag = !!normalizeVersionTag(info.name);
          if (selectedTag && versionTag) {
            if (requestedVersion && info.name === requestedVersion) gitExecFile(path, ["update-ref", `refs/tags/${info.name}`, newSquashed], { timeout: 10000 });
            else gitExecFile(path, ["update-ref", "-d", `refs/tags/${info.name}`], { timeout: 10000 });
          } else {
            gitExecFile(path, ["update-ref", `refs/tags/${info.name}`, newTarget], { timeout: 10000 });
          }
        }
        if (requestedVersion) {
          gitExecFile(path, ["update-ref", `refs/tags/${requestedVersion}`, newSquashed], { timeout: 10000 });
        }
      } catch (e) {
        tagUpdateError = commandErrorText(e) || "版本号更新失败";
      }
      const rewrittenCount = rangeCommits.length;
      const tagDetail = requestedVersion ? `，版本号已更新为 ${requestedVersion.replace(/^v/, "")}` : selectedVersionTags.length ? "，选中提交上的版本号已清理" : "";
      return c.json({
        ok: true,
        branch,
        originalHead,
        newHead,
        newSquashed,
        selectedCommits: selectedOrdered,
        rewrittenCount,
        backupRef,
        tag: requestedVersion || "",
        tagUpdateError,
        message: `已合并 ${selectedOrdered.length} 条连续提交${tagDetail}${tagUpdateError ? `；${tagUpdateError}` : ""}，并重写了后续 ${rewrittenCount} 条提交。如该分支已推送远程，后续需要使用 force-with-lease 推送。`,
      });
    } catch (e) {
      if (rebaseCompleted) {
        return c.json({ ok: true, code: "SQUASH_COMPLETED", backupRef, message: `提交合并已经完成，但后续处理出现异常：${commandErrorText(e) || "未知错误"}。请刷新提交记录确认；备份引用为 ${backupRef}` });
      }
      const recoveryMessage = recoverAfterFailure();
      return c.json({ ok: false, code: "SQUASH_FAILED", backupRef, recovered: !recoveryMessage, message: `合并历史提交失败：${commandErrorText(e) || "Git rebase 执行失败"}${recoveryMessage ? `；${recoveryMessage}` : "；已恢复到操作前状态"}` });
    } finally {
      cleanupTempEditors();
      releaseLock();
    }
  });

  // ======== API: 修改较早历史提交的说明（非交互式 git rebase -i / reword） ========
  app.post("/api/commit-reword", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const message = String(body.message || "").trim();
    const expectedHash = String(body.expectedHash || "").trim();
    const rawCurrentTag = String(body.currentTag || "").trim();
    const currentTag = rawCurrentTag ? normalizeVersionTag(rawCurrentTag) : "";
    const requestedVersion = body.version === undefined ? undefined : normalizeVersionTag(body.version);
    const allowMove = body.allowMove === true;

    if (!message) return c.json({ ok: false, message: "提交消息不能为空" });
    if (rawCurrentTag && currentTag === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "当前版本号格式不正确" });
    if (requestedVersion === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "版本号格式错误，正确格式如 1.2.3" });
    if (!/^[0-9a-f]{4,64}$/i.test(expectedHash)) {
      return c.json({ ok: false, message: "提交 hash 格式不正确" });
    }

    const releaseLock = tryAcquireRewordLock(path);
    if (!releaseLock) {
      return c.json({ ok: false, code: "REWORD_IN_PROGRESS", message: "当前仓库正在进行历史提交说明修改，请等待当前操作完成" });
    }

    let backupRef = "";
    let originalHead = "";
    let sourceTag = currentTag;
    let targetTag = requestedVersion === undefined ? currentTag : requestedVersion;
    let rebaseStarted = false;
    let rebaseCompleted = false;
    let sequenceEditorFile = null;
    let messageEditorFile = null;
    let messageContentFile = null;
    let startBranch = "";
    let startHead = "";
    let startGitDir = "";

    const cleanupTempEditors = () => {
      for (const file of [sequenceEditorFile, messageEditorFile, messageContentFile]) {
        if (file) { try { unlinkSync(file); } catch {} }
      }
    };

    const recoverAfterFailure = () => {
      if (!rebaseStarted || !originalHead) return "";
      try {
        const currentBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
        const currentGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
        const rebaseIdentity = getRebaseIdentity(path);
        const currentBranchMatches = currentBranch === startBranch || !currentBranch;
        const belongsToThisRequest = currentBranchMatches
          && currentGitDir === startGitDir
          && rebaseIdentity
          && rebaseIdentity.headName === `refs/heads/${startBranch}`
          && rebaseIdentity.originalHead === startHead;
        if (!belongsToThisRequest) {
          return `未自动恢复：仓库状态已发生变化，请检查当前 Git 状态；原始备份引用为 ${backupRef}`;
        }
        gitExecFile(path, ["rebase", "--abort"], { timeout: 30000 });
        const restoredHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
        if (restoredHead !== originalHead) {
          return `rebase 已终止但 HEAD 未回到原位置，请使用备份引用 ${backupRef} 恢复`;
        }
        return "";
      } catch (e) {
        return `自动恢复失败，请使用备份引用 ${backupRef} 恢复：${commandErrorText(e)}`;
      }
    };

    try {
      // 只允许在明确的本地分支上修改历史，避免 detached HEAD 下用户找不到新历史。
      const branch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!branch) {
        return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到一个本地分支" });
      }

      // rebase / merge / cherry-pick / revert / bisect 未完成时，不允许嵌套历史重写。
      const operationState = getGitOperationState(path);
      if (operationState) {
        return c.json({ ok: false, code: "GIT_OPERATION_IN_PROGRESS", message: `当前 Git 正在进行 ${operationState} 操作，请先完成或终止它` });
      }

      // 历史重写不能混入当前工作区的任何内容，也不自动 stash。
      const status = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"], { timeout: 10000 });
      if (status) {
        return c.json({ ok: false, code: "DIRTY", message: "当前工作区不干净，请先提交或暂存这些修改后再修改历史提交说明" });
      }

      const localName = gitExecFile(path, ["config", "user.name"], { timeout: 10000 });
      const localEmail = gitExecFile(path, ["config", "user.email"], { timeout: 10000 });
      if (!localName || !localEmail) {
        return c.json({ ok: false, code: "NO_IDENTITY", message: "Git 还未设置你的姓名和邮箱" });
      }

      originalHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
      startBranch = branch;
      startHead = originalHead;
      startGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
      const targetHash = gitExecFile(path, ["rev-parse", "--verify", `${expectedHash}^{commit}`], { timeout: 10000 });
      try {
        gitExecFile(path, ["merge-base", "--is-ancestor", targetHash, originalHead], { timeout: 10000 });
      } catch {
        return c.json({ ok: false, code: "NOT_REACHABLE", message: "目标提交不在当前分支的历史中" });
      }

      if (sourceTag) {
        let sourceTarget = "";
        try { sourceTarget = getTagCommit(path, sourceTag); } catch {}
        if (sourceTarget !== targetHash) {
          return c.json({ ok: false, code: "TAG_CHANGED", message: `版本号 ${sourceTag.replace(/^v/, "")} 已不再指向这条提交，请刷新后重试` });
        }
        try {
          if (gitExecFile(path, ["cat-file", "-t", `refs/tags/${sourceTag}`], { timeout: 10000 }) !== "commit") {
            return c.json({ ok: false, code: "ANNOTATED_TAG", message: `版本号 ${sourceTag.replace(/^v/, "")} 是 annotated tag，当前暂不自动改写，请手动处理` });
          }
        } catch {
          return c.json({ ok: false, code: "TAG_CHANGED", message: `版本号 ${sourceTag.replace(/^v/, "")} 不存在，请刷新后重试` });
        }
      }
      const tagConflict = inspectTagConflict(path, targetTag, targetHash, sourceTag);
      if (tagConflict && !(tagConflict.oldHistory && allowMove)) {
        return c.json({ ok: false, code: tagConflict.oldHistory ? "OLD_TAG_EXISTS" : "TAG_EXISTS", conflict: tagConflict, message: tagConflict.message });
      }

      // 当前版本只支持线性历史。merge commit 需要单独设计拓扑保留策略，先安全拒绝。
      const targetParentLine = gitExecFile(path, ["rev-list", "--parents", "-n", "1", targetHash], { timeout: 10000 }).trim();
      const isRoot = targetParentLine.split(/\s+/).length === 1;
      const rangeSpec = isRoot ? "HEAD" : `${targetHash}^..HEAD`;
      const originalRangeCommits = gitExecFile(path, ["rev-list", "--reverse", rangeSpec], { timeout: 30000 })
        .split("\n").filter(Boolean);
      const targetIndex = isRoot
        ? gitExecFile(path, ["rev-list", "--reverse", "HEAD"], { timeout: 30000 }).split("\n").filter(Boolean).indexOf(targetHash)
        : 0;
      const commitParents = gitExecFile(path, ["rev-list", "--parents", rangeSpec], { timeout: 30000 })
        .split("\n").filter(Boolean);
      if (targetIndex < 0 || originalRangeCommits.length === 0) {
        return c.json({ ok: false, code: "NOT_REACHABLE", message: "无法确定目标提交在当前分支历史中的位置" });
      }
      if (commitParents.some(line => line.trim().split(/\s+/).length > 2)) {
        return c.json({ ok: false, code: "MERGE_HISTORY", message: "当前版本暂不支持包含 merge commit 的历史，请先在纯线性分支上操作" });
      }

      // 标签仍然指向旧 commit，插件不自动移动或删除它们，只在结果中明确提示。
      const rewrittenCommits = new Set(
        gitExecFile(path, ["rev-list", rangeSpec], { timeout: 30000 }).split(String.fromCharCode(10)).filter(Boolean)
      );
      const staleTags = [];
      let tagNames = [];
      try { tagNames = gitExecFile(path, ["tag"], { timeout: 10000 }).split(String.fromCharCode(10)).filter(Boolean); } catch {}
      for (const tag of tagNames) {
        try {
          const tagCommit = gitExecFile(path, ["rev-parse", `${tag}^{commit}`], { timeout: 10000 });
          if (rewrittenCommits.has(tagCommit)) staleTags.push(tag);
        } catch {}
      }

      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      backupRef = `refs/backup/git-save-load/reword-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
      gitExecFile(path, ["update-ref", backupRef, originalHead], { timeout: 10000 });

      // Git 的交互式 rebase 通过两个编辑器完成：sequence editor 把目标行改成 reword，
      // message editor 把目标提交的说明替换为用户输入。两者均使用临时 Node 脚本，避免打开外部编辑器。
      sequenceEditorFile = join(tmpdir(), `git-sl-reword-sequence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      messageEditorFile = join(tmpdir(), `git-sl-reword-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      writeFileSync(sequenceEditorFile, [
        "const fs = require('node:fs');",
        "const todo = process.argv[2];",
        "const target = String(process.env.GIT_SAVE_LOAD_REWORD_TARGET || '').toLowerCase();",
        "let text = fs.readFileSync(todo, 'utf8');",
        "let changed = false;",
        "text = text.split(/\\r?\\n/).map(line => {",
        "  const m = line.match(/^(\\s*)(pick|reword|edit)\\s+([0-9a-f]+)(\\s+.*)?$/i);",
        "  if (m && target.startsWith(m[3].toLowerCase())) { changed = true; return m[1] + 'reword ' + m[3] + (m[4] || ''); }",
        "  return line;",
        "}).join('\\n');",
        "if (!changed) { console.error('目标提交未出现在 rebase todo 中'); process.exit(2); }",
        "fs.writeFileSync(todo, text, 'utf8');",
        "",
      ].join("\n"), "utf8");
      writeFileSync(messageEditorFile, [
        "const fs = require('node:fs');",
        "const target = process.argv[2];",
        "const source = process.env.GIT_SAVE_LOAD_REWORD_MESSAGE_FILE;",
        "if (!target || !source) process.exit(2);",
        "fs.copyFileSync(source, target);",
        "",
      ].join("\n"), "utf8");

      const quoteCommandPath = value => `"${String(value).replace(/"/g, '\\\"')}"`;
      const editorEnv = {
        GIT_SAVE_LOAD_REWORD_TARGET: targetHash,
      };
      messageContentFile = join(tmpdir(), `git-sl-reword-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      editorEnv.GIT_SAVE_LOAD_REWORD_MESSAGE_FILE = messageContentFile;
      writeFileSync(messageContentFile, message, "utf8");
      editorEnv.GIT_SEQUENCE_EDITOR = `${quoteCommandPath(process.execPath)} ${quoteCommandPath(sequenceEditorFile)}`;
      editorEnv.GIT_EDITOR = `${quoteCommandPath(process.execPath)} ${quoteCommandPath(messageEditorFile)}`;

      const upstream = isRoot ? "" : gitExecFile(path, ["rev-parse", `${targetHash}^`], { timeout: 10000 });
      const rebaseArgs = ["rebase", "-i"];
      if (isRoot) rebaseArgs.push("--root");
      else rebaseArgs.push(upstream);
      rebaseStarted = true;
      try {
        gitExecFileWithEnv(path, rebaseArgs, editorEnv, { timeout: 300000 });
      } catch (e) {
        // 只有 rebase 命令本身失败，才进入外层恢复逻辑。
        throw e;
      }
      // 从这一行开始，rebase 已经成功结束；后续任何信息读取失败都不能再 abort/reset。
      rebaseCompleted = true;

      try {
        const newHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
        const newRange = isRoot ? "HEAD" : `${upstream}..HEAD`;
        const newRangeCommits = gitExecFile(path, ["rev-list", "--reverse", newRange], { timeout: 30000 }).split("\n").filter(Boolean);
        const newTarget = newRangeCommits[targetIndex] || "";
        if (!newTarget) throw new Error("无法定位 reword 后的目标提交");

        // tag 更新必须在 rebase 成功后尽早执行；后续读取元信息失败也不能让版本号停留在旧提交。
        let tagUpdateError = "";
        if (sourceTag || targetTag) {
          try { moveLightweightTag(path, sourceTag, targetTag, newTarget); }
          catch (e) { tagUpdateError = commandErrorText(e) || "版本号更新失败"; }
        }

        const newMessage = gitExecFile(path, ["log", "-1", "--format=%s", newTarget], { timeout: 10000 });
        const rewrittenCount = parseInt(gitExecFile(path, ["rev-list", "--count", newRange], { timeout: 10000 }), 10) || 0;
        const tagWarning = staleTags.length && !sourceTag ? `；以下旧 tag 仍指向旧历史：${staleTags.join("、")}` : "";
        const tagDetail = tagUpdateError ? `；版本号更新失败：${tagUpdateError}，请手动检查 tag` : targetTag ? `，版本号已更新为 ${targetTag.replace(/^v/, "")}` : sourceTag ? "，版本号已删除" : "";

        return c.json({
          ok: true,
          branch,
          originalHead,
          newHead,
          targetHash,
          newTarget,
          newMessage,
          rewrittenCount,
          backupRef,
          staleTags,
          tag: targetTag || "",
          tagUpdateError,
          message: `已修改历史提交说明${tagDetail}，重写了 ${rewrittenCount} 条提交${tagWarning}。如该分支已推送远程，后续需要使用 force-with-lease 推送。`,
        });
      } catch (e) {
        // 历史已经改完；保留备份引用并报告结果读取失败，绝不把成功的 reword 回滚掉。
        let currentHead = "";
        try { currentHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 }); } catch {}
        return c.json({
          ok: true,
          code: "REWORD_RESULT_READ_FAILED",
          branch,
          originalHead,
          newHead: currentHead,
          targetHash,
          backupRef,
          staleTags,
          tag: targetTag || "",
          message: `历史提交说明已经修改成功${targetTag ? `，版本号目标为 ${targetTag.replace(/^v/, "")}` : sourceTag ? "，版本号已删除" : ""}，但读取新历史详情失败：${commandErrorText(e) || "无法读取 Git 结果"}。请刷新提交记录确认；备份引用为 ${backupRef}`,
        });
      }
    } catch (e) {
      if (rebaseCompleted) {
        // 防御性分支：任何未来新增的 rebase 后处理异常，也不能触发恢复。
        return c.json({
          ok: true,
          code: "REWORD_COMPLETED",
          backupRef,
          message: `历史提交说明已经修改完成，但后续处理出现异常：${commandErrorText(e) || "未知错误"}。请刷新提交记录确认；备份引用为 ${backupRef}`,
        });
      }
      const recoveryMessage = recoverAfterFailure();
      return c.json({
        ok: false,
        code: "REWORD_FAILED",
        backupRef,
        recovered: !recoveryMessage,
        message: `修改历史提交说明失败：${commandErrorText(e) || "Git rebase 执行失败"}${recoveryMessage ? `；${recoveryMessage}` : "；已恢复到操作前状态"}`,
      });
    } finally {
      cleanupTempEditors();
      releaseLock();
    }
  });

  registerHistoryRoutes(app, { repoPath, gitExecFile });

  // ======== API: 回滚 ========
  app.post("/api/reset", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const commit = String(body.commit || "").trim();
    const mode = ["soft", "mixed", "hard"].includes(body.mode) ? body.mode : "mixed";

    if (!commit) {
      return c.json({ ok: false, message: "请指定要回滚到的提交 hash" });
    }

    try {
      if (!/^[0-9a-f]{4,64}$/i.test(commit)) return c.json({ ok: false, message: "提交 hash 格式不正确" });
      gitExecFile(path, ["cat-file", "-t", commit]);
      const before = gitExecFile(path, ["log", "--oneline", "-n", "1"]);
      const target = gitExecFile(path, ["log", "--oneline", "-n", "1", commit]);
      gitExecFile(path, ["reset", `--${mode}`, commit]);

      // 清理回滚后失效的 tag（指向历史外 commit 的 tag）
      const cleanedTags = [];
      try {
        const tagRaw = gitExecFile(path, ["tag", "--format=%(objectname:short)|%(refname:short)"]);
        for (const line of tagRaw.split("\n").filter(Boolean)) {
          const [h, t] = line.split("|");
          if (!h || !t) continue;
          try {
            gitExecFile(path, ["merge-base", "--is-ancestor", h, "HEAD"]);
          } catch {
            gitExecFile(path, ["tag", "-d", t]);
            cleanedTags.push(t);
          }
        }
      } catch {}

      return c.json({
        ok: true,
        mode,
        before,
        target,
        cleanedTags,
        warning: mode === "hard" ? "已丢弃回滚点之后的所有未提交变更" : undefined,
      });
    } catch (e) {
      return c.json({ ok: false, message: `回滚失败：${e.message}` });
    }
  });

  // ======== API: diff ========
  app.get("/api/diff", async (c) => {
    const path = repoPath(c.req.query("path"));
    const file = String(c.req.query("file") || "").trim();

    try {
      const diffArgs = ["-c", "core.quotepath=false", "diff"];
      const diff = gitExecFile(path, [...diffArgs, "--stat", ...(file ? ["--", file] : [])]);
      const diffDetail = gitExecFile(path, [...diffArgs, ...(file ? ["--", file] : [])]);
      return c.json({ ok: true, file: file || null, summary: diff || "(no diff)", detail: diffDetail || "(no diff)" });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // ======== API: 对比两个版本 ========
  app.get("/api/compare", async (c) => {
    const path = repoPath(c.req.query("path"));
    const from = String(c.req.query("from") || "").trim();
    const to = String(c.req.query("to") || "").trim();
    if (!from || !to) return c.json({ ok: false, message: "请指定两个 hash" });
    try {
      const range = `${from}..${to}`;
      const stat = gitExecFile(path, ["-c", "core.quotepath=false", "diff", "--stat", range]);
      const detail = gitExecFile(path, ["-c", "core.quotepath=false", "diff", range]);
      // 文件级统计
      const fileStats = [];
      const numstat = gitExecFile(path, ["-c", "core.quotepath=false", "diff", "--numstat", range]);
      for (const line of numstat.split("\n").filter(Boolean)) {
        const [added, deleted, ...nameParts] = line.split("\t");
        const name = nameParts.join("\t");
        if (name) fileStats.push({ name, added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 });
      }
      return c.json({ ok: true, stat: stat || "(无差异)", detail: detail || "(无差异)", fileStats });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
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
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
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

  // ======== API: 检测冲突文件 ========
  app.get("/api/conflicts", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      const statusRaw = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--short"]);
      const conflictFiles = statusRaw.split("\n")
        .filter(line => {
          const s = line.trim().slice(0, 2);
          return s.includes("U");
        })
        .map(line => ({ raw: line, name: line.slice(2).trim() }));

      const conflicts = [];
      for (const { raw, name } of conflictFiles) {
        const content = readFileSync(join(path, name), "utf8");
        const blocks = [];
        const re = /<<<<<<<\s+(\S+)\s*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>>\s+(\S+)\s*/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          blocks.push({
            headLabel: m[1],
            headContent: m[2],
            theirLabel: m[4],
            theirContent: m[3],
          });
        }
        conflicts.push({ file: name, blocks, rawStatus: raw.trim().slice(0, 2) });
      }

      return c.json({ ok: true, conflicts, hasConflicts: conflicts.length > 0 });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // ======== API: 解决冲突 ========
  app.post("/api/conflict-resolve", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repo = repoPath(body.path);
    const file = String(body.file || "").trim();
    const picks = body.picks; // [{ blockIndex, side: "head"|"their" }]

    if (!file || !picks || !Array.isArray(picks)) {
      return c.json({ ok: false, message: "缺少参数" });
    }

    try {
      const repoRoot = gitExecFile(repo, ["rev-parse", "--show-toplevel"], { timeout: 10000 });
      const filePath = join(repoRoot, file);
      const normalizedRoot = repoRoot.replace(/[\\/]+$/, "").toLowerCase();
      const normalizedFile = filePath.toLowerCase();
      if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(normalizedRoot + "\\") && !normalizedFile.startsWith(normalizedRoot + "/")) {
        return c.json({ ok: false, message: "文件路径必须位于当前仓库内" });
      }
      let content = readFileSync(filePath, "utf8");

      // 从后往前替换，避免 index 错位
      const re = /<<<<<<<\s+\S+\s*\r?\n[\s\S]*?=======\r?\n[\s\S]*?>>>>>>>\s+\S+\s*/g;
      const matches = [...content.matchAll(re)];

      // 按 picks 替换
      for (const pick of picks) {
        const idx = pick.blockIndex;
        const side = pick.side; // "head" or "their"
        if (idx >= matches.length) continue;

        const rawBlock = matches[idx][0];
        // 解析出保留的内容
        const innerRe = /<<<<<<<\s+\S+\s*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>>\s+\S+\s*/;
        const inner = rawBlock.match(innerRe);
        if (!inner) continue;
        const keep = side === "head" ? inner[1] : inner[2];
        // 替换整块为保留的内容（去除末尾多余换行）
        content = content.replace(rawBlock, keep.replace(/\n$/, ""));
      }

      writeFileSync(filePath, content, "utf8");
      gitExecFile(repo, ["add", "--", file]);

      return c.json({ ok: true, message: `${file} 冲突已解决` });
    } catch (e) {
      return c.json({ ok: false, message: `解决失败：${e.message}` });
    }
  });

  // ======== API: 读写仓库路径配置 ========
  app.get("/api/repo", async (c) => {
    const repoPath = await readRepoPath(ctx);
    return c.json({ ok: true, repoPath });
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

  // ======== API: GitHub 管理 ========
  // gh 自己会读取 GitHub CLI 的登录配置。不要把 Git 的用户级代理强行注入 gh，
  // 否则可能与 gh 的网络实现或本机代理状态冲突，导致 GraphQL 返回 EOF。
  function ghExec(args, opts = {}) {
    return execFileSync(resolveGhPath(), args, {
      encoding: "utf8",
      timeout: opts.timeout || 30000,
      windowsHide: true,
      env: ghEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
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
        localHasCommit = hasHeadCommit(localPath);
        if (license && localHasCommit) {
          localLicense = applyLicenseToLocalRepo(localPath, license);
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
        const raw = readLicenseFile(process.cwd(), license);
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

  // ======== API: 读取本地远程仓库列表 ========
  app.get("/api/remotes", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      gitExecFile(path, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      const branch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      const preferredRemote = String(c.req.query("remote") || "").trim();
      const preferredBranch = String(c.req.query("remoteBranch") || "").trim();
      const remotes = listRemoteDetails(path);
      const settings = await readRemoteSettings(ctx, path, remotes.map(remoteInfo => remoteInfo.name));
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
    } catch (e) {
      return c.json({ ok: false, message: commandErrorText(e) || "读取远程仓库失败" });
    }
  });

  // ======== API: 设置默认推送或获取远程 ========
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
      const settings = await readRemoteSettings(ctx, path, names);
      const roles = { ...settings.roles };
      if (role === "push-target") {
        Object.keys(roles).forEach(name => { if (roles[name] === "push-target") roles[name] = "other"; });
        roles[remote] = "push-target";
        settings.pushRemote = remote;
      } else if (role === "update-source") {
        Object.keys(roles).forEach(name => { if (roles[name] === "update-source") roles[name] = "other"; });
        roles[remote] = "update-source";
        settings.fetchRemote = remote;
      } else {
        if (settings.pushRemote === remote) settings.pushRemote = names.find(name => name !== remote) || "";
        if (settings.fetchRemote === remote) settings.fetchRemote = names.find(name => name !== remote) || "";
        if (roles[remote]) roles[remote] = "other";
      }
      settings.roles = roles;
      await writeRemoteSettings(ctx, path, settings);
      return c.json({ ok: true, remote, role, pushRemote: settings.pushRemote, fetchRemote: settings.fetchRemote, message: role === "push-target" ? `已将 ${remote} 设为默认推送目标` : (role === "update-source" ? `已将 ${remote} 设为默认获取来源` : `已取消 ${remote} 的特殊角色`) });
    } catch (e) {
      return c.json({ ok: false, message: `设置远程角色失败：${commandErrorText(e) || "无法保存远程角色"}` });
    }
  });

  // ======== API: 获取指定远程的最新提交 ========
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
    } catch (e) {
      return c.json({ ok: false, message: `获取更新失败：${commandErrorText(e) || "无法访问远程仓库"}` });
    }
  });

  // ======== API: 将指定远程分支合并到当前本地分支 ========
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
      const status = gitExecFile(path, ["status", "--porcelain"], { timeout: 10000 });
      if (status) return c.json({ ok: false, code: "DIRTY", message: "当前工作区有未提交修改，请先存档、暂存或清理后再合并上游更新" });
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

  // ======== API: 删除本地远程仓库关联 ========
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
    } catch (e) {
      return c.json({ ok: false, message: `移除远程失败：${commandErrorText(e) || "远程不存在"}` });
    }
  });

  // ======== API: 读写配置 ========
  app.get("/api/config", async (c) => {
    try {
      return c.json({ ok: true, config: await readConfig(ctx) });
    } catch { return c.json({ ok: true, config: {} }); }
  });

  app.post("/api/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const current = await readConfig(ctx);
      const merged = { ...current, ...body };
      await writeConfig(ctx, merged);
      return c.json({ ok: true, config: merged });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  // ======== API: 分支管理 ========
  app.get("/api/branches", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      const current = gitExecFile(path, ["branch", "--show-current"]);
      const raw = gitExecFile(path, ["branch"]);
      const branches = raw.split("\n").filter(Boolean).map(line => ({
        name: line.replace(/^\*?\s*/, "").trim(),
        current: line.trimStart().startsWith("*"),
      }));
      // 对每个分支获取最后一条提交消息
      for (const b of branches) {
        try {
          const logMsg = gitExecFile(path, ["log", "-1", "--format=%s", b.name], { timeout: 10000 });
          b.lastCommit = logMsg || "";
          b.lastHash = gitExecFile(path, ["log", "-1", "--format=%h", b.name], { timeout: 10000 });
        } catch { b.lastCommit = ""; b.lastHash = ""; }
      }
      return c.json({ ok: true, branches, current });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  app.post("/api/branch/switch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定分支名" });
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      gitExecFile(path, ["checkout", name]);
      return c.json({ ok: true, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `切换失败：${e.message}` });
    }
  });

  app.post("/api/branch/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定新分支名" });
    const startPoint = String(body.startPoint || "").trim();
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      const args = ["branch", name];
      if (startPoint) args.push(startPoint);
      gitExecFile(path, args);
      return c.json({ ok: true, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `创建失败：${e.message}` });
    }
  });

  app.post("/api/branch/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定分支名" });
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      gitExecFile(path, ["branch", "-D", name]);
      return c.json({ ok: true, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `删除失败：${e.message}` });
    }
  });

  // ======== API: 远程同步状态 ========
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
      if (!remoteBranch) {
        return c.json({ ok: true, branch: targetBranch, targetBranch, remote, remoteBranch: requestedRemoteBranch, remoteUrl: sanitizeRemoteUrl(remoteUrl), hasUpstream: false, ahead: 0, behind: 0, diverged: false, comparisonStatus: "REMOTE_BRANCH_MISSING", branches, message: "远程分支尚未建立" });
      }
      const snapshot = getRemoteBranchSnapshot(path, remote, remoteBranch, targetBranch);
      return c.json({
        ok: true,
        branch: targetBranch,
        targetBranch,
        remote,
        remoteBranch,
        remoteUrl: sanitizeRemoteUrl(remoteUrl),
        remoteHash: snapshot.remoteHash,
        hasUpstream: snapshot.hasRemoteBranch,
        ahead: snapshot.localAhead,
        behind: snapshot.remoteAhead,
        diverged: snapshot.localAhead > 0 && snapshot.remoteAhead > 0,
        comparisonStatus: snapshot.comparisonStatus,
        commits: snapshot.commits,
        files: snapshot.files,
      });
    } catch (e) {
      return c.json({ ok: false, message: commandErrorText(e) || "获取远程状态失败" });
    }
  });

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

  // ======== 在默认浏览器中打开 URL ========
  app.get("/api/open-external", async (c) => {
    // Kept for compatibility with the existing UI. New UI code should prefer
    // hana.external.open(), which is capability-gated by the host.
    const url = String(c.req.query("url") || "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return c.json({ ok: false, message: "只允许打开 http/https 链接" });
    try {
      execFileSync("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, timeout: 10000 });
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

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

  // ======== API: Stash ========
  app.get("/api/stash/list", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      const raw = gitExecFile(path, ["stash", "list"]);
      if (!raw) return c.json({ ok: true, stashes: [] });
      const stashes = raw.split("\n").filter(Boolean).map((line, i) => {
        const idx = line.match(/stash@\{(\d+)\}/);
        const msg = line.replace(/^stash@\{\d+\}:[^:]*:\s*/, "");
        return { index: parseInt(idx?.[1] ?? i), message: msg || line };
      });
      return c.json({ ok: true, stashes });
    } catch (e) { return c.json({ ok: true, stashes: [] }); }
  });

  app.post("/api/stash/push", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const msg = String(body.message || "").trim();
    try {
      const args = ["stash", "push", "-u"];
      if (msg) args.push("-m", msg);
      gitExecFile(path, args);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "暂存失败" }); }
  });

  app.post("/api/stash/pop", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const idx = parseInt(body.index);
    if (!Number.isInteger(idx) || idx < 0) return c.json({ ok: false, message: "暂存索引无效" });
    try {
      gitExecFile(path, ["stash", "pop", `stash@{${idx}}`]);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "恢复暂存失败" }); }
  });

  app.post("/api/stash/drop", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const idx = parseInt(body.index);
    if (!Number.isInteger(idx) || idx < 0) return c.json({ ok: false, message: "暂存索引无效" });
    try {
      gitExecFile(path, ["stash", "drop", `stash@{${idx}}`]);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "删除暂存失败" }); }
  });

  // 返回插件版本号（从 manifest.json 读取）
  app.get("/api/plugin-version", async (c) => {
    try {
      const manifestPath = join(__dirname, "..", "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      return c.json({ ok: true, version: manifest.version || "unknown" });
    } catch (e) {
      return c.json({ ok: false, version: "unknown" });
    }
  });
}
