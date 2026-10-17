// git-tools / tools / show_files.js
// 只读展示：把一组文件的「改了哪些行」摊成一张两行小卡，取代宿主 stage_files
// 那张只有文件名和 MIME 的句柄卡。
//
// 数据怎么到卡片：工具把结果写进 dataDir/show-files.json，卡片拿 iframe URL 上的
// appSurfaceSession 调本 App 自己的 /api/show-files 读回来。宿主不会把工具参数
// 传进卡片 iframe，所以必须走这条侧路。

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, isAbsolute, resolve, basename, extname } from "node:path";

import { resolvePath, resolveDataDir, gitExec, gitExecCapture } from "./_helpers.js";

export const name = "show_files";

export const description =
  "展示一组文件，并在对话里出一张卡片：每个文件一行，显示路径、状态与增删行数，" +
  "带「查看变更」「回退变更」按钮。只读自身不改文件；回退按钮要点确认才会动。";

export const sessionPermission = { readOnly: true };

export const parameters = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "要展示的文件路径数组，可为绝对路径，也可为相对仓库根的路径。",
    },
    path: {
      type: "string",
      description: "仓库路径。不传则使用插件配置中保存的路径，或从文件所属目录反查。",
    },
    title: {
      type: "string",
      description: "卡片标题。不传则按「N 个文件」自动生成。",
    },
  },
  required: ["paths"],
};

const MAX_PATHS = 200;

/** 从某个目录往上找 .git，找到就是仓库根。找不到返回空串。 */
function findRepoRoot(startDir) {
  const cap = gitExecCapture(startDir, ["rev-parse", "--show-toplevel"], { timeout: 8000 });
  if (!cap.ok) return "";
  return String(cap.stdout || "").trim().replace(/\\/g, "/");
}

/** 读文件前 64KB 判一下是不是二进制（含 NUL 就按二进制算）。 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 65536);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * 未跟踪文件的行数：拿一个空文件做基底跑 `git diff --no-index --numstat`。
 *
 * 为什么不用读文件内容再数行：宿主里 `ctx.resources.read` 读安装目录下的文件
 * 会失败（实测三个新文件全回落到 0 行），而这条 git 命令不需要 ResourceIO。
 * --有差异时退出码是 1，所以走 execCapture（不抛，只取 stdout）。
 */
function countUntrackedViaGit(root, emptyPath, absPath) {
  const cap = gitExecCapture(root, ["diff", "--no-index", "--numstat", emptyPath, absPath], { timeout: 20000 });
  const out = String(cap.stdout || "").trim();
  if (!out) return null;
  const first = out.split("\n")[0];
  const [added, deleted] = first.split("\t");
  if (added === "-") return { added: 0, deleted: 0, binary: true };
  return { added: parseInt(added, 10) || 0, deleted: parseInt(deleted, 10) || 0, binary: false };
}

function countLines(text) {
  if (!text) return 0;
  const bare = text.replace(/\r\n/g, "\n");
  const n = bare.split("\n").length;
  return bare.endsWith("\n") ? n - 1 : n;
}

/** 把 git 状态码翻成人话。 */
function statusLabel(code) {
  const c = String(code || "").trim();
  if (!c) return "未改动";
  if (c === "??") return "新文件";
  if (c === "A") return "新增";
  if (c === "D") return "删除";
  if (c === "R") return "重命名";
  if (c === "C") return "复制";
  if (c.includes("U")) return "冲突";
  if (c === "M") return "修改";
  return c;
}

/**
 * 读一个仓库里各文件的状态码。
 *
 * 不用 `git status --porcelain`：gitExec 会对整体结果做 trim，而 porcelain 的
 * 第一行状态码前面就是一个空格（" M path"），trim 掉之后 slice(3) 会少切一个字符，
 * 路径变成 "ndex.js"。`diff --name-status` 和 `ls-files --others` 都是
 * "CODE\tpath" / "path"，没有前导空格，trim 不影响。
 */
function readStatusMap(root) {
  const map = {};
  try {
    const raw = gitExec(root, ["-c", "core.quotepath=false", "diff", "--name-status", "HEAD"], { timeout: 20000 });
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0];
      // 重命名/复制是 "R100\told\tnew"，取目标路径。
      const target = parts.length >= 3 ? parts[2] : parts[1];
      if (!target) continue;
      map[target.replace(/\\/g, "/")] = code.charAt(0);
    }
  } catch {
    // HEAD 不存在（空仓库）时静默跳过
  }
  try {
    const raw = gitExec(root, ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"], { timeout: 20000 });
    for (const line of raw.split("\n")) {
      const p = line.trim();
      if (!p) continue;
      const key = p.replace(/\\/g, "/");
      if (!(key in map)) map[key] = "??";
    }
  } catch {
    // 无未跟踪文件不是错误
  }
  return map;
}

/** 解析 numstat 行：added \t deleted \t path（二进制为 -）。 */
function parseNumstat(raw) {
  const out = {};
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...rest] = line.split("\t");
    const p = rest.join("\t");
    if (!p) continue;
    if (added === "-") {
      out[p] = { added: 0, deleted: 0, binary: true };
      continue;
    }
    out[p] = { added: parseInt(added, 10) || 0, deleted: parseInt(deleted, 10) || 0, binary: false };
  }
  return out;
}

async function readTextVia(ctx, absPath) {
  try {
    const res = await ctx.resources.read({ kind: "local-file", path: absPath });
    const content = res && typeof res === "object" && "content" in res ? res.content : res;
    if (content == null) return null;
    const buf = Buffer.isBuffer(content)
      ? content
      : content instanceof Uint8Array
        ? Buffer.from(content)
        : Buffer.from(String(content), "utf8");
    if (looksBinary(buf)) return { binary: true, text: "" };
    return { binary: false, text: buf.toString("utf8") };
  } catch {
    return null;
  }
}

