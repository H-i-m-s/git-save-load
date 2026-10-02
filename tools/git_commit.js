// git-save-load / tools / git_commit.js
// 暂存所有变更并提交。支持 App 隔离签名（resolveCommitSigning）与 Co-authored-by 尾注，
// 提交后用 gpgconf --kill gpg-agent 回收隔离 GPG agent（找不到 gpgconf 时静默跳过）。

import { dirname, join } from "node:path";

import {
  resolvePath,
  resolveGitPath,
  resolveDataDir,
  gitExec,
  execCapture,
  toPosixPath,
} from "./_helpers.js";
import { resolveCommitSigning, resolveGpgPath } from "../routes/settings-page.js";

export const name = "git_commit";
export const description = "暂存所有变更并提交。提交前先用 git_status 确认变更内容。若 App 隔离签名已开启则签名提交，并可追加 Co-authored-by 尾注。";

export const sessionPermission = {
  kind: "review",
  describeSideEffect: () => ({
    kind: "workspace_write",
    summary: "Stage all changes and create a Git commit in the selected local repository.",
    ruleId: "workspace-git-commit",
  }),
};

export const parameters = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "提交消息。建议格式：feat:xxx / fix:xxx / chore:xxx",
    },
    coAuthors: {
      type: "array",
      items: { type: "string" },
      description: "可选：协作作者列表（如 \"Name <email@example.com>\"），有值时在提交消息末尾追加 Co-authored-by 尾注；无值不追加。",
    },
    path: {
      type: "string",
      description: "git 仓库路径。不传则使用插件配置中保存的路径。",
    },
  },
  required: ["message"],
};

const GNUPG_DIR = "gnupg";

/**
 * 提交收尾：在隔离 GNUPGHOME 下执行 `gpgconf --kill gpg-agent`，避免 agent 常驻。
 * 找不到 gpg/gpgconf 时静默跳过；任何失败都不影响提交结果，只返回一句说明。
 * @returns {string} 人类可读的收尾说明
 */
function cleanupGpgAgent(dataDir, gitPath) {
  if (!dataDir) return "未定位到 App 数据目录，已跳过 gpgconf --kill gpg-agent 收尾。";

  let gpgPath = "";
  try {
    gpgPath = resolveGpgPath(gitPath) || "";
  } catch {
    gpgPath = "";
  }
  if (!gpgPath) return "未检测到 gpg，已跳过 gpgconf --kill gpg-agent 收尾。";

  const home = join(dataDir, GNUPG_DIR);
  const isWin = process.platform === "win32";
  const hasDir = /[\\/]/.test(gpgPath);
  const gpgconf = hasDir
    ? join(dirname(gpgPath), isWin ? "gpgconf.exe" : "gpgconf")
    : isWin
      ? "gpgconf.exe"
      : "gpgconf";

  // Git for Windows 的 gpg 是 MSYS 构建，需经 bash 以 POSIX 路径运行（与 settings-page 一致）。
  let bash = "";
  const m = hasDir ? gpgPath.match(/^(.*?)[\\/](?:usr[\\/]bin|mingw64[\\/]bin)[\\/][^\\/]*$/i) : null;
  if (m) {
    const candidate = join(m[1], "bin", "bash.exe");
    if (execCapture(candidate, ["-c", "true"], { timeout: 8000 }).ok) bash = candidate;
  }

  let r;
  if (bash) {
    const posixHome = toPosixPath(home);
    r = execCapture(bash, ["-lc", 'gpgconf "$@"', "_", "--homedir", posixHome, "--kill", "gpg-agent"], {
      timeout: 15000,
      env: { ...process.env, GNUPGHOME: posixHome },
    });
  } else {
    r = execCapture(gpgconf, ["--homedir", home, "--kill", "gpg-agent"], {
      timeout: 15000,
      env: { ...process.env, GNUPGHOME: home },
    });
  }

  if (r.errCode === "ENOENT") return "未找到 gpgconf，已跳过 gpgconf --kill gpg-agent 收尾（不影响提交）。";
  if (!r.ok) return `gpgconf --kill gpg-agent 未成功，已忽略（不影响提交）：${r.stderr || "未知原因"}`;
  return "已执行 gpgconf --kill gpg-agent，回收隔离 GPG agent。";
}

export async function execute(input = {}, ctx = {}) {
  const cwd = await resolvePath(input, ctx);
  const message = String(input?.message || "").trim();

  if (!message) {
    return JSON.stringify({ error: true, message: "提交消息不能为空" }, null, 2);
  }

  // Co-authored-by 尾注：仅在显式给值且非空时追加。
  const coAuthors = Array.isArray(input?.coAuthors)
    ? input.coAuthors.map((a) => String(a).trim()).filter(Boolean)
    : [];
  let fullMessage = message;
  if (coAuthors.length) {
    fullMessage += "\n\n" + coAuthors.map((a) => `Co-authored-by: ${a}`).join("\n");
  }

  const gitPath = resolveGitPath();
  const dataDir = resolveDataDir(ctx);

  // 隔离签名接线：关闭 / 无密钥 / 无 gpg 时返回空，提交保持原样（不阻塞）。
  let signing = { args: [], env: {} };
  try {
    signing = resolveCommitSigning(dataDir, gitPath) || { args: [], env: {} };
  } catch {
    signing = { args: [], env: {} };
  }
  const signed = Array.isArray(signing.args) && signing.args.length > 0;

  try {
    gitExec(cwd, ["add", "."], { timeout: 30000 });
    // -c commit.gpgsign=true ... 必须置于子命令之前；未签名时 signing.args 为空，行为与原先一致。
    gitExec(cwd, [...signing.args, "commit", "-m", fullMessage], { timeout: 30000, env: signing.env });

    const log = gitExec(cwd, ["log", "--oneline", "-n", "1"], { timeout: 10000 });
    const agentNote = cleanupGpgAgent(dataDir, gitPath);
    return JSON.stringify(
      { ok: true, commit: log, message: fullMessage, signed, coAuthors: coAuthors.length, gpgAgent: agentNote },
      null,
      2,
    );
  } catch (err) {
    const agentNote = cleanupGpgAgent(dataDir, gitPath);
    if (err.message.includes("nothing to commit") || err.message.includes("nothing added")) {
      return JSON.stringify({ ok: true, message: "没有需要提交的变更", nothingToCommit: true, gpgAgent: agentNote }, null, 2);
    }
    return JSON.stringify({ error: true, message: `提交失败：${err.message}`, signed, gpgAgent: agentNote }, null, 2);
  }
}
