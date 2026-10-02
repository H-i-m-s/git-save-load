// Git history read routes.
//
// 「列表」与「增删统计」拆成两条端点：
//   GET /api/log        只列提交（不带 --numstat）。--numstat 要对每个提交算一次
//                       tree diff，在超大仓库上极慢（e:\isaacsim\project 实测 2.6 s），
//                       它不该挡在首屏关键路径上。
//   GET /api/log-stats  拿一批 hash，一次 git 调用算完这批提交的 ± 数字，供前端在
//                       列表渲染完成后异步补齐。
// 两条端点都走注入的 gitExecFileAsync（异步，不冻结事件循环）。只读命令不进仓库锁，
// 所以不 import lib/repo-lock.js。
//
// 未取到统计时 added/deleted 用 null（不是 0）：0 表示「这个提交真的没有改动」，
// null 表示「统计还没到/取不到」，前端据此显示占位而不是 +0/-0。

const HASH_RE = /^[0-9a-f]{4,64}$/i;      // git 对象名；同时挡掉以 "-" 开头的注入
const FULL_HASH_RE = /^[0-9a-f]{7,64}$/i; // %H 输出；带制表符的 numstat 行不会命中
const MAX_STATS_HASHES = 100;             // 一次统计请求最多算多少个 hash（一页 20 远小于此）

export function registerHistoryRoutes(app, { repoPath, gitExecFile, gitExecFileAsync }) {
  app.get("/api/log", async (c) => {
    const path = repoPath(c.req.query("path"));
    const count = Math.min(Math.max(1, parseInt(c.req.query("count") || "20", 10)), 100);
    const offset = Math.max(0, parseInt(c.req.query("skip") || "0", 10));

    try {
      const tagMap = {};
      try {
        const tagRaw = await gitExecFileAsync(path, ["tag", "--sort=-version:refname", "--format=%(objectname:short)|%(refname:short)"]);
        for (const line of tagRaw.split("\n").filter(Boolean)) {
          const [hash, tag] = line.split("|");
          if (hash && tag) tagMap[hash] = tag;
        }
      } catch {}

      // 列表不带 --numstat：先秒出这些行，± 由 /api/log-stats 后台补齐。
      const format = "%h|%s|%an|%ai";
      const raw = await gitExecFileAsync(path, ["log", `--format=${format}`, "-n", String(count + 1), "--skip", String(offset)]);
      const commits = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes("|")) continue;
        const [hash, msg, author, date] = trimmed.split("|");
        commits.push({ hash, message: msg || "", author: author || "", date: date || "", tag: tagMap[hash] || "", added: null, deleted: null });
      }
      return c.json({ ok: true, commits: commits.slice(0, count), offset, hasMore: commits.length > count });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });

  // GET /api/log-stats?path=&hashes=h1,h2,...
  // 一次 `git log --no-walk=unsorted --numstat --format=%H <hash...>` 算完这批 hash 的
  // 增删（对大仓库约 2.6 s，但它在后台跑，不占首屏）。返回
  // { ok, stats: { "<hash>": { added, deleted } } }，键用请求里给的（短）hash 原样回带，
  // 前端按键填行。
  //
  // 这里用 git log --no-walk 而不是 git show：对合并提交，`git log --numstat` 不给 diff
  // （数字 0/0），而 `git show` 默认输出 combined diff，会凭空多出数字。--no-walk 与旧
  // 写法逐条对齐（已实测合并提交），保证拆分没有改变统计值。
  app.get("/api/log-stats", async (c) => {
    const path = repoPath(c.req.query("path"));
    const hashes = [];
    const seen = new Set();
    for (const part of String(c.req.query("hashes") || "").split(",")) {
      const h = part.trim();
      if (!h || seen.has(h) || !HASH_RE.test(h)) continue;
      seen.add(h);
      hashes.push(h);
      if (hashes.length >= MAX_STATS_HASHES) break;
    }
    if (!hashes.length) return c.json({ ok: true, stats: {} });

    try {
      const raw = await gitExecFileAsync(path, ["log", "--no-walk=unsorted", "--numstat", "--format=%H", ...hashes]);
      return c.json({ ok: true, stats: parseLogStats(raw, hashes) });
    } catch (e) {
      return c.json({ ok: false, message: e.message });
    }
  });
}

// 解析 `git log --no-walk=unsorted --numstat --format=%H`：每个提交以一行完整 hash
// 起头，随后是该提交的 numstat 行（"added\tdeleted\tpath"；二进制为 "-\t-"，跳过）。
// 逐条累加与该提交的 diff 等价——--no-walk 不回溯、按参数给出，每个提交的 diff 就是
// 相对首个父提交的 tree diff，与旧写法 `log --numstat` 每个提交算出来的数字一致。
function parseLogStats(raw, requested) {
  const buckets = new Map(); // full hash（小写） -> { added, deleted }
  let cur = null;
  for (const line of String(raw || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (FULL_HASH_RE.test(trimmed)) {
      cur = { added: 0, deleted: 0 };
      buckets.set(trimmed.toLowerCase(), cur);
      continue;
    }
    if (!cur) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      cur.added += parseInt(parts[0], 10) || 0;
      cur.deleted += parseInt(parts[1], 10) || 0;
    }
  }

  // 请求里是短 hash（%h），输出里是完整 hash（%H）：按前缀互相匹配，兼容任意缩写长度。
  const fulls = [...buckets.keys()];
  const stats = {};
  for (const hash of requested) {
    const h = hash.toLowerCase();
    let key = buckets.has(h) ? h : null;
    if (!key) {
      for (const full of fulls) {
        if (full.startsWith(h) || h.startsWith(full)) { key = full; break; }
      }
    }
    if (key) stats[hash] = buckets.get(key);
  }
  return stats;
}
