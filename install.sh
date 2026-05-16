#!/bin/bash
# ============================================================
#  TunnelNet - 一键部署脚本
#  绑定域名: aicq.online  端口: 7739
#  用法: bash install.sh
# ============================================================
set -e

# ======================== 配置 ========================
DOMAIN="aicq.online"
PORT="7739"
DASHBOARD_PORT="3000"
TUNNEL_PORT="3002"
INSTALL_DIR="$HOME/tunnelnet"
REPO_URL="https://github.com/ctz168/tunnel.git"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}  [INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}  [OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}  [WARN]${NC} $1"; }
log_error() { echo -e "${RED}  [ERROR]${NC} $1"; }

echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║                                                  ║"
echo "  ║     TunnelNet 一键部署                           ║"
echo "  ║     固定域名内网穿透服务                          ║"
echo "  ║                                                  ║"
echo "  ║     域名: ${DOMAIN}                              ║"
echo "  ║     端口: ${PORT}                                ║"
echo "  ║                                                  ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""

# ======================== 1. 检测系统 ========================
log_info "检测操作系统..."

detect_os() {
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt-get &>/dev/null; then echo "debian"
    elif command -v yum &>/dev/null; then echo "redhat"
    elif command -v apk &>/dev/null; then echo "alpine"
    else echo "linux"
    fi
  elif [[ "$OSTYPE" == "darwin"* ]]; then echo "macos"
  else echo "unknown"
  fi
}

OS=$(detect_os)
log_ok "系统: $OS"

# ======================== 2. 检查端口占用 ========================
log_info "检查端口 ${PORT}..."

check_port() {
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":${PORT} " && return 0
  elif command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | grep -q ":${PORT} " && return 0
  elif command -v lsof &>/dev/null; then
    lsof -i ":${PORT}" &>/dev/null && return 0
  fi
  return 1
}

if check_port; then
  log_error "端口 ${PORT} 已被占用！请先释放该端口后重试。"
  exit 1
fi
log_ok "端口 ${PORT} 可用"

# ======================== 3. 安装系统依赖 ========================
log_info "安装系统依赖..."

install_deps_debian() {
  log_info "apt-get update..."
  sudo apt-get update -qq
  log_info "安装 curl, unzip, sqlite3, git..."
  sudo apt-get install -y -qq curl unzip sqlite3 git 2>/dev/null
}

install_deps_redhat() {
  sudo yum install -y -q curl unzip sqlite git 2>/dev/null
}

install_deps_alpine() {
  sudo apk add --no-progress curl unzip sqlite git 2>/dev/null
}

install_deps_macos() {
  if ! command -v brew &>/dev/null; then
    log_error "请先安装 Homebrew: https://brew.sh"
    exit 1
  fi
  brew install curl unzip sqlite git 2>/dev/null || true
}

case "$OS" in
  debian) install_deps_debian ;;
  redhat) install_deps_redhat ;;
  alpine) install_deps_alpine ;;
  macos) install_deps_macos ;;
  *) log_warn "未知系统，跳过系统依赖安装" ;;
esac

log_ok "系统依赖安装完成"

# ======================== 4. 安装 Bun ========================
log_info "检查 Bun..."

if command -v bun &>/dev/null; then
  log_ok "Bun 已安装: $(bun --version)"
else
  log_info "安装 Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  log_ok "Bun 安装完成: $(bun --version)"
fi

# 确保 bun 在当前 shell 可用
if ! command -v bun &>/dev/null; then
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# ======================== 5. 克隆项目 ========================
log_info "准备项目目录..."

if [ -d "$INSTALL_DIR" ]; then
  log_warn "项目目录已存在: $INSTALL_DIR"
  log_info "更新代码..."
  cd "$INSTALL_DIR"
  git stash 2>/dev/null || true
  git pull 2>/dev/null || true
else
  log_info "克隆仓库: $REPO_URL"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

log_ok "项目目录: $INSTALL_DIR"

