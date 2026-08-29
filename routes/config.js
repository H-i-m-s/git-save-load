import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function configPath(ctx) {
  return ctx?.dataDir ? join(ctx.dataDir, "config.json") : "";
}

async function readLegacyConfig(ctx) {
  const file = configPath(ctx);
  if (!file) return {};
  try {
    const data = await readFile(file, "utf8");
    return JSON.parse(data) || {};
  } catch {
    return {};
  }
}

const CONFIG_KEYS = new Set(["repoPath", "stashMode", "pushMode", "pullMode", "defaultDiffMode", "theme", "paperTexture", "remoteSettings"]);
const CONFIG_ENUMS = {
  stashMode: new Set(["normal", "untracked", "all"]),
  pushMode: new Set(["normal", "force-with-lease", "force"]),
  pullMode: new Set(["merge", "rebase", "ff-only"]),
  defaultDiffMode: new Set(["detail", "simple"]),
  theme: new Set(["auto", "light", "dark", "warm-paper", "new-warm-paper", "midnight", "midnight-contrast", "high-contrast", "grass-aroma", "contemplation", "absolutely", "delve", "deep-think", "coral"]),
  paperTexture: new Set(["on", "off"]),
};

export function validateConfigPatch(patch = {}) {
  const result = {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, message: "配置格式不正确" };
  for (const [key, value] of Object.entries(patch)) {
    if (!CONFIG_KEYS.has(key)) continue;
    if (CONFIG_ENUMS[key] && (!CONFIG_ENUMS[key].has(value))) return { ok: false, message: `${key} 的值不正确` };
    if (key === "repoPath" && typeof value !== "string") return { ok: false, message: "仓库路径必须是字符串" };
    if (key === "remoteSettings" && (!value || typeof value !== "object" || Array.isArray(value))) return { ok: false, message: "远程设置格式不正确" };
    result[key] = value;
  }
  return { ok: true, value: result };
}

export async function readConfig(ctx) {
  const configApi = ctx?.config;
  let values = {};
  try { values = await configApi?.getAll?.() || {}; } catch {}
  const legacy = await readLegacyConfig(ctx);
  const merged = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (CONFIG_KEYS.has(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(values || {})) {
    if (CONFIG_KEYS.has(key) && value !== undefined && value !== null) merged[key] = value;
  }
  const needsMigration = Object.keys(legacy).some((key) => CONFIG_KEYS.has(key) && values?.[key] === undefined);
  if (needsMigration && configApi?.set) {
    for (const [key, value] of Object.entries(merged)) {
      try { await configApi.set(key, value); } catch {}
    }
  }
  return merged;
}

export async function writeConfig(ctx, config) {
  const checked = validateConfigPatch(config);
  if (!checked.ok) throw new Error(checked.message);
  const next = checked.value;
  if (ctx?.config?.set) {
    const failures = [];
    for (const [key, value] of Object.entries(next)) {
      if (!CONFIG_KEYS.has(key)) continue;
      try { await ctx.config.set(key, value); } catch { failures.push(key); }
    }
    if (!failures.length) return;
  }
  const file = configPath(ctx);
  if (!file) return;
  mkdirSync(join(file, ".."), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2), "utf8");
}

export async function readRepoPath(ctx) {
  const config = await readConfig(ctx);
  return String(config.repoPath || "").trim();
}

export async function writeRepoPath(ctx, path) {
  const current = await readConfig(ctx);
  await writeConfig(ctx, { ...current, repoPath: path });
}
