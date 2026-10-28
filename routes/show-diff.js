// git-tools / routes / show-diff.js
// 给 show_diff 那张卡用的三条接口：
//   GET  /api/show-diff       把上次工具落盘的结果吐回来（卡片 iframe 收不到工具参数）
//   GET  /api/show-diff/diff  单个文件的 unified diff
//   POST /api/show-diff/revert 回退单个文件的未提交改动
//
// 回退只处理已跟踪文件：未跟踪文件的「回退」等于删掉它，那不是还原，是销毁，
// 这里不做，卡片也不给这个按钮。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_DIFF_BYTES = 512 * 1024;

export function registerShowDiffRoutes(app, { ctx, dataDir, gitExecFile, repoPath, commandErrorText }) {
  app.get("/api/show-diff", async (c) => {
    if (!dataDir) {
      return c.json({ ok: false, message: "App 数据目录不可用，卡片拿不到数据" });
    }
    // 每张卡各存一份：卡片带上自己的 cardInstanceId 来认领，
    // 否则同一次会话里多张卡会同时读到最新那一份，前几张就串了。
    const id = String(c.req.query("card") || "").trim();
    const safe = /^a_[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "";
    const latest = join(dataDir, "show-diff.json");
    const own = safe ? join(dataDir, `show-diff.${safe}.json`) : "";

    try {
      if (own) {
        try {
          const text = await readFile(own, "utf8");
          return c.json({ ok: true, data: JSON.parse(text) });
        } catch (e) {
          if (!(e && e.code === "ENOENT")) throw e;
        }
      }
      const text = await readFile(latest, "utf8");
      const data = JSON.parse(text);
      return c.json({ ok: true, data });
    } catch (e) {
      if (e && e.code === "ENOENT") {
        return c.json({ ok: false, message: "还没有数据，先让我跑一次 show_diff" });
      }
      return c.json({ ok: false, message: `读取失败：${e && e.message ? e.message : e}` });
    }
  });

  // 单个文件的 diff。全新文件 git diff 看不到，用 --no-index 对着空文件比。
  app.get("/api/show-diff/diff", async (c) => {
    const repo = repoPath(c.req.query("repo"));
    const file = String(c.req.query("file") || "").trim();
    const untracked = c.req.query("untracked") === "1";
    if (!file) return c.json({ ok: false, message: "缺少 file" });

    try {
      if (untracked) {
        // 未跟踪文件：直接把内容当作全新增返回，不必真跑 git。
        const text = String((await readTextSafe(ctx, repo, file)) || "");
        const lines = text.replace(/\r\n/g, "\n").split("\n");
        if (lines[lines.length - 1] === "") lines.pop();
        const body = lines.map((l) => `+${l}`).join("\n");
        return c.json({
          ok: true,
          kind: "added",
          added: lines.length,
          deleted: 0,
          diff: `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
          truncated: false,
        });
      }

      const raw = gitExecFile(repo, ["-c", "core.quotepath=false", "diff", "HEAD", "--", file], {
        timeout: 30000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const truncated = raw.length > MAX_DIFF_BYTES;
      return c.json({
        ok: true,
        kind: "modified",
        diff: truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw,
        truncated,
      });
    } catch (e) {
      return c.json({ ok: false, message: commandErrorText ? commandErrorText(e) : e.message });
    }
  });

  // 回退单个已跟踪文件的未提交改动。只动工作区，不碰暂存区，不碰提交。
  app.post("/api/show-diff/revert", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const repo = repoPath(body.repo);
    const file = String(body.file || "").trim();
    if (!file) return c.json({ ok: false, message: "缺少 file" });

    // 未跟踪文件不走这条路：git restore 对它无效，能做的只有删，不做。
    try {
      const tracked = gitExecFile(repo, ["ls-files", "--error-unmatch", "--", file], { timeout: 10000 });
      if (!tracked) return c.json({ ok: false, message: "这个文件还没被 Git 跟踪，回退没有可还原的版本" });
    } catch {
      return c.json({ ok: false, message: "这个文件还没被 Git 跟踪，回退没有可还原的版本" });
    }

    try {
      gitExecFile(repo, ["restore", "--worktree", "--", file], { timeout: 30000 });
      return c.json({ ok: true, file });
    } catch (e) {
      return c.json({ ok: false, message: commandErrorText ? commandErrorText(e) : e.message });
    }
  });
}

/** 读仓库里的文本文件，走宿主 ResourceIO；读不到返回空串。 */
async function readTextSafe(ctx, repo, file) {
  if (!ctx || !ctx.resources) return "";
  try {
    const abs = join(repo, file).replace(/\\/g, "/");
    const res = await ctx.resources.read({ kind: "local-file", path: abs });
    const content = res && typeof res === "object" && "content" in res ? res.content : res;
    if (content == null) return "";
    if (Buffer.isBuffer(content)) return content.toString("utf8");
    if (content instanceof Uint8Array) return Buffer.from(content).toString("utf8");
    return String(content);
  } catch {
    return "";
  }
}
