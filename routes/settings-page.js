// 设置窗自定义设置页后端（contributes.settings.ui → /settings.html）。
// 只管三块：账号与 gh 认证、命令行工具检测、隔离 GPG 提交签名。
// 卡片内的设置（仓库/暂存/推送/主题等）不走这里，互不影响。
//
// 分层：本文件是纯后端逻辑 + 路由；被 routes/git.js 的默认导出装配进来。
// 约束：子进程一律 execFile/spawn（不经用户输入的 shell）；GPG 密钥只落在 App dataDir。
//
// 关于 Git 自带的 gpg：Git for Windows 里的 gpg 是 MSYS 构建，脱离 MSYS 直接跑时
// gpg-agent 会因「socket 名里带盘符冒号」起不来。所以当 gpg 来自 Git 安装目录且旁边
// 有 bash.exe 时，统一经 `bash -lc` 以 POSIX 路径运行；提交签名则用一个小 .cmd 包装器
// 把 gpg.program 接进 bash。装的是独立 GnuPG（Gpg4win 等）时走原生路径。

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { resolveGhPath, ghEnvironment } from "./github.js";

const GH_HOST = "github.com";
const DEVICE_URL = "https://github.com/login/device";
const SIGN_HOME_DIR = "gnupg";
const SIGN_META_FILE = "signing.json";
const SIGN_WRAPPER_FILE = "gpg-sign.cmd";

// ---------------------------------------------------------------- 通用子进程

function runTool(exe, args, env, timeoutMs = 12000) {
  try {
    const stdout = execFileSync(exe, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      env: env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout || "").trim(), stderr: "" };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e?.stdout || "").trim(),
      stderr: String(e?.stderr || e?.message || e || "").trim(),
    };
  }
}

const firstVersion = (s) => {
  const m = String(s || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : "";
};

function baseEnv(home) {
  const env = { ...process.env };
  if (!env.HOME && env.USERPROFILE) env.HOME = env.USERPROFILE;
  if (home) env.GNUPGHOME = home;
  return env;
}

// Windows 绝对路径 → MSYS POSIX 路径（C:\a\b → /c/a/b）
function toPosixPath(p) {
  let s = String(p || "").replace(/\\/g, "/");
  const m = s.match(/^([A-Za-z]):\/(.*)$/);
  if (m) s = `/${m[1].toLowerCase()}/${m[2]}`;
  return s;
}

// ---------------------------------------------------------------- gpg 定位与后端

// gpg 可执行路径：优先从 git 安装目录推断（Git for Windows 自带 gpg），
// 再退到 GnuPG 官方安装位置，最后交给 PATH。命中后缓存，未命中则每次重探（便于装上后刷新即见）。
let _gpgPath = "";
export function resolveGpgPath(gitPath) {
  if (_gpgPath) return _gpgPath;
  const candidates = [];
  if (process.env.GPG_PATH) candidates.push(process.env.GPG_PATH);
  if (gitPath && /[\\/]/.test(gitPath)) {
    // 兼容两种布局：…\Git\cmd\git.exe 与 …\mingw64\bin\git.exe
    const dir = gitPath.replace(/[\\/][^\\/]*$/, "");
    const root = dir.replace(/[\\/](cmd|bin)$/i, "");
    candidates.push(join(dir, "gpg.exe"));
    candidates.push(join(root, "usr", "bin", "gpg.exe"));
    candidates.push(join(root, "mingw64", "bin", "gpg.exe"));
    candidates.push(join(dir, "..", "..", "usr", "bin", "gpg.exe"));
  }
  if (process.platform === "win32") {
    candidates.push("C:\\Program Files\\Git\\usr\\bin\\gpg.exe");
    candidates.push("C:\\Program Files (x86)\\GnuPG\\bin\\gpg.exe");
    candidates.push("C:\\Program Files\\GnuPG\\bin\\gpg.exe");
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Programs", "GnuPG", "bin", "gpg.exe"));
  }
  candidates.push("gpg");
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (runTool(candidate, ["--version"], process.env).ok) {
      _gpgPath = candidate;
      return candidate;
    }
  }
  _gpgPath = "";
  return "";
}

