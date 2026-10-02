// git-save-load v2 App 入口。
// 路由沿用 routes/ 目录形式（与 v1 的 export default (app, ctx) 工厂形状一致），
// 本文件只负责：日志、四个 Agent 工具的注册。
// 工具执行时收到的 v2 执行上下文没有 config，这里包一层 { config: { get } } 适配
// tools/_helpers.js 的 resolvePath，保持四个工具模块本身零改动。

import { defineApp } from "./sdk/app-contract/server-client.js";
import { secretBootstrap } from "./lib/secret.js";
import * as toolStatus from "./tools/git_status.js";
import * as toolCommit from "./tools/git_commit.js";
import * as toolLog from "./tools/git_log.js";
import * as toolReset from "./tools/git_reset.js";
import * as toolGitExec from "./tools/git_exec.js";
import * as toolGhExec from "./tools/gh_exec.js";
import * as toolGitPush from "./tools/git_push.js";
import * as toolGhPr from "./tools/gh_pr.js";

export const name = "git-save-load";

// 工具注册顺序即模型看到的顺序。前四个是语义化动作，后四个是透传/协作能力。
const TOOL_MODULES = [
  toolStatus,
  toolCommit,
  toolLog,
  toolReset,
  toolGitExec,
  toolGhExec,
  toolGitPush,
  toolGhPr,
];

export default defineApp(async (sdk) => {
  await sdk.logger.info("git-save-load v2 loaded");

  // 数据目录：路由侧（ctx.dataDir）与工具侧共用同一份。工具 execute 的上下文里
  // 宿主不带 dataDir，这里显式透传——提交签名（GNUPGHOME）、密钥环定位都依赖它。
  const dataDir = typeof sdk.dataDir === "string" ? sdk.dataDir : "";

  // 启动即把加密存放的 GitHub 令牌解进进程缓存（ghEnvironment() 同步读它）。
  // 不阻塞加载：解不开只是 gh 不走 App 自持令牌，仍复用用户自己的 gh 登录态。
  if (dataDir) {
    secretBootstrap(dataDir)
      .then((info) => {
        if (info && info.error) return sdk.logger.info(`git-save-load: GitHub 令牌未载入（${info.error}）`);
        return undefined;
      })
      .catch(() => {});
  }

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
          dataDir,
          config: { get: async (key) => config[key] },
        });
        const text = typeof raw === "string" ? raw : JSON.stringify(raw);
        return { content: [{ type: "text", text }] };
      },
    });
  }

  // 注册结果落日志：宿主日志里能看到实际暴露给模型的工具清单，
  // 便于在 reload 后核对（工具目录是会话级快照，不随 reload 刷新）。
  await sdk.logger.info(
    `git-save-load: 已注册 ${TOOL_MODULES.length} 个工具（${TOOL_MODULES.map((m) => m.name).join(", ")}）`,
  );
});