# ======================== 6. 安装依赖 ========================
log_info "安装项目依赖..."
cd "$INSTALL_DIR"
bun install
log_ok "主项目依赖安装完成"

# ======================== 7. 初始化数据库 ========================
log_info "初始化数据库..."
mkdir -p db
DATABASE_URL="file:db/custom.db" bunx prisma db push --skip-generate 2>/dev/null || \
  DATABASE_URL="file:db/custom.db" bunx prisma db push 2>/dev/null || true
DATABASE_URL="file:db/custom.db" bunx prisma generate 2>/dev/null || true
log_ok "主数据库初始化完成"

# tunnel-server 数据库
if [ -d "mini-services/tunnel-server" ]; then
  log_info "安装 tunnel-server 依赖..."
  cd mini-services/tunnel-server
  bun install

  log_info "初始化 tunnel-server 数据库..."
  DATABASE_URL="file:../../db/custom.db" bunx prisma db push --skip-generate 2>/dev/null || true
  DATABASE_URL="file:../../db/custom.db" bunx prisma generate 2>/dev/null || true
  cd "$INSTALL_DIR"
  log_ok "tunnel-server 初始化完成"
fi

# ======================== 8. 更新域名配置 ========================
log_info "配置域名: ${DOMAIN}:${PORT}..."

# 确保数据库中的域名配置正确
DATABASE_URL="file:db/custom.db" node -e "
const { PrismaClient } = require('./node_modules/.prisma/client');
const prisma = new PrismaClient();
(async () => {
  let config = await prisma.serverConfig.findFirst();
  if (config) {
    await prisma.serverConfig.update({
      where: { id: config.id },
      data: { serverDomain: '${DOMAIN}:${PORT}' }
    });
  } else {
    await prisma.serverConfig.create({
      data: { serverDomain: '${DOMAIN}:${PORT}' }
    });
  }
  await prisma.\$disconnect();
  console.log('域名配置已写入数据库');
})().catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null || log_warn "数据库域名配置跳过（首次启动后可通过 Dashboard 修改）"

log_ok "域名配置完成"

# ======================== 9. 创建 systemd 服务 ========================
log_info "配置 systemd 服务..."

SYSTEMD_DIR="/etc/systemd/system"

create_systemd_service() {
  local SERVICE_NAME="$1"
  local WORK_DIR="$2"
  local EXEC_CMD="$3"
  local DESCRIPTION="$4"

  sudo tee "${SYSTEMD_DIR}/${SERVICE_NAME}.service" > /dev/null << EOF
[Unit]
Description=${DESCRIPTION}
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${WORK_DIR}
Environment=DATABASE_URL=file:db/custom.db
Environment=NODE_ENV=production
Environment=TUNNEL_PORT=${TUNNEL_PORT}
ExecStart=${EXEC_CMD}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  log_ok "服务文件已创建: ${SERVICE_NAME}.service"
}

if [[ "$OS" == "linux" ]] && command -v systemctl &>/dev/null && [ -d "$SYSTEMD_DIR" ]; then
  BUN_PATH="$(which bun)"
  NODE_PATH="$(which bun)"

  # tunnelnet-tunnel.service
  create_systemd_service \
    "tunnelnet-tunnel" \
    "$INSTALL_DIR/mini-services/tunnel-server" \
    "$BUN_PATH index.ts" \
    "TunnelNet Tunnel Server (${DOMAIN}:${PORT})"

  # tunnelnet-dashboard.service
  create_systemd_service \
    "tunnelnet-dashboard" \
    "$INSTALL_DIR" \
    "$BUN_PATH .next/standalone/server.js" \
    "TunnelNet Dashboard (${DOMAIN}:${PORT})"

  # 构建生产版本
  log_info "构建 Dashboard 生产版本..."
  cd "$INSTALL_DIR"
  DATABASE_URL="file:db/custom.db" bun run build 2>/dev/null || {
    log_warn "生产构建失败，将使用开发模式启动"
  }

  log_info "重载 systemd..."
  sudo systemctl daemon-reload
  sudo systemctl enable tunnelnet-tunnel 2>/dev/null || true
  sudo systemctl enable tunnelnet-dashboard 2>/dev/null || true

  log_ok "systemd 服务配置完成"
