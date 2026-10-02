// tests/cases/04-tools-behavior.mjs
// 覆盖：工具行为（在临时 git 仓库上真跑）。
//   · tools/git_exec.js  execute(["log","--oneline","-1"]) / ["status","--short"] 断言返回内容
//   · tools/git_push.js  execute 无远端 → ok=false 且可读错误；配好裸远端 → 推送成功
//   · 语义化推送：force 非法/未给值时不产生裸 --force（命令行断言 + 分叉远端 non-fast-forward 拒绝）
//                        force="with-lease" 时注入 --force-with-lease 并在分叉远端上强推成功

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_DIR, commitFile, git, initBareRemote, initRepo } from "../lib/fixture.mjs";
import { main, check, eq, contains, matches, note } from "../lib/harness.mjs";

/** 桩执行上下文：dataDir 为空串（工具不落盘），config.get 提供仓库路径。 */
function toolCtx(repoPath) {
  return {
    dataDir: "",
    config: { get: async (key) => (key === "repoPath" ? repoPath : undefined) },
  };
}

/** 命令行里是否出现「裸 --force」：精确 token 匹配，避免把 --force-with-lease 误判成裸 force。 */
function hasBareForce(commandLine) {
  const tokens = String(commandLine || "").split(/\s+/);
  return tokens.includes("--force") || tokens.includes("-f");
}

