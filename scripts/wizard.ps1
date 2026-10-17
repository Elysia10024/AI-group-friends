# wizard.ps1 — 群友 AI · 一键安装向导
#
# 目标：让一台"只有 Windows、什么都没装"的电脑也能把 AI 群友跑起来。
# 全程一问一答，不需要懂命令行、不需要手改 JSON。
#
# 用法：
#   双击仓库根目录的「一键安装.bat」（推荐）
#   或在本目录执行：powershell -ExecutionPolicy Bypass -File scripts\wizard.ps1
#
# 参数：
#   -Check   只体检，不安装、不改配置（排查环境用）
#
# 注意：本文件必须带 UTF-8 BOM。PowerShell 5.1 读无 BOM 的 UTF-8 会按 GBK 解码，
# 中文全变乱码、语法直接崩（2026-10-17 踩过）。

param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root        = Split-Path -Parent $PSScriptRoot
$ConfigPath  = Join-Path $Root 'config.json'
$ExamplePath = Join-Path $Root 'config.example.json'
$DshUrl      = 'http://127.0.0.1:3080'
$DshDownload = 'https://github.com/anywhere-labs/deepseek-harness-desktop/releases'
$SlDownload  = 'https://github.com/SnowLuma/SnowLuma/releases/latest'
$NodeDownload= 'https://nodejs.org/zh-cn/download'

