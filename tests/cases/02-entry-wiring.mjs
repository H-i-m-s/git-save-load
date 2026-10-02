// tests/cases/02-entry-wiring.mjs
// 覆盖：入口装配。
//   a) 以桩上下文调用 index.js 的 default.apply，断言注册 8 个工具且名字集合完全一致，
//      并断言每个工具注册项都带 description / parameters / sessionPermission / execute。
//      桩的 tools.register 必须返回 { ready: Promise } 回执，否则 SDK 抛 APP_SDK_HOST_UNSUPPORTED
//      （apply 不抛错本身就是这条契约的证据）。
//   b) 以桩 app 调用 routes/git.js 的 default，断言 PR 端点与令牌端点都已注册。

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_DIR, makeTmpDir } from "../lib/fixture.mjs";
import { main, eq, check, deepEq, note } from "../lib/harness.mjs";
import { makeEntryContext, makeRoutesContext, makeStubApp, findRoute } from "../lib/stub.mjs";

const EXPECTED_TOOLS = [
  "git_status",
  "git_commit",
  "git_log",
  "git_reset",
  "git_exec",
  "gh_exec",
  "git_push",
  "gh_pr",
];

const EXPECTED_ROUTES = [
  ["GET", "/api/gh/pr-list"],
  ["GET", "/api/gh/pr-view"],
  ["POST", "/api/gh/pr-create"],
  ["POST", "/api/gh/pr-merge"],
  ["GET", "/settings/token"],
  ["POST", "/settings/token"],
  ["POST", "/settings/token/clear"],
  ["POST", "/api/config"],
];

const importAppModule = (relPath) => import(pathToFileURL(join(APP_DIR, ...relPath)).href);

await main("entry: index.js 工具注册 + routes/git.js 端点装配", async () => {
  const dataDir = makeTmpDir("datadir");

  // ── a) 入口工具注册 ─────────────────────────────────────────────────────
  const { sdkContext, registered } = makeEntryContext({ dataDir });
  const indexModule = await importAppModule(["index.js"]);
  check(typeof indexModule.default?.apply === "function", "index.js default 暴露 apply(context)");

  let applyError = null;
  try {
    await indexModule.default.apply(sdkContext);
  } catch (error) {
    applyError = error;
  }
  check(!applyError, "以桩上下文 apply 成功（tools.register 回执契约被接受）", applyError ? String(applyError.message) : "");
  note(`注册工具数：${registered.length}`);

  const names = registered.map((definition) => definition?.name);
  eq(registered.length, 8, "恰好注册 8 个工具");
  deepEq([...names].sort(), [...EXPECTED_TOOLS].sort(), "注册的工具名字集合与清单完全一致");
  check(
    registered.every((definition) => typeof definition.execute === "function"),
    "每个注册项都带可执行的 execute",
  );
  check(
    registered.every((definition) => definition.parameters && typeof definition.parameters === "object"),
    "每个注册项都带 parameters JSON Schema",
  );
  check(
    registered.every((definition) => typeof definition.description === "string" && definition.description.length > 0),
    "每个注册项都带非空 description",
  );
  check(
    registered.every((definition) => definition.sessionPermission !== undefined),
    "每个注册项都带 sessionPermission",
  );

  // ── b) 路由装配 ─────────────────────────────────────────────────────────
  const app = makeStubApp();
  const { ctx } = makeRoutesContext({ dataDir });
  const gitRoutes = await importAppModule(["routes", "git.js"]);
  check(typeof gitRoutes.default === "function", "routes/git.js default 是 (app, ctx) 工厂");

  gitRoutes.default(app, ctx);
  note(`注册路由数：${app.table.length}`);
  check(app.table.length > 0, "routes/git.js 至少注册了一条路由");

  for (const [method, path] of EXPECTED_ROUTES) {
    const route = findRoute(app, method, path);
    check(!!route, `已注册 ${method} ${path}`);
    if (route) check(typeof route.handler === "function", `${method} ${path} 处理器是函数`);
  }
});
