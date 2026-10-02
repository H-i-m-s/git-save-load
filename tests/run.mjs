// tests/run.mjs — git-save-load 自动化测试一键入口。
//
//   node tests/run.mjs               跑 tests/cases/*.mjs 全部用例
//   node tests/run.mjs 04 05         只跑文件名含 "04" / "05" 的用例
//
// 每个用例文件都在「受限模式」子进程里跑，贴近 App 真实运行环境：
//   node --permission --allow-fs-read=<APP> --allow-fs-read=<TMP>
//        --allow-fs-write=<TMP> --allow-child-process <case.mjs>
// 安装目录只读、临时目录可写；越界 fs 会抛 ERR_ACCESS_DENIED（用例内 try/catch）。
//
// 退出码：全部通过 0；有失败 1。

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "..");
const CASES_DIR = join(HERE, "cases");
const CASE_TIMEOUT_MS = 300000;

const filters = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const tmpRoot = mkdtempSync(join(tmpdir(), "gsl-tests-"));

function listCases() {
  const files = readdirSync(CASES_DIR)
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  if (!filters.length) return files;
  return files.filter((name) => filters.some((f) => name.includes(f)));
}

function runCase(file) {
  return new Promise((done) => {
    const nodeArgs = [
      "--permission",
      `--allow-fs-read=${APP_DIR}`,
      `--allow-fs-read=${tmpRoot}`,
      `--allow-fs-write=${tmpRoot}`,
      "--allow-child-process",
      join(CASES_DIR, file),
    ];
    const startedAt = Date.now();
    const child = spawn(process.execPath, nodeArgs, {
      cwd: APP_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        GSL_APP_DIR: APP_DIR,
        GSL_TMP_DIR: tmpRoot,
        NODE_NO_WARNINGS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, CASE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ file, code: null, signal: null, stdout, stderr: `${stderr}\nspawn error: ${error.message}`, ms: Date.now() - startedAt, timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ file, code, signal, stdout, stderr, ms: Date.now() - startedAt, timedOut });
    });
  });
}

function indent(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, idx, all) => !(idx === all.length - 1 && line === ""))
    .map((line) => `  | ${line}`)
    .join("\n");
}

async function main() {
  const cases = listCases();
  console.log("git-save-load tests");
  console.log(`  app    : ${APP_DIR}`);
  console.log(`  node   : ${process.version}`);
  console.log(`  tmp    : ${tmpRoot}`);
  console.log(`  cases  : ${cases.length}`);
  console.log("");

  if (!cases.length) {
    console.error(`没有找到用例文件：${CASES_DIR}`);
    process.exitCode = 1;
    return;
  }

  let passed = 0;
  let failed = 0;
  let okChecks = 0;
  let failedChecks = 0;
  const startedAll = Date.now();

  for (const file of cases) {
    console.log(`▶ ${file}`);
    const result = await runCase(file);
    if (result.stdout.trim()) console.log(indent(result.stdout.trimEnd()));
    if (result.stderr.trim()) console.log(indent(`[stderr]\n${result.stderr.trimEnd()}`));

    const ok = result.code === 0 && !result.timedOut;
    const match = /RESULT .*: (\d+) ok, (\d+) failed/.exec(result.stdout);
    if (match) {
      okChecks += Number(match[1]);
      failedChecks += Number(match[2]);
    }
    if (ok) {
      passed += 1;
      console.log(`PASS ${file} (${result.ms}ms)`);
    } else {
      failed += 1;
      const why = result.timedOut
        ? `超时 ${CASE_TIMEOUT_MS}ms 被杀`
        : `退出码 ${result.code}${result.signal ? ` signal ${result.signal}` : ""}`;
      console.log(`FAIL ${file} — ${why}`);
    }
    console.log("");
  }

  const elapsed = ((Date.now() - startedAll) / 1000).toFixed(2);
  console.log("─".repeat(56));
  console.log(`assertions: ${okChecks} ok, ${failedChecks} failed`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log(`elapsed: ${elapsed}s`);

  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  } catch {
    /* 临时目录残留交给系统回收 */
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

await main();