export async function execute(input = {}, ctx = {}) {
  const rawPaths = Array.isArray(input.paths) ? input.paths : [];
  const wanted = rawPaths.map((p) => String(p || "").trim()).filter(Boolean).slice(0, MAX_PATHS);
  if (!wanted.length) {
    return JSON.stringify({ error: true, message: "paths 不能为空" }, null, 2);
  }

  const configured = await resolvePath({}, ctx);
  const dataDir = resolveDataDir(ctx);

  // 按「所属仓库」分组，同一仓库只跑一次 git diff --numstat。
  const groups = new Map();
  const files = [];

  for (const p of wanted) {
    const abs = isAbsolute(p) ? p : resolve(configured || process.cwd(), p);
    const dir = dirname(abs);
    let root = "";
    try {
      root = findRepoRoot(dir);
    } catch {
      root = "";
    }
    const rel = root ? abs.replace(/\\/g, "/").slice(root.length + 1) : "";
    const entry = { abs, rel, root, status: "", added: 0, deleted: 0, binary: false };
    files.push(entry);
    if (root) {
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(entry);
    }
  }

  for (const [root, entries] of groups) {
    const statusMap = readStatusMap(root);

    const rels = entries.map((e) => e.rel).filter(Boolean);
    let statMap = {};
    if (rels.length) {
      try {
        const raw = gitExec(root, ["-c", "core.quotepath=false", "diff", "HEAD", "--numstat", "--", ...rels], {
          timeout: 30000,
        });
        statMap = parseNumstat(raw);
      } catch {
        statMap = {};
      }
    }

    // 数未跟踪文件行数用的空基底，落在 dataDir，不碰工作区。
    let emptyPath = "";
    if (dataDir) {
      try {
        mkdirSync(dataDir, { recursive: true });
        emptyPath = join(dataDir, ".empty-baseline");
        if (!existsSync(emptyPath)) writeFileSync(emptyPath, "", "utf8");
      } catch {
        emptyPath = "";
      }
    }

    for (const e of entries) {
      const code = statusMap[e.rel] || "";
      e.status = statusLabel(code);
      e.untracked = code === "??";
      const st = statMap[e.rel];
      if (st) {
        e.added = st.added;
        e.deleted = st.deleted;
        e.binary = st.binary;
      } else if (code === "??") {
        // 未跟踪文件 git diff 看不到：先试 git --no-index，再退到读内容数行。
        let counted = null;
        if (emptyPath) {
          try {
            counted = countUntrackedViaGit(root, emptyPath, e.abs);
          } catch {
            counted = null;
          }
        }
        if (counted) {
          e.added = counted.added;
          e.deleted = counted.deleted;
          e.binary = counted.binary;
        } else {
          const got = await readTextVia(ctx, e.abs);
          if (got && got.binary) e.binary = true;
          else if (got) e.added = countLines(got.text);
        }
      }
    }
  }

  const out = files.map((f) => ({
    name: basename(f.abs),
    path: f.abs.replace(/\\/g, "/"),
    relative: f.rel || "",
    ext: extname(f.abs).replace(/^\./, "").toLowerCase(),
    status: f.status,
    added: f.added,
    deleted: f.deleted,
    binary: f.binary,
    untracked: Boolean(f.untracked),
    inRepo: Boolean(f.root),
    repo: f.root || "",
  }));

  const totalAdded = out.filter((f) => !f.binary).reduce((s, f) => s + f.added, 0);
  const totalDeleted = out.filter((f) => !f.binary).reduce((s, f) => s + f.deleted, 0);
  const payload = {
    title: String(input.title || "").trim() || `${out.length} 个文件`,
    at: Date.now(),
    repo: groups.size === 1 ? [...groups.keys()][0] : "",
    files: out,
    totalAdded,
    totalDeleted,
  };

  // 写盘给卡片读。dataDir 之外的路径写不了，这时卡片会显示「取不到数据」。
  let saved = false;
  if (dataDir) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "show-files.json"), JSON.stringify(payload), "utf8");
      saved = true;
    } catch {
      saved = false;
    }
  }

  const summary = out
    .map((f) => `- ${f.name}${f.status ? `（${f.status}）` : ""}${f.binary ? " 二进制" : ` +${f.added}/-${f.deleted}`}`)
    .join("\n");

  return {
    content: [
      {
        type: "text",
        text: `${payload.title}${saved ? "" : "（卡片数据没落盘，卡片会显示取不到数据）"}\n${summary}\n合计 +${totalAdded}/-${totalDeleted}`,
      },
    ],
    details: {
      // 必须自带 bridgedTool：v2 App 的工具名在宿主实时投影里会被泛化成 "tool_call"，
      // 归属解析（bundle 里的 nOr）只在泛化时改从 details.bridgedTool.name 取真实名。
      // 不带这个字段，卡片会被判为无主而静默丢弃，而结果里照样会写一行
      // "Card rendered. cardInstanceId: ..."——那句回执不代表卡片真的出来了。
      bridgedTool: { name: "show_files", server: "git-save-load" },
      card: {
        pluginId: "git-save-load",
        route: "/files.html",
        cardType: "iframe",
        cardForm: "flush",
        titlebar: null,
        title: payload.title,
        description: `${out.length} 个文件，合计 +${totalAdded}/-${totalDeleted}`,
        aspectRatio: 3.4,
      },
    },
  };
}
