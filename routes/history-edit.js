// History-rewrite routes: amend, tag edit, squash, reword.
// All four rewrite repository history, so they share one per-repo lock and
// the tag / rebase-identity helpers below.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 历史重写是仓库级别的危险操作。同一 HanaAgent 进程内，同一仓库只能同时执行一个 reword/squash。
const rewordLocks = new Set();

function rewordLockKey(cwd) {
  return resolve(cwd).replace(/[\\/]+$/, "").toLowerCase();
}

function tryAcquireRewordLock(cwd) {
  const key = rewordLockKey(cwd);
  if (rewordLocks.has(key)) return null;
  rewordLocks.add(key);
  return () => rewordLocks.delete(key);
}

function getRebaseIdentity(cwd, gitExecFile) {
  for (const kind of ["rebase-merge", "rebase-apply"]) {
    try {
      const dir = resolve(cwd, gitExecFile(cwd, ["rev-parse", "--git-path", kind], { timeout: 10000 }));
      if (!existsSync(dir)) continue;
      let headName = "";
      let originalHead = "";
      try { headName = readFileSync(join(dir, "head-name"), "utf8").trim(); } catch {}
      try { originalHead = readFileSync(join(dir, "orig-head"), "utf8").trim(); } catch {}
      return { kind, dir, headName, originalHead };
    } catch {}
  }
  return null;
}

function normalizeVersionTag(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const version = raw.replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(version) ? `v${version}` : null;
}

function getTagCommit(cwd, tag, gitExecFile) {
  if (!tag) return "";
  return gitExecFile(cwd, ["rev-parse", `${tag}^{commit}`], { timeout: 10000 });
}

function inspectTagConflict(cwd, tag, targetCommit, gitExecFile, allowedExisting = "") {
  if (!tag) return null;
  let existing = "";
  try { existing = getTagCommit(cwd, tag, gitExecFile); } catch {}
  if (!existing || tag === allowedExisting) return null;
  let onCurrentBranch = false;
  try { gitExecFile(cwd, ["merge-base", "--is-ancestor", existing, "HEAD"], { timeout: 10000 }); onCurrentBranch = true; } catch {}
  return {
    tag,
    existingCommit: existing,
    targetCommit,
    oldHistory: !onCurrentBranch,
    message: onCurrentBranch
      ? `版本号 ${tag.replace(/^v/, "")} 已经存在，请换一个版本号`
      : `版本号 ${tag.replace(/^v/, "")} 已存在于旧历史，是否移动到当前提交？`,
  };
}

function moveLightweightTag(cwd, fromTag, toTag, commit, gitExecFile) {
  // 先写入新 tag，再删除旧 tag，避免删除成功而写入新 tag 失败时造成版本号丢失。
  if (toTag) {
    gitExecFile(cwd, ["update-ref", `refs/tags/${toTag}`, commit], { timeout: 10000 });
  }
  if (fromTag && fromTag !== toTag) {
    gitExecFile(cwd, ["update-ref", "-d", `refs/tags/${fromTag}`], { timeout: 10000 });
  }
}

