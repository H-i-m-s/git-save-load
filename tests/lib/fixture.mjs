// tests/lib/fixture.mjs — 夹具：临时目录 / 临时 git 仓库 / 裸远端。
//
// 所有落盘一律在 GSL_TMP_DIR（由 tests/run.mjs 创建并授权读写）之下；
// 绝不写用户真实仓库，也绝不写 C:\Users\SSS\.hanako\app-data\git-save-load。
// 进程退出时统一清理本次创建的临时目录。

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** 本 App 的安装目录（tests/lib/../..）。 */
export const APP_DIR = process.env.GSL_APP_DIR
  ? resolve(process.env.GSL_APP_DIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 受限模式下被授权读写的临时根目录。 */
export const TMP_ROOT = process.env.GSL_TMP_DIR ? resolve(process.env.GSL_TMP_DIR) : tmpdir();

const created = [];

/** 建一个临时目录（登记以便退出时清理）。 */
export function makeTmpDir(prefix = "tmp") {
  const dir = mkdtempSync(join(TMP_ROOT, `${prefix}-`));
  created.push(dir);
  return dir;
}

/** 同步执行 git（数组传参，不经 shell），返回已 trim 的 stdout。 */
export function git(cwd, args, opts = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    ...opts,
  }).trim();
}

/** 建一个带本地身份、关闭签名、分支名为 main 的临时仓库。 */
export function initRepo(prefix = "repo") {
  const dir = makeTmpDir(prefix);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "gsl-tests@example.invalid"]);
  git(dir, ["config", "user.name", "GSL Tests"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "tag.gpgsign", "false"]);
  git(dir, ["config", "core.autocrlf", "false"]);
  return dir;
}

/** 写文件并提交（相对路径 → 仓库内）。 */
export function commitFile(repo, relPath, content, message) {
  writeFileSync(join(repo, relPath), content, "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** 建一个裸仓库当远端，返回其路径。 */
export function initBareRemote(prefix = "bare") {
  const parent = makeTmpDir(prefix);
  const remote = join(parent, "remote.git");
  git(parent, ["init", "--bare", "--initial-branch=main", "remote.git"]);
  return remote;
}

/** 清理本次创建的临时目录。幂等。 */
export function cleanup() {
  while (created.length) {
    const dir = created.pop();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    } catch {
      /* Windows 上偶发占用：尽力而为，temp 目录由系统回收 */
    }
  }
}

// 即使用例中途抛错也保证清理。
process.on("exit", cleanup);
