// SPDX-License-Identifier: MPL-2.0
//
// 本文件包含参考 GitHana 同名文件的接口定义（timeoutSec 参数与工具声明形状）：
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
// git-save-load / tools / git_exec.js
// 任意 git 子命令透传：args 数组直接喂给 git（绝不经 shell），覆盖长尾操作。

import { resolvePath, gitExecCapture, normalizeTimeoutSec } from "./_helpers.js";

export const name = "git_exec";

export const description = [
  "通用 git 子命令透传：args 参数数组原样传给本地 git（绝不经过 shell，无拼接/无注入）。",
  "args 首元素为子命令，如 [\"status\",\"--porcelain\"]、[\"log\",\"--oneline\",\"-3\"]、[\"diff\",\"--cached\"]。",
  "path 缺省用配置的仓库路径，再缺省当前工作目录；timeoutSec 默认 60，上限 600。",
  "成功返回 stdout（已 trim），失败返回 { error:true, message } 并附带 stderr。",
  "注意：本工具原样执行、不做语义化封装，可能修改仓库状态（含丢数据的子命令），执行前请确认参数。",
].join(" ");

// 危险子命令识别：命中即在审核摘要里显式标注「危险，可能丢数据」。
function detectDanger(args) {
  if (!Array.isArray(args) || args.length === 0) return [];
  const sub = String(args[0] || "");
  const rest = args.slice(1).map((a) => String(a));
  const hits = [];
  const has = (t) => rest.includes(t);

  if (sub === "push") {
    // 裸 force：-f、--force，或短旗标簇里带 f（如 -fu）。--force-with-lease 不在其列。
    const forceOnPush = rest.some((t) => t === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(t) || t === "-f");
    if (forceOnPush) hits.push("push 强制覆盖（-f/--force）");
  }
  if (sub === "reset" && has("--hard")) hits.push("reset --hard 丢弃工作区变更");
  if (sub === "clean" && rest.some((t) => /^-[A-Za-z]*f/.test(t))) hits.push("clean -f 删除未跟踪文件");
  if (sub === "branch" && (has("-D") || has("--delete"))) hits.push("branch -D 强制删除分支");
  if (sub === "tag" && has("-d")) hits.push("tag -d 删除标签");
  if (sub === "filter-branch") hits.push("filter-branch 重写历史");
  if (sub === "update-ref" && has("-d")) hits.push("update-ref -d 删除引用");
  if (sub === "reflog" && has("expire")) hits.push("reflog expire 清理引用日志");
  if (sub === "gc" && has("--prune")) hits.push("gc --prune 清理不可达对象");
  return hits;
}

export const sessionPermission = {
  kind: "review",
  describeSideEffect: (input = {}) => {
    const args = Array.isArray(input?.args) ? input.args.map((a) => String(a)) : [];
    const cmdLine = ["git", ...args].join(" ").trim() || "git（未提供参数）";
    const danger = detectDanger(args);
    const summary =
      `在本地仓库执行 git 子命令：${cmdLine}` +
      (danger.length ? `。危险，可能丢数据（${danger.join("；")}）` : "") +
      "。透传原样执行，执行前请确认仓库路径与参数。";
    return { kind: "workspace_write", summary, ruleId: "git-save-load-git-exec" };
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
        "git 完整参数列表（数组，无 shell 拼接）：首元素为子命令，如 [\"status\",\"--porcelain\"]、[\"log\",\"--oneline\",\"-3\"]、[\"add\",\"src/a.js\"]",
    },
    path: {
      type: "string",
      description: "git 仓库路径。不传则用配置中保存的仓库路径，再缺省当前工作目录。",
    },
    timeoutSec: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "超时秒数（可选）：默认 60，上限 600；超时终止进程并返回可读错误。",
    },
  },
  required: ["args"],
};

export async function execute(input = {}, ctx = {}) {
  const cwd = await resolvePath(input, ctx);

  const rawArgs = input?.args;
  if (!Array.isArray(rawArgs) || rawArgs.length === 0) {
    return JSON.stringify({ error: true, message: "args 必填且至少一个元素（git 子命令，如 [\"status\",\"--porcelain\"]）" }, null, 2);
  }
  const args = rawArgs.map((a) => String(a));
  const timeoutSec = normalizeTimeoutSec(input?.timeoutSec, 60, 600);
  const danger = detectDanger(args);

  const r = gitExecCapture(cwd, args, { timeout: timeoutSec * 1000 });

  if (r.ok) {
    return r.stdout;
  }

  const parts = [];
  if (r.errCode === "ENOENT") parts.push("未找到 git 可执行文件：请确认 git 已安装并在 PATH 中。");
  parts.push(`git ${args.join(" ")} 执行失败（exit code ${r.code === null ? "N/A" : r.code}）`);
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
