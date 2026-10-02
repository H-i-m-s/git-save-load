// tests/cases/01-structure.mjs
// 覆盖：结构自检（不 import，spawn `node scripts/selfcheck.mjs`），断言退出码 0。
// 顺手断言 stdout 里有自检总结行，便于失败时定位是哪些结构项挂了。

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { APP_DIR } from "../lib/fixture.mjs";
import { main, eq, contains, check, note } from "../lib/harness.mjs";

await main("structure: scripts/selfcheck.mjs", async () => {
  const selfcheck = join(APP_DIR, "scripts", "selfcheck.mjs");
  note(`spawn: node ${selfcheck}`);

  const result = spawnSync(process.execPath, [selfcheck], {
    cwd: APP_DIR,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  });

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");

  check(!result.error, "selfcheck 子进程能正常启动", result.error ? String(result.error.message) : "");
  note(`exit=${result.status}`);
  for (const line of stdout.trim().split("\n").slice(-6)) note(`selfcheck: ${line}`);
  if (stderr.trim()) for (const line of stderr.trim().split("\n").slice(-6)) note(`selfcheck[stderr]: ${line}`);

  eq(result.status, 0, "scripts/selfcheck.mjs 退出码为 0");
  contains(stdout, "[selfcheck]", "selfcheck 输出了总结行");
  check(/错误 0 ·/.test(stdout) || /errors 0/.test(stdout), "selfcheck 报告 0 个错误", `stdout tail: ${stdout.trim().slice(-200)}`);
});
