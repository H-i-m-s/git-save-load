// git-tools / tools / gh_pr.js
// GitHub Pull Request 生命周期工具：单工具 + action 子模块（create / list / view / merge）。
// 认证复用 gh keyring（gh auth login）；gh 一律经 routes/github.js 的
// resolveGhPath()/ghEnvironment() spawn，与面板走同一套可执行文件探测与登录目录适配。
//
// 公共上下文：repo（owner/repo，转 -R，显式优先）；cwd 可选（gh 从 git remote 推断仓库）。
// create 缺省 title 时需要 cwd 读取 HEAD commit 首行。全命令非交互（gh 无 TTY 不弹编辑器）。

import { execFileSync } from "node:child_process";

import { resolveGhPath, ghEnvironment } from "../routes/github.js";
import { resolvePath, gitExec } from "./_helpers.js";

export const name = "gh_pr";

export const description = [
  "GitHub Pull Request 生命周期工具（action：create/list/view/merge）。认证复用 gh keyring（gh auth login）。",
  "repo 可选（owner/repo，转 -R，显式优先）；cwd 可选（gh 从 git remote 推断仓库，不传则用插件配置中保存的仓库路径）。",
  "create：base?（缺省 gh 默认目标分支）+ title?（缺省取 cwd 内 HEAD commit 首行）+ body? + draft?，输出新 PR 的 URL 与编号。",
  "list：state?（open 默认/closed/all）+ limit?（默认 10，1~50），输出编号/标题/分支/状态/时间。",
  "view：prNumber?（缺省 = 当前分支关联 PR），输出状态/分支/作者/审查/合并状态/URL/正文。",
  "merge：prNumber 必填 + method?（merge 默认/squash/rebase）+ deleteBranch?。",
  "注意：merge 合并 PR 不可撤销（会合并代码并可删除源分支），执行前请确认编号与参数；本工具无交互提示。",
].join(" ");

// 同一工具内按 action 分支：create/merge 修改 GitHub 远端状态，list/view 只读但随本工具整体送审
// （避免拆成多个工具膨胀工具面）。kind 缺省即"送审"，describeSideEffect 在 create/merge 上写明副作用；
// 另附静态 sideEffect：App 工具跨隔离进程 RPC 只保留数据字段，函数形态的 describeSideEffect 不一定存活，
// 静态副本保证宿主在两种通道下都拿到同样的副作用声明。
export const sessionPermission = {
  kind: "review",
  sideEffect: {
    kind: "github_pr",
    summary:
      "操作 GitHub 远端 Pull Request（gh CLI，认证复用 gh keyring）：create 新建 PR、merge 合并 PR（不可撤销，可删除源分支）会修改 GitHub 远端状态；list/view 只读。",
    ruleId: "github-gh-pr",
  },
  describeSideEffect: (input = {}) => {
    const action = String((input && input.action) || "").trim();
    if (action === "list" || action === "view") {
      return {
        kind: "github_pr_read",
        summary: `只读查询 GitHub Pull Request（action=${action}），不修改远端状态。`,
        ruleId: "github-gh-pr",
      };
    }
    if (action === "merge") {
      const num = input && input.prNumber != null && input.prNumber !== "" ? ` #${input.prNumber}` : "";
      return {
        kind: "github_pr_merge",
        summary: `合并 GitHub Pull Request${num}：不可撤销，会把代码合并进目标分支${input && input.deleteBranch ? "并删除源分支" : ""}。请确认编号与合并方式。`,
        ruleId: "github-gh-pr",
      };
    }
    if (action === "create") {
      return {
        kind: "github_pr_create",
        summary: "在 GitHub 远端新建 Pull Request（创建后可在网页端关闭，但会通知仓库协作者）。",
        ruleId: "github-gh-pr",
      };
    }
    return {
      kind: "github_pr",
      summary: "操作 GitHub 远端 Pull Request（gh CLI）。",
      ruleId: "github-gh-pr",
    };
  },
};

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["create", "list", "view", "merge"],
      description: "子模块：create=创建 PR / list=列出 PR / view=查看 PR 概要 / merge=合并 PR（不可撤销）",
    },
    repo: {
      type: "string",
      description: "可选：仓库，格式 owner/repo（如 liliMozi/openhanako）；传入则转 -R，优先于 cwd 推断",
    },
    cwd: {
      type: "string",
      description: "可选：本地仓库绝对路径（gh 从 git remote 推断仓库；create 缺省 title 时取 HEAD commit 首行）。不传则用插件配置中保存的仓库路径",
    },
    base: {
      type: "string",
      description: "仅 create：目标分支（缺省由 gh 用仓库默认分支，如 main）",
    },
    title: {
      type: "string",
      description: "仅 create：PR 标题（缺省取 cwd 内 HEAD commit 首行）",
    },
    body: {
      type: "string",
      description: "仅 create：PR 正文（可选，支持 Markdown 与中文）",
    },
    draft: {
      type: "boolean",
      description: "仅 create：以草稿（draft）创建 PR",
    },
    state: {
      type: "string",
      enum: ["open", "closed", "all"],
      description: "仅 list：PR 状态过滤，默认 open",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: "仅 list：返回条数，默认 10，上限 50",
    },
    prNumber: {
      type: "integer",
      minimum: 1,
      description: "view/merge：PR 编号（正整数）；view 缺省 = 当前分支关联 PR；merge 必填",
    },
    method: {
      type: "string",
      enum: ["merge", "squash", "rebase"],
      description: "仅 merge：合并方式（默认 merge）：merge=--merge / squash=--squash / rebase=--rebase",
    },
    deleteBranch: {
      type: "boolean",
      description: "仅 merge：合并后删除源分支（--delete-branch）",
    },
  },
  required: ["action"],
};

