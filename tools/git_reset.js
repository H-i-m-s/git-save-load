// git-tools / tools / git_reset.js
// 回滚到指定提交。默认 --soft 保留工作区修改。

import { execSync } from "node:child_process";
import { resolvePath } from "./_helpers.js";

export const name = "git_reset";
export const description = "回滚到指定提交。默认 --soft 保留工作区文件修改，--hard 会丢失所有未提交的变更（慎用）。";

export const parameters = {
  type: "object",
  properties: {
    commit: {
      type: "string",
      description: "目标提交的 hash（完整或前几位）",
    },
    mode: {
      type: "string",
      enum: ["soft", "mixed", "hard"],
      description: "重置模式：soft=保留工作区和暂存区, mixed=保留工作区清暂存区(默认), hard=丢弃所有变更(慎用)",
    },
    path: {
      type: "string",
      description: "git 仓库路径。不传则使用插件配置中保存的路径。",
    },
  },
  required: ["commit"],
};

export async function execute(input = {}) {
  const cwd = resolvePath(input);
  const commit = String(input.commit).trim();
  const mode = (input.mode && ["soft", "mixed", "hard"].includes(input.mode)) ? input.mode : "mixed";

  if (!commit) {
    return JSON.stringify({ error: true, message: "请指定要回滚到的提交 hash" }, null, 2);
  }

  try {
    // 验证 commit 是否存在
    execSync(`git cat-file -t ${commit}`, { cwd, encoding: "utf8", timeout: 10000, windowsHide: true });

    // 获取回滚前的当前提交信息
    const before = execSync("git log --oneline -n 1", { cwd, encoding: "utf8", timeout: 10000, windowsHide: true }).trim();

    // 获取目标提交信息
    const target = execSync(`git log --oneline -n 1 ${commit}`, { cwd, encoding: "utf8", timeout: 10000, windowsHide: true }).trim();

    if (mode === "hard") {
      execSync(`git reset --hard ${commit}`, { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
    } else {
      execSync(`git reset --${mode} ${commit}`, { cwd, encoding: "utf8", timeout: 30000, windowsHide: true });
    }

    return JSON.stringify({
      ok: true,
      mode,
      before,
      target,
      warning: mode === "hard" ? "已丢弃回滚点之后的所有未提交变更" : undefined,
    }, null, 2);
  } catch (err) {
    if (err.message.includes("fatal: not a git repository")) {
      return JSON.stringify({ error: true, message: "该目录不是 git 仓库" }, null, 2);
    }
    if (err.message.includes("fatal: bad revision") || err.message.includes("fatal: Not a valid object name")) {
      return JSON.stringify({ error: true, message: `提交 ${commit} 不存在` }, null, 2);
    }
    return JSON.stringify({ error: true, message: `回滚失败：${err.message}` }, null, 2);
  }
}