await main("tools: git_exec / git_push 行为", async () => {
  const gitExec = await import(pathToFileURL(join(APP_DIR, "tools", "git_exec.js")).href);
  const gitPush = await import(pathToFileURL(join(APP_DIR, "tools", "git_push.js")).href);

  // ── git_exec：读与写都透传 ──────────────────────────────────────────────
  const repo = initRepo("repo");
  const firstSha = commitFile(repo, "a.txt", "hello\n", "init commit");
  note(`临时仓库 ${repo} @ ${firstSha.slice(0, 7)}`);

  const logOut = await gitExec.execute({ args: ["log", "--oneline", "-1"], path: repo }, toolCtx(repo));
  note(`git log --oneline -1 → ${JSON.stringify(logOut)}`);
  contains(logOut, "init commit", "git_exec log --oneline -1 返回提交标题");
  matches(logOut, /^[0-9a-f]{7,}\s/m, "git_exec log 输出带短哈希");

  writeFileSync(join(repo, "untracked.txt"), "x\n", "utf8");
  const statusOut = await gitExec.execute({ args: ["status", "--short"], path: repo }, toolCtx(repo));
  note(`git status --short → ${JSON.stringify(statusOut)}`);
  contains(statusOut, "untracked.txt", "git_exec status --short 列出未跟踪文件");
  matches(statusOut, /^\?\?\s+untracked\.txt$/m, "未跟踪文件以 ?? 标记");

  // 不传 path：走 ctx.config.get("repoPath") 回退
  const statusViaConfig = await gitExec.execute({ args: ["status", "--short"] }, toolCtx(repo));
  eq(statusViaConfig, statusOut, "缺省 path 时回退到配置的仓库路径（结果一致）");

  // 失败路径：错误以 JSON 返回而不是抛异常
  const badOut = await gitExec.execute({ args: ["rev-parse", "--verify", "no-such-ref-xyz"], path: repo }, toolCtx(repo));
  let badJson = null;
  try { badJson = JSON.parse(badOut); } catch { /* 非 JSON 会在下面断言里暴露 */ }
  check(badJson && badJson.error === true, "git_exec 子命令失败时返回 error:true 的 JSON", `got ${badOut.slice(0, 160)}`);
  check(typeof badJson?.message === "string" && badJson.message.length > 0, "失败 JSON 带可读 message");

  // ── git_push：无远端 → 可读错误 ────────────────────────────────────────
  const orphan = initRepo("noremote");
  commitFile(orphan, "b.txt", "hi\n", "first");

  const noRemoteRaw = await gitPush.execute({ path: orphan }, toolCtx(orphan));
  const noRemote = JSON.parse(noRemoteRaw);
  note(`无远端 push → ${JSON.stringify(noRemote).slice(0, 240)}`);
  eq(noRemote.ok, false, "无远端时 git_push 返回 ok=false");
  check(typeof noRemote.message === "string" && noRemote.message.length > 0, "无远端时返回可读错误信息");
  matches(noRemote.message, /推送失败/, "错误信息以「推送失败」开头并带原因");
  contains(noRemote.command, "push origin main", "缺省远端回退到 origin，语义命令可读");

  // ── git_push：配好裸远端 → 推送成功 ────────────────────────────────────
  const bare = initBareRemote("bare");
  git(repo, ["remote", "add", "origin", bare]);

  const pushRaw = await gitPush.execute({ path: repo, remote: "origin", branch: "main", setUpstream: true }, toolCtx(repo));
  const push = JSON.parse(pushRaw);
  note(`首次 push → ${JSON.stringify(push).slice(0, 240)}`);
  eq(push.ok, true, "配好裸远端后 git_push 推送成功");
  contains(push.message, "已推送", "成功时返回可读信息");
  contains(git(bare, ["log", "--oneline", "-1"]), "init commit", "裸远端确实收到了提交");

  // ── 语义化推送：force 语义 ─────────────────────────────────────────────
  const illegalRaw = await gitPush.execute({ path: repo, remote: "origin", branch: "main", force: "yes-please" }, toolCtx(repo));
  const illegal = JSON.parse(illegalRaw);
  note(`force="yes-please" → command: ${illegal.command}`);
  eq(illegal.force, "none", "非法 force 值被归一化为 none");
  check(!hasBareForce(illegal.command), "非法 force 不产生裸 --force");
  check(!String(illegal.command).includes("--force-with-lease"), "非法 force 也不注入 --force-with-lease");

  const missingRaw = await gitPush.execute({ path: repo, remote: "origin", branch: "main" }, toolCtx(repo));
  const missing = JSON.parse(missingRaw);
  note(`未给 force → command: ${missing.command}`);
  eq(missing.force, "none", "未给 force 时归一化为 none");
  check(!hasBareForce(missing.command), "未给 force 时命令行不含裸 --force");
  check(!String(missing.command).includes("--force"), "未给 force 时命令行不含任何 force 旗标");

  const leaseRaw = await gitPush.execute({ path: repo, remote: "origin", branch: "main", force: "with-lease" }, toolCtx(repo));
  const lease = JSON.parse(leaseRaw);
  note(`force="with-lease" → command: ${lease.command}`);
  eq(lease.force, "with-lease", "force=with-lease 被识别");
  contains(lease.command, "--force-with-lease", "with-lease 注入 --force-with-lease");
  check(!hasBareForce(lease.command), "with-lease 命令行不含裸 --force（token 精确匹配）");

  // ── 分叉远端：无 force 被拒，with-lease 成功 ────────────────────────────
  commitFile(repo, "a.txt", "hello\nsecond\n", "second");
  git(repo, ["push", "origin", "main"]);
  git(repo, ["reset", "--hard", "HEAD~1"]);
  commitFile(repo, "a.txt", "hello\ndivergent\n", "divergent");

  const divergedRaw = await gitPush.execute({ path: repo, remote: "origin", branch: "main" }, toolCtx(repo));
  const diverged = JSON.parse(divergedRaw);
  note(`分叉远端 push → ${JSON.stringify(diverged).slice(0, 300)}`);
  eq(diverged.ok, false, "已分叉远端上无 force 推送被拒绝");
  matches(diverged.message, /non-fast-forward|快进推送/, "拒绝信息说明 non-fast-forward");
  contains(diverged.message, "with-lease", "拒绝信息提示可用 force=with-lease 安全强推");

  const recoverRaw = await gitPush.execute({ path: repo, remote: "origin", branch: "main", force: "with-lease" }, toolCtx(repo));
  const recover = JSON.parse(recoverRaw);
  note(`分叉远端 with-lease push → ${JSON.stringify(recover).slice(0, 240)}`);
  eq(recover.ok, true, "force=with-lease 在分叉远端上安全强推成功");
  contains(git(bare, ["log", "--oneline", "-1"]), "divergent", "强推后远端指向本地分叉提交");
});
