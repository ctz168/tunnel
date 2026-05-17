#!/bin/bash
# ============================================================
#  Tunnel Client - 一键安装脚本 (Linux / macOS)
#  用法: bash install.sh
# ============================================================
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_NAME="tunnel-p2p-client"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log_info()  { echo -e "${CYAN}  [INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}  [OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}  [WARN]${NC} $1"; }
log_error() { echo -e "${RED}  [ERROR]${NC} $1"; }

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║     Tunnel Client 一键安装                    ║"
echo "  ║     内网穿透客户端                             ║"
echo "  ║                                              ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""

# ======================== 1. 系统检测 ========================
log_info "检测系统..."
OS="unknown"
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
  if command -v apt-get &>/dev/null;   then OS="debian"
  elif command -v yum &>/dev/null;     then OS="redhat"
  elif command -v apk &>/dev/null;     then OS="alpine"
  else OS="linux"; fi
elif [[ "$OSTYPE" == "darwin"* ]]; then OS="macos"
fi
log_ok "系统: $OS"

# ======================== 2. Python 环境 ========================
log_info "检查 Python..."
if ! command -v python3 &>/dev/null; then
  if [[ "$OS" == "debian" ]]; then
    apt-get update -qq && apt-get install -y -qq python3 python3-pip python3-venv 2>/dev/null
  elif [[ "$OS" == "redhat" ]]; then
    yum install -y -q python3 python3-pip 2>/dev/null
  elif [[ "$OS" == "macos" ]]; then
    log_error "请先安装 Python 3: brew install python3"
    exit 1
  else
    log_error "请先安装 Python 3"
    exit 1
  fi
fi
log_ok "Python: $(python3 --version)"

# ======================== 3. 创建虚拟环境 ========================
log_info "创建虚拟环境..."
cd "$INSTALL_DIR"
if [ ! -d "venv" ]; then
  python3 -m venv venv
fi
source venv/bin/activate
log_ok "虚拟环境已就绪"

# ======================== 4. 安装依赖 ========================
log_info "安装 Python 依赖..."
pip install -q -r requirements.txt
log_ok "依赖安装完成"

# ======================== 5. 创建命令行快捷方式 ========================
SCRIPT_PATH="$INSTALL_DIR/client.py"
LINK_DIR="/usr/local/bin"

if [ -w "$LINK_DIR" ] || [ "$EUID" -eq 0 ]; then
  ln -sf "$SCRIPT_PATH" "$LINK_DIR/tunnel-p2p-client" 2>/dev/null || true
  # 创建 wrapper 脚本，自动激活 venv
  cat > "$LINK_DIR/tunnel-p2p-client" << 'WRAPPER'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo "$0")")" && pwd)"
TUNNEL_CLIENT_DIR="$(dirname "$SCRIPT_DIR")/tunnel-p2p-wrapper"
WRAPPER
  log_ok "已安装到 $LINK_DIR/tunnel-p2p-client"
else
  log_warn "无权限写入 $LINK_DIR，跳过全局安装"
fi

# ======================== 完成 ========================
echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║                                              ║"
echo "  ║           客户端安装完成！                     ║"
echo "  ║                                              ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""
echo -e "  ${GREEN}安装目录:${NC}   $INSTALL_DIR"
echo ""
echo "  ──── 使用方法 ────"
echo ""
echo -e "  ${CYAN}cd $INSTALL_DIR${NC}"
echo -e "  ${CYAN}source venv/bin/activate${NC}"
echo -e "  ${CYAN}python3 client.py --key <认证令牌> --port 8080${NC}"
echo ""
echo "  参数说明:"
echo "    --key, -k    认证令牌（在管理面板创建隧道时生成）"
echo "    --port, -p   本地服务端口（默认: 8080）"
echo "    --server, -s 服务器地址（默认: aicq.online:7739）"
echo "    --host       本地服务地址（默认: localhost）"
echo ""
echo "  示例:"
echo "    python3 client.py --key YOUR_TOKEN --port 8080"
echo "    python3 client.py -k YOUR_TOKEN -p 3000 -s aicq.online:7739"
echo ""
