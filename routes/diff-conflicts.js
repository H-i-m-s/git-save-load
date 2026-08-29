// Diff and merge-conflict routes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function registerDiffConflictRoutes(app, { repoPath, gitExecFile }) {
  // ======== API: diff ========
  app.get("/api/diff", async (c) => {
    const path = repoPath(c.req.query("path"));
    const file = String(c.req.query("file") || "").trim();

    try {
      const diffArgs = ["-c", "core.quotepath=false", "diff"];
      const diff = gitExecFile(path, [...diffArgs, "--stat", ...(file ? ["--", file] : [])]);
      const diffDetail = gitExecFile(path, [...diffArgs, ...(file ? ["--", file] : [])]);
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
      const range = `${from}..${to}`;
      const stat = gitExecFile(path, ["-c", "core.quotepath=false", "diff", "--stat", range]);
      const detail = gitExecFile(path, ["-c", "core.quotepath=false", "diff", range]);
      // 文件级统计
      const fileStats = [];
      const numstat = gitExecFile(path, ["-c", "core.quotepath=false", "diff", "--numstat", range]);
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

  // ======== API: 检测冲突文件 ========
  app.get("/api/conflicts", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      const statusRaw = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--short"]);
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
}
