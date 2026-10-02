// SPDX-License-Identifier: MPL-2.0
//
// 本文件包含衍生自 GitHana 的部分代码（setUpstream 等参数与 push 参数组装）：
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
// git-save-load / tools / git_push.js
// 语义化推送：把本地分支推到远端。force 只映射 --force-with-lease，绝不使用裸 --force。

import { resolve as nodeResolve } from "node:path";

import { resolvePath, gitExecCapture, getCurrentBranch } from "./_helpers.js";

export const name = "git_push";

export const description = [
  "把本地当前（或指定）分支推送到远端。",
  "remote 缺省取该仓库的默认推送远端（配置的远程角色），读不通则回退当前分支 upstream 的远端或 origin；",
  "branch 缺省当前分支；setUpstream=true 带 -u 建立上游跟踪。",
  "force 仅接受 \"with-lease\"（映射 --force-with-lease，安全强推）；任何情况下都不会使用裸 --force。",
  "推送会更新远端分支引用（不可随意撤销），执行前请确认 remote/branch。",
].join(" ");

export const sessionPermission = {
  kind: "review",
  describeSideEffect: (input = {}) => {
    const remote = input?.remote ? String(input.remote).trim() : "(默认推送远端)";
    const branch = input?.branch ? String(input.branch).trim() : "(当前分支)";
    const lease = String(input?.force || "none") === "with-lease";
    const summary =
      `把本地分支推送到远端 ${remote} → ${branch}` +
      (input?.setUpstream === true ? "（-u 建立上游跟踪）" : "") +
      (lease ? "（--force-with-lease 安全强推，绝不使用裸 --force）" : "") +
      "。会更新远端分支引用，执行前请确认 remote/branch。";
    return { kind: "workspace_write", summary, ruleId: "git-save-load-git-push" };
  },
};

export const parameters = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "git 仓库路径。不传则用配置中保存的仓库路径，再缺省当前工作目录。",
    },
    remote: {
      type: "string",
      description: "远端名。缺省用该仓库默认推送远端（远程角色），读不通则回退 upstream 远端或 origin。",
    },
    branch: {
      type: "string",
      description: "要推送的分支名。缺省当前分支。",
    },
    setUpstream: {
      type: "boolean",
      description: "是否带 -u 建立上游跟踪分支（首次推送推荐）。",
    },
    force: {
      type: "string",
      enum: ["none", "with-lease"],
      description: "强制推送模式：none（默认）不强制；with-lease 映射 --force-with-lease（安全强推）。不接受裸 --force。",
    },
  },
  required: [],
};

/** 与 routes/git.js remoteSettingsKey 对齐：按绝对路径（Windows 小写）取远程角色配置。 */
function remoteSettingsKey(path) {
  const p = nodeResolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** 从配置的远程角色里取默认推送远端；读不通返回 ""。 */
async function configuredPushRemote(ctx, cwd) {
  try {
    const settings = await ctx?.config?.get?.("remoteSettings");
    if (!settings || typeof settings !== "object") return "";
    const saved = settings[remoteSettingsKey(cwd)];
    const name = saved && typeof saved === "object" ? String(saved.pushRemote || "").trim() : "";
    return name;
  } catch {
    return "";
  }
}

/** 当前分支 upstream 的远端名（origin/main → origin）；无则返回 ""。 */
function upstreamRemote(cwd, branch) {
  const ref = branch ? `${branch}@{upstream}` : "@{upstream}";
  const r = gitExecCapture(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", ref], { timeout: 5000 });
  if (r.ok && r.stdout && r.stdout.includes("/")) return r.stdout.split("/")[0];
  return "";
}

export async function execute(input = {}, ctx = {}) {
  const cwd = await resolvePath(input, ctx);

  let branch = input?.branch !== undefined && input?.branch !== null ? String(input.branch).trim() : "";
  if (!branch) branch = getCurrentBranch(cwd);
  if (!branch) {
    return JSON.stringify(
      { error: true, message: "无法确定当前分支（游离 HEAD 或仓库尚无提交）：请显式传 branch，或先检出分支。" },
      null,
      2,
    );
  }

  let remote = input?.remote !== undefined && input?.remote !== null ? String(input.remote).trim() : "";
  if (!remote) remote = await configuredPushRemote(ctx, cwd);
  if (!remote) remote = upstreamRemote(cwd, branch);
  if (!remote) remote = "origin";

  const setUpstream = input?.setUpstream === true;
  const force = String(input?.force || "none");

  // 只在 with-lease 时注入 --force-with-lease；其他一律不强制（绝不裸 --force）。
  const args = ["push"];
  if (force === "with-lease") args.push("--force-with-lease");
  if (setUpstream) args.push("-u");
  args.push(remote, branch);

  const r = gitExecCapture(cwd, args, { timeout: 120000 });

  const base = {
    ok: r.ok,
    remote,
    branch,
    force: force === "with-lease" ? "with-lease" : "none",
    setUpstream,
    command: `git ${args.join(" ")}`,
    stdout: r.stdout,
    stderr: r.stderr,
    code: r.code,
  };

  if (r.ok) {
    const raw = `${r.stdout}\n${r.stderr}`;
    base.message = /Everything up-to-date/i.test(raw)
      ? "远端已是最新，无需推送。"
      : `已推送 ${branch} → ${remote}${base.force === "with-lease" ? "（--force-with-lease）" : ""}${setUpstream ? "（-u 已建立上游跟踪）" : ""}。`;
    return JSON.stringify(base, null, 2);
  }

  const s = `${r.stdout}\n${r.stderr}`;
  let hint = "";
  if (r.errCode === "ENOENT") hint = "未找到 git 可执行文件：请确认 git 已安装并在 PATH 中。";
  else if (/does not appear to be a git repository|repository .* (not found|does not exist)|'[^']*' does not appear/i.test(s)) hint = `远端 ${remote} 不存在或不可达：请检查 remote 配置（git remote -v）或 URL。`;
  else if (/Could not read from remote repository|No such remote|not found/i.test(s)) hint = `远端 ${remote} 不存在或不可达：请检查 remote 名称与地址。`;
  else if (/non-fast-forward|fetch first|rejected/i.test(s)) hint = "远端拒绝了快进推送（non-fast-forward）：先拉取合并远端变更，或用 force=\"with-lease\" 安全强推。";
  else if (/Authentication failed|could not read Username|unable to access/i.test(s)) hint = "远端认证失败：请检查凭据或远端 URL 协议。";
  else if (/not a git repository/i.test(s)) hint = "当前目录不是 git 仓库。";
  base.message = `推送失败（exit code ${r.code === null ? "N/A" : r.code}）${hint ? "：" + hint : ""}`;
  return JSON.stringify(base, null, 2);
}
