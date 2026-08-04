// git-tools / tools / _helpers.js
// 工具辅助函数集合。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 解析仓库路径。
 * 优先使用 input.path，否则使用当前工作目录。
 */
export function resolvePath(input = {}) {
  return (input.path && String(input.path).trim()) || process.cwd();
}

// 定位 git 可执行文件并缓存。仅当 PATH 无法解析 git 时探测常见安装位置。
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
    if (!candidate || !existsSync(candidate)) continue;
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
 */
export function gitExec(cwd, args, opts = {}) {
  const timeout = opts.timeout || 60000;
  return execFileSync(resolveGitPath(), args, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
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
