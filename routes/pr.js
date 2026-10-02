// git-tools / routes / pr.js
// GitHub Pull Request 面板端点（App v2）。
// gh 一律经 routes/github.js 的 resolveGhPath()/ghEnvironment() spawn，与 GitHub 面板同一套
// 可执行文件探测与登录目录适配；deps 注入形状照抄 registerGitHubRoutes（由 routes/git.js 装配）。
//
// 端点（全部返回 { ok, ... } / { ok:false, message }）：
//   GET  /api/gh/pr-list   ?path=&state=&limit=
//   GET  /api/gh/pr-view   ?path=&number=
//   POST /api/gh/pr-create { path, base?, title?, body?, draft? }
//   POST /api/gh/pr-merge  { path, number, method?, deleteBranch? }

import { execFileSync } from "node:child_process";

import { resolveGhPath, ghEnvironment } from "./github.js";

const STATES = ["open", "closed", "all"];
const METHODS = ["merge", "squash", "rebase"];

const LIST_FIELDS = "number,title,headRefName,baseRefName,state,isDraft,createdAt,updatedAt,url";
const VIEW_FIELDS =
  "number,title,state,isDraft,headRefName,baseRefName,author,reviewDecision,mergeStateStatus,url,body,createdAt,updatedAt,mergedAt";

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePrUrl(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s"'<>)]+\/pull\/\d+/g);
  if (!matches || !matches.length) return { url: "", number: null };
  const url = matches[matches.length - 1].trim();
  const m = url.match(/\/pull\/(\d+)$/);
  return { url, number: m ? Number(m[1]) : null };
}

