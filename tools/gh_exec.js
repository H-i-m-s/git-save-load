// SPDX-License-Identifier: MPL-2.0
//
// 本文件包含衍生自 GitHana 的部分代码（repo 参数归一化等）：
//   GitHana: https://github.com/Nyasers/GitHana
//   Copyright (c) 2026 Nyasers，以 Mozilla Public License v. 2.0 授权。
// 本文件已由 git-save-load 修改，修改后的版本同样以 MPL-2.0 发布。完整声明见根目录 NOTICE。
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// This Source Code Form is "Incompatible With Secondary Licenses", as
// defined by the Mozilla Public License, v. 2.0.
//
// git-save-load / tools / gh_exec.js
// 任意 gh 子命令透传：args 数组直接喂给 GitHub CLI（绝不经 shell）。
// gh 可执行文件与运行环境复用 routes/github.js 的 resolveGhPath() / ghEnvironment()（只读 import）。

import { resolvePath, execCapture } from "./_helpers.js";
import { resolveGhPath, ghEnvironment } from "../routes/github.js";

export const name = "gh_exec";

export const description = [
  "通用 gh（GitHub CLI）子命令透传：args 参数数组原样传给 gh（绝不经过 shell），认证复用 gh 自身的登录态。",
  "args 首元素为子命令，如 [\"auth\",\"status\"]、[\"pr\",\"list\"]、[\"api\",\"user\"]、[\"release\",\"list\"]。",
  "repo 可选（owner/repo，转 -R 参数，优先于 cwd 推断）；path 可选（cwd，供 gh 从 git remote 推断仓库）。",
  "成功返回 stdout（已 trim），失败返回 { error:true, message } 并附带 stderr。",
  "注意：本工具原样执行，可能创建/修改 GitHub 远端状态（删仓库/合并 PR 等），执行前请确认参数。",
].join(" ");

// 危险子命令识别：命中即在审核摘要里显式标注「危险」。
function detectDanger(args) {
  const t = Array.isArray(args) ? args.map((a) => String(a)) : [];
  const a = t[0] || "";
  const b = t[1] || "";
  const hits = [];
  const pair = (x, y, label) => {
    if (a === x && b === y) hits.push(label);
  };
  pair("repo", "delete", "删除远端仓库");
  pair("pr", "merge", "合并 PR");
  pair("release", "delete", "删除 release");
  pair("secret", "delete", "删除密钥");
  pair("secret", "set", "覆盖密钥");
  pair("variable", "delete", "删除变量");
  pair("variable", "set", "覆盖变量");
  pair("cache", "delete", "清除 Actions 缓存");
  pair("run", "delete", "删除工作流运行");
  pair("gist", "delete", "删除 gist");
  pair("issue", "delete", "删除 issue");
  pair("label", "delete", "删除标签");
  pair("auth", "logout", "退出 gh 登录");
  if (a === "api" && /DELETE/i.test(t.join(" "))) hits.push("api DELETE 删除远端资源");
  return hits;
}

export const sessionPermission = {
  kind: "review",
  describeSideEffect: (input = {}) => {
    const args = Array.isArray(input?.args) ? input.args.map((a) => String(a)) : [];
    const repo = input?.repo !== undefined && input?.repo !== null ? String(input.repo).trim() : "";
    const cmdLine = ["gh", ...(repo ? ["-R", repo] : []), ...args].join(" ").trim() || "gh（未提供参数）";
    const danger = detectDanger(args);
    const summary =
      `执行 gh 子命令：${cmdLine}` +
      (danger.length ? `。危险，可能不可撤销（${danger.join("；")}）` : "") +
      "。可能读写 GitHub 远端状态，执行前请确认参数。";
    return { kind: "external_side_effect", summary, ruleId: "git-save-load-gh-exec" };
  },
};

export const parameters = {
  type: "object",
  properties: {
    args: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "gh 完整参数列表（数组，无 shell 拼接）：首元素为子命令，如 [\"auth\",\"status\"]、[\"pr\",\"list\"]、[\"api\",\"user\"]",
    },
    repo: {
      type: "string",
      description: "可选：仓库，格式 owner/repo，存在则转 -R 参数，优先于 cwd 推断。",
    },
    path: {
      type: "string",
      description: "可选：工作目录（cwd），gh 由此从 git remote 推断仓库；不传则用配置的仓库路径。",
    },
  },
  required: ["args"],
};

export async function execute(input = {}, ctx = {}) {
  const rawArgs = input?.args;
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    return JSON.stringify({ error: true, message: "args 必填且至少一个元素（gh 子命令，如 [\"auth\",\"status\"]）" }, null, 2);
  }
  let args = rawArgs.map((a) => String(a));
  const danger = detectDanger(args); // 按原始子命令识别，勿受 -R 前缀影响

  // repo 显式优先：校验 owner/repo（正好一个斜杠）后转 -R，置于子命令之前。
  const repoRaw = input?.repo !== undefined && input?.repo !== null ? String(input.repo).trim() : "";
  if (repoRaw) {
    const parts = repoRaw.split("/");
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      return JSON.stringify({ error: true, message: `repo 参数格式非法："${repoRaw}"，要求 owner/repo（正好一个斜杠）` }, null, 2);
    }
    args = ["-R", `${parts[0].trim()}/${parts[1].trim()}`, ...args];
  }

  const cwd = await resolvePath(input, ctx);

  let env;
  try {
    env = { ...ghEnvironment(), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  } catch {
    env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  }

  const r = execCapture(resolveGhPath(), args, { cwd, env, timeout: 120000 });

  if (r.ok) {
    return r.stdout;
  }

  const parts = [];
  if (r.errCode === "ENOENT") parts.push("未找到 gh 可执行文件：请确认 GitHub CLI 已安装并在 PATH 中。");
  parts.push(`gh ${args.join(" ")} 执行失败（exit code ${r.code === null ? "N/A" : r.code}）`);
  if (danger.length) parts.push(`（危险命令：${danger.join("；")}）`);
  return JSON.stringify(
    {
      error: true,
      message: parts.join("："),
      code: r.code,
      stderr: r.stderr,
      stdout: r.stdout,
    },
    null,
    2,
  );
}
