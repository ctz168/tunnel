# ============================================================
#  Tunnel Client - 一键安装脚本 (Windows PowerShell)
#  用法: 以管理员身份运行 PowerShell，执行:
#        Set-ExecutionPolicy Bypass -Scope Process -Force; .\install.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Info  { Write-Host "  [INFO] $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "  [OK]   $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "  [WARN] $args" -ForegroundColor Yellow }
function Write-Err   { Write-Host "  [ERROR] $args" -ForegroundColor Red }

Write-Host ""
Write-Host "  ============================================"
Write-Host "  |                                          |"
Write-Host "  |     Tunnel Client Windows 安装            |"
Write-Host "  |     内网穿透客户端                         |"
Write-Host "  |                                          |"
Write-Host "  ============================================"
Write-Host ""

# ======================== 1. 检查 Python ========================
Write-Info "检查 Python..."
$pythonCmd = $null
foreach ($cmd in @("python3", "python", "py")) {
    try {
        $version = & $cmd --version 2>&1
        if ($version -match "Python 3") {
            $pythonCmd = $cmd
            Write-Ok "找到 $version"
            break
        }
    } catch {}
}

if (-not $pythonCmd) {
    Write-Err "未找到 Python 3，请先安装: https://www.python.org/downloads/"
    Write-Host "  安装时请勾选 'Add Python to PATH'"
    exit 1
}

# ======================== 2. 创建虚拟环境 ========================
Write-Info "创建虚拟环境..."
Set-Location $InstallDir
if (-not (Test-Path "venv")) {
    & $pythonCmd -m venv venv
    if ($LASTEXITCODE -ne 0) {
        Write-Err "创建虚拟环境失败"
        exit 1
    }
}
Write-Ok "虚拟环境已就绪"

# ======================== 3. 安装依赖 ========================
Write-Info "安装 Python 依赖..."
& ".\venv\Scripts\pip.exe" install -q -r requirements.txt
if ($LASTEXITCODE -ne 0) {
    Write-Err "依赖安装失败"
    exit 1
}
Write-Ok "依赖安装完成"

# ======================== 4. 创建启动脚本 ========================
$batContent = @"
@echo off
cd /d "%~dp0"
call venv\Scripts\activate.bat
python client.py %*
pause
"@
$batContent | Out-File -FilePath "$InstallDir\start.bat" -Encoding ASCII
Write-Ok "已创建 start.bat 快捷启动脚本"

# ======================== 完成 ========================
Write-Host ""
Write-Host "  ============================================"
Write-Host "  |                                          |"
Write-Host "  |        客户端安装完成！                    |"
Write-Host "  |                                          |"
Write-Host "  ============================================"
Write-Host ""
Write-Host "  安装目录: $InstallDir"
Write-Host ""
Write-Host "  ---- 使用方法 ----"
Write-Host ""
Write-Host "  方式一: 双击 start.bat，输入参数启动"
Write-Host ""
Write-Host "  方式二: 命令行启动"
Write-Host "    cd $InstallDir"
Write-Host "    .\venv\Scripts\activate"
Write-Host "    python client.py --key <认证令牌> --port 8080"
Write-Host ""
Write-Host "  参数说明:"
Write-Host "    --key, -k    认证令牌（管理面板创建隧道时生成）"
Write-Host "    --port, -p   本地服务端口（默认: 8080）"
Write-Host "    --server, -s 服务器地址（默认: aicq.online:7739）"
Write-Host "    --host       本地服务地址（默认: localhost）"
Write-Host ""
