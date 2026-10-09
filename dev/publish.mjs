// SPDX-License-Identifier: MPL-2.0
//
// dev/publish.mjs — 出包 / 发版 / 投稿 的编排引擎（零依赖，只用 Node 内置模块 + git / gh）。
//
// 它是唯一干活的地方：ship.ps1 只是它的窗户，也可以直接被命令行或别的程序调用。
//
// 用法：
//   node dev/publish.mjs --mode=pack                      只出包
//   node dev/publish.mjs --mode=release  --version=3.2.1 --notes="- 修复xxx"
//   node dev/publish.mjs --mode=publish  --version=3.2.1 --notes-file=notes.md
//   加 --dry-run  只做本地和只读检查，不写 manifest、不提交、不打 tag、不发 Release、不建 PR
//   加 --verify   投稿前用市场自带的同步器复核自己那一条（需要联网，默认关）
//   加 --skip-version-write  不把版本号写回 manifest.json（此时两者必须已经一致）
//
// 三步的含义：
//   pack    写版本号 + 出包到 dist/，不联网、不碰 git
//   release pack + 提交打 tag 推送 + 在 GitHub 建 Release
//   publish release + 在市场仓库提一个登记 PR（全程 GitHub API，本地不落市场仓库的副本）
//
// 阶段顺序固定：配置 → 预检 → 写入版本号 → 出包 → 提交并打 tag → 发 Release → 投稿。
// 版本号必须排在出包前面，因为 zip 和 entry 的文件名里都带着它，三种模式都一样。
//
// 每一步都是幂等的：Release 已存在且附件一致就跳过；approvals 里已经是这个 tag + sha256
// 就跳过提 PR；分支已存在就直接更新到新提交。所以中途失败可以原样重跑，不会重复发布。
//
// 出错只重试"可能已经成功但没收到回执"的那一类（DNS / 连接中断 / 5xx）。认证失败、事实错误
// （版本号字符违规、条目超限、sha 不一致）一律立刻停下并说明原因。细则见 dev/投稿规范.md。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

const DEV_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DEV_DIR, "..");

// ─────────────────────────────────────────────────────────────────────────────
// 市场规矩：对所有插件都一样，不放进 config.json。
// 市场改了规矩，只改这一段。
// ─────────────────────────────────────────────────────────────────────────────
const MARKET = {
  /** 正本仓库（维护者所有）。PR 提到这里。 */
  upstream: "liliMozi/hana-marketplace",
  /** 正本的分支。 */
  upstreamBranch: "main",
  /** 登记文件与批准文件。 */
  registryFile: "registry.json",
  approvalsFile: "approvals.json",
  /** 分支命名：每个插件一个固定分支，每次从正本最新提交重置。 */
  branchPrefix: "enroll/",
  /** entry 附件的字节上限（同步器的 MAX_ENTRY_BYTES），超了整批同步失败。 */
  maxEntryBytes: 512 * 1024,
  /** tag 允许的字符集（同步器的 TAG_RE）。 */
  tagPattern: /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/,
  /** 批准记录只允许这四个键（同步器 exactKeys 校验）。 */
  sha256Pattern: /^[0-9a-f]{64}$/,
};

// ─────────────────────────────────────────────────────────────────────────────
// 输出与错误
// ─────────────────────────────────────────────────────────────────────────────
const say = (msg = "") => process.stdout.write(`${msg}\n`);
const step = (msg) => say(`\n==> ${msg}`);
const info = (msg) => say(`    ${msg}`);
const warn = (msg) => say(`[警告] ${msg}`);

/** 带着原因和下一步怎么办退出（不打印堆栈）。 */
function die(message, hint) {
  say(`\n[停] ${message}`);
  if (hint) say(`     怎么办：${hint}`);
  const err = new Error(message);
  err.hinted = true;
  return err;
}

const TRANSIENT = /could not resolve host|connection (reset|refused|aborted)|timed? out|timeout|tls|ssl|eof|network is unreachable|502|503|504|temporarily unavailable|remote end hung up/i;
const RATE_LIMIT = /rate limit|secondary rate/i;
const AUTH_PROBLEM = /authentication|not logged in|gh auth login|bad credentials|401|permission denied|insufficient|forbidden/i;

/** 把一段命令行输出归类，决定能不能重试。 */
function classify(text) {
  const t = String(text || "");
  if (RATE_LIMIT.test(t)) return "rate";
  if (TRANSIENT.test(t)) return "transient";
  if (AUTH_PROBLEM.test(t)) return "auth";
  return "other";
}

/** 跑一条子进程命令，返回 { status, stdout, stderr }。不抛异常。 */
function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    encoding: "utf8",
    input: opts.input,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (result.error) {
    return { status: -1, stdout: "", stderr: String(result.error.message || result.error) };
  }
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

/**
 * 带退避重试的执行。只对"可能已经成功了但没收到回执"的失败重试；
 * 认证问题和事实错误直接抛。
 */
