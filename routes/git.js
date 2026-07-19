// git-tools / routes / git.js
// 提供后端 API + 页面渲染。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, exec } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(__dirname, "..", "views", "git.html");
let cachedHtml = null;

async function loadHtml() {
  if (cachedHtml) return cachedHtml;
  cachedHtml = await readFile(htmlPath, "utf8");
  return cachedHtml;
}

// 执行 git 命令的辅助函数
function gitExec(cwd, cmd) {
  return execSync(cmd, { cwd, encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
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
      const localName = execSync("git config user.name", { cwd: path, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
      const localEmail = execSync("git config user.email", { cwd: path, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
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
        gitExec(path, `git tag ${tag}`);
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
      gitExec(path, `git config user.name "${name.replace(/"/g, '\\"')}"`);
      gitExec(path, `git config user.email "${email.replace(/"/g, '\\"')}"`);
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
      const localName = execSync("git config user.name", { cwd: path, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
      const localEmail = execSync("git config user.email", { cwd: path, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
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
      gitExec(path, `git cat-file -t ${commit}`);
      const before = gitExec(path, "git log --oneline -n 1");
      const target = gitExec(path, `git log --oneline -n 1 ${commit}`);
      gitExec(path, `git reset --${mode} ${commit}`);

      // 清理回滚后失效的 tag（指向历史外 commit 的 tag）
      const cleanedTags = [];
      try {
        const tagRaw = gitExec(path, 'git tag --format="%(objectname:short)|%(refname:short)"');
        for (const line of tagRaw.split("\n").filter(Boolean)) {
          const [h, t] = line.split("|");
          if (!h || !t) continue;
          try {
            gitExec(path, `git merge-base --is-ancestor ${h} HEAD 2>nul`);
          } catch {
            gitExec(path, `git tag -d ${t}`);
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
      const filePath = join(repo, file);
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
      gitExec(repo, `git add "${file}"`);

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
  function ghExec(args) {
    // 直接读取Windows用户环境变量，确保代理等配置生效
    const env = { ...process.env };
    try {
      const userHttps = execSync('[System.Environment]::GetEnvironmentVariable("HTTPS_PROXY", "User")', { encoding: 'utf8', shell: 'powershell', windowsHide: true }).trim();
      const userHttp = execSync('[System.Environment]::GetEnvironmentVariable("HTTP_PROXY", "User")', { encoding: 'utf8', shell: 'powershell', windowsHide: true }).trim();
      if (userHttps) env.HTTPS_PROXY = userHttps;
      if (userHttp) env.HTTP_PROXY = userHttp;
    } catch {}
    const result = execSync(`gh ${args.join(" ")}`, { encoding: "utf8", timeout: 30000, windowsHide: true, env }).trim();
    return result;
  }

  app.post("/api/gh/create", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const privacy = body.private ? "--private" : "--public";
    const desc = body.description ? `--description "${body.description.replace(/"/g, "'")}"` : "";
    if (!name) return c.json({ ok: false, message: "请输入仓库名" });
    try {
      const url = ghExec(["repo", "create", name, privacy, desc].filter(Boolean));
      // 如果有本地路径就关联远程
      const localPath = String(body.localPath || "").trim();
      if (localPath) {
        const { execSync } = await import("node:child_process");
        try {
          execSync(`git remote get-url origin`, { cwd: localPath, encoding: "utf8", windowsHide: true });
          // origin 已存在 → 更新
          execSync(`git remote set-url origin ${url}`, { cwd: localPath, encoding: "utf8", windowsHide: true });
        } catch {
          // origin 不存在 → 添加
          execSync(`git remote add origin ${url}`, { cwd: localPath, encoding: "utf8", windowsHide: true });
        }
      }
      return c.json({ ok: true, url, message: `已创建：${url}` });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.post("/api/gh/clone", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body.url || "").trim();
    const dir = String(body.dir || "").trim();
    if (!url) return c.json({ ok: false, message: "请输入仓库 URL" });
    try {
      const cmd = dir ? `gh repo clone ${url} "${dir}"` : `gh repo clone ${url}`;
      const { execSync } = await import("node:child_process");
      execSync(cmd, { encoding: "utf8", timeout: 120000, windowsHide: true });
      return c.json({ ok: true, message: "克隆成功" });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.get("/api/gh/list", async (c) => {
    const owner = String(c.req.query("owner") || "").trim() || "";
    try {
      const raw = ghExec(["repo", "list", owner, "--limit", "30", "--json", "name,owner,description,url,isPrivate,updatedAt"]);
      const repos = JSON.parse(raw);
      return c.json({ ok: true, repos });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.post("/api/gh/delete", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return c.json({ ok: false, message: "请指定仓库名" });
    try {
      ghExec(["repo", "delete", name, "--yes"]);
      return c.json({ ok: true, message: `已删除：${name}` });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.get("/api/gh/search", async (c) => {
    const q = String(c.req.query("q") || "").trim();
    if (!q) return c.json({ ok: true, repos: [] });
    try {
      const raw = ghExec(["search", "repos", q, "--limit", "20", "--json", "name,owner,description,url,isPrivate,updatedAt"]);
      const repos = JSON.parse(raw);
      return c.json({ ok: true, repos });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
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
          const logMsg = gitExec(path, `git log -1 --format="%s" ${b.name}`);
          b.lastCommit = logMsg || "";
          b.lastHash = gitExec(path, `git log -1 --format="%h" ${b.name}`);
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
    try {
      gitExec(path, `git checkout "${name}"`);
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
    try {
      var cmd = startPoint ? `git branch "${name}" "${startPoint}"` : `git branch "${name}"`;
      gitExec(path, cmd);
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
    try {
      gitExec(path, `git branch -D "${name}"`);
      return c.json({ ok: true, branch: name });
    } catch (e) {
      return c.json({ ok: false, message: `删除失败：${e.message}` });
    }
  });

  // ======== API: 推送到远程 ========
  app.post("/api/pull", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    try {
      const actualBranch = gitExec(path, "git branch --show-current");
      const raw = gitExec(path, `git pull --no-rebase origin "${actualBranch}" 2>&1`);
      const alreadyUpToDate = raw.includes("Already up to date") || raw.includes("Already up-to-date");
      return c.json({ ok: true, message: alreadyUpToDate ? "已经是最新" : "拉取成功" });
    } catch (e) {
      let stderr = "";
      try { stderr = e.stderr || e.stdout || ""; } catch {}
      if (!stderr && e.message) {
        const idx = e.message.indexOf("stderr: ");
        if (idx > 0) stderr = e.message.substring(idx + 8);
        else stderr = e.message;
      }
      const errLine = stderr.split("\n").find(l => l.includes("error:") || l.includes("fatal:"));
      return c.json({ ok: false, message: errLine ? errLine.replace(/^(error:|fatal:)\s*/, "").trim() : "拉取失败" });
    }
  });

  // ======== 在默认浏览器中打开 URL ========
  app.get("/api/open-external", async (c) => {
    const url = String(c.req.query("url") || "").trim();
    if (!url) return c.json({ ok: false, message: "缺少 URL" });
    try {
      exec(`start "" "${url.replace(/"/g, "'")}"`, { windowsHide: true });
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.post("/api/push", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const remote = String(body.remote || "origin").trim() || "origin";
    const branch = String(body.branch || "").trim();
    try {
      const actualBranch = branch || gitExec(path, "git branch --show-current");
      const raw = gitExec(path, `git push "${remote}" "${actualBranch}" 2>&1`);
      const upToDate = raw.includes("up-to-date") || raw.includes("Everything up-to-date");
      return c.json({ ok: true, message: upToDate ? "没有新提交需要推送" : "推送成功" });
    } catch (e) {
      let stderr = "";
      try { stderr = e.stderr || e.stdout || ""; } catch {}
      if (!stderr && e.message) {
        const idx = e.message.indexOf("stderr: ");
        if (idx > 0) stderr = e.message.substring(idx + 8);
        else stderr = e.message;
      }
      let cn = "";
      if (stderr.includes("non-fast-forward")) cn = "推送被拒绝：远程包含本地没有的提交。请先拉取或使用强制推送";
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
      const cmd = msg ? `git stash push -u -m "${msg.replace(/"/g, "'")}"` : "git stash push -u";
      gitExec(path, cmd);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.post("/api/stash/pop", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const idx = parseInt(body.index);
    try {
      gitExec(path, `git stash pop stash@{${idx}}`);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });

  app.post("/api/stash/drop", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const idx = parseInt(body.index);
    try {
      gitExec(path, `git stash drop stash@{${idx}}`);
      return c.json({ ok: true });
    } catch (e) { return c.json({ ok: false, message: e.message }); }
  });
}