export function registerPrRoutes(app, { ctx, gitExecFile, commandErrorText, readRepoPath } = {}) {
  function ghExec(args, opts = {}) {
    const options = {
      encoding: "utf8",
      timeout: opts.timeout || 120000,
      windowsHide: true,
      env: ghEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    };
    if (opts.cwd) options.cwd = opts.cwd;
    return String(execFileSync(resolveGhPath(), args, options)).trim();
  }

  // 目标仓库路径：显式 path 优先，缺省回落到插件配置中保存的仓库路径。
  async function targetPath(explicit) {
    const p = String(explicit || "").trim();
    if (p) return p;
    try {
      return String((await readRepoPath(ctx)) || "").trim();
    } catch {
      return "";
    }
  }

  function failure(e, fallback) {
    const text = typeof commandErrorText === "function" ? commandErrorText(e) : "";
    return { ok: false, message: text || fallback };
  }

  // ======== API: PR 列表 ========
  app.get("/api/gh/pr-list", async (c) => {
    const path = await targetPath(c.req.query("path"));
    if (!path) return c.json({ ok: false, message: "请先选择仓库" });
    const state = String(c.req.query("state") || "").trim() || "open";
    if (!STATES.includes(state)) return c.json({ ok: false, message: "state 只能是 open / closed / all" });
    let limit = 10;
    const limitRaw = c.req.query("limit");
    if (limitRaw != null && String(limitRaw).trim() !== "") {
      const n = positiveInt(limitRaw);
      if (!n) return c.json({ ok: false, message: "limit 必须是 1~50 的正整数" });
      limit = Math.min(50, n);
    }
    try {
      const raw = ghExec([
        "pr", "list",
        "--state", state,
        "--limit", String(limit),
        "--json", LIST_FIELDS,
      ], { cwd: path });
      const parsed = JSON.parse(raw || "[]");
      const prs = Array.isArray(parsed) ? parsed : [];
      return c.json({ ok: true, path, state, limit, count: prs.length, prs });
    } catch (e) {
      return c.json(failure(e, "获取 PR 列表失败"));
    }
  });

  // ======== API: 单个 PR 概要 ========
  app.get("/api/gh/pr-view", async (c) => {
    const path = await targetPath(c.req.query("path"));
    if (!path) return c.json({ ok: false, message: "请先选择仓库" });
    const numberRaw = String(c.req.query("number") || "").trim();
    let numArg = [];
    if (numberRaw) {
      const n = positiveInt(numberRaw);
      if (!n) return c.json({ ok: false, message: "number 必须是正整数" });
      numArg = [String(n)];
    }
    try {
      const raw = ghExec(["pr", "view", ...numArg, "--json", VIEW_FIELDS], { cwd: path });
      const parsed = JSON.parse(raw || "{}");
      const pr = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!pr || typeof pr !== "object") return c.json({ ok: false, message: "未取到 PR 数据" });
      return c.json({ ok: true, path, pr });
    } catch (e) {
      return c.json(failure(e, "查看 PR 失败"));
    }
  });

  // ======== API: 创建 PR ========
  app.post("/api/gh/pr-create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = await targetPath(body.path);
    if (!path) return c.json({ ok: false, message: "请先选择仓库" });

    let title = String(body.title || "").trim();
    if (!title) {
      try {
        title = gitExecFile(path, ["log", "-1", "--format=%s"], { timeout: 10000 });
      } catch (e) {
        const text = typeof commandErrorText === "function" ? commandErrorText(e) : "";
        if (/does not have any commits yet|unknown revision/i.test(text)) {
          return c.json({ ok: false, message: "无法从 HEAD 推导标题：仓库尚无提交，请填写标题" });
        }
        return c.json({ ok: false, message: `无法从 HEAD 推导标题：${text || "读取提交信息失败"}` });
      }
      title = String(title || "").trim();
      if (!title) return c.json({ ok: false, message: "HEAD commit 没有首行内容，请填写标题" });
    }

    const args = ["pr", "create", "--title", title];
    const base = String(body.base || "").trim();
    if (base) args.push("--base", base);
    const bodyText = body.body != null ? String(body.body) : "";
    if (bodyText.trim()) args.push("--body", bodyText);
    if (body.draft === true) args.push("--draft");

    try {
      const raw = ghExec(args, { cwd: path, timeout: 180000 });
      const { url, number } = parsePrUrl(raw);
      return c.json({
        ok: true,
        path,
        title,
        base: base || null,
        draft: body.draft === true,
        number,
        url,
        message: url ? `已创建 PR #${number}` : "PR 已创建，但未能解析编号",
      });
    } catch (e) {
      return c.json(failure(e, "创建 PR 失败"));
    }
  });

  // ======== API: 合并 PR（不可撤销；前端已做页内二次确认） ========
  app.post("/api/gh/pr-merge", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = await targetPath(body.path);
    if (!path) return c.json({ ok: false, message: "请先选择仓库" });
    const number = positiveInt(body.number);
    if (!number) return c.json({ ok: false, message: "number 必须是正整数（合并必须指定 PR 编号）" });
    const method = String(body.method || "").trim() || "merge";
    if (!METHODS.includes(method)) return c.json({ ok: false, message: "method 只能是 merge / squash / rebase" });
    const deleteBranch = body.deleteBranch === true;

    const args = ["pr", "merge", String(number), "--" + method];
    if (deleteBranch) args.push("--delete-branch");

    try {
      ghExec(args, { cwd: path, timeout: 180000 });
    } catch (e) {
      return c.json(failure(e, `合并 PR #${number} 失败`));
    }

    // 合并后确认终态（只读）
    let state = "";
    let url = "";
    try {
      const raw = ghExec(["pr", "view", String(number), "--json", "state,mergedAt,url"], { cwd: path });
      const parsed = JSON.parse(raw || "{}");
      const pr = Array.isArray(parsed) ? parsed[0] : parsed;
      if (pr && typeof pr === "object") {
        state = String(pr.state || "");
        url = pr.url || "";
      }
    } catch {}

    return c.json({
      ok: true,
      path,
      number,
      method,
      deleteBranch,
      state: state || null,
      url: url || null,
      message: state === "MERGED"
        ? `PR #${number} 已合并（${method}${deleteBranch ? "，已删除源分支" : ""}）`
        : `PR #${number} 合并命令已执行，状态：${state || "处理中"}`,
    });
  });
}
