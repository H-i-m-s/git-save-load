// git-tools / tools / git_commit.js
// 暂存所有变更并提交。

import { resolvePath, gitExec } from "./_helpers.js";

export const name = "git_commit";
export const description = "暂存所有变更并提交。提交前先用 git_status 确认变更内容。";

export const sessionPermission = {
  kind: "review",
  describeSideEffect: () => ({
    kind: "workspace_write",
    summary: "Stage all changes and create a Git commit in the selected local repository.",
    ruleId: "workspace-git-commit",
  }),
};

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

export async function execute(input = {}, ctx = {}) {
  const cwd = await resolvePath(input, ctx);
  const message = String(input.message).trim();

  if (!message) {
    return JSON.stringify({ error: true, message: "提交消息不能为空" }, null, 2);
  }

  try {
    gitExec(cwd, ["add", "."], { timeout: 30000 });
    gitExec(cwd, ["commit", "-m", message], { timeout: 30000 });

    const log = gitExec(cwd, ["log", "--oneline", "-n", "1"], { timeout: 10000 });
    return JSON.stringify({ ok: true, commit: log, message }, null, 2);
  } catch (err) {
    if (err.message.includes("nothing to commit") || err.message.includes("nothing added")) {
      return JSON.stringify({ ok: true, message: "没有需要提交的变更", nothingToCommit: true }, null, 2);
    }
    return JSON.stringify({ error: true, message: `提交失败：${err.message}` }, null, 2);
  }
}