// 若 gpg 来自 Git 安装目录（…/Git/usr/bin 或 …/Git/mingw64/bin），返回同装目录下的 bash.exe
function findGitBash(gpgPath) {
  if (!gpgPath || !/[\\/]/.test(gpgPath)) return "";
  const m = gpgPath.match(/^(.*?)[\\/](?:usr[\\/]bin|mingw64[\\/]bin)[\\/][^\\/]*$/i);
  if (!m) return "";
  const bash = join(m[1], "bin", "bash.exe");
  return existsSync(bash) ? bash : "";
}

function gpgBackend(gitPath) {
  const gpgPath = resolveGpgPath(gitPath);
  if (!gpgPath) return null;
  return { gpgPath, bash: findGitBash(gpgPath) };
}

function gpgconfPath(gpgPath) {
  if (!gpgPath || !/[\\/]/.test(gpgPath)) return process.platform === "win32" ? "gpgconf.exe" : "gpgconf";
  const dir = gpgPath.replace(/[\\/][^\\/]*$/, "");
  return join(dir, process.platform === "win32" ? "gpgconf.exe" : "gpgconf");
}

// 统一入口：MSYS 版经 bash 跑（POSIX 路径），独立 GnuPG 直接跑。
function runGpg(backend, home, args, timeoutMs = 30000) {
  const common = ["--no-tty", "--batch", "--yes"];
  if (backend.bash) {
    const env = baseEnv(toPosixPath(home));
    return runTool(backend.bash, ["-lc", 'gpg "$@"', "_", "--homedir", toPosixPath(home), ...common, ...args], env, timeoutMs);
  }
  return runTool(backend.gpgPath, ["--homedir", home, ...common, ...args], baseEnv(home), timeoutMs);
}

// ---------------------------------------------------------------- 签名状态

