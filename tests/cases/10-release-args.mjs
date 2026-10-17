// 验 parseArgs 的实际行为。直接把 publish.mjs 里的函数抠出来跑，避免启动整个流程。
// 说明：publish.mjs 不是模块，没有导出；这里用括号配对截取函数体再 eval，
// 只为了验证「参数怎么拆」，不碰任何发布逻辑。
//
// 注意：parseArgs 末尾会校验 --mode 必须是 pack / release / publish，
// 所以每条用例都得带一个合法 mode，哪怕它跟这次断言无关。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { APP_DIR, makeTmpDir } from "../lib/fixture.mjs";

const SRC = readFileSync(join(APP_DIR, "release", "publish.mjs"), "utf8");

// 截 parseArgs 整个函数（到顶格配对的 } 为止）。
const start = SRC.indexOf("function parseArgs(");
if (start < 0) throw new Error("找不到 parseArgs");
let depth = 0;
let end = -1;
for (let i = SRC.indexOf("{", start); i < SRC.length; i += 1) {
  if (SRC[i] === "{") depth += 1;
  else if (SRC[i] === "}") {
    depth -= 1;
    if (depth === 0) { end = i + 1; break; }
  }
}
const fnSrc = SRC.slice(start, end);

const die = (msg) => { const e = new Error(msg); e.hinted = true; throw e; };
// parseArgs 的 --notes-file 分支会去读文件（resolve / existsSync / readFileSync），
// 这里连它们一起注入，不然截出来的函数体跑不起来。
// eslint-disable-next-line no-new-func
const parseArgs = new Function(
  "die", "resolve", "existsSync", "readFileSync",
  `${fnSrc}; return parseArgs;`,
)(die, resolve, existsSync, readFileSync);

/** 带上合法 mode 再跑，免得被末尾的 mode 校验挡住。 */
const P = (...argv) => parseArgs(["--mode=pack", ...argv]);

let pass = 0;
let fail = 0;
function check(cond, label, detail) {
  if (cond) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? "  [" + detail + "]" : ""}`); }
}
function eq(actual, expected, label) {
  check(Object.is(actual, expected), label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

console.log("CASE release: 参数解析");

// 1) 单行，两种写法都要通
eq(P("--notes=- 单行").notes, "- 单行", "等号写法单行");
eq(P("--notes", "- 单行").notes, "- 单行", "空格写法单行");

// 2) 多行 —— 这就是当初崩掉的那条
const multi = "## 修复\n\n- 第一条\n- 第二条";
eq(P(`--notes=${multi}`).notes, multi, "等号写法多行（原先在这里报「不认识的参数」）");
eq(P("--notes", multi).notes, multi, "空格写法多行");

// 3) 多组小标题 + 空行，原样保留
const md = "## 修复\n\n- a\n\n## 新增\n\n- b";
eq(P(`--notes=${md}`).notes, md, "多组小标题与空行都保留");

// 4) 值里有等号、有空格
eq(P("--notes=a=b").notes, "a=b", "值里的等号不被吃掉");
eq(P("--notes=a b c").notes, "a b c", "值里的空格保留");

// 5) 末尾空白被 trim（跟 --notes-file 那条 readFileSync(...).trim() 对齐）
eq(P("--notes=abc\n").notes, "abc", "末尾换行被 trim");
eq(P("--notes=abc  ").notes, "abc", "末尾空格被 trim");
eq(P("--notes=  abc").notes, "abc", "开头空白被 trim");

// 6) 空值
eq(P("--notes=").notes, "", "空值是空串，不是 undefined");

// 7) 不带等号的开关原样通过
const flags = parseArgs(["--mode=release", "--dry-run", "--verify", "--skip-version-write"]);
eq(flags.dryRun, true, "--dry-run 认得出");
eq(flags.verify, true, "--verify 认得出");
eq(flags.skipVersionWrite, true, "--skip-version-write 认得出");
eq(flags.mode, "release", "--mode 认得出");

// 8) 其余参数照旧（--notes-file 要求文件真实存在，这里先落一个真文件）
const tmpNotes = join(makeTmpDir("args"), "n.md");
writeFileSync(tmpNotes, "## 修复\n\n- x\n", "utf8");
const all = parseArgs(["--mode=publish", "--version=3.4.5", `--notes-file=${tmpNotes}`, "--dry-run"]);
eq(all.mode, "publish", "--mode=publish");
eq(all.version, "3.4.5", "--version 带等号");
eq(all.notes, "## 修复\n\n- x", "--notes-file 读得到且内容已 trim");
eq(all.notesFile, tmpNotes, "--notes-file 带等号");

// 9) 未知参数仍然要拦
let threw = null;
try { P("--nope=1"); } catch (e) { threw = e; }
check(!!threw && /不认识的参数/.test(threw.message), "未知参数照样报错", threw ? threw.message : "没有报错");

// 10) 参数名为空（"--=x"）不拆成空名，走未知参数分支被拦住
let threw2 = null;
try { P("--=x"); } catch (e) { threw2 = e; }
check(!!threw2 && /不认识的参数/.test(threw2.message), "参数名为空时不拆，照样被拦", threw2 ? threw2.message : "没有报错");

// 11) 非法 mode 仍然要拦
let threw3 = null;
try { parseArgs(["--mode=nope"]); } catch (e) { threw3 = e; }
check(!!threw3 && /--mode 必须是/.test(threw3.message), "非法 mode 照样报错", threw3 ? threw3.message : "没有报错");

console.log(`RESULT release 参数解析: ${pass} ok, ${fail} failed`);
console.log(fail > 0 ? "__CASE_FAIL__" : "__CASE_PASS__");
process.exitCode = fail > 0 ? 1 : 0;
