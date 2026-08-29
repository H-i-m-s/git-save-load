// Git Save/Load Card 前端模块 8/26：gh-connect.js — 关联 GitHub 仓库、创建仓库、克隆仓库
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
async function ghConnectRepo(confirmed) {
  const url = document.getElementById("ghConnectUrl").value.trim();
  const remote = document.getElementById("ghConnectRemote").value.trim() || "origin";
  const p = currentPath || getSavedPath();
  const el = document.getElementById("ghConnectResult");
  if (!p) { toast("请先设置本地仓库路径", "err"); return; }
  if (!url) { toast("请输入 GitHub 仓库 URL", "err"); return; }
  el.textContent = "关联并验证中...";
  try {
    const res = await pluginFetch("api/gh/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPath: p, remoteUrl: url, remote, confirmed: !!confirmed }),
    });
    const data = await res.json();
    if (data.code === "REMOTE_REPLACE_CONFIRM") {
      el.textContent = "";
      closeRemoteAddModal();
      showConfirm(
        `当前本地仓库的 ${data.remote} 已经关联到一个远程仓库，是否替换？`,
        "替换远程关联",
        function(ok) { if (ok) ghConnectRepo(true); },
        false,
        { title: "⚠️ 替换远程仓库", detailsHtml: `<div><b>当前：</b>${escapeHtml(data.previousUrl)}</div><div style='margin-top:4px'><b>改为：</b>${escapeHtml(data.nextUrl)}</div>` }
      );
      return;
    }
    el.textContent = data.ok ? "✅ " + data.message : "❌ " + data.message;
    updateGhBodyHeight();
    if (data.ok) {
      document.getElementById("ghConnectUrl").value = "";
      const repoSelect = document.getElementById("ghConnectRepoSelect");
      if (repoSelect) {
        repoSelect.value = "";
        if (repoSelect._hanaSelect) repoSelect._hanaSelect.sync();
      }
      _repoInfoCache.delete(p);
      invalidateRemoteCache(p);
      refresh();
      loadLocalRemotes(undefined, undefined, undefined, true);
      closeRemoteAddModal();
      toast("✅ 已连接 GitHub 仓库", "success");
    }
  } catch (e) { el.textContent = "❌ " + e.message; updateGhBodyHeight(); }
}

async function ghCreateRepo() {
  const name = document.getElementById("ghRepoName").value.trim();
  const nameErr = validateGhRepoName(name);
  if (nameErr) { toast(nameErr, "err"); return; }
  const priv = getHanaSegValue("segGhPrivacy") === "1";
  const desc = document.getElementById("ghRepoDesc").value.trim();
  const license = document.getElementById("ghLicense")?.value || "";
  const p = currentPath || getSavedPath();
  const el = document.getElementById("ghCreateResult");
  if (!el) return;
  const btn = document.getElementById("ghCreateRepoBtn");
  const originalLabel = btn ? btn.textContent : "在 GitHub 创建";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "正在创建 GitHub 仓库…";
    btn.style.opacity = "0.7";
    btn.style.cursor = "wait";
  }
  el.textContent = "正在创建 GitHub 仓库…（网络操作可能需要一点时间）";
  updateGhBodyHeight();
  try {
    const res = await pluginFetch("api/gh/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, private: priv, description: desc, license, localPath: p }),
    });
    const data = await res.json();
    el.textContent = data.ok ? "✅ " + data.message : "❌ " + data.message;
    updateGhBodyHeight();
    if (data.ok) {
      document.getElementById("ghRepoName").value = "";
      document.getElementById("ghRepoDesc").value = "";
      if (document.getElementById("ghLicense")) {
        document.getElementById("ghLicense").value = "";
        const licenseSelect = document.getElementById("ghLicense")._hanaSelect;
        if (licenseSelect) licenseSelect.sync();
      }
      invalidateGhRepoCache();
      loadGhList(true);
      loadGhConnectRepos(true);
    }
  } catch (e) {
    el.textContent = "❌ " + e.message;
    updateGhBodyHeight();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalLabel;
      btn.style.opacity = "";
      btn.style.cursor = "pointer";
    }
    updateGhBodyHeight();
  }
}

async function ghCloneRepo() {
  const url = document.getElementById("ghCloneUrl").value.trim();
  if (!url) { toast("请输入仓库 URL", "err"); return; }
  let dir = document.getElementById("ghCloneDir").value.trim();
  if (!dir) {
    const saved = currentPath || getSavedPath();
    if (saved) {
      const parent = saved.replace(/[\\/][^\\/]*$/, "");
      // 从 URL 提取仓库名作为子目录
      const name = url.replace(/\/?$/, "").split("/").pop() || "repo";
      dir = parent + "/" + name;
    }
  }
  const el = document.getElementById("ghCloneResult");
  el.textContent = "克隆中...（可能较慢）";
  try {
    const res = await pluginFetch("api/gh/clone", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, dir }),
    });
    const data = await res.json();
    el.textContent = data.ok ? "✅ " + data.message : "❌ " + data.message;
    updateGhBodyHeight();
  } catch (e) { el.textContent = "❌ " + e.message; updateGhBodyHeight(); }
}
