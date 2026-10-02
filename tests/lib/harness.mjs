// tests/lib/harness.mjs — 零依赖极简断言/用例骨架。
//
// 约定：每个用例文件顶层 `await main("<用例名>", async () => { ... })`。
// 断言失败不抛出，只记账并打印可定位到「用例名 :: 断言点」的行；
// 用例体抛出的未捕获异常也会被记成一条失败。main() 结束设置进程退出码
// （失败 1 / 成功 0），由 tests/run.mjs 依据退出码判定 PASS / FAIL。

let CASE = "(unnamed)";
let passed = 0;
let failed = 0;
const failures = [];

function render(value, max = 240) {
  if (typeof value === "string") {
    const s = value.length > max ? `${value.slice(0, max)}…(+${value.length - max} chars)` : value;
    return JSON.stringify(s);
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === undefined) return "undefined";
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > max ? `${json.slice(0, max)}…` : json;
  } catch {
    return String(value);
  }
}

export function beginCase(name) {
  CASE = String(name);
  console.log(`CASE ${CASE}`);
}

export function note(message) {
  console.log(`  · ${message}`);
}

export function check(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
    return true;
  }
  failed += 1;
  const line = `${CASE} :: ${label}${detail ? `  [${detail}]` : ""}`;
  failures.push(line);
  console.log(`  FAIL  ${label}${detail ? `  [${detail}]` : ""}`);
  return false;
}

export function eq(actual, expected, label) {
  return check(Object.is(actual, expected), label, `expected ${render(expected)}, got ${render(actual)}`);
}

export function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  return check(a === b, label, `expected ${render(expected)}, got ${render(actual)}`);
}

export function contains(text, needle, label) {
  const hay = String(text ?? "");
  return check(hay.includes(needle), label, `missing ${render(needle)} in ${render(hay, 400)}`);
}

export function excludes(text, needle, label) {
  const hay = String(text ?? "");
  return check(!hay.includes(needle), label, `unexpectedly found ${render(needle)} in ${render(hay, 400)}`);
}

export function matches(text, regex, label) {
  const hay = String(text ?? "");
  return check(regex.test(hay), label, `no match for ${regex} in ${render(hay, 400)}`);
}

export function atLeast(value, min, label) {
  return check(typeof value === "number" && value >= min, label, `expected >= ${min}, got ${render(value)}`);
}

/**
 * 跑一个用例。失败信息会同时汇总在末尾的 FAILURES 段。
 * 用法：await main("tools: behavior", async () => { ... });
 */
export async function main(name, body) {
  beginCase(name);
  const startedAt = Date.now();
  try {
    await body();
  } catch (error) {
    const where = error && error.stack ? String(error.stack).split("\n").slice(0, 4).join(" | ") : render(error);
    check(false, "用例体抛出未捕获异常", where);
  }
  const elapsed = Date.now() - startedAt;
  console.log(`RESULT ${CASE}: ${passed} ok, ${failed} failed (${elapsed}ms)`);
  if (failures.length) {
    console.log(`FAILURES (${failures.length}):`);
    for (const line of failures) console.log(`  - ${line}`);
  }
  console.log(failed > 0 ? "__CASE_FAIL__" : "__CASE_PASS__");
  process.exitCode = failed > 0 ? 1 : 0;
}
