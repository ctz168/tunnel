#!/bin/bash
# ============================================================
#  TunnelNet Server - 一键安装部署脚本
#  适用: Linux / macOS / WSL
#  用法: bash install-server.sh
# ============================================================
set -e

DOMAIN="aicq.online"
PORT="7739"
TUNNEL_PORT="3002"
INSTALL_DIR="$HOME/tunnelnet"
REPO_URL="https://github.com/ctz168/tunnel.git"

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║      TunnelNet Server 一键安装部署           ║"
echo "  ║      域名: ${DOMAIN}:${PORT}                  ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""
echo "  公网域名:    ${DOMAIN}:${PORT}"
echo "  Tunnel 端口: ${TUNNEL_PORT}"
echo "  安装目录:    ${INSTALL_DIR}"
echo ""

# ---- 检测系统 ----
detect_os() {
  if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if command -v apt-get &>/dev/null; then
      echo "debian"
    elif command -v yum &>/dev/null; then
      echo "redhat"
    elif command -v apk &>/dev/null; then
      echo "alpine"
    else
      echo "linux"
    fi
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    echo "macos"
  else
    echo "unknown"
  fi
}

OS=$(detect_os)
echo "  [1/6] 检测系统: $OS"

# ---- 安装依赖 ----
echo "  [2/6] 安装系统依赖..."

install_deps_debian() {
  sudo apt-get update -qq
  sudo apt-get install -y -qq curl unzip sqlite3 2>/dev/null
}

install_deps_redhat() {
  sudo yum install -y -q curl unzip sqlite 2>/dev/null
}

install_deps_alpine() {
  sudo apk add --no-progress curl unzip sqlite 2>/dev/null
}

install_deps_macos() {
  if ! command -v brew &>/dev/null; then
    echo "  请先安装 Homebrew: https://brew.sh"
    exit 1
  fi
  brew install curl unzip sqlite 2>/dev/null || true
}

case "$OS" in
  debian) install_deps_debian ;;
  redhat) install_deps_redhat ;;
  alpine) install_deps_alpine ;;
  macos) install_deps_macos ;;
  *) echo "  [警告] 未知系统，跳过系统依赖安装" ;;
esac

# ---- 安装 Bun ----
echo "  [3/6] 安装 Bun..."

if command -v bun &>/dev/null; then
  echo "  Bun 已安装: $(bun --version)"
else
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  echo "  Bun 安装完成: $(bun --version)"
fi

# ---- 克隆/创建项目 ----
echo "  [4/6] 准备项目..."

if [ -d "$INSTALL_DIR" ]; then
  echo "  项目目录已存在，更新中..."
  cd "$INSTALL_DIR"
  git pull 2>/dev/null || true
else
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# ---- 安装 Node 依赖 ----
echo "  [5/6] 安装项目依赖..."
cd "$INSTALL_DIR"
bun install

# ---- 初始化数据库 ----
echo "  初始化数据库..."
bunx prisma db push --skip-generate 2>/dev/null || bunx prisma db push 2>/dev/null || true
bunx prisma generate 2>/dev/null || true

# 安装 tunnel-server 依赖
if [ -d "mini-services/tunnel-server" ]; then
  cd mini-services/tunnel-server
  DATABASE_URL="file:../../db/custom.db" bunx prisma db push --skip-generate 2>/dev/null || true
  DATABASE_URL="file:../../db/custom.db" bunx prisma generate 2>/dev/null || true
  bun install
  cd "$INSTALL_DIR"
fi

# ---- 启动服务 ----
echo "  [6/6] 启动服务..."

# 写入启动脚本
cat > "$INSTALL_DIR/start.sh" << STARTSCRIPT
#!/bin/bash
# TunnelNet 启动脚本
cd "\$(dirname "\$0")"

export DATABASE_URL="file:db/custom.db"
export TUNNEL_PORT="${TUNNEL_PORT}"

# 启动隧道服务（后台）
cd mini-services/tunnel-server
DATABASE_URL="file:../../db/custom.db" bun index.ts &
TUNNEL_PID=\$!
cd ..

# 启动 Dashboard（前台）
echo ""
echo "  TunnelNet 已启动"
echo "  隧道服务 PID: \$TUNNEL_PID"
echo "  公网地址: http://${DOMAIN}:${PORT}"
echo ""

bun run dev

# 清理
kill \$TUNNEL_PID 2>/dev/null
STARTSCRIPT

chmod +x "$INSTALL_DIR/start.sh"

echo ""
echo "  ╔══════════════════════════════════════════════╗"
echo "  ║          安装完成！                          ║"
echo "  ╚══════════════════════════════════════════════╝"
echo ""
echo "  启动命令:"
echo "    cd $INSTALL_DIR && bash start.sh"
echo ""
echo "  或手动分别启动:"
echo "    终端1: cd $INSTALL_DIR/mini-services/tunnel-server && DATABASE_URL=file:../../db/custom.db bun index.ts"
echo "    终端2: cd $INSTALL_DIR && bun run dev"
echo ""
echo "  访问管理面板: http://${DOMAIN}:${PORT}"
echo "  隧道服务端口: ${TUNNEL_PORT}"
echo ""
