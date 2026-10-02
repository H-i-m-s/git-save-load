// lib/secret.js — GitHub 令牌的本地加密存放（后端可插拔）。
//
// 为什么不让 gh 自己保管：本 App 的隔离原则是「凭据留在 App 命名空间」。把令牌写进
// gh 的全局登录态，等于让用户自己的 gh、任何同用户进程都能读到，还把 App 的操作变成
// 全局状态变更。所以令牌只落在 <dataDir>/credential.json，且只以密文形态落盘。
//
// 为什么必须加密：dataDir 对同用户进程可读，明文落盘等于把令牌交给任何同用户程序。
// 因此没有可用后端时保存直接失败，绝不写明文回退。
//
// 后端可插拔：每个后端提供 { id, alg, storage, available, protect, unprotect }：
//   - win32：DPAPI（CurrentUser）→ 密文写 <dataDir>/credential.json            [已实现]
//   - darwin / linux：待接的系统保险箱，当前 available()=false
//   - none：无可用后端 → 拒绝保存（protect 直接抛错）
// 文件里的 alg 用来判定「这份密文是不是本机这个后端写的」：不一致就明说解不开，
// 不静默当未配置（否则用户会以为配好了，实际 gh 根本用不上）。
//
// 进程内缓存：解密是异步的（win32 要拉起 powershell 调 ProtectedData），而
// ghEnvironment() 必须在 spawn 前同步拿到 GH_TOKEN；所以明文写进模块级同步缓存，
// 调用方只同步读。

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SECRET_FILE = "credential.json";
const SCHEMA_VERSION = 1;

/** 模块级同步缓存：解密后的令牌明文（只在进程内，绝不落盘）。 */
let _cachedToken = "";

/** 同步读取缓存里的令牌；未配置 / 解不开时为空串。ghEnvironment() 靠它注入 GH_TOKEN。 */
export function getCachedToken() {
  return _cachedToken;
}

/** <dataDir>/credential.json */
function secretFilePath(dataDir) {
  return join(String(dataDir || ""), SECRET_FILE);
}

// ───────────────────────────── win32：DPAPI ─────────────────────────────

// 明文 / 密文统一用 base64 经 stdin/stdout 传递：控制台输入输出不经 UTF-8 解码，
// 换行与特殊字符也不会被 shell 或编码层吃掉。
// 每个 PowerShell 调用都必须带 -NoProfile（否则用户 profile 会拉起 conda 并弹黑框）
// 与 windowsHide（避免闪窗）。
const PS_PROTECT = [
  "$ErrorActionPreference='Stop'",
  "try { Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue } catch { }",
  "$sr=New-Object System.IO.StreamReader([Console]::OpenStandardInput())",
  "$b64=$sr.ReadToEnd().Trim()",
  "$bytes=[Convert]::FromBase64String($b64)",
  "$p=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Convert]::ToBase64String($p)",
].join("; ");

const PS_UNPROTECT = [
  "$ErrorActionPreference='Stop'",
  "try { Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue } catch { }",
  "$sr=New-Object System.IO.StreamReader([Console]::OpenStandardInput())",
  "$b64=$sr.ReadToEnd().Trim()",
  "$p=[Convert]::FromBase64String($b64)",
  "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Convert]::ToBase64String($bytes)",
].join("; ");

/** 拉起 powershell.exe，把 input 写进 stdin，返回 stdout（已 trim）。失败抛错。 */
function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const raw = [stdout, stderr].map((s) => String(s || "").trim()).filter(Boolean).join("\n");
        reject(new Error(raw || `powershell 退出码 ${code}`));
        return;
      }
      resolve(String(stdout || "").trim());
    });
    // 子进程提前退出时会 EPIPE，这里吞掉，以 close 的退出码为准。
    child.stdin.on("error", () => {});
    child.stdin.end(String(input ?? ""), "utf8");
  });
}

const WIN32_BACKEND = {
  id: "win32-dpapi",
  alg: "dpapi-current-user",
  storage: "file",
  available: () => process.platform === "win32",
  protect: (text) => runPowerShell(PS_PROTECT, Buffer.from(String(text), "utf8").toString("base64")),
  unprotect: (cipher) =>
    runPowerShell(PS_UNPROTECT, String(cipher)).then((b64) => Buffer.from(b64, "base64").toString("utf8")),
};

// ─────────────────────── 待接后端（跨平台时补齐） ───────────────────────
//
// 两个都应是 keyring 形态：密文交给系统保险箱，App 命名空间体现在 service/account 上，
// 文件里只留定位记录。契约不变，实现时替换 available/protect/unprotect 即可，
// 上层（saveSecret / loadSecretIntoContext / secretInfo）无需改动。

const DARWIN_BACKEND = {
  id: "darwin-keychain",
  alg: "keychain",
  storage: "keyring",
  available: () => false, // TODO(cross-platform): process.platform === "darwin"
  protect: async () => { throw new Error("macOS Keychain 后端尚未实现"); },
  unprotect: async () => { throw new Error("macOS Keychain 后端尚未实现"); },
};

const LINUX_BACKEND = {
  id: "linux-libsecret",
  alg: "libsecret",
  storage: "keyring",
  available: () => false, // TODO(cross-platform): 探测 `secret-tool` 是否在 PATH
  protect: async () => { throw new Error("Linux libsecret 后端尚未实现"); },
  unprotect: async () => { throw new Error("Linux libsecret 后端尚未实现"); },
};