else
  log_warn "systemd 不可用，将使用手动启动方式"
fi

# ======================== 10. 创建管理脚本 ========================
log_info "创建管理脚本..."

cat > "$INSTALL_DIR/manage.sh" << 'MANAGEEOF'
#!/bin/bash
# TunnelNet 管理脚本
cd "$(dirname "$0")"

DOMAIN="aicq.online"
PORT="7739"

case "${1:-status}" in
  start)
    echo "  启动 TunnelNet..."
    if command -v systemctl &>/dev/null; then
      sudo systemctl start tunnelnet-tunnel 2>/dev/null
      sudo systemctl start tunnelnet-dashboard 2>/dev/null
      echo "  [OK] 服务已通过 systemd 启动"
    else
      # 手动启动
      export DATABASE_URL="file:db/custom.db"
      export TUNNEL_PORT="3002"
      cd mini-services/tunnel-server
      DATABASE_URL="file:../../db/custom.db" nohup bun index.ts > /tmp/tunnelnet-tunnel.log 2>&1 &
      TUNNEL_PID=$!
      cd ..
      nohup bun run dev > /tmp/tunnelnet-dashboard.log 2>&1 &
      DASH_PID=$!
      echo "  [OK] Tunnel PID: $TUNNEL_PID"
      echo "  [OK] Dashboard PID: $DASH_PID"
      echo "  [OK] 日志: /tmp/tunnelnet-tunnel.log /tmp/tunnelnet-dashboard.log"
    fi
    echo "  公网地址: http://${DOMAIN}:${PORT}"
    ;;
  stop)
    echo "  停止 TunnelNet..."
    if command -v systemctl &>/dev/null; then
      sudo systemctl stop tunnelnet-dashboard 2>/dev/null
      sudo systemctl stop tunnelnet-tunnel 2>/dev/null
      echo "  [OK] 服务已停止"
    else
      pkill -f "bun index.ts" 2>/dev/null
      pkill -f "next dev" 2>/dev/null
      echo "  [OK] 进程已终止"
    fi
    ;;
  restart)
    "$0" stop
    sleep 2
    "$0" start
    ;;
  status)
    echo ""
    echo "  TunnelNet 状态"
    echo "  ─────────────────────────────"
    if command -v systemctl &>/dev/null; then
      echo "  Tunnel Service:"
      sudo systemctl status tunnelnet-tunnel --no-pager -l 2>/dev/null | head -5
      echo ""
      echo "  Dashboard Service:"
      sudo systemctl status tunnelnet-dashboard --no-pager -l 2>/dev/null | head -5
    else
      if pgrep -f "bun index.ts" &>/dev/null; then
        echo "  Tunnel: 运行中 (PID: $(pgrep -f 'bun index.ts'))"
      else
        echo "  Tunnel: 未运行"
      fi
      if pgrep -f "next dev\|standalone/server" &>/dev/null; then
        echo "  Dashboard: 运行中 (PID: $(pgrep -f 'next dev\|standalone/server'))"
      else
        echo "  Dashboard: 未运行"
      fi
    fi
    echo "  ─────────────────────────────"
    echo "  公网地址: http://${DOMAIN}:${PORT}"
    echo ""
    ;;
  log)
    if command -v systemctl &>/dev/null; then
      sudo journalctl -u tunnelnet-tunnel -f --no-pager
    else
      tail -f /tmp/tunnelnet-tunnel.log
    fi
    ;;
  update)
    echo "  更新 TunnelNet..."
    cd "$(dirname "$0")"
    git stash 2>/dev/null || true
    git pull
    bun install
    DATABASE_URL="file:db/custom.db" bunx prisma db push 2>/dev/null || true
    DATABASE_URL="file:db/custom.db" bunx prisma generate 2>/dev/null || true
    cd mini-services/tunnel-server && bun install && cd ..
    echo "  [OK] 更新完成，请执行: bash manage.sh restart"
    ;;
  *)
    echo ""
    echo "  TunnelNet 管理脚本"
    echo ""
    echo "  用法: bash manage.sh <命令>"
    echo ""
    echo "  命令:"
    echo "    start    启动所有服务"
    echo "    stop     停止所有服务"
    echo "    restart  重启所有服务"
    echo "    status   查看服务状态"
    echo "    log      查看实时日志"
    echo "    update   更新到最新版本"
    echo ""
    ;;
