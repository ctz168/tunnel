#!/bin/bash
# ============================================================
#  TunnelNet - 一键部署脚本
#  绑定域名: aicq.online  端口: 7739
#  用法: bash install.sh
# ============================================================
set -e

DOMAIN="aicq.online"
PORT="7739"
INSTALL_DIR="$HOME/tunnelnet"
REPO_URL="https://github.com/ctz168/tunnel.git"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${CYAN}  [INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}  [OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}  [WARN]${NC} $1"; }
log_error() { echo -e "${RED}  [ERROR]${NC} $1"; }

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║     TunnelNet 一键部署                        ║"
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

# ======================== 2. 端口检查 ========================
log_info "检查端口 ${PORT}..."
if command -v ss &>/dev/null; then ss -tlnp 2>/dev/null | grep -q ":${PORT} " && { log_error "端口 ${PORT} 已被占用"; exit 1; }
elif command -v lsof &>/dev/null; then lsof -i ":${PORT}" &>/dev/null && { log_error "端口 ${PORT} 已被占用"; exit 1; }
fi
log_ok "端口 ${PORT} 可用"

# ======================== 3. 安装系统依赖 ========================
log_info "安装系统依赖..."
if [[ "$OS" == "debian" ]]; then
  sudo apt-get update -qq && sudo apt-get install -y -qq python3 python3-pip python3-venv git 2>/dev/null
elif [[ "$OS" == "redhat" ]]; then
  sudo yum install -y -q python3 python3-pip git 2>/dev/null
elif [[ "$OS" == "alpine" ]]; then
  sudo apk add --no-progress python3 py3-pip git 2>/dev/null
elif [[ "$OS" == "macos" ]]; then
  if ! command -v python3 &>/dev/null; then
    log_error "请先安装 Python 3: brew install python3"
    exit 1
  fi
fi
log_ok "系统依赖安装完成"

# ======================== 4. 克隆项目 ========================
log_info "准备项目..."
if [ -d "$INSTALL_DIR" ]; then
  log_warn "目录已存在: $INSTALL_DIR，更新中..."
  cd "$INSTALL_DIR" && git pull 2>/dev/null || true
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
log_ok "项目目录: $INSTALL_DIR"

# ======================== 5. Python 虚拟环境 ========================
log_info "创建 Python 虚拟环境..."
cd "$INSTALL_DIR/server"
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
mkdir -p "$INSTALL_DIR/data"
DB_PATH="$INSTALL_DIR/data/tunnel.db" python3 -c "
import asyncio, sys
sys.path.insert(0, '.')
import db
asyncio.run(db.init_db())
print('  数据库初始化完成')
" 2>&1 || log_warn "数据库将在首次启动时自动初始化"

# ======================== 8. systemd 服务 ========================
log_info "配置 systemd 服务..."
SERVICE_FILE="/etc/systemd/system/tunnelnet.service"

if [[ "$OS" == "linux" ]] && command -v systemctl &>/dev/null && [ -w "/etc/systemd/system" ] 2>/dev/null; then
  sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=TunnelNet Tunnel Server (${DOMAIN}:${PORT})
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${INSTALL_DIR}/server
Environment=DB_PATH=${INSTALL_DIR}/data/tunnel.db
Environment=SERVER_PORT=${PORT}
ExecStart=${INSTALL_DIR}/server/venv/bin/python3 server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable tunnelnet 2>/dev/null || true
  log_ok "systemd 服务已配置"
else
  log_warn "systemd 不可用，将使用手动启动"
fi

# ======================== 9. 防火墙 ========================
log_info "配置防火墙..."
if command -v ufw &>/dev/null; then
  sudo ufw allow ${PORT}/tcp 2>/dev/null && log_ok "ufw: 端口 ${PORT} 已开放"
fi
if command -v firewall-cmd &>/dev/null; then
  sudo firewall-cmd --permanent --add-port=${PORT}/tcp 2>/dev/null && sudo firewall-cmd --reload 2>/dev/null
  log_ok "firewalld: 端口 ${PORT} 已开放"
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
echo "  ──── 启动服务 ────"
echo ""
if command -v systemctl &>/dev/null; then
  echo "  systemctl start tunnelnet    # 启动"
  echo "  systemctl status tunnelnet   # 状态"
  echo "  journalctl -u tunnelnet -f   # 日志"
  echo "  systemctl stop tunnelnet     # 停止"
  echo ""
else
  echo "  cd ${INSTALL_DIR}/server && source venv/bin/activate && python3 server.py"
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