function signHome(dataDir) {
  return join(dataDir, SIGN_HOME_DIR);
}
function signMetaPath(dataDir) {
  return join(dataDir, SIGN_META_FILE);
}
function readSignMeta(dataDir) {
  try {
    return JSON.parse(readFileSync(signMetaPath(dataDir), "utf8")) || {};
  } catch {
    return {};
  }
}
function writeSignMeta(dataDir, meta) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(signMetaPath(dataDir), JSON.stringify(meta, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
function signingStatus(dataDir) {
  const meta = readSignMeta(dataDir);
  return {
    enabled: !!meta.enabled,
    hasKey: !!meta.fingerprint,
    fingerprint: meta.fingerprint || "",
    uid: meta.uid || "",
    createdAt: meta.createdAt || 0,
  };
}

// gpg --with-colons 输出里 uid/fpr 字段带转义，解码成可读文本
function decodeGpgField(value) {
  return String(value || "")
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\e/g, "%")
    .replace(/\\n/g, " ");
}

function listSignKey(dataDir, backend) {
  const home = signHome(dataDir);
  const r = runGpg(backend, home, ["--list-secret-keys", "--with-colons"], 20000);
  if (!r.ok) return { ok: false, message: r.stderr || "读取密钥失败" };
  let fingerprint = "";
  let uid = "";
  for (const line of r.stdout.split("\n")) {
    const f = line.split(":");
    if (f[0] === "fpr" && !fingerprint) fingerprint = f[9] || "";
    if (f[0] === "uid" && !uid) uid = decodeGpgField(f[9]);
  }
  if (!fingerprint) return { ok: false, message: "未找到密钥" };
  return { ok: true, fingerprint, uid };
}

function killGpgAgent(dataDir, backend) {
  const home = signHome(dataDir);
  if (backend.bash) {
    runTool(backend.bash, ["-lc", 'gpgconf "$@"', "_", "--homedir", toPosixPath(home), "--kill", "gpg-agent"], baseEnv(toPosixPath(home)), 15000);
    return;
  }
  runTool(gpgconfPath(backend.gpgPath), ["--homedir", home, "--kill", "gpg-agent"], baseEnv(home), 15000);
}

// 删除隔离密钥环（先杀 agent，否则 Windows 上目录可能被占用）
function clearKeys(dataDir, backend) {
  const home = signHome(dataDir);
  if (backend) killGpgAgent(dataDir, backend);
  try {
    rmSync(home, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// 身份字段清理：只留安全字符，避免破坏 gpg 参数文件
function sanitizeIdentityPart(value, fallback) {
  const v = String(value || "").replace(/[^A-Za-z0-9 ._@+-]/g, "").trim();
  return v || fallback;
}

// 生成一把只用于签名的密钥（不设口令，提交时不弹窗）。
// 优先 ed25519（现代、小、快），失败时清理后回退 RSA 3072（老版本 gpg 也支持）。
// 导出供自测与复用。
export function generateKey(dataDir, gitPath, uid) {
  const backend = gpgBackend(gitPath);
  if (!backend) return { ok: false, message: "未检测到 gpg" };
  const home = signHome(dataDir);
  mkdirSync(home, { recursive: true });
  const paramsFile = join(dataDir, `gpg-gen-${Date.now()}.txt`);
  const paramsArg = backend.bash ? toPosixPath(paramsFile) : paramsFile;

  // GnuPG 批处理参数块必须以 Key-Type 开头；%no-protection / %commit 是控制语句，放块尾。
  const common = [
    "Key-Usage: sign",
    `Name-Real: ${sanitizeIdentityPart(uid?.name, "Git Save/Load")}`,
    `Name-Email: ${sanitizeIdentityPart(uid?.email, "git-save-load@localhost")}`,
    "Expire-Date: 0",
    "%no-protection",
    "%commit",
  ];
  const attempt = (lines) => {
    writeFileSync(paramsFile, lines.join("\n") + "\n", "utf8");
    return runGpg(backend, home, ["--gen-key", paramsArg], 120000);
  };

  try {
    let r = attempt(["Key-Type: EDDSA", "Key-Curve: Ed25519", ...common]);
    if (!r.ok) {
      clearKeys(dataDir, backend);
      mkdirSync(home, { recursive: true });
      r = attempt(["Key-Type: RSA", "Key-Length: 3072", ...common]);
    }
    if (!r.ok) return { ok: false, message: r.stderr || "生成密钥失败" };
  } finally {
    try { rmSync(paramsFile, { force: true }); } catch {}
  }

  return listSignKey(dataDir, backend);
}

// ---------------------------------------------------------------- gh

let _deviceFlow = null;
const activeFlow = () => (_deviceFlow && _deviceFlow.code && !_deviceFlow.closedAt ? _deviceFlow : null);

function ghRun(args, timeoutMs = 20000) {
  return runTool(resolveGhPath(), args, ghEnvironment(), timeoutMs);
}

function parseAuth(json) {
  let hosts = {};
  try {
    hosts = JSON.parse(String(json || "{}")).hosts || {};
  } catch {
    hosts = {};
  }
  const accounts = Object.values(hosts).flat().filter((a) => a && a.state === "success");
  const account = accounts.find((a) => a.active) || accounts[0] || null;
  return { loggedIn: !!account, login: account?.login || "", host: account?.host || GH_HOST };
}

function readGhStatus() {
  const version = ghRun(["--version"], 12000);
  if (!version.ok) return { installed: false, version: "", loggedIn: false, login: "", accountId: "" };
  const auth = ghRun(["auth", "status", "--json", "hosts"], 20000);
  const parsed = auth.ok ? parseAuth(auth.stdout) : { loggedIn: false, login: "" };
  let accountId = "";
  if (parsed.loggedIn) {
    const idr = ghRun(["api", "user", "--jq", ".id"], 12000);
    if (idr.ok) accountId = idr.stdout.trim();
  }
  return {
    installed: true,
    version: firstVersion(version.stdout),
    loggedIn: parsed.loggedIn,
    login: parsed.login,
    accountId,
  };
}

// 设备码登录：拿到码后进程保持存活继续轮询，用户授权后 gh 自己写入登录态。
function startDeviceFlow() {
  const existing = activeFlow();
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const flow = { code: null, url: DEVICE_URL, startedAt: Date.now(), closedAt: null };
    let buffer = "";
    const child = spawn(
      resolveGhPath(),
      ["auth", "login", "--hostname", GH_HOST, "--git-protocol", "https", "--web"],
      { shell: false, stdio: ["ignore", "pipe", "pipe"], env: ghEnvironment(), windowsHide: true },
    );
    const onData = (chunk) => {
      buffer += chunk;
      if (flow.code) return;
      const m = String(buffer).match(/one[-\s]?time code[^0-9A-Z]*([0-9A-Z]{4}-[0-9A-Z]{4})/i);
      if (m) {
        flow.code = m[1];
        _deviceFlow = flow;
        clearTimeout(timer);
        try { child.unref(); } catch {}
        resolve(flow);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      clearTimeout(timer);
      if (!flow.code) reject(error);
    });
    child.on("close", () => {
      flow.closedAt = Date.now();
      if (!flow.code) {
        clearTimeout(timer);
        reject(new Error(String(buffer).trim() || "gh 提前退出（可能是网络波动，重试即可）"));
      }
    });
    const timer = setTimeout(() => {
      if (!flow.code) {
        try { child.kill(); } catch {}
        reject(new Error("25 秒内未拿到设备码，重试即可"));
      }
    }, 25000);
  });
}

function openExternal(url) {
  const [cmd, argv] =
    { win32: ["cmd", ["/c", "start", "", url]], darwin: ["open", [url]] }[process.platform] ?? ["xdg-open", [url]];
  try {
    spawn(cmd, argv, { shell: false, detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function buildSignUid(gh) {
  if (gh.loggedIn && gh.login) {
    const email = gh.accountId
      ? `${gh.accountId}+${gh.login}@users.noreply.github.com`
      : `${gh.login}@users.noreply.github.com`;
    return { name: gh.login, email };
  }
  return { name: "Git Save/Load", email: "git-save-load@localhost" };
}

// ---------------------------------------------------------------- 提交签名（供 commit 使用）

// MSYS 版 gpg 需要一个经 bash 转发的小包装器当 gpg.program：
// 它把 GNUPGHOME 设成 POSIX 路径，再以 gpg 从 bash 的 PATH 解析执行。
function ensureGpgWrapper(dataDir, bashPath, home) {
  const file = join(dataDir, SIGN_WRAPPER_FILE);
  const content = [
    "@echo off",
    `set "GNUPGHOME=${toPosixPath(home)}"`,
    `"${bashPath}" -c "gpg %*"`,
    "",
  ].join("\r\n");
  try {
    if (!existsSync(file) || readFileSync(file, "utf8") !== content) writeFileSync(file, content, "utf8");
  } catch {
    /* 写不出包装器时不至于崩，最坏情况是签名失败并报错 */
  }
  return file;
}

/**
 * 返回提交时要追加的 git 参数与额外环境。
 * 关闭、无密钥、无 gpg 时都返回空，让提交保持原样（不阻塞）。
 */
export function resolveCommitSigning(dataDir, gitPath) {
  const meta = readSignMeta(dataDir);
  if (!meta.enabled || !meta.fingerprint) return { args: [], env: {} };
  const backend = gpgBackend(gitPath);
  if (!backend) return { args: [], env: {} };
  const home = signHome(dataDir);
  const program = backend.bash ? ensureGpgWrapper(dataDir, backend.bash, home) : backend.gpgPath;
  return {
    args: [
      "-c", "commit.gpgsign=true",
      "-c", `user.signingkey=${meta.fingerprint}`,
      "-c", `gpg.program=${program}`,
    ],
    env: { GNUPGHOME: home },
  };
}

// ---------------------------------------------------------------- 路由

export function registerSettingsPageRoutes(app, { dataDir, resolveGitPath }) {
  const gitPath = () => (typeof resolveGitPath === "function" ? resolveGitPath() : "git");

  function toolchainStatus() {
    const git = runTool(gitPath(), ["--version"], process.env);
    const backend = gpgBackend(gitPath());
    const gpg = backend ? runTool(backend.gpgPath, ["--version"], process.env) : { ok: false, stdout: "" };
    return {
      git: { installed: git.ok, version: git.ok ? firstVersion(git.stdout) : "" },
      gpg: { installed: !!backend && gpg.ok, version: gpg.ok ? firstVersion(gpg.stdout) : "", path: backend?.gpgPath || "" },
    };
  }

  // 一次性状态：页面加载与轮询都读它
  app.get("/settings/status", async (c) => {
    try {
      const gh = readGhStatus();
      const tools = toolchainStatus();
      const flow = activeFlow();
      return c.json({
        ok: true,
        git: tools.git,
        gh,
        gpg: tools.gpg,
        signing: signingStatus(dataDir),
        device: flow ? { active: true, code: flow.code, url: flow.url, startedAt: flow.startedAt } : { active: false },
      });
    } catch (e) {
      return c.json({ ok: false, message: String(e?.message || e) });
    }
  });

  app.post("/settings/gh-login", async (c) => {
    const existing = activeFlow();
    if (existing) {
      openExternal(DEVICE_URL);
      return c.json({ ok: true, reused: true, code: existing.code, url: existing.url, browserOpened: true });
    }
    if (!readGhStatus().installed) {
      return c.json({ ok: false, message: "未检测到 GitHub CLI（gh），请先安装 gh 再登录。" });
    }
    try {
      const flow = await startDeviceFlow();
      const browserOpened = openExternal(DEVICE_URL);
      return c.json({ ok: true, code: flow.code, url: flow.url, browserOpened });
    } catch (e) {
      return c.json({ ok: false, message: String(e?.message || e) }, 502);
    }
  });

  app.post("/settings/gh-logout", async (c) => {
    const r = ghRun(["auth", "logout", "--hostname", GH_HOST], 20000);
    if (r.ok) _deviceFlow = null;
    return c.json({ ok: r.ok, message: r.ok ? "已退出登录（仅删本地凭据，不影响远端令牌）" : r.stderr || "退出失败" });
  });

  app.post("/settings/open-device", async (c) => c.json({ ok: openExternal(DEVICE_URL) }));

  // 生成隔离签名密钥（已有则原样返回）
  app.post("/settings/signing/generate", async (c) => {
    const current = signingStatus(dataDir);
    if (current.hasKey) return c.json({ ok: true, signing: current, existed: true });
    if (!gpgBackend(gitPath())) return c.json({ ok: false, message: "未检测到 gpg，请先安装 GnuPG（Git for Windows 也自带 gpg）。" });
    const uid = buildSignUid(readGhStatus());
    const res = generateKey(dataDir, gitPath(), uid);
    if (!res.ok) return c.json({ ok: false, message: res.message || "生成密钥失败" });
    writeSignMeta(dataDir, { fingerprint: res.fingerprint, uid: res.uid, enabled: true, createdAt: Date.now() });
    return c.json({ ok: true, signing: signingStatus(dataDir) });
  });

  // 轮换：清掉旧密钥环后重新生成
  app.post("/settings/signing/rotate", async (c) => {
    const backend = gpgBackend(gitPath());
    if (!backend) return c.json({ ok: false, message: "未检测到 gpg，无法轮换密钥。" });
    const previous = readSignMeta(dataDir);
    if (!clearKeys(dataDir, backend)) return c.json({ ok: false, message: "旧密钥环无法清除（可能被 gpg-agent 占用），请稍后重试。" });
    const uid = buildSignUid(readGhStatus());
    const res = generateKey(dataDir, gitPath(), uid);
    if (!res.ok) {
      writeSignMeta(dataDir, { ...previous, enabled: !!previous.enabled });
      return c.json({ ok: false, message: res.message || "轮换失败" });
    }
    writeSignMeta(dataDir, { fingerprint: res.fingerprint, uid: res.uid, enabled: true, createdAt: Date.now() });
    return c.json({ ok: true, signing: signingStatus(dataDir) });
  });

  // 切换「提交时签名」
  app.post("/settings/signing/toggle", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const enabled = !!body.enabled;
    const meta = readSignMeta(dataDir);
    if (enabled && !meta.fingerprint) return c.json({ ok: false, message: "还没有签名密钥，请先生成。" });
    writeSignMeta(dataDir, { ...meta, enabled });
    return c.json({ ok: true, signing: signingStatus(dataDir) });
  });

  // 导出公钥（armor），供用户加到 GitHub 显示 Verified
  app.get("/settings/signing/pubkey", async (c) => {
    const meta = readSignMeta(dataDir);
    if (!meta.fingerprint) return c.json({ ok: false, message: "还没有签名密钥。" });
    const backend = gpgBackend(gitPath());
    if (!backend) return c.json({ ok: false, message: "未检测到 gpg。" });
    const r = runGpg(backend, signHome(dataDir), ["--armor", "--export", meta.fingerprint], 20000);
    if (!r.ok || !r.stdout) return c.json({ ok: false, message: r.stderr || "导出公钥失败" });
    return c.json({ ok: true, armored: r.stdout });
  });
}
