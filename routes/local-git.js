// Local Git state, basic write, and rollback routes.
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function registerLocalGitRoutes(app, { repoPath, gitExecFile, gitExecFileAsync, gitExecFileWithEnv, commandErrorText, tmpFile, getCommitSigning }) {
  app.get("/api/status", async (c) => {
    const path = repoPath(c.req.query("path"));

    try {
      // 只跑渲染这个接口真正需要的三条只读 git 调用，并行执行（异步不阻塞事件循环），
      // 总耗时从串行累加降为最慢单项。branch/status 失败 = 不是仓库；diff 失败静默降级。
      //
      // 这里以前还顺带跑一条 `git log --numstat -n 5` 产出 recentCommits，但前端从未
      // 消费该字段（全仓库 grep 只在本文件命中），而它在大仓库上极贵：
      // e:\isaacsim\project（10262 个跟踪文件）实测这一条 2678 ms，占掉 /api/status
      // 整体 2940 ms 里的绝大部分，而真正渲染「变更文件」的 status + diff 只要约 250 ms。
      const branchP = gitExecFileAsync(path, ["branch", "--show-current"]);
      const statusP = gitExecFileAsync(path, ["-c", "core.quotepath=false", "status", "--short"]);
      const diffP = gitExecFileAsync(path, ["-c", "core.quotepath=false", "diff", "--numstat"]).catch(() => "");
      let branch;
      let statusShort;
      try {
        [branch, statusShort] = await Promise.all([branchP, statusP]);
      } catch (e) {
        return c.json({ ok: false, isRepo: false, path, message: e.message });
      }
      const diffRaw = await diffP;

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
    // 隔离签名：设置页打开「提交时签名」且密钥可用时，给这次提交带上 -c 参数与 GNUPGHOME。
    // 关闭/无密钥/无 gpg 时 signing 为空，提交行为与原来完全一致。
    const signing = typeof getCommitSigning === "function" ? getCommitSigning() : { args: [], env: {} };
    const commitWithEnv = typeof gitExecFileWithEnv === "function"
      ? (args, extraEnv) => gitExecFileWithEnv(path, args, extraEnv)
      : (args) => gitExecFile(path, args);
    try {
      gitExecFile(path, ["add", "."]);

      try {
        // 临时消息文件落 App dataDir（Node Permission Model 下只有 dataDir 可写），
        // 用完 unlink，避免污染 .git/COMMIT_EDITMSG
        msgFile = tmpFile("git-sl-msg", ".txt");
        writeFileSync(msgFile, message, "utf8");
        commitWithEnv([...(signing.args || []), "commit", "-F", msgFile], signing.env || {});
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
