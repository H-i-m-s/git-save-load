// git-tools / tools / git_status.js
// 查看当前 git 工作区状态。

import { execSync } from "node:child_process";
import { resolvePath } from "./_helpers.js";

export const name = "git_status";
export const description = "查看当前 git 工作区状态：分支、变更文件、暂存区。";

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "git 仓库路径。不传则使用插件配置中保存的路径。",
    },
  },
  required: [],
};

export async function execute(input = {}) {
  const cwd = resolvePath(input);

  try {
    const branch = execSync("git branch --show-current", { cwd, encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
    const statusShort = execSync("git -c core.quotepath=false status --short", { cwd, encoding: "utf8", timeout: 5000, windowsHide: true }).trim();

    const changed = [];
    const untracked = [];
    if (statusShort) {
      for (const line of statusShort.split("\n")) {
        const t = line.trim();
        if (t.startsWith("??")) untracked.push(t.slice(2).trim());
        else changed.push(t);
      }
    }

    return JSON.stringify({
      ok: true,
      repo: cwd,
      branch: branch || "(no branch)",
      changedCount: changed.length,
      untrackedCount: untracked.length,
      changed,
      untracked,
    }, null, 2);
  } catch (err) {
    if (err.message.includes("not a git repository")) {
      return JSON.stringify({ error: true, message: "该目录不是 git 仓库" }, null, 2);
    }
    return JSON.stringify({ error: true, message: `获取状态失败：${err.message}` }, null, 2);
  }
}