const NONE_BACKEND = {
  id: "none",
  alg: null,
  storage: "none",
  available: () => true,
  protect: async () => { throw new Error("本平台暂无可用的加密后端，拒绝以明文落盘"); },
  unprotect: async () => { throw new Error("本平台暂无可用的加密后端"); },
};

/** 选后端：按平台顺序取第一个可用的；都不行则 none（拒绝保存）。 */
function pickBackend() {
  for (const b of [WIN32_BACKEND, DARWIN_BACKEND, LINUX_BACKEND]) {
    if (b.available()) return b;
  }
  return NONE_BACKEND;
}

// ───────────────────────────── 记录读写 ─────────────────────────────

/** 读记录；文件不存在 / 损坏 / 不可读 → null。 */
function readSecretRecord(dataDir) {
  try {
    const rec = JSON.parse(readFileSync(secretFilePath(dataDir), "utf8"));
    return rec && typeof rec === "object" ? rec : null;
  } catch {
    return null;
  }
}

/** 原子写记录（先写 .tmp 再 rename）。 */
function writeSecretRecord(dataDir, record) {
  const dir = String(dataDir || "");
  mkdirSync(dir, { recursive: true });
  const target = secretFilePath(dir);
  const tmp = target + ".tmp";
  writeFileSync(
    tmp,
    JSON.stringify({ schemaVersion: SCHEMA_VERSION, updatedAt: new Date().toISOString(), ...record }),
    "utf8",
  );
  renameSync(tmp, target);
}

// ───────────────────────────── 对外行为 ─────────────────────────────

/**
 * 保存令牌：走后端加密落盘，同时填进程缓存。没有可用后端时直接失败，绝不写明文。
 * @returns {Promise<{protection: string, backend: string}>}
 */
export async function saveSecret({ dataDir, token } = {}) {
  const value = String(token ?? "");
  if (!value) throw new Error("令牌为空，未保存");
  const backend = pickBackend();
  if (backend.storage === "none") {
    throw new Error("本平台暂无可用的加密后端（Windows 用 DPAPI，macOS/Linux 后端待接）：拒绝以明文保存令牌。");
  }
  const cipher = await backend.protect(value);
  writeSecretRecord(dataDir, { backend: backend.id, alg: backend.alg, storage: backend.storage, cipher });
  _cachedToken = value;
  return { protection: backend.alg, backend: backend.id };
}

/**
 * 把令牌解进进程缓存。永不抛出：解不开就按未配置处理，清缓存并给出原因。
 * @returns {Promise<{source: string, configured: boolean, readable?: boolean, error?: string}>}
 */
export async function loadSecretIntoContext(dataDir) {
  const backend = pickBackend();
  const rec = readSecretRecord(dataDir);

  if (rec && rec.cipher) {
    // 密文带 alg：不一致说明是别的平台 / 别的后端写的，明确说明解不开，不静默当未配置。
    if (rec.alg && backend.alg && rec.alg !== backend.alg) {
      _cachedToken = "";
      return {
        source: "encrypted",
        configured: false,
        readable: false,
        error: `密文由 ${rec.alg} 保护，本机后端是 ${backend.alg}，解不开`,
      };
    }
    try {
      const text = await backend.unprotect(rec.cipher);
      _cachedToken = text;
      return { source: "encrypted", configured: !!text, readable: true };
    } catch (e) {
      _cachedToken = "";
      return {
        source: "encrypted",
        configured: false,
        readable: false,
        error: `密文解不开：${String((e && e.message) || e)}`,
      };
    }
  }

  _cachedToken = "";
  return { source: "none", configured: false, readable: true };
}

/**
 * 启动时调一次：异步把令牌解进缓存。永不抛出（内部兜底），失败按未配置处理。
 */
export async function secretBootstrap(dataDir) {
  try {
    return await loadSecretIntoContext(dataDir);
  } catch (e) {
    _cachedToken = "";
    return { source: "none", configured: false, readable: false, error: String((e && e.message) || e) };
  }
}

/** 清除令牌：删记录 + 清进程缓存（记录不存在也当作已清）。 */
export async function clearSecret({ dataDir } = {}) {
  try {
    unlinkSync(secretFilePath(dataDir));
  } catch {
    /* 文件不存在 / 权限问题：调用方按「已无本地凭据」处理 */
  }
  _cachedToken = "";
  return { cleared: true };
}

/**
 * 给设置页看的摘要：是否已配置、保护方式、存放位置、后端是否可用（绝不回传明文）。
 */
export function secretInfo(dataDir) {
  const dir = String(dataDir || "");
  const backend = pickBackend();
  const available = backend.storage !== "none";
  const location =
    backend.storage === "file"
      ? secretFilePath(dir)
      : backend.storage === "keyring"
        ? `${backend.id}（系统保险箱）`
        : "不可用（本平台无加密后端）";
  const rec = readSecretRecord(dir);

  if (rec && rec.cipher) {
    const mismatch = !available || !!(rec.alg && backend.alg && rec.alg !== backend.alg);
    return {
      configured: !mismatch,
      protection: rec.alg || backend.alg || "",
      location,
      backend: rec.backend || backend.id,
      backendAvailable: available,
      readable: !mismatch,
    };
  }
  return {
    configured: false,
    protection: backend.alg || "",
    location,
    backend: backend.id,
    backendAvailable: available,
    readable: true,
  };
}
