# 发布 @psyduck25/dsh-session-manager 到 npm 公共仓库
#
# 用法：在这个目录里运行
#     powershell -ExecutionPolicy Bypass -File .\publish-npm.ps1
#
# 它会依次做四件事，每一步失败都会停下并说明原因：
#   1. 检查工作区干净、远端已同步
#   2. 登录 npm（会打开浏览器，登录一次以后不用再登）
#   3. 确认包名还没被人占
#   4. 发布，并回查确认真的上去了
#
# 显式指定 registry.npmjs.org：本机默认源是 npmmirror 镜像，那个是只读的，发不了包。

$ErrorActionPreference = 'Stop'
$Registry = 'https://registry.npmjs.org/'

function Step($n, $text) { Write-Host "`n[$n/4] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "  OK   $text" -ForegroundColor Green }
function Bad($text) { Write-Host "  FAIL $text" -ForegroundColor Red }

# ---------------------------------------------------------------- 1. 前置检查

Step 1 '检查仓库状态'

if (-not (Test-Path -Path '.\package.json')) {
  Bad '这里不是插件目录（找不到 package.json）'
  exit 1
}

$pkg = Get-Content '.\package.json' -Raw | ConvertFrom-Json
Write-Host "  包名: $($pkg.name)"
Write-Host "  版本: $($pkg.version)"

$dirty = git status --porcelain
if ($dirty) {
  Bad '工作区有未提交的改动，先处理干净再发：'
  $dirty | ForEach-Object { Write-Host "       $_" }
  exit 1
}
Ok '工作区干净'

$local = git rev-parse HEAD
# 注意：不能用 2>$null 吞掉 git 的报错 —— $ErrorActionPreference='Stop' 下
# 「没有上游分支」这类 stderr 输出仍然会中断脚本。先切回 Continue，跑完再切回来。
$saved = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$remote = git rev-parse '@{u}' 2>$null
$hasUpstream = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $saved

if (-not $hasUpstream) {
  Write-Host '  提示: 没有配置上游分支，跳过远端同步检查' -ForegroundColor Yellow
} elseif ($local -ne $remote) {
  Bad "本地 $($local.Substring(0,7)) 与远端 $($remote.Substring(0,7)) 不一致，先 push"
  exit 1
} else {
  Ok "已与远端同步 ($($local.Substring(0,7)))"
}

# ---------------------------------------------------------------- 2. 登录

Step 2 '登录 npm'

$who = $null
$saved = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$who = npm whoami --registry $Registry 2>$null
$loggedIn = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $saved

if ($loggedIn) {
  Ok "已登录为 $who"
} else {
  Write-Host '  未登录，即将打开浏览器。登录后回到这个窗口。' -ForegroundColor Yellow
  npm login --registry $Registry --auth-type web
  if ($LASTEXITCODE -ne 0) {
    Bad '登录失败'
    exit 1
  }
  $who = npm whoami --registry $Registry
  Ok "已登录为 $who"
}

# ---------------------------------------------------------------- 3. 名字可用？

Step 3 '确认包名可用'

$encoded = $pkg.name.Replace('/', '%2F').Replace('@', '%40')
try {
  $response = Invoke-WebRequest -Uri "https://registry.npmjs.org/$encoded" -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 20
} catch {
  $response = $null
}

if ($null -ne $response -and $response.StatusCode -eq 200) {
  $existing = $response.Content | ConvertFrom-Json
  $published = $existing.'dist-tags'.latest
  if ($published -eq $pkg.version) {
    Bad "版本 $($pkg.version) 已经发布过了，要重新发得先改版本号"
    exit 1
  }
  Write-Host "  已存在 $($pkg.name)@$published，本次将发布新版本 $($pkg.version)" -ForegroundColor Yellow
} elseif ($null -ne $response -and $response.StatusCode -eq 404) {
  Ok '名字可用，这是首次发布'
} else {
  Write-Host '  查不到 registry 响应，继续尝试发布' -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 4. 发布

Step 4 "发布 $($pkg.name)@$($pkg.version)"

npm publish --registry $Registry --access public
if ($LASTEXITCODE -ne 0) {
  Bad '发布失败，看上面的错误'
  exit 1
}
Ok '发布命令已返回成功'

Write-Host '  等待 registry 同步…' -ForegroundColor Yellow
Start-Sleep -Seconds 6

$verify = Invoke-WebRequest -Uri "https://registry.npmjs.org/$encoded" -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 20
if ($verify.StatusCode -eq 200) {
  $live = $verify.Content | ConvertFrom-Json
  Ok "确认上线：https://www.npmjs.com/package/$($pkg.name)"
  Ok "最新版本: $($live.'dist-tags'.latest)"
  Write-Host "`n别人现在可以这样装：" -ForegroundColor Green
  Write-Host "    dsh plugin add $($pkg.name)" -ForegroundColor White
  Write-Host "`n下载量统计（有约 24 小时延迟）：" -ForegroundColor Green
  Write-Host "    https://www.npmjs.com/package/$($pkg.name)" -ForegroundColor White
} else {
  Write-Host '  发布命令成功了，但 registry 还没回显，通常等 1-2 分钟就好' -ForegroundColor Yellow
  Write-Host "  稍后打开 https://www.npmjs.com/package/$($pkg.name) 确认" -ForegroundColor Yellow
}