function runRetry(cmd, args, opts = {}) {
  const label = opts.label || `${cmd} ${args.slice(0, 3).join(" ")}`;
  const attempts = opts.attempts ?? 3;
  const delays = [1000, 4000, 16000];
  for (let attempt = 1; ; attempt += 1) {
    const result = run(cmd, args, opts);
    if (result.status === 0 || opts.acceptNonZero) return result;
    const kind = classify(result.stderr + result.stdout);
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(0, 4).join("\n      ");
    if (kind === "transient" && attempt < attempts) {
      warn(`${label} 第 ${attempt} 次失败（网络类），${delays[attempt - 1] / 1000} 秒后重试：${detail.replace(/\s+/g, " ").slice(0, 160)}`);
      sleepSync(delays[attempt - 1]);
      continue;
    }
    if (kind === "rate") {
      throw die(`${label} 被 GitHub 限速`, "配置一个只读的 GITHUB_TOKEN 环境变量，或过一会儿再试");
    }
    if (kind === "auth") {
      throw die(`${label} 认证失败\n      ${detail}`, "运行 gh auth login，确认账号对仓库有读写权限");
    }
    if (kind === "transient") {
      throw die(`${label} 重试 ${attempts} 次仍未成功（网络类）\n      ${detail}`, "检查网络或代理，然后原样重跑");
    }
    throw die(`${label} 失败\n      ${detail}`);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// git / gh
// ─────────────────────────────────────────────────────────────────────────────
const git = (args, opts = {}) => runRetry("git", args, { ...opts, label: `git ${args[0]}` });
const gh = (args, opts = {}) => runRetry("gh", args, { ...opts, label: `gh ${args[0]}` });

const gitQuiet = (args) => run("git", args);

/** gh api 的薄封装。input 传对象时按 JSON 走 stdin。 */
function ghApi(endpoint, opts = {}) {
  const args = ["api", endpoint];
  if (opts.method) args.push("--method", opts.method);
  if (opts.jq) args.push("--jq", opts.jq);
  for (const h of opts.headers || []) args.push("-H", h);
  let input;
  if (opts.body !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(opts.body);
  }
  const result = gh(args, { input, acceptNonZero: opts.acceptNonZero });
  return result;
}

function ghApiJson(endpoint, opts = {}) {
  const result = ghApi(endpoint, opts);
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置与清单
// ─────────────────────────────────────────────────────────────────────────────
function loadConfig() {
  const path = join(DEV_DIR, "config.json");
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw die(`读不到或解析不了 dev/config.json：${(e && e.message) || e}`, "确认 dev/config.json 存在且是合法 JSON");
  }
  const missing = [];
  if (raw.schema !== 1) missing.push("schema 必须是 1");
  if (typeof raw.publisher !== "string" || !raw.publisher.trim()) missing.push("publisher 必须是非空字符串");
  if (!raw.release || typeof raw.release.repo !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(raw.release.repo)) {
    missing.push("release.repo 必须是 owner/repo 形式");
  }
  if (missing.length) {
    throw die(`dev/config.json 有问题：\n      ${missing.join("\n      ")}`, "补齐后再跑一次");
  }
  return {
    publisher: raw.publisher.trim(),
    defaultBranch: typeof raw.defaultBranch === "string" && raw.defaultBranch ? raw.defaultBranch : "master",
    releaseRepo: raw.release.repo.trim(),
    releaseTitle: typeof raw.release.title === "string" && raw.release.title ? raw.release.title : null,
    packOut: raw.pack && typeof raw.pack.out === "string" && raw.pack.out ? raw.pack.out : "dist",
  };
}

function readManifestText() {
  const path = join(ROOT, "manifest.json");
  if (!existsSync(path)) throw die("找不到 manifest.json", "在仓库根目录跑这个脚本");
  return readFileSync(path, "utf8");
}

function parseManifest(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw die(`manifest.json 解析失败：${(e && e.message) || e}`, "修好 manifest.json 再跑");
  }
}

/** 只替换顶层那个 "version" 字段，不动文件其余部分的排版。 */
function replaceVersionField(text, version) {
  const re = /"version"\s*:\s*"([^"]*)"/;
  const match = re.exec(text);
  if (!match) throw die('manifest.json 里找不到 "version" 字段', "手工确认 manifest.json 的结构");
  return text.slice(0, match.index) + `"version": "${version}"` + text.slice(match.index + match[0].length);
}

// ─────────────────────────────────────────────────────────────────────────────
// 版本比较（够用的语义化比较，忽略预发布后缀）
// ─────────────────────────────────────────────────────────────────────────────
function versionParts(value) {
  const core = String(value).trim().replace(/^v/, "").split(/[-+]/)[0];
  return core.split(".").map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
}

