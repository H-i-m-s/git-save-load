// git-tools / tools / git_log.js
// 查看 git 提交历史。

import { execSync } from "node:child_process";
import { resolvePath } from "./_helpers.js";

export const name = "git_log";
export const description = "查看 git 提交历史。返回最近 n 条提交的 hash、消息、作者、日期。";

export const parameters = {
  type: "object",
  properties: {
    count: {
      type: "number",
      description: "返回的提交数量，默认 20。",
    },
    path: {
      type: "string",
      description: "git 仓库路径。不传则使用插件配置中保存的路径。",
    },
  },
  required: [],
};

export async function execute(input = {}) {
  const cwd = resolvePath(input);
  const count = Number.isFinite(input.count) ? Math.min(Math.max(1, input.count), 100) : 20;

  try {
    const format = "%h|%s|%an|%ai";
    const raw = execSync(
      `git log --oneline --format="${format}" -n ${count}`,
      { cwd, encoding: "utf8", timeout: 10000, windowsHide: true }
    ).trim();

    if (!raw) {
      return JSON.stringify({ error: true, message: "没有提交记录" }, null, 2);
    }

    const commits = raw.split("\n").map((line) => {
      const [hash, ...rest] = line.split("|");
      const message = rest.slice(0, -2).join("|") || "(no message)";
      const author = rest[rest.length - 2] || "";
      const date = rest[rest.length - 1] || "";
      return { hash, message, author, date };
    });

    return JSON.stringify({ repo: cwd, total: commits.length, commits }, null, 2);
  } catch (err) {
    return JSON.stringify({ error: true, message: `获取提交历史失败：${err.message}` }, null, 2);
  }
}
