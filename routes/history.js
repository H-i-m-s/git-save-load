// Git history read routes.
export function registerHistoryRoutes(app, { repoPath, gitExecFile }) {
  app.get("/api/log", async (c) => {
    const path = repoPath(c.req.query("path"));
    const count = Math.min(Math.max(1, parseInt(c.req.query("count") || "20", 10)), 100);
    const offset = Math.max(0, parseInt(c.req.query("skip") || "0", 10));

    try {
      const tagMap = {};
      try {
        const tagRaw = gitExecFile(path, ["tag", "--sort=-version:refname", "--format=%(objectname:short)|%(refname:short)"]);
        for (const line of tagRaw.split("\n").filter(Boolean)) {
          const [hash, tag] = line.split("|");
          if (hash && tag) tagMap[hash] = tag;
        }
      } catch {}

      const format = "%h|%s|%an|%ai";
      const raw = gitExecFile(path, ["log", `--format=${format}`, "--numstat", "-n", String(count + 1), "--skip", String(offset)]);
      const commits = [];
      let cur = null;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes("|")) {
          if (cur) commits.push(cur);
          const [hash, msg, author, date] = trimmed.split("|");
          cur = { hash, message: msg || "", author: author || "", date: date || "", tag: tagMap[hash] || "", added: 0, deleted: 0 };
        } else if (cur) {
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
            cur.added += parseInt(parts[0]) || 0;
            cur.deleted += parseInt(parts[1]) || 0;
          }
        }
      }
      if (cur) commits.push(cur);
      return c.json({ ok: true, commits: commits.slice(0, count), offset, hasMore: commits.length > count });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });
}
