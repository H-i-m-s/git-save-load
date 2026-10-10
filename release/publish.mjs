// SPDX-License-Identifier: MPL-2.0
//
// release/publish.mjs — 出包 / 发版 / 投稿 的编排引擎（零依赖，只用 Node 内置模块 + git / gh）。
//
// 它是唯一干活的地方：ship.ps1 只是它的窗户，也可以直接被命令行或别的程序调用。
//
// 用法：
//   node release/publish.mjs --mode=pack                      只出包
//   node release/publish.mjs --mode=release  --version=3.2.1 --notes="- 修复xxx"
//   node release/publish.mjs --mode=publish  --version=3.2.1 --notes-file=notes.md
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
// （版本号字符违规、条目超限、sha 不一致）一律立刻停下并说明原因。细则见 release/投稿规范.md。
//
// 这个文件只放编排：命令行参数、配置与清单、七阶段流程、main。其余三头在
//   release/console.mjs   终端输出与带着原因退出
//   release/exec.mjs      调 git / gh，失败分类与退避重试
//   release/market.mjs    市场的规矩与投稿动作

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { say, step, info, warn, die } from "./console.mjs";
import { run, runRetry, git, gh, gitQuiet, classify, sleepSync } from "./exec.mjs";
import { MARKET, marketStage, verifyStage } from "./market.mjs";

const RELEASE_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(RELEASE_DIR, "..");

// ─────────────────────────────────────────────────────────────────────────────
// 配置与清单
// ─────────────────────────────────────────────────────────────────────────────
function loadConfig() {
  const path = join(RELEASE_DIR, "config.json");
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw die(`读不到或解析不了 release/config.json：${(e && e.message) || e}`, "确认 release/config.json 存在且是合法 JSON");
  }
  const missing = [];
  if (raw.schema !== 1) missing.push("schema 必须是 1");
  if (typeof raw.publisher !== "string" || !raw.publisher.trim()) missing.push("publisher 必须是非空字符串");
  if (!raw.release || typeof raw.release.repo !== "string" || !/^[^\s/]+\/[^\s/]+$/.test(raw.release.repo)) {
    missing.push("release.repo 必须是 owner/repo 形式");
  }
  if (missing.length) {
    throw die(`release/config.json 有问题：\n      ${missing.join("\n      ")}`, "补齐后再跑一次");
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
    // 已经打过这个 tag 怎么办？
    // 这里只提醒，不拦。理由是「同一个 tag」不等于「同一份包」：改动 release/ 这类不进包的
    // 文件也会动 HEAD，拿提交相不相等当判据会误伤合法的重跑。
    // 真正的硬约束在 releaseStage：发 Release 前拿远端附件的 sha256 跟本地现算的比，对不上就停。
    const head = gitQuiet(["rev-parse", "HEAD"]).stdout.trim();
    const noteExistingTag = (where, sha) => {
      if (!sha) return;
      const at = sha === head ? "指向当前提交" : `指向 ${sha.slice(0, 8)}，而当前 HEAD 是 ${head.slice(0, 8)}`;
      warn(`${where}已有 tag ${ctx.tag}（${at}）—— 按“重跑这一版”处理，包是不是同一份由后面的 sha256 比对决定`);
    };

    const localTag = gitQuiet(["rev-parse", "-q", "--verify", `refs/tags/${ctx.tag}`]);
    if (localTag.status === 0) noteExistingTag("本地", gitQuiet(["rev-list", "-n", "1", ctx.tag]).stdout.trim());

    // 远端有没有这个 tag，必须问清楚，不能把“查不到”当成“没有”：
    // 网络抖一下就放行，会带着一个推不上去的 tag 和提交继续发版。
    // 用带重试的 git（不是 gitQuiet）：先给网络三次机会，仍不通就中止。
    // 没有 origin 的纯本地仓库是另一回事，那种情况跳过。
    if (run("git", ["remote", "get-url", "origin"]).status === 0) {
      const remote = git(["ls-remote", "--tags", "origin", `refs/tags/${ctx.tag}`]);
      const lines = remote.stdout.trim().split("\n").filter(Boolean);
      // annotated tag 会多一行 <sha> refs/tags/x^{}（解引用后的提交），优先取它
      const pick = lines.find((l) => l.endsWith("^{}")) || lines.find((l) => l.endsWith(`refs/tags/${ctx.tag}`));
      noteExistingTag("远端", pick ? pick.split(/\s+/)[0] : "");
    } else {
      warn("这个仓库没有 origin 远端，跳过远端 tag 检查");
    }

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
  // 用 run 不用 runRetry：pack.mjs 是纯本地的，失败就是本地失败，重试只会再跑一遍自检、
  // 白等几秒，还会把「自检没过」这种已经确定的事伪装成网络抖动。重试层留给 git / gh。
  const result = run(process.execPath, [join(RELEASE_DIR, "pack.mjs")]);
  process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
  if (result.stderr.trim()) process.stdout.write(result.stderr);
  if (result.status !== 0) throw die("出包失败", "看上面 pack.mjs 的输出；自检没过也会走到这里");

  const ver = ctx.effectiveVersion || ctx.version;
  const distDir = resolve(ROOT, config.packOut);
  ctx.zipPath = join(distDir, `${ctx.id}-v${ver}.zip`);
  ctx.entryPath = join(distDir, `app-${ctx.id}-${ver}.entry.json`);
  if (!existsSync(ctx.zipPath)) throw die(`出包后找不到 ${relative(ROOT, ctx.zipPath)}`, "看 pack.mjs 的输出");
  if (!existsSync(ctx.entryPath)) throw die(`出包后找不到 ${relative(ROOT, ctx.entryPath)}`, "看 pack.mjs 的输出");

  const entry = JSON.parse(readFileSync(ctx.entryPath, "utf8"));
  ctx.entry = entry;

  // 事实只认当场从包里算出来的。entry 里那份、dist 里那个 .sha256 副文件，都只是小票；
  // 小票与包对不上时必须停下，别把错的 sha256 登记进市场（那要整个 PR 重来）。
  const zipBytes = readFileSync(ctx.zipPath);
  const zipSha256 = createHash("sha256").update(zipBytes).digest("hex");
  if (entry.archive.sha256 !== zipSha256) {
    throw die(
      `entry 里写的 sha256 和 zip 现算的对不上\n      entry：${entry.archive.sha256}\n      现算：${zipSha256}`,
      "包在出包之后被改动过，原样重跑一次；还不行就是 pack.mjs 的问题",
    );
  }
  if (entry.archive.size !== zipBytes.length) {
    throw die(`entry 里写的字节数与 zip 实际不符：entry ${entry.archive.size}，实际 ${zipBytes.length}`);
  }
  ctx.sha256 = zipSha256;
  ctx.zipSize = zipBytes.length;

  if (!MARKET.sha256Pattern.test(ctx.sha256)) throw die(`算出来的 sha256 不合法：${ctx.sha256}`);
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

  // tag 可能已经打过了：上一次发到一半（Release 发了、投稿没做成）重跑时会走到这里。
  // 不用 -f 去覆盖：git tag 默认就拒绝覆盖，顺着它来。这个 tag 已经对外存在，
  // 一旦它指向的提交和现在这批代码不同，-f 会把它悄悄挪走，那比报错麻烦得多。
  if (gitQuiet(["rev-parse", "-q", "--verify", `refs/tags/${ctx.tag}`]).status === 0) {
    info(`tag ${ctx.tag} 已存在，跳过打 tag`);
  } else {
    git(["tag", ctx.tag]);
    info(`打 tag ${ctx.tag}`);
  }

  git(["push", "origin", config.defaultBranch]);
  git(["push", "origin", ctx.tag]);
  info(`已推送到 origin/${config.defaultBranch} 和 ${ctx.tag}`);
}

