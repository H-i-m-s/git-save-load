// Git Save/Load Card 前端模块 25/26：identity.js — Git 身份配置弹窗
// 由原单文件脚本按原始顺序机械切分；加载顺序即拆分前的顶层执行顺序，勿随意调整。
// ======== Git 身份配置弹窗 ========
let _pendingCommitMsg = "";
let _pendingCommitVersion = "";

function showIdentitySetup(msg, version) {
  _pendingCommitMsg = msg || "";
  _pendingCommitVersion = version || "";
  document.getElementById("identitySetupResult").textContent = "";
  document.getElementById("identitySetupResult").style.color = "";
  document.getElementById("identityName").value = "";
  document.getElementById("identityEmail").value = "";
  document.getElementById("identitySetupModal").style.display = "flex";
  setTimeout(function() { document.getElementById("identityName").focus(); }, 50);
}

function closeIdentitySetup() {
  document.getElementById("identitySetupModal").style.display = "none";
}

async function submitIdentitySetup() {
  const name = document.getElementById("identityName").value.trim();
  const email = document.getElementById("identityEmail").value.trim();
  const resultEl = document.getElementById("identitySetupResult");
  const btn = document.getElementById("identitySubmitBtn");

  if (!name) { resultEl.textContent = "❌ 姓名不能为空"; resultEl.style.color = "#e74c3c"; return; }
  if (!email) { resultEl.textContent = "❌ 邮箱不能为空"; resultEl.style.color = "#e74c3c"; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    resultEl.textContent = "❌ 邮箱格式不对（例：xx@example.com）";
    resultEl.style.color = "#e74c3c";
    return;
  }

  btn.disabled = true; btn.textContent = "保存中...";
  resultEl.textContent = "";

  try {
    const res = await pluginFetch("api/git-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, path: currentPath }),
    });
    const data = await res.json();
    if (data.ok) {
      resultEl.textContent = "✅ " + data.message;
      resultEl.style.color = "var(--hana-accent,#5e6ad2)";
      btn.textContent = "重试中...";
      // 根据场景重试：commit 或 amend
      const mode = window._identitySetupAfter || "commit";
      try {
        let url, body, parseRes;
        if (mode === "amend") {
          url = "/api/commit-amend";
          body = { message: _pendingAmendMsg, path: _pendingAmendPath || currentPath, expectedHash: _pendingAmendHash };
          parseRes = function(d) { return d; };
        } else {
          url = "/api/commit";
          body = { message: _pendingCommitMsg, version: _pendingCommitVersion, path: currentPath };
          parseRes = function(d) {
            if (d.ok) {
              if (d.nothingToCommit) {
                toast("身份已设置（没有需要提交的变更）", "success");
              } else {
                const tagInfo = d.tag ? ` v${_pendingCommitVersion}` : "";
                toast(`✅ ${d.commit}${tagInfo}`, "success");
                document.getElementById("commitMsg").value = "";
                loadNextVersion();
              }
            }
            return d;
          };
        }
        const r2 = await pluginFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d2 = await r2.json();
        if (d2.ok) {
          if (mode === "amend") {
            toast("✅ " + (d2.commit || d2.message), "success");
          } else {
            parseRes(d2);
          }
          window._identitySetupAfter = null;
          setTimeout(closeIdentitySetup, 400);
          refresh();
        } else if (d2.code === "NO_IDENTITY") {
          resultEl.textContent = "❌ 仍未能配置身份，请重试";
          resultEl.style.color = "#e74c3c";
        } else if (d2.code === "NOT_HEAD") {
          resultEl.textContent = "❌ " + d2.message;
          resultEl.style.color = "#e74c3c";
        } else if (d2.code === "DIRTY") {
          resultEl.textContent = "❌ " + d2.message;
          resultEl.style.color = "#e74c3c";
        } else {
          resultEl.textContent = "❌ " + d2.message;
          resultEl.style.color = "#e74c3c";
        }
      } catch (e) {
        resultEl.textContent = "❌ 重试失败：" + e.message;
        resultEl.style.color = "#e74c3c";
      }
    } else {
      resultEl.textContent = "❌ " + data.message;
      resultEl.style.color = "#e74c3c";
    }
  } catch (e) {
    resultEl.textContent = "❌ " + e.message;
    resultEl.style.color = "#e74c3c";
  } finally {
    btn.disabled = false; btn.textContent = "保存并重试提交";
  }
}

// 初始加载：先从插件配置读路径，再刷新状态