function Write-Step($n, $text) {
    Write-Host ''
    Write-Host ('-' * 60) -ForegroundColor DarkCyan
    Write-Host ("  第 $n 步 / $text") -ForegroundColor Cyan
    Write-Host ('-' * 60) -ForegroundColor DarkCyan
}
function Write-Ok($t)   { Write-Host "  [完成] $t" -ForegroundColor Green }
function Write-Warn($t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Write-Info($t) { Write-Host "  $t" -ForegroundColor Gray }
function Pause-User($msg) { Read-Host "`n  >>> $msg" | Out-Null }

function Test-DshAlive {
    try {
        $r = Invoke-WebRequest $DshUrl -TimeoutSec 3 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Test-OneBotAlive([string]$httpUrl) {
    try {
        $r = Invoke-WebRequest ("{0}/get_status" -f $httpUrl.TrimEnd('/')) -TimeoutSec 3 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Get-NodeVersion {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    try {
        $v = (& node -v) -replace '^v', ''
        return [version]$v
    } catch { return $null }
}

# ============================================================
Write-Host ''
Write-Host '  ##################################################' -ForegroundColor Magenta
Write-Host '  #                                                #' -ForegroundColor Magenta
Write-Host '  #        群友 AI · 一键安装向导                  #' -ForegroundColor Magenta
Write-Host '  #                                                #' -ForegroundColor Magenta
Write-Host '  ##################################################' -ForegroundColor Magenta
Write-Host ''
Write-Info '会依次检查三样东西：DSH Desktop、SnowLuma、Node.js。'
Write-Info '缺哪个就装哪个；都齐了，问你 4 个问题就能跑起来。'
Write-Info '全程大约 10~15 分钟，中途可以随时按 Ctrl+C 退出。'
if ($Check) { Write-Warn '当前是「只体检模式」：不会安装、不会改配置。' }
Pause-User '准备好了就按回车开始'

# ============================================================
Write-Step 1 '检查 Node.js（运行桥接用的）'
$nodeVer = Get-NodeVersion
if ($null -eq $nodeVer) {
    Write-Warn '这台电脑上还没装 Node.js。'
    Write-Info ''
    Write-Info '请打开下面这个网址，下载「LTS」版本，安装时一路点"下一步"即可：'
    Write-Host "     $NodeDownload" -ForegroundColor Cyan
    Write-Info ''
    Write-Info '装完回来这里按回车，我会重新检查。'
    Pause-User '装好 Node.js 后按回车'
    $nodeVer = Get-NodeVersion
    if ($null -eq $nodeVer) {
        Write-Warn '还是没检测到 Node.js。可能装完需要重开这个窗口。'
        Write-Info '把窗口关掉，重新双击「一键安装.bat」再来一次。'
        Pause-User '按回车退出'
        exit 1
    }
}
if ($nodeVer -lt [version]'22.13.0') {
    Write-Warn "当前 Node.js 是 $nodeVer，需要 22.13 或更高。"
    Write-Info "请到 $NodeDownload 下载新版覆盖安装，然后重开本向导。"
    Pause-User '按回车退出'
    exit 1
}
Write-Ok "Node.js $nodeVer"

# ============================================================
Write-Step 2 '检查 DSH Desktop（AI 的大脑）'
$dshAlive = Test-DshAlive
if ($dshAlive) {
    Write-Ok "DSH 正在运行（$DshUrl）"
} else {
    Write-Warn "在 $DshUrl 没找到 DSH。"
    Write-Info ''
    Write-Info 'DSH Desktop 是「群友 AI」的大脑，必须先装好并开机运行。'
    Write-Info '下载地址（选最新版本的 Windows 安装包）：'
    Write-Host "     $DshDownload" -ForegroundColor Cyan
    Write-Info ''
    Write-Info '装好之后打开 DSH，让它停在桌面上（别关），再回来继续。'
    Pause-User 'DSH 已经打开后按回车，我会重新检查'
    if (-not (Test-DshAlive)) {
        Write-Warn '仍然连不上 DSH。'
        Write-Info '请确认：① DSH 窗口确实开着；② 没有改过它的端口（默认 3080）。'
        Pause-User '按回车退出'
        exit 1
    }
    Write-Ok "DSH 已连上（$DshUrl）"
}

# ============================================================
Write-Step 3 '检查 SnowLuma（QQ 那一端）'
Write-Info 'SnowLuma 负责登录你的 QQ 账号，并把消息转给桥接。'
Write-Info ''
$slReady = $false
while (-not $slReady) {
    $slWs  = Read-Host '  SnowLuma 的 OneBot WebSocket 地址（直接回车用默认 ws://127.0.0.1:3001）'
    if ([string]::IsNullOrWhiteSpace($slWs)) { $slWs = 'ws://127.0.0.1:3001' }
    $slHttp = Read-Host '  SnowLuma 的 OneBot HTTP 地址（直接回车用默认 http://127.0.0.1:3000）'
    if ([string]::IsNullOrWhiteSpace($slHttp)) { $slHttp = 'http://127.0.0.1:3000' }

    if (Test-OneBotAlive $slHttp) {
        Write-Ok "SnowLuma 已连上（$slHttp）"
        $slReady = $true
    } else {
        Write-Warn "连不上 $slHttp"
        Write-Info ''
        Write-Info '如果你还没装 SnowLuma：'
        Write-Host "     $SlDownload" -ForegroundColor Cyan
        Write-Info '下载带 Node 运行时的完整版，解压后双击 launcher.bat，按网页提示扫码登录 QQ。'
        Write-Info ''
        Write-Info '登录后在 SnowLuma 的网页设置里，把 OneBot 的「WebSocket 服务端」和「HTTP API」都打开。'
        Write-Info '默认端口就是 3001 / 3000，保持一致最省事。'
        Pause-User '弄好之后按回车，我再检查一次'
    }
}

$slToken = Read-Host '  SnowLuma 的 accessToken（没设置过就直接回车）'
if ($null -eq $slToken) { $slToken = '' }

# ============================================================
Write-Step 4 '安装依赖（一次性，约 1~3 分钟）'
if ($Check) {
    Write-Info '[体检模式] 跳过 npm install'
} else {
    Write-Info '正在执行 npm install ...'
    Push-Location $Root
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install 退出码 $LASTEXITCODE" }
        Write-Ok '依赖装好了'
    } catch {
        Write-Warn "装依赖失败：$_"
        Write-Info '常见原因：网络问题（可试试挂代理），或者 Node.js 版本太低。'
        Pop-Location
        Pause-User '按回车退出'
        exit 1
    }
    Pop-Location
}

# ============================================================
Write-Step 5 '回答 4 个问题，生成配置'

$ownerQQ = Read-Host '  ① 你的 QQ 号（用来接收"主人专属"提示，可留空）'
$ownerQQ = ($ownerQQ -replace '[^\d]', '')
if ([string]::IsNullOrEmpty($ownerQQ)) { $ownerQQ = '0' }

$allowPrivate = Read-Host '  ② 允许她私聊哪些 QQ（多个用逗号隔开，直接回车 = 先不加）'
$allowGroups  = Read-Host '  ③ 允许她参与哪些群（群号，多个用逗号隔开，直接回车 = 先不加）'

function Split-QQList([string]$raw) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    $parts = $raw -split '[,，;；\s]+'
    $out = @()
    foreach ($p in $parts) {
        $d = ($p -replace '[^\d]', '')
        if ($d -and $d.Length -ge 5) { $out += [long]$d }
    }
    return $out
}
$privList  = Split-QQList $allowPrivate
$groupList = Split-QQList $allowGroups

Write-Info ''
Write-Info '④ 最后确认一下：'
Write-Info "    DSH   : $DshUrl"
Write-Info "    桥接  : $slWs / $slHttp"
Write-Info "    主人  : $(if ($ownerQQ -eq '0') { '(没填)' } else { $ownerQQ })"
Write-Info "    私聊白名单: $(if ($privList.Count)  { $privList -join ', ' }  else { '(空)' })"
Write-Info "    群白名单  : $(if ($groupList.Count) { $groupList -join ', ' } else { '(空)' })"

if ($Check) {
    Write-Info ''
    Write-Host '  体检到此结束：环境都齐了。' -ForegroundColor Green
    Pause-User '按回车退出'
    exit 0
}

# 用模板做底，只覆盖关键字段（模板里那些高级默认值全部保留）
$cfg = Get-Content $ExamplePath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.dsh.baseUrl = $DshUrl
$cfg.snowluma.wsUrl = $slWs
$cfg.snowluma.httpUrl = $slHttp
$cfg.snowluma.accessToken = $slToken
$cfg.snowluma.launcherPath = ''
$cfg.snowluma.homeDir = ''
$cfg.ownerQQ = [long]$ownerQQ
$cfg.allow.private = $privList
$cfg.allow.groups = $groupList
$cfg.allowAllWhenEmpty = $false
if (-not $cfg.consoleToken) { $cfg.consoleToken = '' }

$cfg | ConvertTo-Json -Depth 30 | Set-Content -Path $ConfigPath -Encoding UTF8
Write-Ok "配置已写入 config.json"

# ============================================================
Write-Step 6 '把 DSH 端也配好（聊天预设 + 工具）'
Write-Info '正在执行 node scripts/setup-dsh.mjs ...'
Push-Location $Root
try {
    & node scripts/setup-dsh.mjs
    Write-Ok 'DSH 端配置完成'
} catch {
    Write-Warn "setup-dsh 出错：$_"
    Write-Info '可以稍后手动重跑：node scripts/setup-dsh.mjs'
} finally {
    Pop-Location
}

# ============================================================
Write-Step 7 '全部完成'
Write-Host ''
Write-Host '  接下来会启动桥接。请在 QQ 上给机器人账号发一条消息测试。' -ForegroundColor Green
Write-Host ''
Write-Info '以后想再启动：双击仓库里的 start.bat'
Write-Info '想重启桥接  ：双击 restart.bat'
Write-Info '浏览器控制台：http://127.0.0.1:3100（令牌在 state/console-token）'
Write-Info '详细说明    ：SETUP.md'
Write-Host ''
Pause-User '按回车启动桥接'

Push-Location $Root
& node src/bridge.js
Pop-Location
