// tests/cases/07-settings-first-paint.mjs
// 覆盖：设置页首屏不被网络拖住。
//
// 这一条是回归用例，对着一个真实踩过的坑：gh 账号校验（`gh auth status` 会拿手里的
// 令牌去 GitHub 真的验一次，最长 20s，网络快失败时还会再重试一次）曾与本地探针
// （git/gpg --version、签名元信息、设备码会话）捆在同一个 /settings/status 里。
// 结果是：一打开设置页，上面那几张纯本地的卡片（包括「关于」与更新说明）全都要等
// 这一次网络往返，观感就是「点开后很久才长出东西来」。
//
// 现在的契约分两趟：
//   GET /settings/local  → 只读本地，一次网都不出（首屏读它）
//   GET /settings/gh     → 才联网，只补「登没登上」那一行
// 本用例用一个没有 network 的 ctx 桩来证明前者真的没碰网络。

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { APP_DIR, makeTmpDir } from "../lib/fixture.mjs";
import { main, eq, check, note } from "../lib/harness.mjs";
import { makeRoutesContext, makeStubApp, findRoute, fakeRequest } from "../lib/stub.mjs";

const importAppModule = (relPath) => import(pathToFileURL(join(APP_DIR, ...relPath)).href);

await main("settings: 首屏本地那一趟不碰网络", async () => {
  const dataDir = makeTmpDir("first-paint");
  const app = makeStubApp();
  // 关键：这个 ctx 故意不给 network。若 local 那一趟中途想联网，
  // 它只能拿到 undefined 或抛错，下面的断言就会当场暴露。
  const { ctx } = makeRoutesContext({ dataDir });
  check(!("network" in ctx), "桩 ctx 上没有 network（本地那一趟无从联网）", JSON.stringify(Object.keys(ctx)));

  const gitRoutes = await importAppModule(["routes", "git.js"]);
  gitRoutes.default(app, ctx);

  const localRoute = findRoute(app, "GET", "/settings/local");
  const ghRoute = findRoute(app, "GET", "/settings/gh");
  check(!!localRoute, "已注册 GET /settings/local（首屏读它）");
  check(!!ghRoute, "已注册 GET /settings/gh（联网那一趟单独立口）");
  check(!findRoute(app, "GET", "/settings/status"), "旧的合并口 /settings/status 已不再注册");
  if (!localRoute) return;

  const started = Date.now();
  const res = await localRoute.handler(fakeRequest());
  const elapsed = Date.now() - started;

  eq(res?.ok, true, "本地状态请求返回 ok");
  check(typeof res?.gh?.installed === "boolean", "本地那一趟就交代了 gh 装没装");
  check(res?.gh && res.gh.loggedIn === undefined, "本地那一趟不下「登没登上」的结论（那是联网那趟的事）");
  check(!!res?.git, "本地那一趟带了 git 探针结果");
  check(!!res?.gpg, "本地那一趟带了 gpg 探针结果");
  check(!!res?.signing, "本地那一趟带了签名状态");
  check(!!res?.device, "本地那一趟带了设备码会话");
  // 本地探针是几次 --version 子进程，正常几十毫秒；这里给一个很宽的上限，
  // 只卡「它是不是在等网络」这种量级的差异（那是秒级以上）。
  note(`本地那一趟耗时 ${elapsed}ms`);
  check(elapsed < 8000, "本地那一趟不卡在网络量级上", `${elapsed}ms`);
});
