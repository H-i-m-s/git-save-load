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
  const next = config && typeof config === "object" ? config : {};
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
