// tests/cases/03-config-whitelist.mjs
// 覆盖：配置白名单回归（POST /api/config 处理器行为）。
//   1) 第一次传白名单内的三个键 → 断言 ctx.config.set 分别收到
//      ghOpenMode="external"、repoPath、defaultDiffMode，且只写这三个键。
//   2) 第二次只传一个白名单外的键（在空配置上）→ 断言没有任何键被写入，
//      且该键自始至终没进过 config.set。
//
// 关于「没有任何键被写入」：writeConfig 会把 readConfig() 的当前值 + patch 合并后整份回写，
// 所以第二次调用前把桩 store 清空，使其等价于「一个只带白名单外键的请求」，
// 这样断言就能精确到字面意义：写入次数为 0。
//
// 注意：routes/config.js 的 CONFIG_KEYS 由集成方并行维护，本用例只做行为断言，不改 routes/。

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_DIR, makeTmpDir } from "../lib/fixture.mjs";
import { main, eq, check, deepEq, note } from "../lib/harness.mjs";
import { makeRoutesContext, makeStubApp, findRoute, fakeRequest } from "../lib/stub.mjs";

const OUT_OF_WHITELIST_KEY = "definitelyNotAWhitelistedKey";

await main("config: POST /api/config 白名单回归", async () => {
  const dataDir = makeTmpDir("datadir");
  const app = makeStubApp();
  const { ctx, store, setCalls } = makeRoutesContext({ dataDir });

  const gitRoutes = await import(pathToFileURL(join(APP_DIR, "routes", "git.js")).href);
  gitRoutes.default(app, ctx);

  const route = findRoute(app, "POST", "/api/config");
  check(!!route, "已注册 POST /api/config");
  if (!route) return;

  // 记录所有写入：用于「白名单外的键从未被写入」这一全局断言。
  const allCalls = [];
  const originalSet = ctx.config.set;
  ctx.config.set = async (key, value) => {
    allCalls.push([key, value]);
    return originalSet(key, value);
  };

  // ── 第一次：白名单内的三个键 ────────────────────────────────────────────
  const firstBody = { repoPath: "C:/tmp/x", ghOpenMode: "external", defaultDiffMode: "simple" };
  const firstResponse = await route.handler(fakeRequest({ body: firstBody }));
  note(`第一次响应：${JSON.stringify(firstResponse)}`);
  note(`第一次写入：${JSON.stringify(setCalls)}`);

  eq(firstResponse?.ok, true, "第一次请求返回 ok=true");

  const firstWrites = Object.fromEntries(setCalls);
  eq(firstWrites.ghOpenMode, "external", "ctx.config.set 收到 ghOpenMode = external");
  eq(firstWrites.repoPath, "C:/tmp/x", "ctx.config.set 收到 repoPath");
  eq(firstWrites.defaultDiffMode, "simple", "ctx.config.set 收到 defaultDiffMode");
  deepEq(
    Object.keys(firstWrites).sort(),
    ["defaultDiffMode", "ghOpenMode", "repoPath"],
    "第一次只写入这三个白名单键，没有多余键",
  );

  // ── 第二次：只传一个白名单外的键（先清空桩 store，使回写量为 0 可精确断言） ──
  for (const key of Object.keys(store)) delete store[key];
  setCalls.length = 0;

  const secondResponse = await route.handler(fakeRequest({ body: { [OUT_OF_WHITELIST_KEY]: "whatever" } }));
  note(`第二次响应：${JSON.stringify(secondResponse)}`);
  note(`第二次写入：${JSON.stringify(setCalls)}`);

  eq(setCalls.length, 0, "只传白名单外的键时，没有任何键被写入 config.set");
  eq(store[OUT_OF_WHITELIST_KEY], undefined, "白名单外的键没有落进配置");
  check(
    !allCalls.some(([key]) => key === OUT_OF_WHITELIST_KEY),
    "白名单外的键自始至终没有被写入过",
  );
});
