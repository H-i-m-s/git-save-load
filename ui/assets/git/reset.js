// Git Save/Load Card 前端模块 19/26：reset.js — 回滚确认与执行
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。

// 回滚
function doReset(hash) {
  showConfirm(
    `确定要回滚到 ${hash} 吗？`,
    "回滚",
    (ok) => {
      document.getElementById("confirmModal").style.display = "none";
      if (!ok) return;
      doResetExecute(hash, selectedResetMode);
    },
    true
  );
}

async function doResetExecute(hash, mode) {
  try {
    const res = await pluginFetch("api/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commit: hash, mode, path: currentPath }),
    });
    const data = await res.json();
    if (data.ok) {
      invalidateRepoCaches(currentPath || getSavedPath());
      cacheClear();
      Bus.emit("reset");
      let msg = `✅ 已回滚到 ${hash}（${data.mode}）`;
      if (data.cleanedTags && data.cleanedTags.length > 0) {
        msg += `\n已清理 ${data.cleanedTags.length} 个旧 tag`;
      }
      toast(msg, "success");
      refresh();
    } else {
      toast("❌ " + data.message, "err");
    }
  } catch (e) {
    toast("回滚失败：" + e.message, "err");
  }
}

// .gitignore 模板数据（每项一组排除条目）
