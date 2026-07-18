// git-tools / tools / _helpers.js
// 工具辅助函数集合。

import { execSync } from "node:child_process";

/**
 * 解析仓库路径。
 * 优先使用 input.path，否则使用当前工作目录。
 */
export function resolvePath(input = {}) {
  return (input.path && String(input.path).trim()) || process.cwd();
}

/**
 * 读取当前分支名。
 */
export function getCurrentBranch(cwd) {
  try {
    return execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
  } catch {
    return "";
  }
}
