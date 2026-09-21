// git-save-load v2 App 入口。
// 路由沿用 routes/ 目录形式（与 v1 的 export default (app, ctx) 工厂形状一致），
// 本文件只负责：日志、四个 Agent 工具的注册。
// 工具执行时收到的 v2 执行上下文没有 config，这里包一层 { config: { get } } 适配
// tools/_helpers.js 的 resolvePath，保持四个工具模块本身零改动。

import { defineApp } from "./sdk/app-contract/server-client.js";
import * as toolStatus from "./tools/git_status.js";
import * as toolCommit from "./tools/git_commit.js";
import * as toolLog from "./tools/git_log.js";
import * as toolReset from "./tools/git_reset.js";

export const name = "git-save-load";

const TOOL_MODULES = [toolStatus, toolCommit, toolLog, toolReset];

export default defineApp(async (sdk) => {
  await sdk.logger.info("git-save-load v2 loaded");

  const readConfig = async () => {
    try {
      return (await sdk.config.getAll()) || {};
    } catch {
      return {};
    }
  };

  for (const mod of TOOL_MODULES) {
    await sdk.tools.register({
      name: mod.name,
      description: mod.description,
      parameters: mod.parameters,
      sessionPermission: mod.sessionPermission,
      execute: async (input, execCtx) => {
        const config = await readConfig();
        const raw = await mod.execute(input, {
          ...(execCtx || {}),
          config: { get: async (key) => config[key] },
        });
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        return { content: [{ type: "text", text }] };
      },
    });
  }
});
