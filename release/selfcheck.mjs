// SPDX-License-Identifier: MPL-2.0
//
// 本文件包含衍生自 GitHana 的部分代码：
//   GitHana: https://github.com/Nyasers/GitHana
//   Copyright (c) 2026 Nyasers，以 Mozilla Public License v. 2.0 授权。
// 本文件已由 git-save-load 修改，修改后的版本同样以 MPL-2.0 发布。完整声明见根目录 NOTICE。
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// This Source Code Form is "Incompatible With Secondary Licenses", as
// defined by the Mozilla Public License, v. 2.0.
//
// scripts/selfcheck.mjs — 零依赖结构自检（本地与 CI 都可跑）。
//
// 只做「不依赖任何外部工具也能判定」的那部分，给 CI 一个实际门槛：
//   1) manifest.json 能解析、必备字段齐全（manifestVersion/id/name/version/entry/icon）
//   2) entry 与 icon 指向的文件存在
//   3) entry、routes/、tools/、lib/ 下所有 .js 能被 Node 解析（node --check）
//   4) ui/settings.html 与 ui/git.html 存在，且它们引用的本地 ./assets/... 都存在
//   5) manifest 声明的设置页 / 卡片 route（settings.ui.route、cards[].route、
//      cards[].functionPanel.route）对应的 ui 页面必须存在
//
// 用法：
//   node scripts/selfcheck.mjs          # 人类可读文本，失败以非零码退出
//   node scripts/selfcheck.mjs --json   # 结构化输出 { ok, errors, warnings }
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JSON_MODE = process.argv.slice(2).includes("--json");

const errors = [];
const warnings = [];
const rel = (p) => relative(ROOT, p).split(sep).join("/");
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

/** 该目录不存在时不算错误，但会记一条警告（约定：目录缺席意味着没有该类文件）。 */
function listDirOrWarn(dir, label) {
  if (existsSync(dir)) return true;
  warn(`${label} 目录不存在，跳过其内容检查：${rel(dir)}/`);
  return false;
}

// ── 1) manifest.json 结构与必备字段 ─────────────────────────────────────────
let manifest = null;
try {
  manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
} catch (e) {
  fail(`manifest.json 无法解析：${(e && e.message) || e}`);
}

const REQUIRED_FIELDS = ["manifestVersion", "id", "name", "version", "entry", "icon"];
if (manifest) {
  for (const field of REQUIRED_FIELDS) {
    const value = manifest[field];
    if (value === undefined || value === null || value === "") {
      fail(`manifest.json 缺少必备字段：${field}`);
    }
  }
  if (typeof manifest.entry === "string" && manifest.entry && !existsSync(join(ROOT, manifest.entry))) {
    fail(`entry 指向的文件不存在：${manifest.entry}`);
  }
  if (typeof manifest.icon === "string" && manifest.icon && !existsSync(join(ROOT, manifest.icon))) {
    fail(`icon 指向的文件不存在：${manifest.icon}`);
  }
}

// ── 2) entry 与 routes/ 与 tools/ 与 lib/ 下所有 .js 的语法 ────────────────────
function collectJs(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectJs(p, out);
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(p);
  }
  return out;
}

const jsFiles = [];
const seen = new Set();
const addJs = (p) => {
  if (existsSync(p) && !seen.has(p)) {
    seen.add(p);
    jsFiles.push(p);
  }
};
if (manifest && typeof manifest.entry === "string" && manifest.entry) {
  addJs(join(ROOT, manifest.entry));
}
if (listDirOrWarn(join(ROOT, "routes"), "routes")) {
  for (const f of collectJs(join(ROOT, "routes"))) addJs(f);
}
if (listDirOrWarn(join(ROOT, "tools"), "tools")) {
  for (const f of collectJs(join(ROOT, "tools"))) addJs(f);
}
// lib/ 装着 git 与 gh 共用的逻辑（secret / repo-lock / user-proxy），
// 一条语法错就能把整个后端带下水，必须进闸。
if (listDirOrWarn(join(ROOT, "lib"), "lib")) {
  for (const f of collectJs(join(ROOT, "lib"))) addJs(f);
}

/** 用 node --check 校验一段源码的语法。
 *
 * 不用「node --check <文件>」：Node 24 对含 ESM 语法的无 type 字段 .js 会走模块自动探测，
 * 即便后面真有语法错误也可能返回 0（实测），会漏报。改用 stdin + 显式 --input-type，
 * 两种模式各检一遍：ESM 过或 CJS 过即视为语法合法；都不过才报错。 */