export function registerHistoryEditRoutes(app, { repoPath, gitExecFile, gitExecFileWithEnv, commandErrorText, getGitOperationState }) {
  // ======== API: 修改最近一次提交的消息（git commit --amend） ========
  app.post("/api/commit-amend", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const message = String(body.message || "").trim();
    const expectedHash = String(body.expectedHash || "").trim();

    if (!message) return c.json({ ok: false, message: "提交消息不能为空" });

    // 身份检查（与 commit 路由一致）
    try {
      const localName = gitExecFile(path, ["config", "user.name"]);
      const localEmail = gitExecFile(path, ["config", "user.email"]);
      if (!localName || !localEmail) {
        return c.json({
          ok: false,
          code: "NO_IDENTITY",
          message: "Git 还未设置你的姓名和邮箱",
          needIdentity: true,
        });
      }
    } catch (e) {
      return c.json({
        ok: false,
        code: "NO_IDENTITY",
        message: "Git 还未设置你的姓名和邮箱",
        needIdentity: true,
      });
    }

    // hash 校验：用户点的必须是当前 HEAD
    if (!expectedHash) {
      return c.json({ ok: false, message: "内部错误：缺少预期 hash" });
    }
    let currentHash = "";
    try {
      currentHash = gitExecFile(path, ["rev-parse", "HEAD"]);
    } catch (e) {
      return c.json({ ok: false, message: "读取 HEAD 失败：" + e.message });
    }
    if (currentHash.slice(0, expectedHash.length) !== expectedHash) {
      return c.json({
        ok: false,
        code: "NOT_HEAD",
        message: "只能修改最近一条提交。这条提交已经不是最新了，如需修改请在终端使用 git rebase -i （高级操作）。",
      });
    }

    // 检查工作区是否干净（--amend 不能有未提交修改，否则会混入）
    try {
      const status = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--porcelain"]);
      if (status) {
        return c.json({
          ok: false,
          code: "DIRTY",
          message: "当前有未提交的修改，请先存档或丢弃这些修改，再修改提交说明。",
        });
      }
    } catch (e) {}

    let msgFile = null;
    try {
      msgFile = join(tmpdir(), "git-sl-amend-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".txt");
      writeFileSync(msgFile, message, "utf8");
      gitExecFile(path, ["commit", "--amend", "-F", msgFile]);
      const last = gitExecFile(path, ["log", "--oneline", "-n", "1"]);
      return c.json({ ok: true, message: "已修改最近一次提交说明", commit: last });
    } catch (e) {
      return c.json({ ok: false, message: `修改失败：${e.message}` });
    } finally {
      if (msgFile) { try { unlinkSync(msgFile); } catch {} }
    }
  });

  // ======== API: 修改提交版本号（只操作 lightweight Git tag，不重写提交历史） ========
  app.post("/api/tag-edit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const commit = String(body.commit || "").trim();
    const currentTagRaw = String(body.currentTag || "").trim();
    const currentTag = currentTagRaw ? normalizeVersionTag(currentTagRaw) : "";
    const requestedVersion = normalizeVersionTag(body.version);
    const allowMove = body.allowMove === true;

    if (!commit) return c.json({ ok: false, message: "请指定提交 hash" });
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) return c.json({ ok: false, message: "提交 hash 格式不正确" });
    if (currentTagRaw && currentTag === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "当前版本号格式不正确" });
    if (requestedVersion === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "版本号格式错误，正确格式如 1.2.3" });

    const releaseLock = tryAcquireRewordLock(path);
    if (!releaseLock) return c.json({ ok: false, code: "REWORD_IN_PROGRESS", message: "当前仓库正在进行历史提交编辑，请等待当前操作完成" });
    try {
      const targetHash = gitExecFile(path, ["rev-parse", "--verify", `${commit}^{commit}`], { timeout: 10000 });
      if (currentTag) {
        if (getTagCommit(path, currentTag, gitExecFile) !== targetHash) {
          return c.json({ ok: false, code: "TAG_CHANGED", message: "当前版本号已经不再指向这条提交，请刷新后重试" });
        }
        if (gitExecFile(path, ["cat-file", "-t", `refs/tags/${currentTag}`], { timeout: 10000 }) !== "commit") {
          return c.json({ ok: false, code: "ANNOTATED_TAG", message: "当前版本号是 annotated tag，暂不支持在插件内修改" });
        }
      }
      const conflict = inspectTagConflict(path, requestedVersion, targetHash, gitExecFile, currentTag);
      if (conflict && !(conflict.oldHistory && allowMove)) {
        return c.json({ ok: false, code: conflict.oldHistory ? "OLD_TAG_EXISTS" : "TAG_EXISTS", conflict, message: conflict.message });
      }
      moveLightweightTag(path, currentTag, requestedVersion, targetHash, gitExecFile);
      return c.json({ ok: true, tag: requestedVersion || "", message: requestedVersion ? `版本号已更新为 ${requestedVersion.replace(/^v/, "")}` : "版本号已删除" });
    } catch (e) {
      return c.json({ ok: false, message: `版本号修改失败：${commandErrorText(e) || "无法更新 Git tag"}` });
    } finally {
      releaseLock();
    }
  });

  // ======== API: 合并连续历史提交（非交互式 git rebase -i / squash） ========
  app.post("/api/commit-squash", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const requestedMessage = String(body.message || "").trim();
    const messageAuto = body.messageAuto === true;
    const requestedVersion = normalizeVersionTag(body.version);
    const selectedRaw = Array.isArray(body.selectedCommits) ? body.selectedCommits.map(v => String(v || "").trim()).filter(Boolean) : [];
    const expectedHead = String(body.expectedHead || "").trim();
    const allowMove = body.allowMove === true;

    if (!requestedMessage && !messageAuto) return c.json({ ok: false, message: "提交消息不能为空" });
    if (requestedVersion === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "版本号格式错误，正确格式如 1.2.3" });
    if (selectedRaw.length < 2) return c.json({ ok: false, code: "TOO_FEW_COMMITS", message: "至少选择两条提交才能合并" });
    if (selectedRaw.some(hash => !/^[0-9a-f]{4,64}$/i.test(hash))) {
      return c.json({ ok: false, message: "提交 hash 格式不正确" });
    }

    const releaseLock = tryAcquireRewordLock(path);
    if (!releaseLock) return c.json({ ok: false, code: "REWORD_IN_PROGRESS", message: "当前仓库正在进行历史重写，请等待当前操作完成" });

    let backupRef = "";
    let originalHead = "";
    let rebaseStarted = false;
    let rebaseCompleted = false;
    let sequenceEditorFile = null;
    let messageEditorFile = null;
    let messageContentFile = null;
    let startBranch = "";
    let startHead = "";
    let startGitDir = "";

    const cleanupTempEditors = () => {
      for (const file of [sequenceEditorFile, messageEditorFile, messageContentFile]) {
        if (file) { try { unlinkSync(file); } catch {} }
      }
    };

    const recoverAfterFailure = () => {
      if (!rebaseStarted || !originalHead) return "";
      try {
        const currentBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
        const currentGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
        const rebaseIdentity = getRebaseIdentity(path, gitExecFile);
        const currentBranchMatches = currentBranch === startBranch || !currentBranch;
        const belongsToThisRequest = currentBranchMatches
          && currentGitDir === startGitDir
          && rebaseIdentity
          && rebaseIdentity.headName === `refs/heads/${startBranch}`
          && rebaseIdentity.originalHead === startHead;
        if (!belongsToThisRequest) return `未自动恢复：仓库状态已发生变化，请检查当前 Git 状态；原始备份引用为 ${backupRef}`;
        gitExecFile(path, ["rebase", "--abort"], { timeout: 30000 });
        const restoredHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
        if (restoredHead !== originalHead) return `rebase 已终止但 HEAD 未回到原位置，请使用备份引用 ${backupRef} 恢复`;
        return "";
      } catch (e) {
        return `自动恢复失败，请使用备份引用 ${backupRef} 恢复：${commandErrorText(e)}`;
      }
    };

    try {
      const branch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!branch) return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到一个本地分支" });
      const operationState = getGitOperationState(path);
      if (operationState) return c.json({ ok: false, code: "GIT_OPERATION_IN_PROGRESS", message: `当前 Git 正在进行 ${operationState} 操作，请先完成或终止它` });
      const status = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"], { timeout: 10000 });
      if (status) return c.json({ ok: false, code: "DIRTY", message: "当前工作区不干净，请先提交或暂存这些修改后再合并历史提交" });
      const localName = gitExecFile(path, ["config", "user.name"], { timeout: 10000 });
      const localEmail = gitExecFile(path, ["config", "user.email"], { timeout: 10000 });
      if (!localName || !localEmail) return c.json({ ok: false, code: "NO_IDENTITY", message: "Git 还未设置你的姓名和邮箱" });

      originalHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
      startBranch = branch;
      startHead = originalHead;
      startGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
      if (expectedHead) {
        if (!/^[0-9a-f]{4,64}$/i.test(expectedHead)) return c.json({ ok: false, code: "HEAD_CHANGED", message: "提交列表状态无效，请刷新后重试" });
        const expectedFull = gitExecFile(path, ["rev-parse", "--verify", `${expectedHead}^{commit}`], { timeout: 10000 });
        if (expectedFull !== originalHead) return c.json({ ok: false, code: "HEAD_CHANGED", message: "仓库在编辑期间发生了变化，请刷新提交记录后重试" });
      }

      const history = gitExecFile(path, ["rev-list", "--reverse", "HEAD"], { timeout: 30000 }).split("\n").filter(Boolean);
      const selected = [];
      const selectedSet = new Set();
      for (const raw of selectedRaw) {
        const full = gitExecFile(path, ["rev-parse", "--verify", `${raw}^{commit}`], { timeout: 10000 });
        if (selectedSet.has(full)) return c.json({ ok: false, code: "DUPLICATE_COMMITS", message: "不能重复选择同一条提交" });
        selected.push(full);
        selectedSet.add(full);
      }
      const indexes = selected.map(hash => history.indexOf(hash));
      if (indexes.some(index => index < 0)) return c.json({ ok: false, code: "NOT_REACHABLE", message: "选择的提交不在当前分支历史中" });
      const minIndex = Math.min(...indexes);
      const maxIndex = Math.max(...indexes);
      if (maxIndex - minIndex + 1 !== selected.length) return c.json({ ok: false, code: "NON_CONTIGUOUS", message: "请选择连续的提交，不能跳过中间提交" });
      const selectedOrdered = history.slice(minIndex, maxIndex + 1);
      const selectedSubjects = selectedOrdered.map(hash => gitExecFile(path, ["show", "-s", "--format=%s", hash], { timeout: 10000 }).trim()).filter(Boolean);
      const generatedMessage = selectedSubjects.join("+");
      const message = messageAuto ? generatedMessage : requestedMessage;
      if (!message) return c.json({ ok: false, message: "选中提交没有可用的提交说明" });
      const earliest = selectedOrdered[0];
      const rangeSpec = minIndex === 0 ? "HEAD" : `${earliest}^..HEAD`;
      const rangeCommits = gitExecFile(path, ["rev-list", "--reverse", rangeSpec], { timeout: 30000 }).split("\n").filter(Boolean);
      const commitParents = gitExecFile(path, ["rev-list", "--parents", rangeSpec], { timeout: 30000 }).split("\n").filter(Boolean);
      if (commitParents.some(line => line.trim().split(/\s+/).length > 2)) {
        return c.json({ ok: false, code: "MERGE_HISTORY", message: "当前版本暂不支持包含 merge commit 的历史，请先在纯线性分支上操作" });
      }

      // 读取所有 tag，准备在 rebase 成功后把 lightweight tag 映射到新提交。
      const tagInfos = [];
      let tagRaw = "";
      try { tagRaw = gitExecFile(path, ["for-each-ref", "refs/tags", "--format=%(refname:short)|%(objecttype)|%(objectname)"], { timeout: 10000 }); } catch {}
      for (const line of tagRaw.split("\n").filter(Boolean)) {
        const parts = line.split("|");
        const name = parts[0] || "";
        const type = parts[1] || "";
        if (!name) continue;
        let commit = "";
        try { commit = getTagCommit(path, name, gitExecFile); } catch {}
        tagInfos.push({ name, type, commit });
      }
      const rewrittenSet = new Set(rangeCommits);
      const selectedVersionTags = tagInfos.filter(info => selectedSet.has(info.commit) && normalizeVersionTag(info.name));
      const requestedInfo = requestedVersion ? tagInfos.find(info => info.name === requestedVersion) : null;
      if (requestedInfo) {
        if (requestedInfo.type !== "commit") return c.json({ ok: false, code: "ANNOTATED_TAG", message: `版本号 ${requestedVersion.replace(/^v/, "")} 是 annotated tag，当前暂不自动改写` });
        const isSelectedTag = selectedSet.has(requestedInfo.commit);
        const isRewrittenLaterTag = rewrittenSet.has(requestedInfo.commit) && !isSelectedTag;
        if (!isSelectedTag && !isRewrittenLaterTag) {
          let onCurrentBranch = false;
          try { gitExecFile(path, ["merge-base", "--is-ancestor", requestedInfo.commit, originalHead], { timeout: 10000 }); onCurrentBranch = true; } catch {}
          const conflict = { tag: requestedVersion, existingCommit: requestedInfo.commit, targetCommit: earliest, oldHistory: !onCurrentBranch };
          if (!(conflict.oldHistory && allowMove)) return c.json({ ok: false, code: conflict.oldHistory ? "OLD_TAG_EXISTS" : "TAG_EXISTS", conflict, message: conflict.message || `版本号 ${requestedVersion.replace(/^v/, "")} 已经存在` });
        }
        if (isRewrittenLaterTag) return c.json({ ok: false, code: "TAG_EXISTS", message: `版本号 ${requestedVersion.replace(/^v/, "")} 位于合并范围之后的提交，不能覆盖` });
      }
      for (const info of tagInfos) {
        if (rewrittenSet.has(info.commit) && info.type !== "commit") {
          return c.json({ ok: false, code: "ANNOTATED_TAG", message: `提交 ${info.commit.slice(0, 7)} 上存在 annotated tag ${info.name}，当前暂不自动改写` });
        }
      }

      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      backupRef = `refs/backup/git-save-load/squash-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
      gitExecFile(path, ["update-ref", backupRef, originalHead], { timeout: 10000 });

      sequenceEditorFile = join(tmpdir(), `git-sl-squash-sequence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      messageEditorFile = join(tmpdir(), `git-sl-squash-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      writeFileSync(sequenceEditorFile, [
        "const fs = require('node:fs');",
        "const todo = process.argv[2];",
        "const selected = new Set(String(process.env.GIT_SAVE_LOAD_SQUASH_SELECTED || '').split(',').filter(Boolean).map(v => v.toLowerCase()));",
        "let text = fs.readFileSync(todo, 'utf8');",
        "let selectedSeen = 0;",
        "text = text.split(/\\r?\\n/).map(line => {",
        "  const m = line.match(/^(\\s*)(pick|reword|edit|squash|fixup)\\s+([0-9a-f]+)(\\s+.*)?$/i);",
        "  if (!m) return line;",
        "  const hash = m[3].toLowerCase();",
        "  if (!selected.has(hash) && !Array.from(selected).some(target => target.startsWith(hash) || hash.startsWith(target))) return line;",
        "  selectedSeen += 1;",
        "  return m[1] + (selectedSeen === 1 ? 'pick ' : 'squash ') + m[3] + (m[4] || '');",
        "}).join('\\n');",
        "if (selectedSeen !== selected.size) { console.error('selected commit not found in rebase todo'); process.exit(2); }",
        "fs.writeFileSync(todo, text, 'utf8');",
        "",
      ].join("\n"), "utf8");
      writeFileSync(messageEditorFile, [
        "const fs = require('node:fs');",
        "const target = process.argv[2];",
        "const source = process.env.GIT_SAVE_LOAD_SQUASH_MESSAGE_FILE;",
        "if (!target || !source) process.exit(2);",
        "fs.copyFileSync(source, target);",
        "",
      ].join("\n"), "utf8");
      const quoteCommandPath = value => `"${String(value).replace(/"/g, '\\\"')}"`;
      messageContentFile = join(tmpdir(), `git-sl-squash-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      writeFileSync(messageContentFile, message, "utf8");
      const editorEnv = {
        GIT_SAVE_LOAD_SQUASH_SELECTED: selectedOrdered.join(","),
        GIT_SAVE_LOAD_SQUASH_MESSAGE_FILE: messageContentFile,
        GIT_SEQUENCE_EDITOR: `${quoteCommandPath(process.execPath)} ${quoteCommandPath(sequenceEditorFile)}`,
        GIT_EDITOR: `${quoteCommandPath(process.execPath)} ${quoteCommandPath(messageEditorFile)}`,
      };
      const upstream = minIndex === 0 ? "" : gitExecFile(path, ["rev-parse", `${earliest}^`], { timeout: 10000 });
      const rebaseArgs = ["rebase", "-i"];
      if (minIndex === 0) rebaseArgs.push("--root"); else rebaseArgs.push(upstream);
      rebaseStarted = true;
      gitExecFileWithEnv(path, rebaseArgs, editorEnv, { timeout: 300000 });
      rebaseCompleted = true;

      const newHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
      const newRangeSpec = minIndex === 0 ? "HEAD" : `${upstream}..HEAD`;
      const newRangeCommits = gitExecFile(path, ["rev-list", "--reverse", newRangeSpec], { timeout: 30000 }).split("\n").filter(Boolean);
      const rangeStartIndex = minIndex === 0 ? 0 : minIndex;
      const selectedStartInRange = minIndex - rangeStartIndex;
      const newSquashed = newRangeCommits[selectedStartInRange] || "";
      if (!newSquashed) throw new Error("无法定位合并后的提交");
      const newIndexByOld = new Map();
      for (let i = 0; i < rangeCommits.length; i++) {
        const newIndex = i < selectedStartInRange
          ? i
          : i < selectedStartInRange + selectedOrdered.length
            ? selectedStartInRange
            : i - selectedOrdered.length + 1;
        newIndexByOld.set(rangeCommits[i], newRangeCommits[newIndex] || "");
      }
      let tagUpdateError = "";
      try {
        for (const info of tagInfos) {
          if (!rewrittenSet.has(info.commit)) continue;
          const newTarget = newIndexByOld.get(info.commit);
          if (!newTarget) continue;
          const selectedTag = selectedSet.has(info.commit);
          const versionTag = !!normalizeVersionTag(info.name);
          if (selectedTag && versionTag) {
            if (requestedVersion && info.name === requestedVersion) gitExecFile(path, ["update-ref", `refs/tags/${info.name}`, newSquashed], { timeout: 10000 });
            else gitExecFile(path, ["update-ref", "-d", `refs/tags/${info.name}`], { timeout: 10000 });
          } else {
            gitExecFile(path, ["update-ref", `refs/tags/${info.name}`, newTarget], { timeout: 10000 });
          }
        }
        if (requestedVersion) {
          gitExecFile(path, ["update-ref", `refs/tags/${requestedVersion}`, newSquashed], { timeout: 10000 });
        }
      } catch (e) {
        tagUpdateError = commandErrorText(e) || "版本号更新失败";
      }
      const rewrittenCount = rangeCommits.length;
      const tagDetail = requestedVersion ? `，版本号已更新为 ${requestedVersion.replace(/^v/, "")}` : selectedVersionTags.length ? "，选中提交上的版本号已清理" : "";
      return c.json({
        ok: true,
        branch,
        originalHead,
        newHead,
        newSquashed,
        selectedCommits: selectedOrdered,
        rewrittenCount,
        backupRef,
        tag: requestedVersion || "",
        tagUpdateError,
        message: `已合并 ${selectedOrdered.length} 条连续提交${tagDetail}${tagUpdateError ? `；${tagUpdateError}` : ""}，并重写了后续 ${rewrittenCount} 条提交。如该分支已推送远程，后续需要使用 force-with-lease 推送。`,
      });
    } catch (e) {
      if (rebaseCompleted) {
        return c.json({ ok: true, code: "SQUASH_COMPLETED", backupRef, message: `提交合并已经完成，但后续处理出现异常：${commandErrorText(e) || "未知错误"}。请刷新提交记录确认；备份引用为 ${backupRef}` });
      }
      const recoveryMessage = recoverAfterFailure();
      return c.json({ ok: false, code: "SQUASH_FAILED", backupRef, recovered: !recoveryMessage, message: `合并历史提交失败：${commandErrorText(e) || "Git rebase 执行失败"}${recoveryMessage ? `；${recoveryMessage}` : "；已恢复到操作前状态"}` });
    } finally {
      cleanupTempEditors();
      releaseLock();
    }
  });

  // ======== API: 修改较早历史提交的说明（非交互式 git rebase -i / reword） ========
  app.post("/api/commit-reword", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const path = repoPath(body.path);
    const message = String(body.message || "").trim();
    const expectedHash = String(body.expectedHash || "").trim();
    const rawCurrentTag = String(body.currentTag || "").trim();
    const currentTag = rawCurrentTag ? normalizeVersionTag(rawCurrentTag) : "";
    const requestedVersion = body.version === undefined ? undefined : normalizeVersionTag(body.version);
    const allowMove = body.allowMove === true;

    if (!message) return c.json({ ok: false, message: "提交消息不能为空" });
    if (rawCurrentTag && currentTag === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "当前版本号格式不正确" });
    if (requestedVersion === null) return c.json({ ok: false, code: "INVALID_VERSION", message: "版本号格式错误，正确格式如 1.2.3" });
    if (!/^[0-9a-f]{4,64}$/i.test(expectedHash)) {
      return c.json({ ok: false, message: "提交 hash 格式不正确" });
    }

    const releaseLock = tryAcquireRewordLock(path);
    if (!releaseLock) {
      return c.json({ ok: false, code: "REWORD_IN_PROGRESS", message: "当前仓库正在进行历史提交说明修改，请等待当前操作完成" });
    }

    let backupRef = "";
    let originalHead = "";
    let sourceTag = currentTag;
    let targetTag = requestedVersion === undefined ? currentTag : requestedVersion;
    let rebaseStarted = false;
    let rebaseCompleted = false;
    let sequenceEditorFile = null;
    let messageEditorFile = null;
    let messageContentFile = null;
    let startBranch = "";
    let startHead = "";
    let startGitDir = "";

    const cleanupTempEditors = () => {
      for (const file of [sequenceEditorFile, messageEditorFile, messageContentFile]) {
        if (file) { try { unlinkSync(file); } catch {} }
      }
    };

    const recoverAfterFailure = () => {
      if (!rebaseStarted || !originalHead) return "";
      try {
        const currentBranch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
        const currentGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
        const rebaseIdentity = getRebaseIdentity(path, gitExecFile);
        const currentBranchMatches = currentBranch === startBranch || !currentBranch;
        const belongsToThisRequest = currentBranchMatches
          && currentGitDir === startGitDir
          && rebaseIdentity
          && rebaseIdentity.headName === `refs/heads/${startBranch}`
          && rebaseIdentity.originalHead === startHead;
        if (!belongsToThisRequest) {
          return `未自动恢复：仓库状态已发生变化，请检查当前 Git 状态；原始备份引用为 ${backupRef}`;
        }
        gitExecFile(path, ["rebase", "--abort"], { timeout: 30000 });
        const restoredHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
        if (restoredHead !== originalHead) {
          return `rebase 已终止但 HEAD 未回到原位置，请使用备份引用 ${backupRef} 恢复`;
        }
        return "";
      } catch (e) {
        return `自动恢复失败，请使用备份引用 ${backupRef} 恢复：${commandErrorText(e)}`;
      }
    };

    try {
      // 只允许在明确的本地分支上修改历史，避免 detached HEAD 下用户找不到新历史。
      const branch = gitExecFile(path, ["branch", "--show-current"], { timeout: 10000 });
      if (!branch) {
        return c.json({ ok: false, code: "DETACHED_HEAD", message: "当前处于 detached HEAD 状态，请先切换到一个本地分支" });
      }

      // rebase / merge / cherry-pick / revert / bisect 未完成时，不允许嵌套历史重写。
      const operationState = getGitOperationState(path);
      if (operationState) {
        return c.json({ ok: false, code: "GIT_OPERATION_IN_PROGRESS", message: `当前 Git 正在进行 ${operationState} 操作，请先完成或终止它` });
      }

      // 历史重写不能混入当前工作区的任何内容，也不自动 stash。
      const status = gitExecFile(path, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"], { timeout: 10000 });
      if (status) {
        return c.json({ ok: false, code: "DIRTY", message: "当前工作区不干净，请先提交或暂存这些修改后再修改历史提交说明" });
      }

      const localName = gitExecFile(path, ["config", "user.name"], { timeout: 10000 });
      const localEmail = gitExecFile(path, ["config", "user.email"], { timeout: 10000 });
      if (!localName || !localEmail) {
        return c.json({ ok: false, code: "NO_IDENTITY", message: "Git 还未设置你的姓名和邮箱" });
      }

      originalHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
      startBranch = branch;
      startHead = originalHead;
      startGitDir = resolve(path, gitExecFile(path, ["rev-parse", "--git-dir"], { timeout: 10000 }));
      const targetHash = gitExecFile(path, ["rev-parse", "--verify", `${expectedHash}^{commit}`], { timeout: 10000 });
      try {
        gitExecFile(path, ["merge-base", "--is-ancestor", targetHash, originalHead], { timeout: 10000 });
      } catch {
        return c.json({ ok: false, code: "NOT_REACHABLE", message: "目标提交不在当前分支的历史中" });
      }

      if (sourceTag) {
        let sourceTarget = "";
        try { sourceTarget = getTagCommit(path, sourceTag, gitExecFile); } catch {}
        if (sourceTarget !== targetHash) {
          return c.json({ ok: false, code: "TAG_CHANGED", message: `版本号 ${sourceTag.replace(/^v/, "")} 已不再指向这条提交，请刷新后重试` });
        }
        try {
          if (gitExecFile(path, ["cat-file", "-t", `refs/tags/${sourceTag}`], { timeout: 10000 }) !== "commit") {
            return c.json({ ok: false, code: "ANNOTATED_TAG", message: `版本号 ${sourceTag.replace(/^v/, "")} 是 annotated tag，当前暂不自动改写，请手动处理` });
          }
        } catch {
          return c.json({ ok: false, code: "TAG_CHANGED", message: `版本号 ${sourceTag.replace(/^v/, "")} 不存在，请刷新后重试` });
        }
      }
      const tagConflict = inspectTagConflict(path, targetTag, targetHash, gitExecFile, sourceTag);
      if (tagConflict && !(tagConflict.oldHistory && allowMove)) {
        return c.json({ ok: false, code: tagConflict.oldHistory ? "OLD_TAG_EXISTS" : "TAG_EXISTS", conflict: tagConflict, message: tagConflict.message });
      }

      // 当前版本只支持线性历史。merge commit 需要单独设计拓扑保留策略，先安全拒绝。
      const targetParentLine = gitExecFile(path, ["rev-list", "--parents", "-n", "1", targetHash], { timeout: 10000 }).trim();
      const isRoot = targetParentLine.split(/\s+/).length === 1;
      const rangeSpec = isRoot ? "HEAD" : `${targetHash}^..HEAD`;
      const originalRangeCommits = gitExecFile(path, ["rev-list", "--reverse", rangeSpec], { timeout: 30000 })
        .split("\n").filter(Boolean);
      const targetIndex = isRoot
        ? gitExecFile(path, ["rev-list", "--reverse", "HEAD"], { timeout: 30000 }).split("\n").filter(Boolean).indexOf(targetHash)
        : 0;
      const commitParents = gitExecFile(path, ["rev-list", "--parents", rangeSpec], { timeout: 30000 })
        .split("\n").filter(Boolean);
      if (targetIndex < 0 || originalRangeCommits.length === 0) {
        return c.json({ ok: false, code: "NOT_REACHABLE", message: "无法确定目标提交在当前分支历史中的位置" });
      }
      if (commitParents.some(line => line.trim().split(/\s+/).length > 2)) {
        return c.json({ ok: false, code: "MERGE_HISTORY", message: "当前版本暂不支持包含 merge commit 的历史，请先在纯线性分支上操作" });
      }

      // 标签仍然指向旧 commit，插件不自动移动或删除它们，只在结果中明确提示。
      const rewrittenCommits = new Set(
        gitExecFile(path, ["rev-list", rangeSpec], { timeout: 30000 }).split(String.fromCharCode(10)).filter(Boolean)
      );
      const staleTags = [];
      let tagNames = [];
      try { tagNames = gitExecFile(path, ["tag"], { timeout: 10000 }).split(String.fromCharCode(10)).filter(Boolean); } catch {}
      for (const tag of tagNames) {
        try {
          const tagCommit = gitExecFile(path, ["rev-parse", `${tag}^{commit}`], { timeout: 10000 });
          if (rewrittenCommits.has(tagCommit)) staleTags.push(tag);
        } catch {}
      }

      const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
      backupRef = `refs/backup/git-save-load/reword-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
      gitExecFile(path, ["update-ref", backupRef, originalHead], { timeout: 10000 });

      // Git 的交互式 rebase 通过两个编辑器完成：sequence editor 把目标行改成 reword，
      // message editor 把目标提交的说明替换为用户输入。两者均使用临时 Node 脚本，避免打开外部编辑器。
      sequenceEditorFile = join(tmpdir(), `git-sl-reword-sequence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      messageEditorFile = join(tmpdir(), `git-sl-reword-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.cjs`);
      writeFileSync(sequenceEditorFile, [
        "const fs = require('node:fs');",
        "const todo = process.argv[2];",
        "const target = String(process.env.GIT_SAVE_LOAD_REWORD_TARGET || '').toLowerCase();",
        "let text = fs.readFileSync(todo, 'utf8');",
        "let changed = false;",
        "text = text.split(/\\r?\\n/).map(line => {",
        "  const m = line.match(/^(\\s*)(pick|reword|edit)\\s+([0-9a-f]+)(\\s+.*)?$/i);",
        "  if (m && target.startsWith(m[3].toLowerCase())) { changed = true; return m[1] + 'reword ' + m[3] + (m[4] || ''); }",
        "  return line;",
        "}).join('\\n');",
        "if (!changed) { console.error('目标提交未出现在 rebase todo 中'); process.exit(2); }",
        "fs.writeFileSync(todo, text, 'utf8');",
        "",
      ].join("\n"), "utf8");
      writeFileSync(messageEditorFile, [
        "const fs = require('node:fs');",
        "const target = process.argv[2];",
        "const source = process.env.GIT_SAVE_LOAD_REWORD_MESSAGE_FILE;",
        "if (!target || !source) process.exit(2);",
        "fs.copyFileSync(source, target);",
        "",
      ].join("\n"), "utf8");

      const quoteCommandPath = value => `"${String(value).replace(/"/g, '\\\"')}"`;
      const editorEnv = {
        GIT_SAVE_LOAD_REWORD_TARGET: targetHash,
      };
      messageContentFile = join(tmpdir(), `git-sl-reword-content-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      editorEnv.GIT_SAVE_LOAD_REWORD_MESSAGE_FILE = messageContentFile;
      writeFileSync(messageContentFile, message, "utf8");
      editorEnv.GIT_SEQUENCE_EDITOR = `${quoteCommandPath(process.execPath)} ${quoteCommandPath(sequenceEditorFile)}`;
      editorEnv.GIT_EDITOR = `${quoteCommandPath(process.execPath)} ${quoteCommandPath(messageEditorFile)}`;

      const upstream = isRoot ? "" : gitExecFile(path, ["rev-parse", `${targetHash}^`], { timeout: 10000 });
      const rebaseArgs = ["rebase", "-i"];
      if (isRoot) rebaseArgs.push("--root");
      else rebaseArgs.push(upstream);
      rebaseStarted = true;
      try {
        gitExecFileWithEnv(path, rebaseArgs, editorEnv, { timeout: 300000 });
      } catch (e) {
        // 只有 rebase 命令本身失败，才进入外层恢复逻辑。
        throw e;
      }
      // 从这一行开始，rebase 已经成功结束；后续任何信息读取失败都不能再 abort/reset。
      rebaseCompleted = true;

      try {
        const newHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 });
        const newRange = isRoot ? "HEAD" : `${upstream}..HEAD`;
        const newRangeCommits = gitExecFile(path, ["rev-list", "--reverse", newRange], { timeout: 30000 }).split("\n").filter(Boolean);
        const newTarget = newRangeCommits[targetIndex] || "";
        if (!newTarget) throw new Error("无法定位 reword 后的目标提交");

        // tag 更新必须在 rebase 成功后尽早执行；后续读取元信息失败也不能让版本号停留在旧提交。
        let tagUpdateError = "";
        if (sourceTag || targetTag) {
          try { moveLightweightTag(path, sourceTag, targetTag, newTarget, gitExecFile); }
          catch (e) { tagUpdateError = commandErrorText(e) || "版本号更新失败"; }
        }

        const newMessage = gitExecFile(path, ["log", "-1", "--format=%s", newTarget], { timeout: 10000 });
        const rewrittenCount = parseInt(gitExecFile(path, ["rev-list", "--count", newRange], { timeout: 10000 }), 10) || 0;
        const tagWarning = staleTags.length && !sourceTag ? `；以下旧 tag 仍指向旧历史：${staleTags.join("、")}` : "";
        const tagDetail = tagUpdateError ? `；版本号更新失败：${tagUpdateError}，请手动检查 tag` : targetTag ? `，版本号已更新为 ${targetTag.replace(/^v/, "")}` : sourceTag ? "，版本号已删除" : "";

        return c.json({
          ok: true,
          branch,
          originalHead,
          newHead,
          targetHash,
          newTarget,
          newMessage,
          rewrittenCount,
          backupRef,
          staleTags,
          tag: targetTag || "",
          tagUpdateError,
          message: `已修改历史提交说明${tagDetail}，重写了 ${rewrittenCount} 条提交${tagWarning}。如该分支已推送远程，后续需要使用 force-with-lease 推送。`,
        });
      } catch (e) {
        // 历史已经改完；保留备份引用并报告结果读取失败，绝不把成功的 reword 回滚掉。
        let currentHead = "";
        try { currentHead = gitExecFile(path, ["rev-parse", "HEAD"], { timeout: 10000 }); } catch {}
        return c.json({
          ok: true,
          code: "REWORD_RESULT_READ_FAILED",
          branch,
          originalHead,
          newHead: currentHead,
          targetHash,
          backupRef,
          staleTags,
          tag: targetTag || "",
          message: `历史提交说明已经修改成功${targetTag ? `，版本号目标为 ${targetTag.replace(/^v/, "")}` : sourceTag ? "，版本号已删除" : ""}，但读取新历史详情失败：${commandErrorText(e) || "无法读取 Git 结果"}。请刷新提交记录确认；备份引用为 ${backupRef}`,
        });
      }
    } catch (e) {
      if (rebaseCompleted) {
        // 防御性分支：任何未来新增的 rebase 后处理异常，也不能触发恢复。
        return c.json({
          ok: true,
          code: "REWORD_COMPLETED",
          backupRef,
          message: `历史提交说明已经修改完成，但后续处理出现异常：${commandErrorText(e) || "未知错误"}。请刷新提交记录确认；备份引用为 ${backupRef}`,
        });
      }
      const recoveryMessage = recoverAfterFailure();
      return c.json({
        ok: false,
        code: "REWORD_FAILED",
        backupRef,
        recovered: !recoveryMessage,
        message: `修改历史提交说明失败：${commandErrorText(e) || "Git rebase 执行失败"}${recoveryMessage ? `；${recoveryMessage}` : "；已恢复到操作前状态"}`,
      });
    } finally {
      cleanupTempEditors();
      releaseLock();
    }
  });
}