const ACTIONS = ["create", "list", "view", "merge"];
const STATES = ["open", "closed", "all"];
const METHODS = ["merge", "squash", "rebase"];
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const VIEW_FIELDS =
  "number,title,state,isDraft,headRefName,baseRefName,author,reviewDecision,mergeStateStatus,url,body,createdAt,updatedAt,mergedAt";
const LIST_FIELDS = "number,title,headRefName,baseRefName,state,isDraft,createdAt,updatedAt,url";

function fail(message) {
  return JSON.stringify({ ok: false, message }, null, 2);
}

function ok(payload) {
  return JSON.stringify({ ok: true, ...payload }, null, 2);
}

/** gh 失败输出 → 中文引导（未登录 / 仓库上下文 / 非交互推送）。 */
function ghGuidance(text) {
  const s = String(text || "");
  if (/Please log in|not logged in|invalid auth|authentication required|gh auth login/i.test(s)) {
    return "gh 未登录或凭据失效：请先在终端执行 gh auth login（本工具复用 gh keyring，重登一次即可）。";
  }
  if (/not a git repository|no git remotes|could not determine|no remotes found/i.test(s)) {
    return "无法确定 GitHub 仓库：请显式传 repo（owner/repo）或在 git 仓库 cwd 内执行。";
  }
  if (/must first push|not been pushed|no commits between|Head branch is not/i.test(s)) {
    return "源分支尚未推送到远程：请先 git push -u 分支，再创建 PR。";
  }
  return "";
}

/** 把 execFileSync 的错误统一成可读文本。 */
function errorText(err) {
  const parts = [err && err.stderr, err && err.stdout, err && err.message];
  return parts
    .filter(Boolean)
    .map((v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v)))
    .join("\n")
    .trim();
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return { error: `${label} 必须是正整数（收到：${value}）。` };
  return { value: n };
}

function parsePrUrl(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>)]+\/pull\/\d+/g);
  if (!matches || !matches.length) return { url: "", number: null };
  const url = matches[matches.length - 1].trim();
  const m = url.match(/\/pull\/(\d+)$/);
  return { url, number: m ? Number(m[1]) : null };
}