function checkSyntax(file) {
  const run = (src, inputType) => {
    try {
      execFileSync(process.execPath, ["--input-type=" + inputType, "--check"], {
        input: src,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { ok: true };
    } catch (e) {
      const out = [e.stdout, e.stderr].map((b) => String(b || "")).join("").trim();
      return { ok: false, out };
    }
  };
  let src;
  try {
    src = readFileSync(file);
  } catch (e) {
    return { ok: false, out: `读取失败：${(e && e.message) || e}` };
  }
  const asEsm = run(src, "module");
  if (asEsm.ok) return { ok: true };
  const asCjs = run(src, "commonjs");
  if (asCjs.ok) return { ok: true };
  // 都不过：按内容挑更贴切的报错（含 import/export 的按 ESM 报，否则按 CJS 报）
  const looksEsm = /\b(import|export)\b/.test(src.toString("utf8"));
  return { ok: false, out: looksEsm ? asEsm.out : asCjs.out };
}

for (const file of jsFiles) {
  const r = checkSyntax(file);
  if (!r.ok) {
    const head = (r.out || "").split("\n").slice(0, 3).join("\n    ");
    fail(`语法检查失败：${rel(file)}${head ? "\n    " + head : ""}`);
  }
}

// ── 3) ui 页面与其引用的本地资源 ────────────────────────────────────────────
const UI_DIR = join(ROOT, "ui");
const pageFiles = ["settings.html", "git.html"];
for (const name of pageFiles) {
  if (!existsSync(join(UI_DIR, name))) fail(`ui/${name} 不存在`);
}

/** 抽取 html 里 src/href 的本地相对引用（跳过 scheme://、//、#、以 / 开头的宿主路由）。 */
function htmlLocalRefs(htmlFile) {
  const html = readFileSync(htmlFile, "utf8");
  const re = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  const refs = [];
  let m;
  while ((m = re.exec(html))) {
    const value = (m[1] ?? m[2] ?? "").trim();
    if (!value) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) continue; // http: data: mailto: …
    if (value.startsWith("//") || value.startsWith("#")) continue;
    if (value.startsWith("/")) continue; // 宿主提供的绝对路由，不落在本目录
    const clean = value.split("#")[0].split("?")[0];
    if (!clean) continue;
    refs.push({ raw: value, clean });
  }
  return refs;
}

for (const name of pageFiles) {
  const htmlFile = join(UI_DIR, name);
  if (!existsSync(htmlFile)) continue;
  for (const ref of htmlLocalRefs(htmlFile)) {
    const target = resolve(UI_DIR, ref.clean);
    if (!existsSync(target)) fail(`ui/${name} 引用的本地资源不存在：${ref.raw}`);
  }
}

// ── 4) manifest 声明的 route 对应页面必须存在 ───────────────────────────────
if (manifest) {
  const contributes = manifest.contributes || {};
  const routeDecls = [];
  const settingsRoute = contributes.settings && contributes.settings.ui && contributes.settings.ui.route;
  if (typeof settingsRoute === "string") routeDecls.push({ route: settingsRoute, from: "contributes.settings.ui.route" });
  const cards = Array.isArray(contributes.cards) ? contributes.cards : [];
  for (const card of cards) {
    if (card && typeof card.route === "string") {
      routeDecls.push({ route: card.route, from: `contributes.cards[${card.id ?? "?"}].route` });
    }
    const fpRoute = card && card.functionPanel && card.functionPanel.route;
    if (typeof fpRoute === "string") {
      routeDecls.push({ route: fpRoute, from: `contributes.cards[${card.id ?? "?"}].functionPanel.route` });
    }
  }
  for (const { route, from } of routeDecls) {
    const file = join(UI_DIR, route.replace(/^\/+/, ""));
    if (!existsSync(file)) {
      const shown = route.startsWith("/") ? route : `/${route}`;
      fail(`${from} 指向的页面不存在：ui${shown}`);
    }
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────
const ok = errors.length === 0;

if (JSON_MODE) {
  console.log(JSON.stringify({ ok, errors, warnings }, null, 2));
} else {
  for (const w of warnings) console.log(`  warn: ${w}`);
  for (const e of errors) console.error(`  FAIL: ${e}`);
  console.log(
    `[selfcheck] 检查文件 ${jsFiles.length} 个 · 错误 ${errors.length} · 警告 ${warnings.length} · ${ok ? "OK" : "FAILED"}`,
  );
}

process.exit(ok ? 0 : 1);