/** S5 发 Release。 */
function releaseStage(config, ctx, args) {
  step("发布 Release");

  if (ctx.existingRelease?.exists) {
    const byName = new Map(ctx.existingRelease.assets.map((a) => [a.name, a]));
    const remoteZip = byName.get(`${ctx.id}-v${ctx.version}.zip`);
    const remoteEntry = byName.get(ctx.entryName);
    if (!remoteZip || !remoteEntry) {
      throw die(`远端已有 Release ${ctx.tag}，但附件对不上`, "先删掉那个 Release，或者换一个版本号");
    }

    // digest 是 GitHub 存着的 "sha256:<hex>"，拿出来跟本地现算的那个比 —— 这样「重跑」是
    // 真的幂等：同一份包才跳过，包不一样就停。老版本 gh 或老 Release 可能没这个字段，
    // 那种情况退回只比字节数（比只看文件名强，但不如 digest）。
    const remoteZipSha = String(remoteZip.digest || "").replace(/^sha256:/, "");
    if (remoteZipSha && remoteZipSha !== ctx.sha256) {
      throw die(
        `远端 Release ${ctx.tag} 上的 zip 和本地刚出的不是同一份\n      远端 ${remoteZipSha}\n      本地 ${ctx.sha256}`,
        "删掉远端那个 Release 重发，或者换一个版本号",
      );
    }
    const localEntryBytes = statSync(ctx.entryPath).size;
    if (remoteEntry.size !== localEntryBytes) {
      throw die(
        `远端 Release ${ctx.tag} 上的条目和本地刚出的不是同一份（远端 ${remoteEntry.size} 字节，本地 ${localEntryBytes} 字节）`,
        "删掉远端那个 Release 重发，或者换一个版本号",
      );
    }

    info(`Release ${ctx.tag} 已存在，附件与本地一致，跳过`);
    ctx.releaseSkipped = true;
    return;
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
// main
// ─────────────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));

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

  // 标题跟着插件走，不写死：整个 release/ 是要整目录复制到别的插件去的。
  step(`${ctx.name} 发布 · 模式 ${args.mode}${args.dryRun ? " · 干跑" : ""}`);

  ctx.version = String(ctx.version).trim().replace(/^v/, "");
  ctx.effectiveVersion = manifest.version;
  if (!/^\d+\.\d+\.\d+/.test(ctx.version)) throw die(`版本号看起来不合法：${ctx.version}`, "用形如 3.2.1 的写法");
  ctx.tag = `v${ctx.version}`;
  ctx.entryName = `app-${ctx.id}-${ctx.version}.entry.json`;

  const prAssets = join(RELEASE_DIR, "pr-assets");
  if (existsSync(prAssets)) {
    ctx.screenshots = readdirSync(prAssets)
      .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f))
      .sort();
  }
  const selfTestPath = join(RELEASE_DIR, "自测.md");
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
    warn("release/pr-assets/ 里没有图，PR 正文的截图那块留了「待补」，记得去浏览器里补一下");
  }
}

try {
  main();
} catch (error) {
  if (!error?.hinted) {
    say(`\n[停] ${error instanceof Error ? error.message : String(error)}`);
    if (process.env.RELEASE_DEBUG) say(String(error?.stack || ""));
  }
  process.exitCode = 1;
}

