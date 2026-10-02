// git-tools / tools / _helpers.js
// 工具辅助函数集合。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 解析仓库路径。
 * 优先使用 input.path，否则使用当前工作目录。
 */
export async function resolvePath(input = {}, ctx = {}) {
  const explicit = input.path && String(input.path).trim();
  if (explicit) return explicit;
  let configured = "";
  try { configured = await ctx.config?.get?.("repoPath"); } catch {}
  return (configured && String(configured).trim()) || process.cwd();
}

// 定位 git 可执行文件并缓存。仅当 PATH 无法解析 git 时探测常见安装位置。
// Node Permission Model 下 existsSync 对安装目录/dataDir 之外的路径会抛
// ERR_ACCESS_DENIED 而不是返回 false，探测一律走 safeExists；宿主侧的
// resolveExecutable 探测见 routes/git.js。
function safeExists(p) {
  try { return existsSync(p); } catch { return false; }
}
let _cachedGitPath = null;
export function resolveGitPath() {
  if (_cachedGitPath !== null) return _cachedGitPath;
  try {
    execFileSync("git", ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    _cachedGitPath = "git";
    return "git";
  } catch {}
  const candidates = [
    "C:\\Program Files\\Git\\cmd\\git.exe",
    join(process.env.LOCALAPPDATA || "", "Programs", "Git", "cmd", "git.exe"),
    join(process.env.LOCALAPPDATA || "", "Programs", "HanaAgent", "resources", "git", "cmd", "git.exe"),
    join(process.env.LOCALAPPDATA || "", "GitHubDesktop", "bin", "git.exe"),
    join(process.env.USERPROFILE || "", "scoop", "apps", "git", "current", "cmd", "git.exe"),
  ];
  for (const candidate of candidates) {
    if (!candidate || !safeExists(candidate)) continue;
    try {
      execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      _cachedGitPath = candidate;
      return candidate;
    } catch {}
  }
  _cachedGitPath = "git";
  return "git";
}

/**
 * 执行 git 命令（数组传参，不经过 shell）。
 * opts.env 存在时在 process.env 之上叠加（提交签名需要注入隔离 GNUPGHOME）。
 */
export function gitExec(cwd, args, opts = {}) {
  const timeout = opts.timeout || 60000;
  // maxBuffer 预留 10MB：大仓库单次提交可能包含数千文件，git log --numstat
  // 输出可超 Node 默认的 1MB，不足时报 ENOBUFS（实测 project 仓库触发过）。
  const options = {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  };
  if (opts.env) options.env = { ...process.env, ...opts.env };
  return execFileSync(resolveGitPath(), args, options).trim();
}

/**
 * 通用子进程执行（数组传参，不经过 shell），失败不抛异常，返回归一化结果。
 * 供透传工具（git_exec / gh_exec / git_push）读取 stderr 并可读化错误。
 * @returns {{ ok: boolean, code: number|null, errCode: string|null, stdout: string, stderr: string }}
 */
export function execCapture(bin, args, opts = {}) {
  const timeout = opts.timeout || 60000;
  const options = {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: opts.maxBuffer || 10 * 1024 * 1024,
  };
  if (opts.cwd) options.cwd = opts.cwd;
  if (opts.env) options.env = opts.env;
  try {
    const stdout = execFileSync(bin, args, options);
    return { ok: true, code: 0, errCode: null, stdout: String(stdout || "").trim(), stderr: "" };
  } catch (err) {
    return {
      ok: false,
      code: typeof err?.status === "number" ? err.status : null,
      errCode: err?.code || null,
      stdout: String(err?.stdout || "").trim(),
      stderr: String(err?.stderr || err?.message || "").trim(),
    };
  }
}

/** git 版 execCapture：定位 git 后执行，opts.env 叠加在 process.env 之上。 */
export function gitExecCapture(cwd, args, opts = {}) {
  const env = opts.env ? { ...process.env, ...opts.env } : undefined;
  return execCapture(resolveGitPath(), args, { ...opts, cwd, env });
}

/**
 * 归一化超时秒数：非法/缺省回落 fallbackSec，取值夹在 [1, maxSec]。
 */
export function normalizeTimeoutSec(value, fallbackSec = 60, maxSec = 600) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallbackSec;
  return Math.min(Math.max(1, Math.floor(n)), maxSec);
}

// 本 App 在宿主里的 id（manifest.id），用于从 HANA_HOME 反推数据目录。
const APP_ID = "git-save-load";

/** 读环境变量：AppHost 下读不存在的键会抛错，统一吞成空串。 */
function safeEnv(name) {
  try {
    const v = process.env[name];
    return typeof v === "string" && v ? v : "";
  } catch {
    return "";
  }
}

/**
 * 解析 App 数据目录（隔离 GPG 密钥环 / signing.json 所在）。
 * 优先用 ctx.dataDir（宿主/集成方注入时）；否则由 HANA_HOME 反推
 * <HANA_HOME>/app-data/<appId>（v2 隔离进程下该目录可写）。定位不到返回 ""。
 */
export function resolveDataDir(ctx = {}) {
  const explicit = ctx && typeof ctx.dataDir === "string" ? ctx.dataDir.trim() : "";
  if (explicit) return explicit;
  const home = safeEnv("HANA_HOME");
  if (!home) return "";
  return join(home, "app-data", APP_ID);
}

/** Windows 绝对路径 → MSYS POSIX 路径（C:\a\b → /c/a/b）；非 Windows 路径原样返回。 */
export function toPosixPath(p) {
  let s = String(p || "").replace(/\\/g, "/");
  const m = s.match(/^([A-Za-z]):\/(.*)$/);
  if (m) s = `/${m[1].toLowerCase()}/${m[2]}`;
  return s;
}

/**
 * 读取当前分支名。
 */
export function getCurrentBranch(cwd) {
  try {
    return gitExec(cwd, ["branch", "--show-current"], { timeout: 5000 });
  } catch {
    return "";
  }
}
