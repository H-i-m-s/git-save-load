// Local Git state, basic write, and rollback routes.
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function registerLocalGitRoutes(app, { repoPath, gitExecFile, gitExecFileAsync, commandErrorText }) {
  app.get("/api/status", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      // 四个只读 git 调用并行执行（异步不阻塞事件循环），总耗时从串行累加
      // 降为最慢单项。branch/status 失败 = 不是仓库；log/diff 失败静默降级
      //（空仓库无 commit 时 log 会失败，属正常情况）。
      const branchP = gitExecFileAsync(path, ["branch", "--show-current"]);
      const statusP = gitExecFileAsync(path, ["-c", "core.quotepath=false", "status", "--short"]);
      const logP = gitExecFileAsync(path, ["log", "--format=%H %s", "--numstat", "-n", "5"]).catch(() => "");
      const diffP = gitExecFileAsync(path, ["-c", "core.quotepath=false", "diff", "--numstat"]).catch(() => "");
      let branch;
      let statusShort;
      try {
        [branch, statusShort] = await Promise.all([branchP, statusP]);
      } catch (e) {
        return c.json({ ok: false, isRepo: false, path, message: e.message });
      }
      const logRaw = await logP;
      const diffRaw = await diffP;

      // 解析 log --numstat 输出（空仓库 logRaw 为空串，recentCommits 保持空）
      let recentCommits = [];
      if (logRaw) {
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
      }

      let changed = [];
      let untracked = [];
      if (statusShort) {
        for (const line of statusShort.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          if (t.startsWith("??")) untracked.push(t.slice(2).trim());
          else changed.push(t);
        }
      }

      // 获取每个文件的增删统计（与 branch/status/log 并行，上面已发起）
      const numstat = {};
      if (diffRaw) {
        for (const line of diffRaw.split("\n").filter(Boolean)) {
          const [added, deleted, ...nameParts] = line.split("\t");
          const name = nameParts.join("\t");
          if (name && added !== "-") numstat[name] = { added: parseInt(added) || 0, deleted: parseInt(deleted) || 0 };
        }
      }

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
      gitExecFile(path, ["add", "."]);

      try {
        // 用系统临时目录存提交消息文件，用完 unlink，避免污染 .git/COMMIT_EDITMSG
        msgFile = join(tmpdir(), "git-sl-msg-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".txt");
        writeFileSync(msgFile, message, "utf8");
        gitExecFile(path, ["commit", "-F", msgFile]);
      } catch (e) {
        // execFileSync 抛错时 git 的真实输出在 stderr/stdout，不在 e.message 里，
        // 必须用 commandErrorText 拼接后才能匹配 "nothing to commit"。
        const errText = commandErrorText(e);
        if (errText.includes("nothing to commit") || errText.includes("nothing added")) {
          return c.json({ ok: true, nothingToCommit: true, message: "没有需要提交的变更" });
        }
        throw e;
      }

      const last = gitExecFile(path, ["log", "--oneline", "-n", "1"]);

      // 如果有版本号，打 tag
      let tag = "";
      const version = String(body.version || "").trim();
      if (version) {
        tag = `v${version.replace(/^v/, "")}`;
        gitExecFile(path, ["tag", tag]);
      }

      return c.json({ ok: true, commit: last, message, tag });
    } catch (e) {
      return c.json({ ok: false, message: `提交失败：${commandErrorText(e) || e.message}` });
    } finally {
      // 清理临时文件
      if (msgFile) {
        try { unlinkSync(msgFile); } catch {}
      }
    }
  });

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
        const tagRaw = gitExecFile(path, ["tag", "--format=%(objectname:short)|%(refname:short)"]);
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
}
