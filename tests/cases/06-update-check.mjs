// tests/cases/06-update-check.mjs
// 覆盖：版本与更新说明（数据层 + 新装配的端点）。
//   1) 数据层纯函数：版本比较、间隔校验、atom 解析、说明分组。
//   2) REPO_SLUG 与 release/config.json 的 release.repo 一致 —— 移植这一套时
//      唯一必须手改的就是仓库地址，改漏一处就会去查别的仓库有没有新版，
//      而且不会报错，只会一直说「已是最新」。这条断言把它钉住。
//   3) routes/git.js 装配的 GET/POST /settings/update-check 行为：
//      cached=1 只交手里那份、不出网；没给出网通道时不假装有网；
//      interval / toggle / ack 三个动作各走各的，非法间隔明确报错。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_DIR, makeTmpDir } from "../lib/fixture.mjs";
import { main, eq, check, contains, note } from "../lib/harness.mjs";
import { makeRoutesContext, makeStubApp, findRoute, fakeRequest } from "../lib/stub.mjs";

const importAppModule = (relPath) => import(pathToFileURL(join(APP_DIR, ...relPath)).href);

// 一段最小但形状完整的 atom：两条 Release，各带三级标题分组。
const ATOM = [
  "<feed>",
  "<entry><title>v3.2.1</title>",
  '<link href="https://github.com/H-i-m-s/git-save-load/releases/tag/v3.2.1"/>',
  "<updated>2026-10-13T00:00:00Z</updated>",
  '<content type="html">&lt;h3&gt;新增&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;关于卡片&lt;/li&gt;&lt;/ul&gt;</content>',
  "</entry>",
  "<entry><title>v3.2.0</title>",
  '<link href="https://github.com/H-i-m-s/git-save-load/releases/tag/v3.2.0"/>',
  "<updated>2026-10-10T00:00:00Z</updated>",
  '<content type="html">&lt;h3&gt;修复&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;某某&lt;/li&gt;&lt;/ul&gt;</content>',
  "</entry>",
  "</feed>",
].join("");

await main("update-check: 数据层与 /settings/update-check 端点", async () => {
  const uc = await importAppModule(["lib", "update-check.mjs"]);

  // ── 1) 纯函数 ─────────────────────────────────────────────────────────────
  eq(uc.compareVersions("3.2.0", "3.2.1"), -1, "3.2.0 低于 3.2.1");
  eq(uc.compareVersions("3.2.0", "3.2.0"), 0, "同版本相等");
  eq(uc.compareVersions("3.2.0", "3.2.0-beta.1"), 1, "正式版高于同号预发布版");
  eq(uc.compareVersions("abc", "3.2.0"), null, "认不出的版本号返回 null，不猜");
  eq(uc.normalizeIntervalMinutes(360), 360, "合法间隔原样通过");
  eq(uc.normalizeIntervalMinutes(0), null, "0 分钟越界，拒收");
  eq(uc.normalizeIntervalMinutes("3.5"), null, "非十进制整数拒收");

  const releases = uc.parseAtom(ATOM);
  eq(releases.length, 2, "atom 里两条 Release 都认出来了");
  eq(releases[0].tag, "v3.2.1", "按版本从新到旧排好");
  eq(releases[0].sections[0]?.heading, "新增", "三级标题被切成分组标题");
  eq(releases[0].sections[0]?.items[0], "关于卡片", "分组里的条目被还原成纯文本");

  // ── 2) 仓库地址：数据层与 release/config.json 必须同一个 ─────────────────
  const releaseConfig = JSON.parse(readFileSync(join(APP_DIR, "release", "config.json"), "utf8"));
  eq(uc.REPO_SLUG, releaseConfig.release?.repo, "REPO_SLUG 与 release/config.json 的 release.repo 一致");
  eq(uc.REPO_SLUG, "H-i-m-s/git-save-load", "REPO_SLUG 指向本仓库");
  contains(uc.ATOM_URL, uc.REPO_SLUG, "订阅源地址由 REPO_SLUG 拼出");
  contains(uc.RELEASES_URL, uc.REPO_SLUG, "Release 页地址由 REPO_SLUG 拼出");

  // ── 3) 端点行为 ───────────────────────────────────────────────────────────
  const dataDir = makeTmpDir("update-check");
  const app = makeStubApp();
  const { ctx } = makeRoutesContext({ dataDir });
  const gitRoutes = await importAppModule(["routes", "git.js"]);
  gitRoutes.default(app, ctx);

  const getRoute = findRoute(app, "GET", "/settings/update-check");
  const postRoute = findRoute(app, "POST", "/settings/update-check");
  check(!!getRoute, "已注册 GET /settings/update-check");
  check(!!postRoute, "已注册 POST /settings/update-check");
  if (!getRoute || !postRoute) return;
  // cached=1：只交手里那份，一次网络都不出。ctx 桩没有 network，正好证明它没去碰网络。
  const cached = await getRoute.handler(fakeRequest({ query: { cached: "1" } }));
  eq(cached?.ok, true, "cached 快照请求返回 ok");
  eq(cached?.update?.current, JSON.parse(readFileSync(join(APP_DIR, "manifest.json"), "utf8")).version,
    "当前版本取自包根 manifest.json（受限模式下也能读到）");
  eq(cached?.update?.releasesUrl, uc.RELEASES_URL, "快照里的 Release 页地址指向本仓库");
  eq(cached?.update?.intervalMinutes, uc.DEFAULT_INTERVAL_MINUTES, "还没改过时用默认检查间隔");
  eq(cached?.update?.enabled, true, "更新提示默认开着");

  // 没有出网通道时不假装有网：如实报「没有网络能力」，但手里那份照旧交出去。
  const forced = await getRoute.handler(fakeRequest({ query: { force: "1" } }));
  eq(forced?.ok, true, "没通道时请求本身不失败");
  eq(forced?.update?.error, "当前环境没有网络能力", "没通道时如实说明，不静默说「已是最新」");
  eq(forced?.update?.hasUpdate, false, "没有远端数据时不谎报有新版本");

  const intervalOk = await postRoute.handler(fakeRequest({ body: { action: "interval", minutes: 60 } }));
  eq(intervalOk?.update?.intervalMinutes, 60, "合法的检查间隔被写入");
  const intervalBad = await postRoute.handler(fakeRequest({ body: { action: "interval", minutes: 0 } }));
  eq(intervalBad?.ok, false, "非法检查间隔被拒收");

  const toggled = await postRoute.handler(fakeRequest({ body: { action: "toggle", enabled: false } }));
  eq(toggled?.update?.enabled, false, "更新提示开关被关掉");

  const acked = await postRoute.handler(fakeRequest({ body: { action: "ack", version: "v3.2.1" } }));
  eq(acked?.update?.ackVersion, "v3.2.1", "「我已知晓」记住的版本号被落盘");

  const unknown = await postRoute.handler(fakeRequest({ body: { action: "whatever" } }));
  eq(unknown?.ok, false, "不认识的 action 被拒收");
  note(`更新说明端点行为已覆盖（dataDir=${dataDir}）`);
});
