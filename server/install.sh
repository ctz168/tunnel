#!/bin/bash
# ============================================================
#  Tunnel Server - 一键部署脚本
#  绑定域名: aicq.online  端口: 7739
#  用法: cd server && sudo bash install.sh
# ============================================================
set -e

DOMAIN="aicq.online"
PORT="7739"

# 安装目录 = install.sh 所在目录（即 server/）
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
# 项目根目录 = server/ 的上级
PROJECT_DIR="$(cd "$INSTALL_DIR/.." && pwd)"
REAL_USER="${SUDO_USER:-$(whoami)}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${CYAN}  [INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}  [OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}  [WARN]${NC} $1"; }
log_error() { echo -e "${RED}  [ERROR]${NC} $1"; }

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║     Tunnel Server 一键部署                    ║"
echo "  ║     固定域名内网穿透服务                       ║"
echo "  ║     域名: ${DOMAIN}  端口: ${PORT}             ║"
echo "  ║                                              ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# ======================== 1. 系统 ========================
log_info "检测系统..."
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  if command -v apt-get &>/dev/null;   then OS="debian"
  elif command -v yum &>/dev/null;     then OS="redhat"
  elif command -v apk &>/dev/null;     then OS="alpine"
  else OS="linux"; fi
elif [[ "$OSTYPE" == "darwin"* ]]; then OS="macos"
else OS="unknown"; fi
log_ok "系统: $OS"
log_info "安装用户: $REAL_USER"
log_info "项目目录: $PROJECT_DIR"
log_info "服务目录: $INSTALL_DIR"

# ======================== 2. 检测 systemd ========================
SERVICE_FILE="/etc/systemd/system/tunnel.service"
HAS_SYSTEMD=false
SYSTEMCTL_CMD="systemctl"

if [ -x "/usr/bin/systemctl" ]; then
  SYSTEMCTL_CMD="/usr/bin/systemctl"; HAS_SYSTEMD=true
elif [ -x "/bin/systemctl" ]; then
  SYSTEMCTL_CMD="/bin/systemctl"; HAS_SYSTEMD=true
elif [ -x "/usr/sbin/systemctl" ]; then
  SYSTEMCTL_CMD="/usr/sbin/systemctl"; HAS_SYSTEMD=true
elif [ -x "/usr/sbin/systemd" ]; then
  HAS_SYSTEMD=true
fi

# ======================== 3. 端口检查 ========================
log_info "检查端口 ${PORT}..."
PORT_OCCUPIED=false
if command -v ss &>/dev/null; then
  ss -tlnp 2>/dev/null | grep -q ":${PORT} " && PORT_OCCUPIED=true
elif command -v lsof &>/dev/null; then
  lsof -i ":${PORT}" &>/dev/null && PORT_OCCUPIED=true
fi

if [ "$PORT_OCCUPIED" = true ]; then
  log_warn "端口 ${PORT} 已被占用，尝试停止现有服务..."
  # 尝试通过 systemd 停止
  if [ "$HAS_SYSTEMD" = true ] && [ -f "/etc/systemd/system/tunnel.service" ]; then
    $SYSTEMCTL_CMD stop tunnel 2>/dev/null && sleep 1
  fi
  # 强制杀残留进程
  if command -v lsof &>/dev/null; then
    kill $(lsof -t -i ":${PORT}" 2>/dev/null) 2>/dev/null && sleep 1 || true
  fi
  # 再次检查
  PORT_OCCUPIED=false
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":${PORT} " && PORT_OCCUPIED=true
  elif command -v lsof &>/dev/null; then
    lsof -i ":${PORT}" &>/dev/null && PORT_OCCUPIED=true
  fi
  if [ "$PORT_OCCUPIED" = true ]; then
    log_error "端口 ${PORT} 仍被占用，请手动释放后重试"
    exit 1
  fi
fi
log_ok "端口 ${PORT} 可用"

# ======================== 3. 安装系统依赖 ========================
log_info "安装系统依赖..."
if [[ "$OS" == "debian" ]]; then
  apt-get update -qq && apt-get install -y -qq python3 python3-pip python3-venv git 2>/dev/null || true
elif [[ "$OS" == "redhat" ]]; then
  yum install -y -q python3 python3-pip git 2>/dev/null || true
elif [[ "$OS" == "alpine" ]]; then
  apk add --no-progress python3 py3-pip git 2>/dev/null || true
elif [[ "$OS" == "macos" ]]; then
  if ! command -v python3 &>/dev/null; then
    log_error "请先安装 Python 3: brew install python3"
    exit 1
  fi
fi
log_ok "系统依赖安装完成"

# ======================== 4. 确认代码 ========================
log_info "确认代码..."
if [ ! -f "$INSTALL_DIR/server.py" ]; then
  log_error "找不到 server.py，请在 server/ 目录下运行此脚本"
  exit 1
fi
if [ ! -f "$INSTALL_DIR/db.py" ]; then
  log_error "找不到 db.py"
  exit 1
