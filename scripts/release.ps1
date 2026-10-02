#requires -Version 5.1
<#
Git Save/Load 一键发版脚本

用法:
  .\scripts\release.ps1                                  # 用 manifest.json 的版本号发版
  .\scripts\release.ps1 -Notes "- 修复xxx`n- 新增yyy"    # 附带发布说明（支持多行）
  .\scripts\release.ps1 -PackageOnly                     # 只打包不发布（输出 zip 与 sha256）

前置条件（发布）:
  - Node 与 gh CLI 已安装，gh 已登录（gh auth login）
  - 工作区干净：改动已提交并推送
  - manifest.json 的 version 就是本次要发的版本号（tag 与它强绑定）

出包统一交给 scripts/pack.mjs，产物落 <repo>\dist：
  <id>-v<version>.zip / .zip.sha256 / .entry.json
-PackageOnly 只做这一步，不需要 gh、不需要网络、不要求工作区干净。
#>
param(
  [string]$Notes = "",
  [switch]$PackageOnly,
  [switch]$SkipCleanCheck
)

$ErrorActionPreference = "Stop"
$RepoSlug = "H-i-m-s/git-save-load"
$repoRoot = Split-Path -Parent $PSScriptRoot

# ---------- 1. 版本号以 manifest.json 为唯一事实源 ----------
$manifestPath = Join-Path $repoRoot "manifest.json"
# PS5.1 的 Get-Content 默认按 ANSI 读无 BOM 的 UTF-8 文件会乱码，必须显式指定 UTF-8
$manifest = [System.IO.File]::ReadAllText($manifestPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
$version = $manifest.version
$tag = "v$version"
Write-Host "==> 发布版本: $tag"

# ---------- 出包：统一交给 scripts/pack.mjs ----------
# 与手动出包（node scripts/pack.mjs）走同一条路，产物落 <repo>\dist。
# pack.mjs 内部会先跑 scripts/selfcheck.mjs，失败即以非零码退出，这里不再重复跑自检。
function Invoke-Pack {
  $packScript = Join-Path $PSScriptRoot "pack.mjs"
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "未找到 node，无法出包（scripts/pack.mjs 需要 Node）" }
  if (-not (Test-Path $packScript)) { throw "未找到 scripts/pack.mjs，无法出包" }
  # node 的输出去 host 通道（Write-Host），避免被当成函数返回值的一部分：
  # 若直接写 & node $packScript，它的 stdout 会混进 return 的结果里。
  & node $packScript 2>&1 | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "scripts/pack.mjs 出包失败（exit $LASTEXITCODE）" }
  $zipPath = Join-Path $repoRoot ("dist\{0}-{1}.zip" -f $manifest.id, $tag)
  if (-not (Test-Path $zipPath)) { throw "pack.mjs 未产出预期文件：$zipPath" }
  return $zipPath
}

# ---------- 1.5 -PackageOnly：只本地出包，不发布 ----------
# 纯本地操作，所以排在网络与 gh 校验之前：没登录、没网络、工作区脏也能出包。
if ($PackageOnly) {
  $localZip = Invoke-Pack
  Write-Host ""
  Write-Host "==> -PackageOnly：到此为止，未发布。"
  Write-Host "    zip:    $localZip"
  Write-Host "    sha256: $localZip.sha256  （校验值侧车文件）"
  Write-Host "    entry:  $(Join-Path $repoRoot ('dist\{0}-{1}.entry.json' -f $manifest.id, $tag))  （市场条目）"
  return
}

# ---------- 2. 前置校验 ----------
if (-not $SkipCleanCheck) {
  $dirty = & git -C $repoRoot status --porcelain
  if ($dirty) { throw "工作区有未提交变更，先 commit + push 再发版（或加 -SkipCleanCheck）" }
}
cmd /c "git -C ""$repoRoot"" fetch origin --quiet >nul 2>&1"
$ahead = & git -C $repoRoot rev-list --count "origin/master..master"
if ("$ahead" -ne "0") { throw "本地有 $ahead 个提交未推送到 origin/master，先 git push" }
cmd /c "gh auth status >nul 2>&1"
if ($LASTEXITCODE -ne 0) { throw "gh CLI 未登录，先运行 gh auth login" }
cmd /c "gh release view $tag --repo $RepoSlug >nul 2>&1"
if ($LASTEXITCODE -eq 0) { throw "Release $tag 已存在，换版本号或先删除旧 Release" }

# ---------- 3. 打包：调 scripts/pack.mjs，产物落 dist（顶层 <id>/ 包裹，正斜杠条目） ----------
# 自检由 pack.mjs 内部执行（scripts/selfcheck.mjs），这里不再重复跑一遍。
$asset = Invoke-Pack

# ---------- 4. 校验 zip：条目必须是正斜杠（yauzl 拒绝反斜杠条目），manifest 版本一致 ----------
$zip = [System.IO.Compression.ZipFile]::OpenRead($asset)
try {
  $bad = @($zip.Entries | Where-Object { $_.FullName.Contains("\") })
  if ($bad.Count -gt 0) { throw "zip 条目含反斜杠（yauzl 会拒绝）: $($bad[0].FullName)" }
  $mf = $zip.Entries | Where-Object { $_.FullName -eq "git-save-load/manifest.json" }
  if (-not $mf) { throw "zip 中缺少 git-save-load/manifest.json" }
  $sr = New-Object System.IO.StreamReader($mf.Open())
  $zipVersion = ($sr.ReadToEnd() | ConvertFrom-Json).version
  $sr.Close()
  if ($zipVersion -ne $version) { throw "zip 内 manifest version ($zipVersion) 与发布版本 ($version) 不一致" }
  $sizeKB = [math]::Round((Get-Item $asset).Length / 1KB)
  Write-Host "==> 打包完成: $asset ($sizeKB KB, $($zip.Entries.Count) 个条目)"
} finally { $zip.Dispose() }

$sha256 = (Get-FileHash $asset -Algorithm SHA256).Hash.ToLower()
Write-Host "==> sha256: $sha256"

# ---------- 5. 创建 GitHub Release 并上传 ----------
$notesFile = Join-Path $env:TEMP "gsl-notes-$tag.md"
$notesText = "## Git Save/Load $tag`n`n$Notes`n`n---`n`n安装：下载附件 zip 拖入 HanaAgent 设置 → 插件；提交到官方插件目录后可直接在市场更新。`n"
[System.IO.File]::WriteAllText($notesFile, $notesText, (New-Object System.Text.UTF8Encoding($false)))
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& gh release create $tag $asset --repo $RepoSlug --title "Git Save/Load $tag" --notes-file $notesFile
$ErrorActionPreference = $prevEap
Remove-Item $notesFile -Force
if ($LASTEXITCODE -ne 0) { throw "gh release create 失败（zip 仍在 $asset，可到网页端手动上传）" }

Write-Host ""
Write-Host "==> 发布完成。OH-Plugins 市场条目需要的两个字段："
Write-Host "    packageUrl: https://github.com/$RepoSlug/releases/download/$tag/git-save-load-$tag.zip"
Write-Host "    sha256:     $sha256"
