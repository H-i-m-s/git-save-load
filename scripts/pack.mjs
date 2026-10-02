// scripts/pack.mjs — 零依赖出包（不调外部 tar/zip，不用 npm 库）。
//
// 产物（dist/）：
//   <id>-v<version>.zip          归档；内含顶层目录 <id>/（宿主安装时自动剥壳）
//   <id>-v<version>.zip.sha256   sha256 校验值
//   <id>-v<version>.entry.json   市场条目（archive.url 用 {{BASE_URL}} 占位）
//
// 打包前先跑 scripts/selfcheck.mjs，不过就拒绝出包并说明原因。
//
// 用法：
//   node scripts/pack.mjs                 # 出包到 <app>/dist
//   node scripts/pack.mjs --out <dir>     # 自定义输出目录
//   node scripts/pack.mjs --publisher <p> # 指定 entry.json 的 publisher
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 任意层级的整目录排除项。release.ps1 出包时也调本脚本，所以这里是唯一的排除清单：
 *  开发脚本、测试与 CI 配置不进包，安装位的 App 用不到它们。 */
const SKIP_DIRS = new Set([".git", ".github", "node_modules", "dist", "scripts", "tests"]);
/** 常见临时/系统文件（按文件名匹配）。 */
const SKIP_FILE_RE = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._)|\.(tmp|temp|swp|swo|log|bak)$|~$/i;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// ── 0) 出包前先自检 ─────────────────────────────────────────────────────────
function runSelfcheck() {
  const script = join(ROOT, "scripts", "selfcheck.mjs");
  try {
    execFileSync(process.execPath, [script], { stdio: "pipe" });
    console.log("[pack] selfcheck 通过");
    return true;
  } catch (e) {
    const out = [e.stdout, e.stderr].map((b) => String(b || "")).join("").trim();
    console.error("[pack] selfcheck 未通过，拒绝出包：");
    if (out) console.error(out.split("\n").map((l) => "    " + l).join("\n"));
    return false;
  }
}

// ── 1) 递归收集待打包文件（顶层目录 <id>/，跳过排除项与符号链接） ────────────
function collect(dir, base, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      collect(abs, base, out);
    } else if (st.isFile()) {
      if (SKIP_FILE_RE.test(name)) continue;
      out.push({ abs, entry: relative(base, abs).split(sep).join("/"), size: st.size });
    }
  }
  return out;
}

// ── 最小 ZIP 写入器（deflate/store，UTF-8 名，保留可执行位） ─────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function writeZip(outFile, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.entry, "utf8");
    const data = readFileSync(e.abs);
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 标志
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE((((e.mode || 0o644) | 0o100000) << 16) >>> 0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outFile, Buffer.concat([...chunks, cenBuf, eocd]));
}

/** 市场条目（.entry.json），字段对齐 GitHana 的产物；archive.url 用 {{BASE_URL}} 占位。 */
function buildEntry({ manifest, publisher, zipName, digest, size }) {
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  const entry = {
    kind: "app",
    id: manifest.id,
    name: manifest.name || manifest.id,
    publisher: publisher || manifest.id,
    description: typeof manifest.description === "string" ? manifest.description : "",
    version: manifest.version,
    permissions: capabilities.map((capability) => ({ capability })),
    ...(manifest.minAppVersion ? { compatibility: { minAppVersion: manifest.minAppVersion } } : {}),
    archive: { url: `{{BASE_URL}}/${zipName}`, sha256: digest, size, format: "zip" },
  };
  try {
    const iconPath = join(ROOT, manifest.icon);
    if (manifest.icon && existsSyncFile(iconPath)) {
      const ext = manifest.icon.toLowerCase().endsWith(".svg") ? "image/svg+xml" : "image/png";
      entry.icon = `data:${ext};base64,${readFileSync(iconPath).toString("base64")}`;
    }
  } catch {
    /* 图标只是加性字段，读不到就不带 */
  }
  if (manifest.repository) entry.repository = manifest.repository;
  if (manifest.homepage) entry.homepage = manifest.homepage;
  return entry;
}

function existsSyncFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// ── main ────────────────────────────────────────────────────────────────────
function main() {
  const manifest = readJson(join(ROOT, "manifest.json"));
  if (!manifest.id || !manifest.version) {
    console.error("[pack] manifest.json 缺 id/version，拒绝出包");
    process.exit(1);
  }

  if (!runSelfcheck()) process.exit(1);

  const outDir = resolve(arg("--out") || join(ROOT, "dist"));
  const baseName = `${manifest.id}-v${manifest.version}`;
  const zipName = `${baseName}.zip`;
  const zipPath = join(outDir, zipName);

  // 收集（顶层目录名 = manifest.id），保证 zip 内末级目录名等于 id。
  const files = collect(ROOT, ROOT).map((f) => ({ ...f, entry: `${manifest.id}/${f.entry}` }));
  if (files.length === 0) {
    console.error("[pack] 没有可打包的文件，拒绝出包");
    process.exit(1);
  }

  rmSync(zipPath, { force: true });
  mkdirSync(outDir, { recursive: true });
  writeZip(zipPath, files);

  const zipBytes = readFileSync(zipPath);
  const digest = createHash("sha256").update(zipBytes).digest("hex");
  writeFileSync(`${zipPath}.sha256`, `${digest}  ${zipName}\n`, "utf8");

  const entryPath = join(outDir, `${baseName}.entry.json`);
  const entry = buildEntry({
    manifest,
    publisher: arg("--publisher"),
    zipName,
    digest,
    size: zipBytes.length,
  });
  writeFileSync(entryPath, JSON.stringify(entry, null, 2) + "\n", "utf8");

  const relOut = (p) => relative(ROOT, p).split(sep).join("/");
  console.log(`[pack] 完成 ${relOut(zipPath)}  ${(zipBytes.length / 1024).toFixed(1)} KiB  ${files.length} 条`);
  console.log(`        sha256 ${digest}`);
  console.log(`        entry  ${relOut(entryPath)}`);
  console.log(`        条目   ${manifest.id}/manifest.json, ${manifest.id}/index.js, …`);
}

main();
