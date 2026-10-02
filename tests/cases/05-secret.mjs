// tests/cases/05-secret.mjs
// 覆盖：令牌存取（lib/secret.js）。
//   · saveSecret → loadSecretIntoContext 往返一致（进程缓存里拿到的是原明文）
//   · <dataDir>/credential.json 的内容里不含明文令牌（只存密文）
//   · 手工把记录里的 alg 改成别的值 → loadSecretIntoContext 返回 readable=false 且带 error

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_DIR, makeTmpDir } from "../lib/fixture.mjs";
import { main, check, eq, contains, matches, excludes, note } from "../lib/harness.mjs";

const TOKEN = "ghp_GSLtests0123456789abcdefXYZ";

await main("secret: 令牌加密存取与解密失败语义", async () => {
  const secret = await import(pathToFileURL(join(APP_DIR, "lib", "secret.js")).href);
  const dataDir = makeTmpDir("secret");
  const recordPath = join(dataDir, "credential.json");

  // ── 往返 ────────────────────────────────────────────────────────────────
  const saved = await secret.saveSecret({ dataDir, token: TOKEN });
  note(`saveSecret → ${JSON.stringify(saved)}`);
  check(typeof saved?.protection === "string" && saved.protection.length > 0, "saveSecret 返回非空的 protection 标识");
  check(typeof saved?.backend === "string" && saved.backend.length > 0, "saveSecret 返回非空的 backend 标识");

  eq(existsSync(recordPath), true, "记录写在 <dataDir>/credential.json");
  contains(secret.getCachedToken(), TOKEN, "保存后进程缓存里是可用的明文令牌");

  const loaded = await secret.loadSecretIntoContext(dataDir);
  note(`loadSecretIntoContext → ${JSON.stringify(loaded)}`);
  eq(loaded.readable, true, "loadSecretIntoContext 能解开密文（readable=true）");
  eq(loaded.configured, true, "loadSecretIntoContext 报告已配置");
  eq(secret.getCachedToken(), TOKEN, "往返一致：解出的明文与保存时完全相同");

  // ── 落盘内容不含明文 ────────────────────────────────────────────────────
  const rawRecord = readFileSync(recordPath, "utf8");
  note(`record: ${rawRecord}`);
  excludes(rawRecord, TOKEN, "credential.json 不含明文令牌");
  let parsed = null;
  try { parsed = JSON.parse(rawRecord); } catch { /* 下面的断言会暴露 */ }
  check(parsed && typeof parsed.cipher === "string" && parsed.cipher.length > 0, "记录里存在非空 cipher 密文字段");
  check(parsed && typeof parsed.alg === "string" && parsed.alg.length > 0, "记录里存在非空 alg 字段");
  eq(parsed?.storage, "file", "记录声明的存放形态是 file");

  // ── alg 被改动 → 明确解不开 ─────────────────────────────────────────────
  const tampered = { ...parsed, alg: "some-other-platform-alg" };
  writeFileSync(recordPath, JSON.stringify(tampered), "utf8");

  const broken = await secret.loadSecretIntoContext(dataDir);
  note(`after tamper → ${JSON.stringify(broken)}`);
  eq(broken.readable, false, "alg 被改动后 readable=false");
  eq(broken.configured, false, "alg 被改动后 configured=false");
  check(typeof broken.error === "string" && broken.error.length > 0, "alg 不匹配时带可读 error");
  contains(broken.error, "some-other-platform-alg", "error 里指出了无法解开的密文 alg");
  matches(broken.error, /解不开/, "error 说明是解不开而不是未配置");
  eq(secret.getCachedToken(), "", "解不开时清空进程缓存（不残留旧明文）");

  // 摘要接口同样反映「配置不可读」
  const info = secret.secretInfo(dataDir);
  note(`secretInfo → ${JSON.stringify(info)}`);
  eq(info.readable, false, "secretInfo 对 alg 不匹配的记录报告 readable=false");
  eq(info.configured, false, "secretInfo 报告 configured=false");
});
