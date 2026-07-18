// git-tools / tools / git_commit.js
// 暂存所有变更并提交。

import { execSync } from "node:child_process";
import { resolvePath } from "./_helpers.js";

export const name = "git_commit";
export const description = "暂存所有变更并提交。提交前先用 git_status 确认变更内容。";

export const parameters = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "提交消息。建议格式：feat:xxx / fix:xxx / chore:xxx",
    },
    path: {
      type: "string",
      description: "git 仓库路径。不传则使用插件配置中保存的路径。",
    },
  },
  required: ["message"],
};

export async function execute(input = {}) {
  const cwd = resolvePath(input);
  const message = String(input.message).trim();

  if (!message) {
    return JSON.stringify({ error: true, message: "提交消息不能为空" }, null, 2);
  }

  try {
    execSync("git add .", { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });

    const log = execSync("git log --oneline -n 1", { cwd, encoding: "utf8", timeout: 10000, windowsHide: true }).trim();
    return JSON.stringify({ ok: true, commit: log, message }, null, 2);
  } catch (err) {
    if (err.message.includes("nothing to commit") || err.message.includes("nothing added")) {
      return JSON.stringify({ ok: true, message: "没有需要提交的变更", nothingToCommit: true }, null, 2);
    }
    return JSON.stringify({ error: true, message: `提交失败：${err.message}` }, null, 2);
  }
}