export async function execute(input = {}, ctx = {}) {
  const action = String(input.action != null ? input.action : "").trim();
  if (!ACTIONS.includes(action)) {
    return fail(`action 必须是 create / list / view / merge（收到：${action || "空"}）。`);
  }

  // repo?: owner/repo → -R
  const repoRaw = input.repo != null ? String(input.repo).trim() : "";
  if (repoRaw && !REPO_RE.test(repoRaw)) {
    return fail(`repo 格式应为 owner/repo（收到：${repoRaw}）。`);
  }
  const repoFlag = repoRaw ? ["-R", repoRaw] : [];

  // cwd?: 显式优先；缺省回落到插件配置中保存的仓库路径（resolvePath 读 input.path → config.repoPath → process.cwd()）
  let cwd = "";
  const cwdRaw = input.cwd != null ? String(input.cwd).trim() : "";
  if (cwdRaw) {
    cwd = cwdRaw;
  } else {
    try {
      cwd = await resolvePath({}, ctx);
    } catch {
      cwd = "";
    }
  }

  // 统一 gh 执行：经 resolveGhPath()/ghEnvironment()，非交互、参数数组不过 shell
  function runGh(args, opts = {}) {
    const options = {
      encoding: "utf8",
      timeout: opts.timeout || 120000,
      windowsHide: true,
      env: ghEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    };
    if (cwd) options.cwd = cwd;
    try {
      const stdout = execFileSync(resolveGhPath(), args, options);
      return { ok: true, stdout: String(stdout == null ? "" : stdout).trim() };
    } catch (err) {
      return { ok: false, stdout: err && err.stdout ? String(err.stdout).trim() : "", text: errorText(err) };
    }
  }

  try {
    if (action === "list") return await doList(input, { repoFlag, runGh });
    if (action === "view") return await doView(input, { repoFlag, runGh });
    if (action === "create") return await doCreate(input, { cwd, repoFlag, runGh });
    return await doMerge(input, { repoFlag, runGh });
  } catch (err) {
    return fail(`gh_pr（action=${action}）执行异常：${(err && err.message) || String(err)}`);
  }
}

async function doList(input, { repoFlag, runGh }) {
  const state = input.state != null && String(input.state).trim() ? String(input.state).trim() : "open";
  if (!STATES.includes(state)) {
    return fail(`list 的 state 必须是 open / closed / all（收到：${state}）。`);
  }
  let limit = 10;
  if (input.limit != null && input.limit !== "") {
    const n = Number(input.limit);
    if (!Number.isInteger(n) || n <= 0) return fail(`list 的 limit 必须是正整数（收到：${input.limit}）。`);
    limit = Math.min(50, n);
  }

  const res = runGh([
    "pr", "list", ...repoFlag,
    "--state", state,
    "--limit", String(limit),
    "--json", LIST_FIELDS,
  ]);
  if (!res.ok) return fail(`获取 PR 列表失败：\n${res.text}${guideSuffix(res.text)}`);

  let prs;
  try {
    const parsed = JSON.parse(res.stdout || "[]");
    prs = Array.isArray(parsed) ? parsed : [];
  } catch {
    return fail(`gh pr list 输出非 JSON，原始输出：\n${res.stdout}`);
  }
  return ok({ action: "list", state, limit, count: prs.length, prs });
}

async function doView(input, { repoFlag, runGh }) {
  let numArg = [];
  if (input.prNumber != null && input.prNumber !== "") {
    const n = positiveInt(input.prNumber, "prNumber");
    if (n.error) return fail(`view 参数错误：${n.error}`);
    numArg = [String(n.value)];
  }

  const res = runGh(["pr", "view", ...numArg, ...repoFlag, "--json", VIEW_FIELDS]);
  if (!res.ok) {
    if (!numArg.length && /no (open )?pull requests?|no PR|no pull request found/i.test(res.text)) {
      return fail("当前分支没有关联的 PR。传入 prNumber 可查看指定 PR。");
    }
    return fail(`查看 PR 失败：\n${res.text}${guideSuffix(res.text)}`);
  }

  let pr;
  try {
    const parsed = JSON.parse(res.stdout || "{}");
    pr = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return fail(`gh pr view 输出非 JSON，原始输出：\n${res.stdout}`);
  }
  if (!pr || typeof pr !== "object") return fail(`未取到 PR 数据，原始输出：\n${res.stdout}`);
  if (typeof pr.body === "string" && pr.body.length > 4000) pr.body = pr.body.slice(0, 4000) + "…";
  return ok({ action: "view", pr });
}

