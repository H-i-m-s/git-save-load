// git-save-load / lib / snapshot-retention.js
//
// show_diff 每次调用都会往 dataDir 写两份快照：
//   show-diff.json                    最新一份，无 id，卡片兜底读它
//   show-diff.<cardInstanceId>.json   按卡实例一份，卡片按自己的 id 认领
//
// 按卡实例那一份是「只写不读回」的副产物：卡片关掉之后文件就没有意义了，
// 但从来没人删，于是无限堆积（改名前的 show-files.* 前缀已经堆了一百多份）。
// 这个文件只负责回收，不参与渲染，不改动任何快照的内容格式。
//
// 三条硬约束：
//   1) 全同步。show_diff 的 execute 里是同步写盘，这里引入异步会把写快照和清理
//      拆成两段，卡片可能读到清理中途的目录状态。
//   2) 全吞错。清理失败最多让磁盘脏一点，绝不能让写快照、让工具返回、让 App 启动失败。
//   3) 常态零成本。日常调用只做一次 readdir；stat 只在超出上限时才发生。

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// 按卡实例的快照最多留这么多份。
// 一次 show_diff 出一张卡，一个活跃用户一天几十张算高频；300 份大约覆盖几个月，
// 再往前的卡基本不会有人再打开，留着只是占目录项。
const MAX_KEPT = 300;

// 超过 30 天的直接删，不管数量多少。
// 30 天是「用户还可能回头看这个变更」的粗估上限，超过它的快照价值低于它的维护成本。
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// 最新快照的名字。它是卡片的兜底数据源，任何情况下都不删。
const LATEST_NAME = "show-diff.json";

// 按卡实例的快照。
// 注意：不能用 `name.startsWith("show-diff.")` 判断——"show-diff.json" 也满足它。
const INSTANCE_RE = /^show-diff\..+\.json$/;

// 改名前的旧前缀。这批文件路由侧已经不再读，是纯垃圾。
const LEGACY_LATEST = "show-files.json";
const LEGACY_INSTANCE_RE = /^show-files\..+\.json$/;

/**
 * 列出该删的按卡实例快照文件名。
 * 排除：点开头的文件（.empty-baseline 这类内部标记）、最新快照本身、不匹配 INSTANCE_RE 的。
 * 目录不存在或读不了时返回空数组。
 */
function listInstances(dataDir) {
  let names;
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (name === LATEST_NAME) continue;
    if (!INSTANCE_RE.test(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * 按数量回收：只留最新 MAX_KEPT 份按卡实例快照。
 * 每次写完快照后调用。
 *
 * @param {string} dataDir
 * @param {{ maxKept?: number }} [opts] maxKept 仅供测试覆盖上限
 * @returns {{ removed: number, kept: number, failed: number }}
 */
export function pruneSnapshots(dataDir, opts = {}) {
  const result = { removed: 0, kept: 0, failed: 0 };
  try {
    if (!dataDir) return result;
    const maxKept = Number.isFinite(opts.maxKept) ? Math.max(0, Math.floor(opts.maxKept)) : MAX_KEPT;

    const names = listInstances(dataDir);
    result.kept = names.length;
    if (!names.length) return result;
    // 常态路径：没超上限，一次 readdir 结束，不做任何 stat。
    if (names.length <= maxKept) return result;

    const entries = [];
    for (const name of names) {
      try {
        entries.push({ name, mtimeMs: statSync(join(dataDir, name)).mtimeMs });
      } catch {
        result.failed += 1;
      }
    }
    // mtime 降序：新的在前。
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // 下标 maxKept 起都是该删的。用 slice 而不是循环判断，顺序更明确。
    for (const entry of entries.slice(maxKept)) {
      try {
        unlinkSync(join(dataDir, entry.name));
        result.removed += 1;
      } catch {
        result.failed += 1;
      }
    }
    result.kept = names.length - result.removed;
    return result;
  } catch {
    return result;
  }
}

/**
 * 按年龄回收：mtime 早于 MAX_AGE_MS 的按卡实例快照删掉。
 * 只在 App 启动时调用一次（启动时的几十次 stat 摊得开，不该塞进每次写快照的路径）。
 *
 * @param {string} dataDir
 * @param {{ maxAgeMs?: number }} [opts] maxAgeMs 仅供测试覆盖阈值
 * @returns {{ removed: number, failed: number }}
 */
export function pruneByAge(dataDir, opts = {}) {
  const result = { removed: 0, failed: 0 };
  try {
    if (!dataDir) return result;
    const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? Math.max(0, opts.maxAgeMs) : MAX_AGE_MS;

    const now = Date.now();
    for (const name of listInstances(dataDir)) {
      let mtimeMs;
      try {
        mtimeMs = statSync(join(dataDir, name)).mtimeMs;
      } catch {
        result.failed += 1;
        continue;
      }
      if (now - mtimeMs <= maxAgeMs) continue;
      try {
        unlinkSync(join(dataDir, name));
        result.removed += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  } catch {
    return result;
  }
}

/**
 * 清掉改名前的旧前缀垃圾（show-files.json / show-files.<id>.json）。
 * 路由侧自改名后只读 show-diff.*，这批文件永远不会再被读。
 *
 * @param {string} dataDir
 * @returns {{ removed: number, failed: number }}
 */
export function pruneLegacy(dataDir) {
  const result = { removed: 0, failed: 0 };
  try {
    if (!dataDir) return result;
    let names;
    try {
      names = readdirSync(dataDir);
    } catch {
      return result;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      // show-files.json 不带 id，INSTANCE_RE 匹配不到，必须单独列出来。
      if (name !== LEGACY_LATEST && !LEGACY_INSTANCE_RE.test(name)) continue;
      try {
        unlinkSync(join(dataDir, name));
        result.removed += 1;
      } catch {
        result.failed += 1;
      }
    }
    return result;
  } catch {
    return result;
  }
}
