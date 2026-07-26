// git-tools / routes / git.js
// 提供后端 API + 页面渲染。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, exec, execFile, execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, "..", "views", "git.html");
let cachedHtml = null;

async function loadHtml() {
  if (cachedHtml) return cachedHtml;
  cachedHtml = await readFile(htmlPath, "utf8");
  return cachedHtml;
}

// 缓存用户级代理环境变量，避免每次 git 调用都查询 Windows 注册表
let _cachedUserProxy = null;
function getUserProxy() {
  if (_cachedUserProxy) return _cachedUserProxy;
  _cachedUserProxy = {};
  try {
    const userHttps = execSync('[System.Environment]::GetEnvironmentVariable("HTTPS_PROXY", "User")', { encoding: 'utf8', shell: 'powershell', windowsHide: true }).trim();
    const userHttp = execSync('[System.Environment]::GetEnvironmentVariable("HTTP_PROXY", "User")', { encoding: 'utf8', shell: 'powershell', windowsHide: true }).trim();
    if (userHttps) _cachedUserProxy.HTTPS_PROXY = userHttps;
    if (userHttp) _cachedUserProxy.HTTP_PROXY = userHttp;
  } catch {}
  return _cachedUserProxy;
}

// 执行 git 命令的辅助函数
function gitEnv() {
  const env = { ...process.env, ...getUserProxy() };
  // Windows 上 HOME 通常未设置，OpenSSH 靠它找 .ssh/config 和 known_hosts
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  return env;
}

function ghEnvironment() {
  const env = { ...process.env };
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  return env;
}

function gitExec(cwd, cmd, opts = {}) {
  const timeout = opts.timeout || 60000;
  return execSync(cmd, { cwd, encoding: "utf8", timeout, windowsHide: true, env: gitEnv() }).trim();
}

// 对用户输入敏感的 Git 调用使用 execFileSync，避免经过 shell 解释。
function gitExecFile(cwd, args, opts = {}) {
  const timeout = opts.timeout || 60000;
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
    windowsHide: true,
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commandErrorText(error) {
  const parts = [error?.stderr, error?.stdout, error?.message];
  return parts
    .filter(Boolean)
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value))
    .join("\n")
    .trim();
}

function isValidRemoteName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name);
}

function isValidRemoteUrl(url) {
  return /^(?:https?|ssh):\/\/[^\s]+$/.test(url) || /^git@[^\s:]+:[^\s]+$/.test(url);
}

function validateBranchName(cwd, branch) {
  if (!branch || branch.startsWith("-")) return false;
  try {
    gitExecFile(cwd, ["check-ref-format", `refs/heads/${branch}`], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function parseNameStatus(raw) {
  return String(raw || "").split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return { status: parts[0] || "?", name: parts.slice(1).join("\t") || parts[0] || "" };
  });
}

function parseCommitList(raw) {
  return String(raw || "").split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf("|");
    if (separator < 0) return { hash: line, subject: "" };
    return { hash: line.slice(0, separator), subject: line.slice(separator + 1) };
  });
}

const LICENSE_OPTIONS = new Set(["MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause", "LGPL-3.0", "MPL-2.0", "Unlicense"]);

function normalizeLicense(value) {
  const license = String(value || "").trim();
  return license && LICENSE_OPTIONS.has(license) ? license : "";
}