fi
chown -R "$REAL_USER:$REAL_USER" "$PROJECT_DIR" 2>/dev/null || true
log_ok "代码目录: $INSTALL_DIR"

# ======================== 5. Python 虚拟环境 ========================
log_info "创建 Python 虚拟环境..."
cd "$INSTALL_DIR"
if [ ! -d "venv" ]; then
  python3 -m venv venv
fi
source venv/bin/activate
log_ok "虚拟环境: $(python3 --version)"

# ======================== 6. 安装依赖 ========================
log_info "安装 Python 依赖..."
pip install -q -r requirements.txt
log_ok "Python 依赖安装完成"

# ======================== 7. 初始化数据库 ========================
log_info "初始化数据库..."
mkdir -p "$PROJECT_DIR/data"
chown -R "$REAL_USER:$REAL_USER" "$PROJECT_DIR/data" 2>/dev/null || true
DB_PATH="$PROJECT_DIR/data/tunnel.db" python3 -c "
import asyncio, sys
sys.path.insert(0, '.')
import db
asyncio.run(db.init_db())
print('  数据库初始化完成')
" 2>&1 || log_warn "数据库将在首次启动时自动初始化"

# ======================== 8. systemd 服务 ========================
if [ "$HAS_SYSTEMD" = true ]; then
  log_info "配置 systemd 服务..."
  cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Tunnel Server (${DOMAIN}:${PORT})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${REAL_USER}
Group=${REAL_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=DB_PATH=${PROJECT_DIR}/data/tunnel.db
Environment=SERVER_PORT=${PORT}
ExecStart=${INSTALL_DIR}/venv/bin/python3 server.py
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  chmod 644 "$SERVICE_FILE"
  $SYSTEMCTL_CMD daemon-reload
  $SYSTEMCTL_CMD enable tunnel 2>/dev/null || true
  log_ok "systemd 服务已配置 ($SYSTEMCTL_CMD)"
else
  log_warn "systemd 不可用，将使用 nohup 后台启动"
fi

# ======================== 9. 防火墙 ========================
log_info "配置防火墙..."
if command -v ufw &>/dev/null; then
  ufw allow ${PORT}/tcp 2>/dev/null && log_ok "ufw: 端口 ${PORT} 已开放" || true
fi
if command -v firewall-cmd &>/dev/null; then
  firewall-cmd --permanent --add-port=${PORT}/tcp 2>/dev/null && firewall-cmd --reload 2>/dev/null
  log_ok "firewalld: 端口 ${PORT} 已开放" || true
fi

# ======================== 10. 启动服务 ========================
log_info "启动服务..."
if [ "$HAS_SYSTEMD" = true ]; then
  $SYSTEMCTL_CMD restart tunnel
  sleep 1
  if $SYSTEMCTL_CMD is-active --quiet tunnel; then
    log_ok "Tunnel 服务已启动 (systemd)"
  else
    log_warn "systemd 启动失败，尝试 nohup..."
    cd "$INSTALL_DIR"
    source venv/bin/activate
    nohup python3 server.py > /tmp/tunnel.log 2>&1 &
    TUNNEL_PID=$!
    echo "$TUNNEL_PID" > /tmp/tunnel.pid
    log_ok "Tunnel 已后台启动 (PID: $TUNNEL_PID)"
  fi
else
  cd "$INSTALL_DIR"
  source venv/bin/activate
  nohup python3 server.py > /tmp/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  echo "$TUNNEL_PID" > /tmp/tunnel.pid
  log_ok "Tunnel 已后台启动 (PID: $TUNNEL_PID)"
  log_info "日志: tail -f /tmp/tunnel.log"
fi

# ======================== 完成 ========================
echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║            部署完成！                         ║"
echo "  ║                                              ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}公网地址:${NC}   http://${DOMAIN}:${PORT}"
echo -e "  ${GREEN}管理面板:${NC}   http://${DOMAIN}:${PORT}"
echo ""
echo "  ──── 管理命令 ────"
echo ""
if [ "$HAS_SYSTEMD" = true ]; then
  echo "  $SYSTEMCTL_CMD start tunnel    # 启动"
  echo "  $SYSTEMCTL_CMD stop tunnel     # 停止"
  echo "  $SYSTEMCTL_CMD restart tunnel  # 重启"
  echo "  $SYSTEMCTL_CMD status tunnel   # 状态"
  echo "  journalctl -u tunnel -f        # 日志"
  echo ""
else
  echo "  停止: kill \$(cat /tmp/tunnel.pid)"
  echo "  日志: tail -f /tmp/tunnel.log"
  echo ""
fi
echo "  ──── 客户端使用 ────"
echo ""
echo "  1. 打开 http://${DOMAIN}:${PORT} 创建隧道"
echo "  2. 获取认证令牌后，在客户端运行:"
echo ""
echo -e "     ${CYAN}python3 client.py --key <认证令牌> --port <本地端口>${NC}"
echo ""
echo "  示例: python3 client.py --key xxx --port 8080"
echo "  公网访问: http://${DOMAIN}:${PORT}/<隧道编码>"
echo ""