esac
MANAGEEOF

chmod +x "$INSTALL_DIR/manage.sh"
log_ok "管理脚本已创建: $INSTALL_DIR/manage.sh"

# ======================== 11. 开放防火墙端口 ========================
log_info "配置防火墙..."

open_firewall() {
  # 通用方法：尝试多种防火墙工具
  if command -v ufw &>/dev/null; then
    sudo ufw allow ${PORT}/tcp 2>/dev/null && log_ok "ufw: 端口 ${PORT} 已开放"
  fi
  if command -v firewall-cmd &>/dev/null; then
    sudo firewall-cmd --permanent --add-port=${PORT}/tcp 2>/dev/null
    sudo firewall-cmd --reload 2>/dev/null
    log_ok "firewalld: 端口 ${PORT} 已开放"
  fi
  if command -v iptables &>/dev/null; then
    sudo iptables -I INPUT -p tcp --dport ${PORT} -j ACCEPT 2>/dev/null && \
    log_ok "iptables: 端口 ${PORT} 已开放"
  fi
}

if [[ "$OS" != "macos" ]]; then
  open_firewall
else
  log_warn "macOS 跳过防火墙配置"
fi

# ======================== 完成 ========================
echo ""
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║                                                  ║"
echo "  ║            部署完成！                             ║"
echo "  ║                                                  ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}公网隧道地址:${NC} http://${DOMAIN}:${PORT}"
echo -e "  ${GREEN}管理面板:${NC}     http://${DOMAIN}:${PORT}"
echo -e "  ${GREEN}WebSocket:${NC}    ws://${DOMAIN}:${PORT}/ws?key=<密钥>"
echo ""
echo "  ──────────── 快速启动 ────────────"
echo ""
if command -v systemctl &>/dev/null; then
  echo "  启动服务:"
  echo "    bash $INSTALL_DIR/manage.sh start"
  echo ""
  echo "  查看状态:"
  echo "    bash $INSTALL_DIR/manage.sh status"
  echo ""
  echo "  查看日志:"
  echo "    bash $INSTALL_DIR/manage.sh log"
  echo ""
  echo "  停止服务:"
  echo "    bash $INSTALL_DIR/manage.sh stop"
  echo ""
else
  echo "  启动服务（开发模式）:"
  echo "    cd $INSTALL_DIR && bun run dev &"
  echo "    cd $INSTALL_DIR/mini-services/tunnel-server && DATABASE_URL=file:../../db/custom.db bun index.ts &"
  echo ""
  echo "  或使用管理脚本:"
  echo "    bash $INSTALL_DIR/manage.sh start"
  echo ""
fi
echo "  ──────────── 客户端使用 ────────────"
echo ""
echo "  1. 打开 Dashboard: http://${DOMAIN}:${PORT}"
echo "  2. 创建隧道，获取 8 位密钥"
echo "  3. 在客户端机器上运行:"
echo ""
echo -e "     ${CYAN}tunnelnet --key <密钥> --port <本地端口>${NC}"
echo ""
echo "  示例: tunnelnet --key ABCD1234 --port 8080"
echo "  之后公网即可通过 http://${DOMAIN}:${PORT}/ABCD1234 访问本地服务"
echo ""
echo "  ────────────────────────────────────"
echo ""