function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口参数
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs(rawArgv) {
  // 允许 --key=value 和 --key value 两种写法
  const argv = [];
  for (const a of rawArgv) {
    const m = /^--([A-Za-z][A-Za-z-]*)=(.*)$/.exec(a);
    if (m) argv.push(`--${m[1]}`, m[2]);
    else argv.push(a);
  }
  const args = { mode: null, version: null, notes: "", notesFile: null, dryRun: false, verify: false, skipVersionWrite: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--notes") args.notes = argv[++i] ?? "";
    else if (a === "--notes-file") args.notesFile = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verify") args.verify = true;
    else if (a === "--skip-version-write") args.skipVersionWrite = true;
    else throw die(`不认识的参数：${a}`, "可用：--mode --version --notes --notes-file --dry-run --verify --skip-version-write");
  }
  if (!["pack", "release", "publish"].includes(args.mode)) {
    throw die(`--mode 必须是 pack / release / publish，收到 ${JSON.stringify(args.mode)}`);
  }
  if (args.notesFile) {
    const p = resolve(process.cwd(), args.notesFile);
    if (!existsSync(p)) throw die(`--notes-file 不存在：${p}`);
    args.notes = readFileSync(p, "utf8").trim();
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// 各阶段
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 确认 gh 真的能认证。
 *
 * 不用 `gh auth status`：它自己也要联网，网络一抖它就报“令牌失效”，
 * 与真实情况不符。改成打一次需要令牌的接口，网络问题和认证问题就分得开了。
 */
function requireGhAuth(config) {
  for (let attempt = 1; ; attempt += 1) {
    const r = run("gh", ["api", "user", "--jq", ".login"]);
    if (r.status === 0) {
      info(`gh 已登录为 ${r.stdout.trim()}，目标仓库 ${config.releaseRepo}`);
      return;
    }
    const detail = (r.stderr || r.stdout).trim().split("\n").slice(0, 3).join("\n      ");
    const kind = classify(r.stderr + r.stdout);
    if (kind === "transient" && attempt < 3) {
      warn(`gh 认证检查第 ${attempt} 次没通（网络类），${attempt} 秒后重试`);
      sleepSync(1000 * attempt);
      continue;
    }
    if (kind === "transient") {
      throw die(`连不上 GitHub，没法确认 gh 登录状态\n      ${detail}`, "检查网络或代理，然后重跑；网络不稳定时重跑即可，前面做好的不会白做");
    }
    if (kind === "rate") {
      throw die(`GitHub 限速，没法确认登录状态\n      ${detail}`, "设一个只读的 GITHUB_TOKEN，或过一会儿再跑");
    }
    throw die(`gh 未登录或令牌已失效\n      ${detail}`, "运行 gh auth refresh -h github.com，或 gh auth login");
  }
}

/** S2 预检：只读，不改任何东西。 */
function preflight(config, ctx, args) {
  step("预检");
  // 只打包完全不碰 gh，也就没必要要求登录。
  const needsGh = args.mode !== "pack";
  const gates = [];

  for (const tool of needsGh ? ["git", "gh", "node"] : ["git", "node"]) {
    if (run(tool, ["--version"]).status !== 0) gates.push(`找不到 ${tool}`);
  }

  if (needsGh) requireGhAuth(config);

  if (gitQuiet(["rev-parse", "--is-inside-work-tree"]).status !== 0) {
    throw die("当前目录不是 git 仓库");
  }

  const branch = gitQuiet(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (branch !== config.defaultBranch) {
    throw die(`当前分支是 ${branch}，config 里写的是 ${config.defaultBranch}`, `先切到 ${config.defaultBranch} 再发版`);
  }

  if (args.mode !== "pack" && !args.dryRun) {
    // 唯一允许的不干净：manifest.json —— 脚本自己会改它，并且会替你把这一次提交做掉。
    const lines = gitQuiet(["status", "--porcelain"])
      .stdout.split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => !/(^|\s)manifest\.json$/.test(l));
    if (lines.length) {
      throw die(
        `工作区有未提交的改动，发版前请先处理：\n      ${lines.slice(0, 10).join("\n      ")}`,
        "先把要发的代码提交推送，再发版；脚本只会替你把版本号那一次提交做掉",
      );
    }
  }

  if (gates.length) throw die(gates.join("；"));

  // 版本相关
  if (args.mode !== "pack") {
    if (!MARKET.tagPattern.test(ctx.tag)) {
      throw die(`tag ${ctx.tag} 含不允许的字符`, "tag 只能用字母、数字、. _ + -，且以字母或数字开头");
    }
    const localTag = gitQuiet(["rev-parse", "-q", "--verify", `refs/tags/${ctx.tag}`]);
    if (localTag.status === 0) throw die(`本地已经有 tag ${ctx.tag}`, "换一个版本号，或先删掉这个 tag");
    const remoteTags = gitQuiet(["ls-remote", "--tags", "origin", `refs/tags/${ctx.tag}`]).stdout.trim();
    if (remoteTags) throw die(`远端已经有 tag ${ctx.tag}`, "换一个版本号");

    const allTags = gitQuiet(["tag", "--list"]).stdout.split("\n").map((t) => t.trim()).filter(Boolean);
    const highest = allTags.map((t) => t.replace(/^v/, "")).filter((v) => /^\d/.test(v)).sort(compareVersions).pop();
    if (highest && compareVersions(ctx.version, highest) < 0) {
      throw die(`要发的 ${ctx.version} 比现有的最高版本 ${highest} 还低`, "市场不允许版本倒退，换一个更高的版本号");
    }

    const existingRelease = run("gh", ["release", "view", ctx.tag, "--repo", config.releaseRepo, "--json", "assets"]);
    if (existingRelease.status === 0) {
      let assets = [];
      try {
        assets = JSON.parse(existingRelease.stdout).assets || [];
      } catch {
        assets = [];
      }
      ctx.existingRelease = { exists: true, assets };
      info(`远端已有 Release ${ctx.tag}（附件 ${assets.length} 个），稍后会核对内容决定是否跳过`);
    }
  }

  info(`分支 ${branch} · 版本 ${ctx.version} · tag ${ctx.tag}`);
}

/**
 * S1 写入版本号。必须排在出包之前：zip 和 entry 的文件名里都带着版本号。
 * 干跑时只预告不改文件，此时包仍按 manifest 里现有的版本出，effectiveVersion 记的就是这个值。
 */
function writeVersion(config, ctx, args) {
  step("写入版本号");
  const text = readManifestText();
  const manifest = parseManifest(text);

  if (args.dryRun) {
    ctx.effectiveVersion = manifest.version;
    info(`[干跑] 会把 manifest.json 改成 ${ctx.version}；本次不改，包仍按 ${manifest.version} 出`);
    return;
  }

  if (args.skipVersionWrite) {
    if (manifest.version !== ctx.version) {
      throw die(
        `--skip-version-write 下 manifest.json 是 ${manifest.version}，但你要发 ${ctx.version}`,
        "去掉 --skip-version-write，或先把 manifest.json 改成目标版本",
      );
    }
    ctx.effectiveVersion = manifest.version;
    info("按参数跳过写入");
    return;
  }

  if (manifest.version !== ctx.version) {
    writeFileSync(join(ROOT, "manifest.json"), replaceVersionField(text, ctx.version), "utf8");
    info(`manifest.json 版本号 ${manifest.version} → ${ctx.version}`);
  } else {
    info(`manifest.json 已经是 ${manifest.version}`);
  }
  ctx.effectiveVersion = ctx.version;
}

/** S3 出包。 */
function packStage(config, ctx) {
  step("出包");
  const result = runRetry(process.execPath, [join(DEV_DIR, "pack.mjs")], { label: "pack.mjs" });
  process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  if (result.stderr.trim()) process.stdout.write(result.stderr);

  const ver = ctx.effectiveVersion || ctx.version;
  const distDir = resolve(ROOT, config.packOut);
  ctx.zipPath = join(distDir, `${ctx.id}-v${ver}.zip`);
  ctx.entryPath = join(distDir, `app-${ctx.id}-${ver}.entry.json`);
  if (!existsSync(ctx.zipPath)) throw die(`出包后找不到 ${relative(ROOT, ctx.zipPath)}`, "看 pack.mjs 的输出");
  if (!existsSync(ctx.entryPath)) throw die(`出包后找不到 ${relative(ROOT, ctx.entryPath)}`, "看 pack.mjs 的输出");

  const entry = JSON.parse(readFileSync(ctx.entryPath, "utf8"));
  ctx.entry = entry;
  ctx.sha256 = entry.archive.sha256;
  ctx.zipSize = entry.archive.size;

  if (!MARKET.sha256Pattern.test(ctx.sha256)) throw die(`entry 里的 sha256 不合法：${ctx.sha256}`);
  if (entry.publisher !== config.publisher) {
    throw die(`entry 的 publisher 是 ${entry.publisher}，config 里是 ${config.publisher}`, "两者必须一致，市场按 publisher 校验身份");
  }
  if (entry.id !== ctx.id || entry.version !== ver) {
    throw die(`entry 身份不对：${entry.id}@${entry.version}，预期 ${ctx.id}@${ver}`);
  }

  const entryBytes = statSync(ctx.entryPath).size;
  if (entryBytes > MARKET.maxEntryBytes) {
    throw die(`市场条目有 ${entryBytes} 字节，超过上限 ${MARKET.maxEntryBytes}`, "大头通常是 manifest.icon 内联 base64，先压那张图再出包");
  }
  info(`zip ${(ctx.zipSize / 1024).toFixed(1)} KiB · entry ${entryBytes} 字节 · sha256 ${ctx.sha256.slice(0, 16)}…`);
}

/** S4：提交版本号、打 tag、推送。 */
function commitAndTag(config, ctx, args) {
  step("提交并打 tag");

  if (args.dryRun) {
    info("[干跑] 跳过 git add / commit / tag / push");
    return;
  }

  const staged = gitQuiet(["status", "--porcelain", "--", "manifest.json"]).stdout.trim();
  if (staged) {
    git(["add", "--", "manifest.json"]);
    git(["commit", "-m", `chore(release): ${ctx.tag}`]);
    info(`提交 chore(release): ${ctx.tag}`);
  } else {
    info("manifest.json 没有变化，跳过提交");
  }

  git(["tag", ctx.tag]);
  info(`打 tag ${ctx.tag}`);

  git(["push", "origin", config.defaultBranch]);
  git(["push", "origin", ctx.tag]);
  info(`已推送到 origin/${config.defaultBranch} 和 ${ctx.tag}`);
}

/** S5 发 Release。 */
function releaseStage(config, ctx, args) {
  step("发布 Release");

  if (ctx.existingRelease?.exists) {
    const names = new Set(ctx.existingRelease.assets.map((a) => a.name));
    if (names.has(ctx.entryName) && names.has(`${ctx.id}-v${ctx.version}.zip`)) {
      const remoteEntry = ctx.existingRelease.assets.find((a) => a.name === ctx.entryName);
      const localBytes = statSync(ctx.entryPath).size;
      if (remoteEntry.size !== localBytes) {
        throw die(`远端 Release ${ctx.tag} 上的条目和本地刚出的不是同一份（远端 ${remoteEntry.size} 字节，本地 ${localBytes} 字节）`, "删掉远端那个 Release 重发，或者换一个版本号");
      }
      info(`Release ${ctx.tag} 已存在且附件一致，跳过`);
      ctx.releaseSkipped = true;
      return;
    }
    throw die(`远端已有 Release ${ctx.tag}，但附件对不上`, "先删掉那个 Release，或者换一个版本号");
  }

  if (args.dryRun) {
    info(`[干跑] 跳过 gh release create ${ctx.tag}`);
    return;
  }

  const notesDir = mkdtempSync(join(tmpdir(), "gsl-notes-"));
  const notesFile = join(notesDir, "notes.md");
  const notesText = `${ctx.notes ? ctx.notes + "\n\n" : ""}---\n\n安装：下载附件 zip 拖入 HanaAgent 设置 → 插件；或从市场更新。\n`;
  writeFileSync(notesFile, notesText, "utf8");

  const title = config.releaseTitle ? config.releaseTitle.replace(/\{tag\}/g, ctx.tag).replace(/\{name\}/g, ctx.name) : `${ctx.name} ${ctx.tag}`;
  info(`上传 ${relative(ROOT, ctx.zipPath)} 和 ${ctx.entryName} …`);
  try {
    gh(["release", "create", ctx.tag, ctx.zipPath, ctx.entryPath, "--repo", config.releaseRepo, "--title", title, "--notes-file", notesFile]);
  } finally {
    rmSync(notesDir, { recursive: true, force: true });
  }
  info(`Release ${ctx.tag} 已创建`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 市场侧：全程 GitHub API，本地不留市场仓库的副本
// ─────────────────────────────────────────────────────────────────────────────
const forkOf = (publisher) => `${publisher}/hana-marketplace`;
const branchOf = (id) => `${MARKET.branchPrefix}${id}`;

/** 正本上游 main 的最新提交 sha。 */
function upstreamHeadSha() {
  const result = ghApi(`repos/${MARKET.upstream}/git/ref/heads/${MARKET.upstreamBranch}`, { jq: ".object.sha" });
  const sha = result.status === 0 ? result.stdout.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw die(`读不到 ${MARKET.upstream} 的 ${MARKET.upstreamBranch} 最新提交`);
  return sha;
}

/** 读正本某个文件在某个 ref 上的原文。 */
function readUpstreamFile(path, ref) {
  const result = ghApi(`repos/${MARKET.upstream}/contents/${path}?ref=${encodeURIComponent(ref)}`, { jq: ".content" });
  if (result.status !== 0) throw die(`读不到 ${MARKET.upstream}/${path}`, "确认网络和仓库可访问");
  return Buffer.from(result.stdout.replace(/\s/g, ""), "base64").toString("utf8");
}

/** 把登记和批准改好；返回 { registry, approvals, changed, addedEnrollment, changedEnrollment }。 */
function planMarketEdit(registryText, approvalsText, ctx, config) {
  const registry = JSON.parse(registryText);
  const approvals = JSON.parse(approvalsText);
  if (!Array.isArray(registry.entries)) throw die("registry.json 结构不对：entries 不是数组");
  if (!Array.isArray(approvals.approvals)) throw die("approvals.json 结构不对：approvals 不是数组");

  const same = (a, b) => a.kind === b.kind && a.id === b.id;

  // 名录：没有就加，已有的不一致就改；一致就一个字不碰。
  let addedEnrollment = false;
  let changedEnrollment = false;
  const enrolled = registry.entries.find((e) => same(e, ctx));
  if (!enrolled) {
    registry.entries.push({ kind: ctx.kind, id: ctx.id, repository: config.releaseRepo, publisher: config.publisher });
    addedEnrollment = true;
  } else if (enrolled.repository !== config.releaseRepo || enrolled.publisher !== config.publisher) {
    enrolled.repository = config.releaseRepo;
    enrolled.publisher = config.publisher;
    changedEnrollment = true;
  }

  // 批准：每次都要改。
  let changedApproval = false;
  const record = approvals.approvals.find((a) => same(a, ctx));
  if (!record) {
    approvals.approvals.push({ kind: ctx.kind, id: ctx.id, tag: ctx.tag, sha256: ctx.sha256 });
    changedApproval = true;
  } else if (record.tag !== ctx.tag || record.sha256 !== ctx.sha256) {
    record.tag = ctx.tag;
    record.sha256 = ctx.sha256;
    changedApproval = true;
  }

  return {
    registry,
    approvals,
    addedEnrollment,
    changedEnrollment,
    changedApproval,
    changed: addedEnrollment || changedEnrollment || changedApproval,
  };
}

/** 在 fork 上落一个提交，并让分支指向它。全程 API。 */
function pushMarketCommit(fork, branch, baseSha, baseTreeSha, files, message) {
  const entries = [];
  for (const { path, content } of files) {
    const blob = ghApiJson(`repos/${fork}/git/blobs`, { method: "POST", body: { content, encoding: "utf-8" } });
    if (!blob?.sha) throw die(`在 ${fork} 上创建 blob 失败（${path}）`);
    entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = ghApiJson(`repos/${fork}/git/trees`, { method: "POST", body: { base_tree: baseTreeSha, tree: entries } });
  if (!tree?.sha) throw die("创建 tree 失败");

  const commit = ghApiJson(`repos/${fork}/git/commits`, { method: "POST", body: { message, tree: tree.sha, parents: [baseSha] } });
  if (!commit?.sha) throw die("创建 commit 失败");

  const refPath = `repos/${fork}/git/ref/heads/${branch}`;
  const existing = ghApi(refPath, { acceptNonZero: true });
  if (existing.status === 0) {
    const patched = ghApi(`repos/${fork}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: commit.sha, force: true } });
    if (patched.status !== 0) throw die(`更新分支 ${branch} 失败`);
  } else {
    const created = ghApi(`repos/${fork}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
    if (created.status !== 0) throw die(`创建分支 ${branch} 失败`);
  }
  return commit.sha;
}

/** 拼 PR 正文。 */
function buildPrBody(config, ctx, changeNote) {
  const repoUrl = `https://github.com/${config.releaseRepo}`;
  const releaseUrl = `${repoUrl}/releases/tag/${ctx.tag}`;
  const rawBase = `https://raw.githubusercontent.com/${config.releaseRepo}/${encodeURIComponent(ctx.tag)}`;
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

  const capabilities = Array.isArray(ctx.manifest.capabilities) ? ctx.manifest.capabilities : [];

  const lines = [];
  lines.push("## 投稿信息 / Submission", "");
  lines.push(`- 扩展名称 / Extension name: ${ctx.name}`);
  lines.push(`- 类型与 ID / Kind and ID: app / ${ctx.id}`);
  lines.push(`- 发布者 / Publisher: ${config.publisher}`);
  lines.push(`- 用途与主要功能 / Purpose and main features: ${ctx.manifest.description || "（见仓库 README）"}`);
  lines.push(`- 作者仓库 / Author repository: ${repoUrl}`);
  lines.push(`- 正式 Release / Stable Release: ${releaseUrl}`);
  lines.push(`- 本次登记或变更说明 / Enrollment or registration change: ${changeNote}`);
  lines.push("");

  lines.push("## 图标预览 / Icon preview", "");
  if (ctx.manifest.icon) lines.push(`![icon](${rawBase}/${encodePath(ctx.manifest.icon)})`);
  else lines.push("（无图标）");
  lines.push("");

  lines.push("## 截图或演示 / Screenshots or demo", "");
  if (ctx.screenshots.length) {
    for (const shot of ctx.screenshots) {
      lines.push(`![${shot}](${rawBase}/dev/pr-assets/${encodeURIComponent(shot)})`);
    }
  } else {
    lines.push("<!-- 在 dev/pr-assets/ 里放几张图，脚本会自动列到这里；也可以在这里手动拖图 -->");
    lines.push("（待补）");
  }
  lines.push("");

  lines.push("## 自测报告 / Author test report", "");
  lines.push(ctx.selfTest || "<!-- 在 dev/自测.md 里写好，脚本会自动抄到这里；也可以在这里手动补 -->\n（待补）");
  lines.push("");

  lines.push("## 权限与外部服务 / Permissions and external services", "");
  lines.push(`- 声明能力 / Capabilities: ${capabilities.length ? capabilities.join(", ") : "无"}`);
  lines.push("- 为什么需要 / Why: <!-- 一句话说明每个能力的用途 -->（待补）");
  lines.push("- 外部服务 / External services: GitHub（git / gh CLI）");
  lines.push("");

  lines.push("## 投稿检查 / Enrollment checklist", "");
  lines.push("- [x] 本 PR 仅修改登记数据；未提交源码、安装包或截图文件。");
  lines.push("- [x] 作者仓库已有正式 Release，包含匹配的条目 JSON 和 ZIP。");
  lines.push("- [x] 登记的 kind、id、publisher 与条目一致。");
  lines.push("- [x] `approvals.json` 中的 tag 指向该 Release，sha256 照抄自条目 JSON 的 `archive.sha256`。");
  lines.push("- [x] 未手动编辑生成的 `index.v2.json`。");
  lines.push("- [ ] 已填写审阅材料，不适用或未测试的部分已注明，图片已检查敏感信息。");
  return lines.join("\n") + "\n";
}

function marketStage(config, ctx, args) {
  step("投稿到市场");
  const fork = forkOf(config.publisher);
  const branch = branchOf(ctx.id);

  const baseSha = upstreamHeadSha();
  const baseCommit = ghApiJson(`repos/${fork}/git/commits/${baseSha}`);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (!baseTreeSha) throw die(`在 ${fork} 上找不到提交 ${baseSha.slice(0, 8)}`, "确认 fork 还在、且和正本同源");
  info(`基线 ${MARKET.upstream}@${baseSha.slice(0, 8)} → fork ${fork}`);

  const registryText = readUpstreamFile(MARKET.registryFile, baseSha);
  const approvalsText = readUpstreamFile(MARKET.approvalsFile, baseSha);
  const edit = planMarketEdit(registryText, approvalsText, ctx, config);

  if (!edit.changed) {
    info("市场登记和批准都已经是最新的，跳过提 PR");
    const existingPr = ghApiJson(`repos/${MARKET.upstream}/pulls?head=${encodeURIComponent(config.publisher)}:${encodeURIComponent(branch)}&state=open`);
    if (Array.isArray(existingPr) && existingPr[0]) ctx.prUrl = existingPr[0].html_url;
    return;
  }

  if (args.dryRun) {
    info(`[干跑] 会${edit.addedEnrollment ? "新增名录" : edit.changedEnrollment ? "修改名录" : "不动名录"}、${edit.changedApproval ? "更新批准" : "不动批准"}`);
    info(`[干跑] 会写到 ${fork} 的 ${branch}，PR 提到 ${MARKET.upstream}`);
    return;
  }

  const files = [
    { path: MARKET.registryFile, content: JSON.stringify(edit.registry, null, 2) + "\n" },
    { path: MARKET.approvalsFile, content: JSON.stringify(edit.approvals, null, 2) + "\n" },
  ];

  const changeBits = [];
  if (edit.addedEnrollment) changeBits.push("首次登记");
  if (edit.changedEnrollment) changeBits.push("登记信息有变更");
  if (edit.changedApproval) changeBits.push(`更新到 ${ctx.tag}`);
  const changeNote = `${changeBits.join("；")}。${ctx.notes ? "\n\n" + ctx.notes : ""}`;
  const message = `${edit.addedEnrollment || edit.changedEnrollment ? "enroll" : "approve"}: app/${ctx.id} ${ctx.tag}`;
  const body = buildPrBody(config, ctx, changeNote);

  pushMarketCommit(fork, branch, baseSha, baseTreeSha, files, message);
  info(`已提交到 ${fork}:${branch}`);

  const title = message;
  const pr = ghApiJson(`repos/${MARKET.upstream}/pulls`, {
    method: "POST",
    body: { title, head: `${config.publisher}:${branch}`, base: MARKET.upstreamBranch, body },
    acceptNonZero: true,
  });
  if (pr?.html_url) {
    ctx.prUrl = pr.html_url;
    info(`PR 已创建：${pr.html_url}`);
    return;
  }

  const existing = ghApiJson(`repos/${MARKET.upstream}/pulls?head=${encodeURIComponent(config.publisher)}:${encodeURIComponent(branch)}&state=open`);
  if (Array.isArray(existing) && existing[0]) {
    ctx.prUrl = existing[0].html_url;
    warn("这个分支已经有一个开着的 PR，没有重复创建");
    info(`已有 PR：${ctx.prUrl}`);
    return;
  }
  throw die("创建 PR 失败", "看看上面 gh 的报错，必要时手工到网页上开 PR");
}

/** 可选：用市场自带的同步器复核自己那一条。 */
function verifyStage(config, ctx) {
  step("复核（市场自带同步器）");
  const baseSha = upstreamHeadSha();

  const dir = mkdtempSync(join(tmpdir(), "gsl-verify-"));
  try {
    const syncPath = join(dir, "extension-market-sync.mjs");
    const registryPath = join(dir, "registry.json");
    const approvalsPath = join(dir, "approvals.json");
    writeFileSync(syncPath, readUpstreamFile("scripts/extension-market-sync.mjs", baseSha), "utf8");
    writeFileSync(registryPath, readUpstreamFile(MARKET.registryFile, baseSha), "utf8");
    writeFileSync(approvalsPath, readUpstreamFile(MARKET.approvalsFile, baseSha), "utf8");

    const token = run("gh", ["auth", "token"]).stdout.trim();
    const result = runRetry(
      process.execPath,
      [syncPath, "--discover", "--registry", registryPath, "--approvals", approvalsPath],
      { label: "market-sync --discover", env: token ? { GITHUB_TOKEN: token } : {} },
    );
    const out = `${result.stdout}\n${result.stderr}`;
    const mine = out.split("\n").find((l) => l.includes(`app/${ctx.id} `) && l.includes("approvals.json record:"));
    if (!mine) {
      warn("同步器没有为这个扩展提出批准记录（可能：Release 还不是最新的正式 Release，或市场那边已经是最新）");
      return;
    }
    const json = mine.slice(mine.indexOf("record: ") + "record: ".length).trim();
    let proposed;
    try {
      proposed = JSON.parse(json);
    } catch {
      warn(`解析同步器的输出失败：${json}`);
      return;
    }
    if (proposed.sha256 !== ctx.sha256) {
      throw die(`同步器算出的 sha256 是 ${proposed.sha256}，本地是 ${ctx.sha256}`, "两边不一致说明包不对，别提交");
    }
    info(`同步器复核通过：${proposed.tag} · sha256 一致`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));

  step(`Git Save/Load 发布 · 模式 ${args.mode}${args.dryRun ? " · 干跑" : ""}`);
  const config = loadConfig();
  const manifest = parseManifest(readManifestText());

  const ctx = {
    kind: "app",
    id: manifest.id,
    name: manifest.name || manifest.id,
    manifest,
    version: args.version || manifest.version,
    notes: args.notes,
    screenshots: [],
  };
  if (!ctx.id) throw die("manifest.json 缺 id");
  ctx.version = String(ctx.version).trim().replace(/^v/, "");
  ctx.effectiveVersion = manifest.version;
  if (!/^\d+\.\d+\.\d+/.test(ctx.version)) throw die(`版本号看起来不合法：${ctx.version}`, "用形如 3.2.1 的写法");
  ctx.tag = `v${ctx.version}`;
  ctx.entryName = `app-${ctx.id}-${ctx.version}.entry.json`;

  const prAssets = join(DEV_DIR, "pr-assets");
  if (existsSync(prAssets)) {
    ctx.screenshots = readdirSync(prAssets)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .sort();
  }
  const selfTestPath = join(DEV_DIR, "自测.md");
  ctx.selfTest = existsSync(selfTestPath) ? readFileSync(selfTestPath, "utf8").trim() : "";

  let stage = 0;
  const next = (label, fn) => {
    stage += 1;
    say(`\n──────── ${stage}. ${label} ────────`);
    return fn();
  };

  next("配置与版本", () => info(`${ctx.name} ${ctx.version} · 发布者 ${config.publisher} · 仓库 ${config.releaseRepo}${args.dryRun ? " · 干跑" : ""}`));
  next("预检", () => preflight(config, ctx, args));
  next("写入版本号", () => writeVersion(config, ctx, args));
  next("出包", () => packStage(config, ctx));

  if (args.mode === "pack") {
    step("只出包，收工");
    info(`版本:  ${ctx.effectiveVersion}`);
    info(`zip:   ${relative(ROOT, ctx.zipPath)}`);
    info(`entry: ${relative(ROOT, ctx.entryPath)}`);
    info(`sha256 ${ctx.sha256}`);
    return;
  }

  next("提交并打 tag", () => commitAndTag(config, ctx, args));
  next("发布 Release", () => releaseStage(config, ctx, args));

  if (args.verify) verifyStage(config, ctx);

  if (args.mode === "publish") {
    next("投稿到市场", () => marketStage(config, ctx, args));
  }

  step("完成");
  const repoUrl = `https://github.com/${config.releaseRepo}`;
  if (!ctx.releaseSkipped) say(`RELEASE_URL=${repoUrl}/releases/tag/${ctx.tag}`);
  else say(`RELEASE_URL=${repoUrl}/releases/tag/${ctx.tag}  (已存在，未重复创建)`);
  if (ctx.prUrl) say(`PR_URL=${ctx.prUrl}`);
  else if (args.mode === "publish" && !args.dryRun) say("PR_URL=（没有新建 PR，市场那边可能已经是最新的）");
  if (args.dryRun) say("（干跑：以上动作都没有真正执行）");
  if (!ctx.screenshots.length && args.mode === "publish") {
    warn("dev/pr-assets/ 里没有图，PR 正文的截图那块留了「待补」，记得去浏览器里补一下");
  }
}

try {
  main();
} catch (error) {
  if (!error?.hinted) {
    say(`\n[停] ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.GSL_DEBUG) say(String(error?.stack || ""));
  }
  process.exitCode = 1;
}
