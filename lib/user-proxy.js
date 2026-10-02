// 用户作用域代理环境变量（HKCU\Environment 里的 HTTPS_PROXY / HTTP_PROXY）的读取与缓存。
//
// 为什么单独成一个模块：git 与 gh 都要用它，而且两条链路必须看到同一个值。
// 各写一份不只是重复读一次注册表，更容易长成"git 走代理、gh 直连"这种不对称
// （本机就踩过这个坑：git 有代理、gh 没有，于是 gh 的联网校验时好时坏，界面在
// "已登录"和"未登录"之间来回跳）。
//
// 为什么不用 process.env：用户级变量常常只写在注册表里、进程环境里没有。
// 本机实测 HTTPS_PROXY 在 HKCU\Environment 里，但 process.env 里没有，所以
// 只 spread process.env 的调用方永远拿不到它。
//
// 为什么不用 powershell.exe：即使带 -NoProfile，冷启一次也要约 1 s；而本函数会在
// 应用进程的第一次 git/gh 调用里同步执行，那一次请求会凭空慢 1 s 以上（受影响的
// 正是面板首屏渲染「变更文件」的 GET /api/status）。reg.exe 一次约 30 ms。
import { execFileSync } from "node:child_process";

const ENV_KEY = "HKCU\\Environment";
const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

// 缓存有 TTL：代理是用户随时会开关的东西，缓存到进程结束会让"改了环境变量"必须
// 重启应用才生效。30 s 够省（一次 reg.exe 约 30 ms），也够快（改完半分钟内自愈）。
const PROXY_CACHE_TTL_MS = 30000;

let _cachedUserProxy = null;
let _cachedUserProxyAt = 0;

/** 读一个 reg 键的全部值（失败给空串，调用方自己解析不出来的就当没读到）。 */
function regQuery(key) {
  try {
    return String(execFileSync("reg.exe", ["query", key], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch {
    return "";
  }
}

/** Windows「系统代理」里的绕过清单（WinINET 的 ProxyOverride，形如
 *  "localhost;127.*;192.168.*;10.*;<local>"）。没有就返回空串。 */
function systemProxyOverride() {
  for (const line of regQuery(INTERNET_SETTINGS_KEY).split(/\r?\n/)) {
    const m = line.match(/^\s*ProxyOverride\s+REG_(?:SZ|EXPAND_SZ)\s+(\S.*?)\s*$/i);
    if (m) return m[1].trim();
  }
  return "";
}

/** 把两串 NO_PROXY 合并去重（逗号分隔）。 */
function mergeNoProxy(a, b) {
  const seen = new Set();
  const out = [];
  for (const piece of String(a || "").split(/[,\s]+/).concat(String(b || "").split(","))) {
    const v = piece.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.join(",");
}

/**
 * 把 Windows 系统代理的绕过清单（ProxyOverride）翻成 NO_PROXY。
 *
 * 两边语法不是一对一，逐条映射：
 *   localhost / 1.2.3.4 / 域名      → 原样（NO_PROXY 认域名和 IP）
 *   10.* / 127.*                    → 10.0.0.0/8 / 127.0.0.0/8（两段通配 = /8）
 *   192.168.* / 172.16.*            → 192.168.0.0/16 / 172.16.0.0/16（三段通配 = /16）
 *   *.example.com                   → .example.com（Go 与 libcurl 都用前导点表示"子域"）
 *   <local> 与单独的 *              → 丢弃
 *
 * 为什么丢弃而不是硬套：NO_PROXY 没有"无点主机名"（<local>）这个概念；而单独的 * 在
 * WinINET 里的语义我不确定，万一写错成 NO_PROXY=*，等于把代理整个关掉，那是个可怕
 * 的惊喜。丢弃的代价只是"可能多转一次代理"（安全方向），写错方向的代价是静默失效。
 *
 * 127.* 额外补一条 127.0.0.1：libcurl 直到 7.86（2022-10）才认 NO_PROXY 里的 CIDR，
 * 老版只认具体主机，这一步是退路。
 */
export function proxyOverrideToNoProxy(raw) {
  const seen = new Set();
  const out = [];
  const push = (v) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  for (const item of String(raw || "").split(";")) {
    const v = item.trim();
    if (!v) continue;
    if (/^<local>$/i.test(v) || v === "*") continue;
    if (/^\*\./.test(v)) { push(v.slice(1)); continue; }        // *.a.com → .a.com
    const m = v.match(/^(\d{1,3}(?:\.\d{1,3}){0,2})\.\*$/);  // 10.* / 192.168.*
    if (m) {
      const octets = m[1].split(".").length;
      push(octets === 1 ? `${m[1]}.0.0.0/8` : octets === 2 ? `${m[1]}.0.0/16` : `${m[1]}.0/24`);
      if (m[1] === "127") push("127.0.0.1");
      continue;
    }
    push(v);
  }
  return out.join(",");
}

/** 返回 { HTTPS_PROXY?, HTTP_PROXY?, NO_PROXY? }；没配（或读不到）时返回空对象。 */
export function getUserProxy() {
  const now = Date.now();
  if (_cachedUserProxy && now - _cachedUserProxyAt < PROXY_CACHE_TTL_MS) return _cachedUserProxy;
  const next = {};
  const out = regQuery(ENV_KEY);
  for (const line of out.split(/\r?\n/)) {
    // 形如：  HTTPS_PROXY    REG_SZ    http://127.0.0.1:7890
    const m = line.match(/^\s*(HTTPS_PROXY|HTTP_PROXY|NO_PROXY)\s+REG_(?:SZ|EXPAND_SZ)\s+(\S.*?)\s*$/i);
    if (!m) continue;
    const value = m[2].trim();
    if (value) next[m[1].toUpperCase()] = value;
  }
  // 有代理时，再把系统代理那份"绕过清单"翻成 NO_PROXY 一并带上（否则本机/内网地址
  // 也会被送去代理，代理一停连本地远程都连不上）。没代理就什么都不带，不无端造变量。
  if (next.HTTPS_PROXY || next.HTTP_PROXY) {
    const derived = proxyOverrideToNoProxy(systemProxyOverride());
    if (derived) next.NO_PROXY = mergeNoProxy(next.NO_PROXY, derived);
  }
  _cachedUserProxy = next;
  _cachedUserProxyAt = now;
  return next;
}
