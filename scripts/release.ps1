#requires -Version 5.1
<#
Git Save/Load 一键发版脚本

用法:
  .\scripts\release.ps1                                  # 用 manifest.json 的版本号发版
  .\scripts\release.ps1 -Notes "- 修复xxx`n- 新增yyy"    # 附带发布说明（支持多行）
  .\scripts\release.ps1 -PackageOnly                     # 只打包不发布（输出 zip 与 sha256）

前置条件:
  - gh CLI 已安装并登录（gh auth login）
  - 工作区干净：改动已提交并推送
  - manifest.json 的 version 就是本次要发的版本号（tag 与它强绑定）
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

# ---------- 3. 打包：顶层 git-save-load/ 包裹（宿主安装时自动剥壳） ----------
$stage = Join-Path $env:TEMP ("gsl-release-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$pkgDir = Join-Path $stage "git-save-load"
New-Item -ItemType Directory -Path $pkgDir -Force | Out-Null
$exclude = @(".git", ".github", "scripts")
Get-ChildItem $repoRoot -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName $pkgDir -Recurse -Force
}
$asset = Join-Path $env:TEMP "git-save-load-$tag.zip"
if (Test-Path $asset) { Remove-Item $asset -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
# 不用 CreateFromDirectory：部分 .NET 版本会把条目名写成反斜杠，宿主的 yauzl 解压器直接拒绝。
# 手动逐条添加，显式用正斜杠拼条目名。
$zip = [System.IO.Compression.ZipFile]::Open($asset, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $allFiles = Get-ChildItem $pkgDir -Recurse -File -Force
  foreach ($f in $allFiles) {
    $rel = $f.FullName.Substring($pkgDir.Length).TrimStart("\", "/").Replace("\", "/")
    $entryName = "git-save-load/" + $rel
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
    $entryStream = $entry.Open()
    $entryStream.Write($bytes, 0, $bytes.Length)
    $entryStream.Close()
  }
} finally { $zip.Dispose() }
Remove-Item $stage -Recurse -Force

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

if ($PackageOnly) {
  Write-Host "==> -PackageOnly：到此为止，未发布。"
  return
}

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