function hasHeadCommit(cwd) {
  try {
    gitExecFile(cwd, ["rev-parse", "--verify", "HEAD"], { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function getGitIdentity(cwd) {
  try {
    const name = gitExecFile(cwd, ["config", "user.name"], { timeout: 10000 });
    const email = gitExecFile(cwd, ["config", "user.email"], { timeout: 10000 });
    return name && email ? { name, email } : null;
  } catch {
    return null;
  }
}

function readLicenseFile(cwd, license) {
  try {
    const output = execFileSync("gh", ["repo", "license", "view", license], {
      cwd,
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
      env: ghEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return output;
  } catch {
    return "";
  }
}

function applyLicenseToLocalRepo(cwd, license) {
  if (!license) return { applied: false, existing: false, committed: false };
  const licensePath = join(cwd, "LICENSE");
  if (existsSync(licensePath)) return { applied: false, existing: true, committed: false };
  const content = readLicenseFile(cwd, license);
  if (!content) throw new Error("无法获取许可证模板，请检查 GitHub CLI 是否支持该许可证");
  const identity = getGitIdentity(cwd);
  if (!identity) throw new Error("当前仓库还没有配置 Git 姓名和邮箱，无法自动提交许可证");
  const year = String(new Date().getFullYear());
  const normalized = content
    .replace(/\[year\]/gi, year)
    .replace(/\[fullname\]/gi, identity.name);
  writeFileSync(licensePath, normalized + "\n", "utf8");
  return { applied: true, existing: false, committed: false };
}

// 路径辅助函数
function extractBasename(p) {
  if (!p) return "";
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() || p;
}

function extractParentTail(p, depth = 2) {
  if (!p) return "";
  const segs = p.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return segs.slice(-depth).join("/");
}

// 解析 git remote URL，统一成 "owner/repo" 形式用于显示
function parseOriginUrl(url) {
  if (!url) return "";
  // https://host/owner/repo(.git)  /  ssh://git@host/owner/repo(.git)  /  file:///path
  let m = url.match(/^(?:https?|ssh|file):\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (m) return m[1].replace(/\.git$/, "");
  // git@host:owner/repo(.git)
  m = url.match(/^[^@/]+@[^:]+:(.+?)(?:\.git)?\/?$/);
  if (m) return m[1].replace(/\.git$/, "");
  return url;
}

function repoPath(input) {
  return (input && String(input).trim()) || process.cwd();
}

let _configPath = "";
function configPath(ctx) {
  if (!_configPath && ctx.dataDir) _configPath = join(ctx.dataDir, "config.json");
  return _configPath;
}

async function readRepoPath(ctx) {
  try {
    const data = await readFile(configPath(ctx), "utf8");
    const j = JSON.parse(data);
    return (j && j.repoPath) || "";
  } catch { return ""; }
}

async function writeRepoPath(ctx, path) {
  try { await writeFile(configPath(ctx), JSON.stringify({ repoPath: path }), "utf8"); } catch {}
}

async function readConfig(ctx) {
  try {
    const data = await readFile(configPath(ctx), "utf8");
    return JSON.parse(data) || {};
  } catch {
    return {};
  }
}

export default function (app, ctx) {
  // ======== 页面 ========
  app.get("/widget", async (c) => {
    const html = await loadHtml();
    // 读取 Hana 传递的主题参数
    const theme = c.req.query("hana-theme") || "";
    // 在 body 上设置 data-hana-theme 属性，供前端读取
    const patched = html.replace(
      /<body([^>]*)>/,
      `<body data-hana-theme="${theme}"$1>`
    );
    return c.html(patched);
  });

  // ======== API: 获取状态 ========
  app.get("/api/status", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      const branch = gitExec(path, "git branch --show-current");
      const statusShort = gitExec(path, "git -c core.quotepath=false status --short");
      // git log 在空仓库（无 commit）会失败，单独处理
      let recentCommits = [];
      try {
        const logRaw = gitExec(path, "git log --format=\"%H %s\" --numstat -n 5");
        // 解析 log --numstat 输出
        const lines = logRaw.split("\n");
        let current = null;
        for (const line of lines) {
          if (!line.trim()) { if (current) { recentCommits.push(current); current = null; } continue; }
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2 && /^[0-9a-f]{40}$/i.test(parts[0])) {
            if (current) recentCommits.push(current);
            current = { hash: parts[0].slice(0, 7), subject: parts.slice(1).join(" "), added: 0, deleted: 0 };
          } else if (current && parts.length >= 2 && /^\d+$/.test(parts[0])) {
            current.added += parseInt(parts[0]) || 0;
            current.deleted += parseInt(parts[1]) || 0;
          }
        }
        if (current) recentCommits.push(current);
      } catch {}

      let changed = [];
      let untracked = [];
      if (statusShort) {
        for (const line of statusShort.split("\n")) {
          const t = line.trim();
          if (t.startsWith("??")) untracked.push(t.slice(2).trim());
          else changed.push(t);
        }
      }

      // 获取每个文件的增删统计
      const numstat = {};
      try {
        const raw = gitExec(path, "git -c core.quotepath=false diff --numstat");
        for (const line of raw.split("\n").filter(Boolean)) {
          const [added, deleted, ...nameParts] = line.split("\t");
          const name = nameParts.join("\t");
          if (name && added !== "-") numstat[name] = { added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
        }
      } catch {}

      // 增强 changedFiles，带上统计
      const changedWithStats = changed.map(line => {
        const name = line.slice(2).trim();
        const st = line.slice(0, 2).trim();
        const stats = numstat[name] || { added: 0, deleted: 0 };
        return { raw: line, name, status: st, added: stats.added, deleted: stats.deleted };
      });

      return c.json({
        ok: true,
        branch,
        path,
        isRepo: true,
        hasChanges: changed.length > 0 || untracked.length > 0,
        changedFiles: changed,
        changedWithStats,
        untrackedFiles: untracked,
        recentCommits,
        changedCount: changed.length,
        untrackedCount: untracked.length,
      });
    } catch (e) {
      return c.json({ ok: false, isRepo: false, path, message: e.message });
    }
  });

  // ======== API: 提交 ========
  app.post("/api/commit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const message = String(body.message || "").trim();

    if (!message) {
      return c.json({ ok: false, message: "提交消息不能为空" });
    }

    // 提交前检测身份配置（使用本地仓库配置，不读 global，避免泄漏全局状态）
    try {
      const localName = gitExecFile(path, ["config", "user.name"]);
      const localEmail = gitExecFile(path, ["config", "user.email"]);
      if (!localName || !localEmail) {
        return c.json({
          ok: false,
          code: "NO_IDENTITY",
          message: "Git 还未设置你的姓名和邮箱（用来标识谁提交了这次修改）",
          needIdentity: true,
        });
      }
    } catch (e) {
      return c.json({
        ok: false,
        code: "NO_IDENTITY",
        message: "Git 还未设置你的姓名和邮箱（用来标识谁提交了这次修改）",
        needIdentity: true,
      });
    }

    let msgFile = null;
    try {
      gitExec(path, "git add .");

      try {
        // 用系统临时目录存提交消息文件，用完 unlink，避免污染 .git/COMMIT_EDITMSG
        msgFile = join(tmpdir(), "git-sl-msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".txt");
        writeFileSync(msgFile, message, "utf8");
        gitExec(path, `git commit -F "${msgFile}"`);
      } catch (e) {
        if (e.message.includes("nothing to commit") || e.message.includes("nothing added")) {
          return c.json({ ok: true, nothingToCommit: true, message: "没有需要提交的变更" });
        }
        throw e;
      }

      const last = gitExec(path, "git log --oneline -n 1");

      // 如果有版本号，打 tag
      let tag = "";
      const version = String(body.version || "").trim();
      if (version) {
        tag = `v${version.replace(/^v/, "")}`;
        gitExecFile(path, ["tag", tag]);
      }

      return c.json({ ok: true, commit: last, message, tag });
    } catch (e) {
      return c.json({ ok: false, message: `提交失败：${e.message}` });
    } finally {
      // 清理临时文件
      if (msgFile) {
        try { unlinkSync(msgFile); } catch {}
      }
    }
  });

  // ======== API: 配置 git 身份（仅写入当前仓库，不污染全局） ========
  app.post("/api/git-config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    if (!name) return c.json({ ok: false, message: "姓名不能为空" });
    if (!email) return c.json({ ok: false, message: "邮箱不能为空" });
    // 邮箱格式粗校验（不验证可达性）
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ ok: false, message: "邮箱格式不正确，请检查（例：xx@example.com）" });
    }
    try {
      gitExecFile(path, ["config", "user.name", name]);
      gitExecFile(path, ["config", "user.email", email]);
      return c.json({ ok: true, message: "身份配置成功" });
    } catch (e) {
      return c.json({ ok: false, message: `配置失败：${e.message}` });
    }
  });

  // ======== API: 修改最近一次提交的消息（git commit --amend） ========
  app.post("/api/commit-amend", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const message = String(body.message || "").trim();
    const expectedHash = String(body.expectedHash || "").trim();

    if (!message) return c.json({ ok: false, message: "提交消息不能为空" });

    // 身份检查（与 commit 路由一致）
    try {
      const localName = gitExecFile(path, ["config", "user.name"]);
      const localEmail = gitExecFile(path, ["config", "user.email"]);
      if (!localName || !localEmail) {
        return c.json({
          ok: false,
          code: "NO_IDENTITY",
          message: "Git 还未设置你的姓名和邮箱",
          needIdentity: true,
        });
      }
    } catch (e) {
      return c.json({
        ok: false,
        code: "NO_IDENTITY",
        message: "Git 还未设置你的姓名和邮箱",
        needIdentity: true,
      });
    }

    // hash 校验：用户点的必须是当前 HEAD
    if (!expectedHash) {
      return c.json({ ok: false, message: "内部错误：缺少预期 hash" });
    }
    let currentHash = "";
    try {
      currentHash = gitExec(path, "git rev-parse HEAD");
    } catch (e) {
      return c.json({ ok: false, message: "读取 HEAD 失败：" + e.message });
    }
    if (currentHash.slice(0, expectedHash.length) !== expectedHash) {
      return c.json({
        ok: false,
        code: "NOT_HEAD",
        message: "只能修改最近一条提交。这条提交已经不是最新了，如需修改请在终端使用 git rebase -i （高级操作）。",
      });
    }

    // 检查工作区是否干净（--amend 不能有未提交修改，否则会混入）
    try {
      const status = gitExec(path, "git -c core.quotepath=false status --porcelain");
      if (status) {
        return c.json({
          ok: false,
          code: "DIRTY",
          message: "当前有未提交的修改，请先存档或丢弃这些修改，再修改提交说明。",
        });
      }
    } catch (e) {}

    let msgFile = null;
    try {
      msgFile = join(tmpdir(), "git-sl-amend-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".txt");
      writeFileSync(msgFile, message, "utf8");
      gitExec(path, `git commit --amend -F "${msgFile}"`);
      const last = gitExec(path, "git log --oneline -n 1");
      return c.json({ ok: true, message: "已修改最近一次提交说明", commit: last });
    } catch (e) {
      return c.json({ ok: false, message: `修改失败：${e.message}` });
    } finally {
      if (msgFile) { try { unlinkSync(msgFile); } catch {} }
    }
  });

  // ======== API: 历史 ========
  app.get("/api/log", async (c) => {
    const path = repoPath(c.req.query("path"));
    const count = Math.min(Math.max(1, parseInt(c.req.query("count") || "20", 10)), 100);

    try {
      // 获取 tag → hash 映射
      const tagMap = {};
      try {
        const tagRaw = gitExec(path, 'git tag --sort=-version:refname --format="%(objectname:short)|%(refname:short)"');
        for (const line of tagRaw.split("\n").filter(Boolean)) {
          const [hash, tag] = line.split("|");
          if (hash && tag) tagMap[hash] = tag;
        }
      } catch {}

      // 用 --numstat 一次性获取每次提交的增删统计
      const format = "%h|%s|%an|%ai";
      const raw = gitExec(path, `git log --format="${format}" --numstat -n ${count}`);
      const commits = [];
      let cur = null;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes("|")) {
          // 新提交头
          if (cur) commits.push(cur);
          const [hash, msg, author, date] = trimmed.split("|");
          cur = { hash, message: msg || "", author: author || "", date: date || "", tag: tagMap[hash] || "", added: 0, deleted: 0 };
        } else if (cur) {
          // numstat 行
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
            cur.added += parseInt(parts[0]) || 0;
            cur.deleted += parseInt(parts[1]) || 0;
          }
        }
      }
      if (cur) commits.push(cur);

      return c.json({ ok: true, commits });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // ======== API: 回滚 ========
  app.post("/api/reset", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const commit = String(body.commit || "").trim();
    const mode = ["soft", "mixed", "hard"].includes(body.mode) ? body.mode : "mixed";

    if (!commit) {
      return c.json({ ok: false, message: "请指定要回滚到的提交 hash" });
    }

    try {
      if (!/^[0-9a-f]{4,64}$/i.test(commit)) return c.json({ ok: false, message: "提交 hash 格式不正确" });
      gitExecFile(path, ["cat-file", "-t", commit]);
      const before = gitExecFile(path, ["log", "--oneline", "-n", "1"]);
      const target = gitExecFile(path, ["log", "--oneline", "-n", "1", commit]);
      gitExecFile(path, ["reset", `--${mode}`, commit]);

      // 清理回滚后失效的 tag（指向历史外 commit 的 tag）
      const cleanedTags = [];
      try {
        const tagRaw = gitExec(path, 'git tag --format="%(objectname:short)|%(refname:short)"');
        for (const line of tagRaw.split("\n").filter(Boolean)) {
          const [h, t] = line.split("|");
          if (!h || !t) continue;
          try {
            gitExecFile(path, ["merge-base", "--is-ancestor", h, "HEAD"]);
          } catch {
            gitExecFile(path, ["tag", "-d", t]);
            cleanedTags.push(t);
          }
        }
      } catch {}

      return c.json({
        ok: true,
        mode,
        before,
        target,
        cleanedTags,
        warning: mode === "hard" ? "已丢弃回滚点之后的所有未提交变更" : undefined,
      });
    } catch (e) {
      return c.json({ ok: false, message: `回滚失败：${e.message}` });
    }
  });

  // ======== API: diff ========
  app.get("/api/diff", async (c) => {
    const path = repoPath(c.req.query("path"));
    const file = String(c.req.query("file") || "").trim();

    try {
      const fileArg = file ? ` -- "${file}"` : "";
      const diff = gitExec(path, `git -c core.quotepath=false diff --stat${fileArg}`);
      const diffDetail = gitExec(path, `git -c core.quotepath=false diff${fileArg}`);
      return c.json({ ok: true, file: file || null, summary: diff || "(no diff)", detail: diffDetail || "(no diff)" });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // ======== API: 对比两个版本 ========
  app.get("/api/compare", async (c) => {
    const path = repoPath(c.req.query("path"));
    const from = String(c.req.query("from") || "").trim();
    const to = String(c.req.query("to") || "").trim();
    if (!from || !to) return c.json({ ok: false, message: "请指定两个 hash" });
    try {
      const stat = gitExec(path, `git -c core.quotepath=false diff --stat ${from}..${to}`);
      const detail = gitExec(path, `git -c core.quotepath=false diff ${from}..${to}`);
      // 文件级统计
      const fileStats = [];
      const numstat = gitExec(path, `git -c core.quotepath=false diff --numstat ${from}..${to}`);
      for (const line of numstat.split("\n").filter(Boolean)) {
        const [added, deleted, ...nameParts] = line.split("\t");
        const name = nameParts.join("\t");
        if (name) fileStats.push({ name, added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 });
      }
      return c.json({ ok: true, stat: stat || "(无差异)", detail: detail || "(无差异)", fileStats });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // ======== API: 初始化 git 仓库 ========
  app.post("/api/init", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = String(body.path || "").trim();
    const gitignore = String(body.gitignore || "").trim();

    if (!path) return c.json({ ok: false, message: "请指定目录路径" });

    try {
      gitExec(path, "git init");

      // 有 .gitignore 模板就写入
      if (gitignore) {
        const { writeFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        writeFileSync(join(path, ".gitignore"), gitignore, "utf8");
      }

      const branch = gitExec(path, "git branch --show-current");
      return c.json({ ok: true, path, branch: branch || "master" });
    } catch (e) {
      return c.json({ ok: false, message: `初始化失败：${e.message}` });
    }
  });

  // ======== API: 获取当前版本号（最新 tag） ========
  app.get("/api/version", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      const tags = gitExec(path, "git tag --sort=-version:refname").split("\n").filter(Boolean);
      const latest = tags.length > 0 ? tags[0].replace(/^v/, "") : "0.0.0";
      const parts = latest.split(".").map(Number);
      const next = `${parts[0] || 0}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;
      return c.json({ ok: true, current: latest, next, tags });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // ======== API: 检测冲突文件 ========
  app.get("/api/conflicts", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      const statusRaw = gitExec(path, "git -c core.quotepath=false status --short");
      const conflictFiles = statusRaw.split("\n")
        .filter(line => {
          const s = line.trim().slice(0, 2);
          return s.includes("U");
        })
        .map(line => ({ raw: line, name: line.slice(2).trim() }));

      const conflicts = [];
      for (const { raw, name } of conflictFiles) {
        const content = readFileSync(join(path, name), "utf8");
        const blocks = [];
        const re = /<<<<<<<\s+(\S+)\s*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>>\s+(\S+)\s*/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          blocks.push({
            headLabel: m[1],
            headContent: m[2],
            theirLabel: m[4],
            theirContent: m[3],
          });
        }
        conflicts.push({ file: name, blocks, rawStatus: raw.trim().slice(0, 2) });
      }

      return c.json({ ok: true, conflicts, hasConflicts: conflicts.length > 0 });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // ======== API: 解决冲突 ========
  app.post("/api/conflict-resolve", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repo = repoPath(body.path);
    const file = String(body.file || "").trim();
    const picks = body.picks; // [{ blockIndex, side: "head"|"their" }]

    if (!file || !picks || !Array.isArray(picks)) {
      return c.json({ ok: false, message: "缺少参数" });
    }

    try {
      const repoRoot = gitExecFile(repo, ["rev-parse", "--show-toplevel"], { timeout: 10000 });
      const filePath = join(repoRoot, file);
      const normalizedRoot = repoRoot.replace(/[\\/]+$/, "").toLowerCase();
      const normalizedFile = filePath.toLowerCase();
      if (normalizedFile !== normalizedRoot && !normalizedFile.startsWith(normalizedRoot + "\\") && !normalizedFile.startsWith(normalizedRoot + "/")) {
        return c.json({ ok: false, message: "文件路径必须位于当前仓库内" });
      }
      let content = readFileSync(filePath, "utf8");

      // 从后往前替换，避免 index 错位
      const re = /<<<<<<<\s+\S+\s*\r?\n[\s\S]*?=======\r?\n[\s\S]*?>>>>>>>\s+\S+\s*/g;
      const matches = [...content.matchAll(re)];

      // 按 picks 替换
      for (const pick of picks) {
        const idx = pick.blockIndex;
        const side = pick.side; // "head" or "their"
        if (idx >= matches.length) continue;

        const rawBlock = matches[idx][0];
        // 解析出保留的内容
        const innerRe = /<<<<<<<\s+\S+\s*\r?\n([\s\S]*?)=======\r?\n([\s\S]*?)>>>>>>>\s+\S+\s*/;
        const inner = rawBlock.match(innerRe);
        if (!inner) continue;
        const keep = side === "head" ? inner[1] : inner[2];
        // 替换整块为保留的内容（去除末尾多余换行）
        content = content.replace(rawBlock, keep.replace(/\n$/, ""));
      }

      writeFileSync(filePath, content, "utf8");
      gitExecFile(repo, ["add", "--", file]);

      return c.json({ ok: true, message: `${file} 冲突已解决` });
    } catch (e) {
      return c.json({ ok: false, message: `解决失败：${e.message}` });
    }
  });

  // ======== API: 读写仓库路径配置 ========
  app.get("/api/repo", async (c) => {
    const repoPath = await readRepoPath(ctx);
    return c.json({ ok: true, repoPath });
  });

  app.post("/api/repo", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = String(body.repoPath || "").trim();
    await writeRepoPath(ctx, path);
    return c.json({ ok: true, repoPath: path });
  });

  // ======== API: 读取仓库元信息（用于库列表面板） ========
  // 返回 basename / path tail / 远程信息 / 默认分支，路径不论是否 git 仓库都返回
  app.get("/api/repo-info", async (c) => {
    const path = repoPath(c.req.query("path"));
    const out = {
      ok: false,
      path,
      basename: extractBasename(path),
      parentTail: extractParentTail(path),
      isGit: false,
      origin: "",
      defaultBranch: ""
    };
    if (!path) return c.json(out);

    // 判断是否为 git 仓库
    try {
      gitExec(path, "git rev-parse --is-inside-work-tree");
      out.isGit = true;
    } catch {
      return c.json(out); // 不是 git 仓库，basename 仍可用
    }

    // 远程 origin（需静默错误：未设置 remote 时 git config --get 返回 1）
    try { out.origin = parseOriginUrl(gitExec(path, "git config --get remote.origin.url")); } catch {}

    // 默认分支：先试 symbolic-ref（需先 fetch），失败则退到 init.defaultBranch，再不济给 "main"
    try {
      const sym = gitExec(path, "git symbolic-ref --short refs/remotes/origin/HEAD");
      out.defaultBranch = (sym || "").replace(/^origin\//, "");
    } catch {}
    if (!out.defaultBranch) {
      try { out.defaultBranch = gitExec(path, "git config init.defaultBranch") || "main"; } catch {}
      if (!out.defaultBranch) out.defaultBranch = "main";
    }

    out.ok = true;
    return c.json(out);
  });

  // ======== API: GitHub 管理 ========
  // gh 自己会读取 GitHub CLI 的登录配置。不要把 Git 的用户级代理强行注入 gh，
  // 否则可能与 gh 的网络实现或本机代理状态冲突，导致 GraphQL 返回 EOF。
  function ghExec(args, opts = {}) {
    return execFileSync("gh", args, {
      encoding: "utf8",
      timeout: opts.timeout || 30000,
      windowsHide: true,
      env: ghEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  app.post("/api/gh/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const privacy = body.private ? "--private" : "--public";
    const description = String(body.description || "").trim();
    const license = normalizeLicense(body.license);
    const localPath = String(body.localPath || "").trim();
    if (!name) return c.json({ ok: false, message: "请输入仓库名" });

    try {
      let localLicense = { applied: false, existing: false, committed: false };
      let localHasCommit = false;
      if (localPath) {
        gitExecFile(localPath, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
        localHasCommit = hasHeadCommit(localPath);
        if (license && localHasCommit) {
          localLicense = applyLicenseToLocalRepo(localPath, license);
          if (localLicense.applied) {
            const status = gitExecFile(localPath, ["status", "--porcelain", "--", "LICENSE"], { timeout: 10000 });
            if (status) {
              gitExecFile(localPath, ["add", "--", "LICENSE"], { timeout: 10000 });
              gitExecFile(localPath, ["commit", "-m", `chore: add ${license} license`], { timeout: 30000 });
              localLicense.committed = true;
            }
          }
        }
      }

      const args = ["repo", "create", name, privacy];
      if (description) args.push("--description", description);
      // 已有本地提交时，许可证已经在本地生成并提交，远程必须保持空初始化，避免产生分叉。
      if (license && !localHasCommit) args.push("--license", license);
      const url = ghExec(args);

      if (localPath) {
        try {
          try {
            gitExecFile(localPath, ["remote", "get-url", "origin"], { timeout: 10000 });
            gitExecFile(localPath, ["remote", "set-url", "origin", url], { timeout: 10000 });
          } catch {
            gitExecFile(localPath, ["remote", "add", "origin", url], { timeout: 10000 });
          }
          if (localHasCommit) {
            const branch = gitExecFile(localPath, ["branch", "--show-current"], { timeout: 10000 });
            if (branch && validateBranchName(localPath, branch)) {
              gitExecFile(localPath, ["push", "--set-upstream", "origin", `${branch}:${branch}`], { timeout: 120000 });
            }
          }
        } catch (e) {
          return c.json({ ok: false, url, license, message: `GitHub 仓库已创建，但本地关联或首次推送失败：${commandErrorText(e)}` });
        }
      }
      const details = localLicense.committed ? `，已在本地提交 ${license} 许可证` : (license ? `，已选择 ${license} 许可证` : "");
      return c.json({ ok: true, url, license, localLicense, message: `已创建并关联：${url}${details}` });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "创建失败" }); }
  });

  app.post("/api/gh/clone", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url || "").trim();
    const dir = String(body.dir || "").trim();
    if (!url) return c.json({ ok: false, message: "请输入仓库 URL" });
    if (!isValidRemoteUrl(url)) return c.json({ ok: false, message: "仓库 URL 格式不正确" });
    try {
      const args = ["repo", "clone", url];
      if (dir) args.push(dir);
      ghExec(args, { timeout: 120000 });
      return c.json({ ok: true, message: "克隆成功" });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "克隆失败" }); }
  });

  app.get("/api/gh/list", async (c) => {
    const owner = String(c.req.query("owner") || "").trim();
    try {
      const args = ["repo", "list"];
      if (owner) args.push(owner);
      args.push("--limit", "30", "--json", "name,owner,description,url,isPrivate,updatedAt");
      const raw = ghExec(args);
      const repos = JSON.parse(raw);
      return c.json({ ok: true, repos });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "获取仓库列表失败" }); }
  });

  app.post("/api/gh/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定仓库名" });
    if (!body.confirmed) return c.json({ ok: false, code: "CONFIRM_REQUIRED", message: "删除 GitHub 仓库需要二次确认" });
    try {
      ghExec(["repo", "delete", name, "--yes"]);
      return c.json({ ok: true, message: `已删除：${name}` });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "删除失败" }); }
  });

  app.get("/api/gh/search", async (c) => {
    const q = String(c.req.query("q") || "").trim();
    if (!q) return c.json({ ok: true, repos: [] });
    try {
      const raw = ghExec(["search", "repos", q, "--limit", "20", "--json", "name,owner,description,url,isPrivate,updatedAt"]);
      const repos = JSON.parse(raw);
      return c.json({ ok: true, repos });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "搜索仓库失败" }); }
  });

  // ======== API: 将当前本地仓库关联到已有远程仓库 ========
  app.post("/api/gh/connect", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const localPath = String(body.localPath || "").trim();
    const remoteUrl = String(body.remoteUrl || "").trim();
    const remote = String(body.remote || "origin").trim() || "origin";

    if (!localPath) return c.json({ ok: false, message: "请先选择本地仓库" });
    if (!remoteUrl || !isValidRemoteUrl(remoteUrl)) return c.json({ ok: false, message: "GitHub 仓库 URL 格式不正确" });
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });

    try {
      gitExecFile(localPath, ["rev-parse", "--is-inside-work-tree"], { timeout: 10000 });
      let previousUrl = "";
      try { previousUrl = gitExecFile(localPath, ["remote", "get-url", remote], { timeout: 10000 }); } catch {}
      if (previousUrl && !body.confirmed) {
        return c.json({ ok: false, code: "REMOTE_REPLACE_CONFIRM", requiresConfirmation: true, remote, previousUrl, nextUrl: remoteUrl, message: "当前远程名称已经存在，需要确认是否替换" });
      }
      if (previousUrl) {
        gitExecFile(localPath, ["remote", "set-url", remote, remoteUrl], { timeout: 10000 });
      } else {
        gitExecFile(localPath, ["remote", "add", remote, remoteUrl], { timeout: 10000 });
      }
      gitExecFile(localPath, ["fetch", "--prune", remote], { timeout: 120000 });
      let currentBranch = "";
      try { currentBranch = gitExecFile(localPath, ["branch", "--show-current"], { timeout: 10000 }); } catch {}
      return c.json({
        ok: true,
        remote,
        remoteUrl,
        previousUrl,
        branch: currentBranch,
        message: previousUrl ? "已更新远程仓库关联" : "已关联远程仓库",
      });
    } catch (e) {
      return c.json({ ok: false, message: `关联失败：${commandErrorText(e) || "无法访问远程仓库"}` });
    }
  });

  // ======== API: 读写配置 ========
  app.get("/api/config", async (c) => {
    try {
      const data = await readFile(configPath(ctx), "utf8");
      return c.json({ ok: true, config: JSON.parse(data) });
    } catch { return c.json({ ok: true, config: {} }); }
  });

  app.post("/api/config", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      let current = {};
      try {
        const data = await readFile(configPath(ctx), "utf8");
        current = JSON.parse(data);
      } catch {}
      const merged = { ...current, ...body };
      mkdirSync(join(configPath(ctx), ".."), { recursive: true });
      await writeFile(configPath(ctx), JSON.stringify(merged, null, 2), "utf8");
      return c.json({ ok: true, config: merged });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  // ======== API: 分支管理 ========
  app.get("/api/branches", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      const current = gitExec(path, "git branch --show-current");
      const raw = gitExec(path, "git branch");
      const branches = raw.split("\n").filter(Boolean).map(line => ({
        name: line.replace(/^\*?\s*/, "").trim(),
        current: line.trimStart().startsWith("*"),
      }));
      // 对每个分支获取最后一条提交消息
      for (const b of branches) {
        try {
          const logMsg = gitExecFile(path, ["log", "-1", "--format=%s", b.name], { timeout: 10000 });
          b.lastCommit = logMsg || "";
          b.lastHash = gitExecFile(path, ["log", "-1", "--format=%h", b.name], { timeout: 10000 });
        } catch { b.lastCommit = ""; b.lastHash = ""; }
      }
      return c.json({ ok: true, branches, current });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  app.post("/api/branch/switch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定分支名" });
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      gitExecFile(path, ["checkout", name]);
      return c.json({ ok: true, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `切换失败：${e.message}` });
    }
  });

  app.post("/api/branch/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定新分支名" });
    const startPoint = String(body.startPoint || "").trim();
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      const args = ["branch", name];
      if (startPoint) args.push(startPoint);
      gitExecFile(path, args);
      return c.json({ ok: true, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `创建失败：${e.message}` });
    }
  });

  app.post("/api/branch/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定分支名" });
    if (!validateBranchName(path, name)) return c.json({ ok: false, message: "分支名格式不正确" });
    try {
      gitExecFile(path, ["branch", "-D", name]);
      return c.json({ ok: true, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `删除失败：${e.message}` });
    }
  });

  // ======== API: 远程同步状态 ========
  app.post("/api/sync-status", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "origin").trim() || "origin";
    const requestedBranch = String(body.branch || "").trim();
    if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });

    try {
      const branch = requestedBranch || gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!validateBranchName(path, branch)) return c.json({ ok: false, message: "当前分支名无效" });
      const remoteUrl = gitExecFile(path, ["remote", "get-url", remote], { timeout: 10000 });
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const remoteRef = `${remote}/${branch}`;
      let remoteHash = "";
      try { remoteHash = gitExecFile(path, ["rev-parse", remoteRef], { timeout: 10000 }); } catch {}
      if (!remoteHash) {
        return c.json({ ok: true, branch, remote, remoteUrl, hasUpstream: false, ahead: 0, behind: 0, diverged: false, message: "远程分支尚未建立" });
      }
      const counts = gitExecFile(path, ["rev-list", "--left-right", "--count", `${remoteRef}...${branch}`], { timeout: 10000 }).split(/\s+/).map(Number);
      const behind = Number.isFinite(counts[0]) ? counts[0] : 0;
      const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
      const commits = parseCommitList(gitExecFile(path, ["log", "--format=%H|%s", "-n", "20", `${branch}..${remoteRef}`], { timeout: 10000 }))
        .map((item) => ({ hash: item.hash.slice(0, 12), subject: item.subject }));
      const files = parseNameStatus(gitExecFile(path, ["diff", "--name-status", `${branch}..${remoteRef}`], { timeout: 10000 }));
      return c.json({ ok: true, branch, remote, remoteUrl, remoteHash, hasUpstream: true, ahead, behind, diverged: ahead > 0 && behind > 0, commits, files });
    } catch (e) {
      return c.json({ ok: false, message: commandErrorText(e) || "获取远程状态失败" });
    }
  });

  // ======== API: 拉取远程 ========
  app.post("/api/pull", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "origin").trim() || "origin";
    try {
      const actualBranch = String(body.branch || "").trim() || gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!validateBranchName(path, actualBranch)) return c.json({ ok: false, message: "当前分支名无效" });
      const config = await readConfig(ctx);
      const pullMode = ["merge", "rebase", "ff-only"].includes(body.mode) ? body.mode : (["merge", "rebase", "ff-only"].includes(config.pullMode) ? config.pullMode : "merge");
      const pullArgs = ["pull"];
      if (pullMode === "rebase") pullArgs.push("--rebase");
      else if (pullMode === "ff-only") pullArgs.push("--ff-only");
      else pullArgs.push("--no-rebase");
      pullArgs.push(remote, actualBranch);
      const raw = gitExecFile(path, pullArgs, { timeout: 120000 });
      const alreadyUpToDate = raw.includes("Already up to date") || raw.includes("Already-up-to-date");
      return c.json({ ok: true, mode: pullMode, message: alreadyUpToDate ? "已经是最新" : "拉取成功" });
    } catch (e) {
      const stderr = commandErrorText(e);
      const errLine = stderr.split("\n").find(l => l.includes("error:") || l.includes("fatal:"));
      return c.json({ ok: false, message: errLine ? errLine.replace(/^(error:|fatal:)\s*/, "").trim() : "拉取失败" });
    }
  });

  // ======== 在默认浏览器中打开 URL ========
  app.get("/api/open-external", async (c) => {
    const url = String(c.req.query("url") || "").trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return c.json({ ok: false, message: "只允许打开 http/https 链接" });
    try {
      execFileSync("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, timeout: 10000 });
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.post("/api/push", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "origin").trim() || "origin";
    const requestedBranch = String(body.branch || "").trim();
    const force = body.force === true;
    const expectedRemoteHash = String(body.expectedRemoteHash || "").trim();
    try {
      if (!isValidRemoteName(remote)) return c.json({ ok: false, message: "远程名称格式不正确" });
      const actualBranch = requestedBranch || gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!validateBranchName(path, actualBranch)) return c.json({ ok: false, message: "当前分支名无效" });
      const config = await readConfig(ctx);
      const pushMode = ["normal", "force-with-lease", "force"].includes(body.mode) ? body.mode : (["normal", "force-with-lease", "force"].includes(config.pushMode) ? config.pushMode : "normal");

      // 推送前先获取远程状态。确认覆盖必须绑定到用户确认时看到的远程 hash。
      gitExecFile(path, ["fetch", "--prune", remote], { timeout: 120000 });
      const remoteRef = `${remote}/${actualBranch}`;
      let remoteHash = "";
      try { remoteHash = gitExecFile(path, ["rev-parse", remoteRef], { timeout: 10000 }); } catch {}
      if (remoteHash) {
        const counts = gitExecFile(path, ["rev-list", "--left-right", "--count", `${remoteRef}...${actualBranch}`], { timeout: 10000 }).split(/\s+/).map(Number);
        const behind = Number.isFinite(counts[0]) ? counts[0] : 0;
        const ahead = Number.isFinite(counts[1]) ? counts[1] : 0;
        if (behind > 0 && !force) {
          const commits = parseCommitList(gitExecFile(path, ["log", "--format=%H|%s", "-n", "20", `${actualBranch}..${remoteRef}`], { timeout: 10000 }))
            .map((item) => ({ hash: item.hash.slice(0, 12), subject: item.subject }));
          const files = parseNameStatus(gitExecFile(path, ["diff", "--name-status", `${actualBranch}..${remoteRef}`], { timeout: 10000 }));
          return c.json({
            ok: false,
            code: "REMOTE_AHEAD",
            requiresConfirmation: true,
            remoteHash,
            ahead,
            behind,
            diverged: ahead > 0,
            branch: actualBranch,
            remote,
            commits,
            files,
            message: ahead > 0 ? "本地与远程已分叉" : "远程包含本地没有的提交",
          });
        }
        if (force && expectedRemoteHash && expectedRemoteHash !== remoteHash) {
          return c.json({ ok: false, code: "REMOTE_CHANGED", message: "确认后远程仓库又发生了变化，请重新检查后再覆盖" });
        }
      }

      const pushArgs = ["push"];
      if (force) {
        // 二次确认后的覆盖只允许安全强推，并锁定用户确认时看到的远程提交。
        pushArgs.push(expectedRemoteHash ? `--force-with-lease=refs/heads/${actualBranch}:${expectedRemoteHash}` : "--force-with-lease");
      } else if (pushMode === "force") pushArgs.push("--force");
      else if (pushMode === "force-with-lease") pushArgs.push("--force-with-lease");
      pushArgs.push(remote, `${actualBranch}:${actualBranch}`);
      const raw = gitExecFile(path, pushArgs, { timeout: 120000 });
      const upToDate = raw.includes("up-to-date") || raw.includes("Everything up-to-date");
      return c.json({ ok: true, mode: force ? "force-with-lease" : pushMode, message: upToDate ? "没有新提交需要推送" : (force ? "已按本地版本覆盖远程" : "推送成功") });
    } catch (e) {
      const stderr = commandErrorText(e);
      let cn = "";
      if (stderr.includes("non-fast-forward")) cn = "推送被拒绝：远程包含本地没有的提交";
      else if (stderr.includes("Could not read from remote")) cn = "无法连接远程仓库，请检查网络或仓库地址";
      else if (stderr.includes("Repository not found")) cn = "远程仓库不存在，请检查仓库地址";
      else if (stderr.includes("Permission denied")) cn = "权限不足，请检查 GitHub 登录状态";
      else if (stderr.includes("unable to access")) cn = "无法访问远程仓库，请检查网络连接";
      else {
        const errLine = stderr.split("\n").find(l => l.includes("error:") || l.includes("fatal:"));
        cn = errLine ? "推送失败：" + errLine.replace(/^(error:|fatal:)\s*/, "").trim() : "推送失败";
      }
      return c.json({ ok: false, message: cn });
    }
  });

  // ======== API: Stash ========
  app.get("/api/stash/list", async (c) => {
    const path = repoPath(c.req.query("path"));
    try {
      const raw = gitExec(path, "git stash list");
      if (!raw) return c.json({ ok: true, stashes: [] });
      const stashes = raw.split("\n").filter(Boolean).map((line, i) => {
        const idx = line.match(/stash@\{(\d+)\}/);
        const msg = line.replace(/^stash@\{\d+\}:[^:]*:\s*/, "");
        return { index: parseInt(idx?.[1] ?? i), message: msg || line };
      });
      return c.json({ ok: true, stashes });
    } catch (e) { return c.json({ ok: true, stashes: [] }); }
  });

  app.post("/api/stash/push", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const msg = String(body.message || "").trim();
    try {
      const args = ["stash", "push", "-u"];
      if (msg) args.push("-m", msg);
      gitExecFile(path, args);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "暂存失败" }); }
  });

  app.post("/api/stash/pop", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const idx = parseInt(body.index);
    if (!Number.isInteger(idx) || idx < 0) return c.json({ ok: false, message: "暂存索引无效" });
    try {
      gitExecFile(path, ["stash", "pop", `stash@{${idx}}`]);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "恢复暂存失败" }); }
  });

  app.post("/api/stash/drop", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const idx = parseInt(body.index);
    if (!Number.isInteger(idx) || idx < 0) return c.json({ ok: false, message: "暂存索引无效" });
    try {
      gitExecFile(path, ["stash", "drop", `stash@{${idx}}`]);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: commandErrorText(e) || "删除暂存失败" }); }
  });

  // 返回插件版本号（从 manifest.json 读取）
  app.get("/api/plugin-version", async (c) => {
    try {
      const manifestPath = join(__dirname, "..", "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      return c.json({ ok: true, version: manifest.version || "unknown" });
    } catch (e) {
      return c.json({ ok: false, version: "unknown" });
    }
  });
}