async function doCreate(input, { cwd, repoFlag, runGh }) {
  let title = input.title != null ? String(input.title).trim() : "";
  if (!title) {
    let head = "";
    try {
      head = gitExec(cwd, ["log", "-1", "--format=%s"], { timeout: 10000 });
    } catch (err) {
      const text = (err && err.message) || String(err);
      if (/does not have any commits yet|unknown revision/i.test(text)) {
        return fail("无法从 HEAD 推导 title：仓库尚无提交。请显式传 title。");
      }
      if (/not a git repository/i.test(text)) {
        return fail("cwd 不是 git 仓库，无法推导 title。请传仓库 cwd 或显式传 title。");
      }
      return fail(`读取 HEAD commit 首行失败：${text}`);
    }
    title = String(head || "").trim();
    if (!title) return fail("HEAD commit 没有首行内容，无法推导 title，请显式传 title。");
  }

  const args = ["pr", "create", ...repoFlag, "--title", title];
  const base = input.base != null ? String(input.base).trim() : "";
  if (base) args.push("--base", base);
  const body = input.body != null ? String(input.body) : "";
  if (body.trim()) args.push("--body", body);
  if (input.draft === true) args.push("--draft");

  const res = runGh(args, { timeout: 180000 });
  if (!res.ok) return fail(`创建 PR 失败：\n${res.text}${guideSuffix(res.text)}`);

  const { url, number } = parsePrUrl(res.stdout);
  return ok({
    action: "create",
    title,
    base: base || null,
    draft: input.draft === true,
    number,
    url,
    message: url ? `已创建 PR #${number}：${url}` : "gh 未输出可解析的 PR URL，请查看 raw。",
    raw: reasonForRaw(url, res.stdout),
  });
}

function reasonForRaw(url, stdout) {
  return url ? undefined : stdout;
}

async function doMerge(input, { repoFlag, runGh }) {
  const n = positiveInt(input.prNumber, "prNumber");
  if (n.error) return fail(`merge 参数错误：${n.error}（merge 必须指定 PR 编号）。`);
  const number = n.value;

  const method = input.method != null && String(input.method).trim() ? String(input.method).trim() : "merge";
  if (!METHODS.includes(method)) {
    return fail(`merge 的 method 必须是 merge / squash / rebase（收到：${method}）。`);
  }
  const deleteBranch = input.deleteBranch === true;

  const args = ["pr", "merge", String(number), ...repoFlag, "--" + method];
  if (deleteBranch) args.push("--delete-branch");

  const res = runGh(args, { timeout: 180000 });
  if (!res.ok) {
    const raw = res.text || "";
    if (/already merged/i.test(raw)) {
      return fail(`PR #${number} 已经合并过，无法重复合并。\n${raw}`);
    }
    if (/not mergeable|merge conflict|conflicts with base/i.test(raw)) {
      return fail(`PR #${number} 存在冲突或未通过合并检查：\n${raw}${guideSuffix(raw)}`);
    }
    return fail(`合并 PR #${number} 失败：\n${raw}${guideSuffix(raw)}`);
  }

  // 合并后确认终态（只读）
  let state = "";
  let url = "";
  let mergedAt = "";
  const conf = runGh(["pr", "view", String(number), ...repoFlag, "--json", "state,mergedAt,url"]);
  if (conf.ok) {
    try {
      const p = JSON.parse(conf.stdout || "{}");
      const pr = Array.isArray(p) ? p[0] : p;
      if (pr && typeof pr === "object") {
        state = String(pr.state || "");
        url = pr.url || "";
        mergedAt = pr.mergedAt || "";
      }
    } catch {}
  }

  return ok({
    action: "merge",
    number,
    method,
    deleteBranch,
    state: state || null,
    url: url || null,
    mergedAt: mergedAt || null,
    message: state === "MERGED"
      ? `PR #${number} 已合并（method=${method}${deleteBranch ? "，已删除源分支" : ""}）。`
      : `gh pr merge 已执行（PR #${number}，method=${method}）；最终状态：${state || "未知，可能仍在处理中"}。`,
  });
}

function guideSuffix(text) {
  const g = ghGuidance(text);
  return g ? `\n${g}` : "";
}
