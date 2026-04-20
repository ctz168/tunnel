# TunnelNet - 内网穿透服务

类似 ngrok 的内网穿透服务，使用固定公网地址，无需动态域名。

**公网地址格式**: `http://aicq.online:1018/XXXXXXXX`（8位密钥）

---

## 服务端部署（Linux / macOS / Windows）

### 一行命令安装部署启动

```bash
curl -fsSL https://get.tunnelnet.sh | bash
```

或手动安装：

```bash
# 1. 安装 Bun（如已安装可跳过）
curl -fsSL https://bun.sh/install | bash

# 2. 克隆项目
git clone https://github.com/yourname/tunnelnet.git && cd tunnelnet

# 3. 安装依赖并启动
bun install && bun run db:push && bun run dev & bun run tunnel:server &

# 4. 打开浏览器
open http://localhost:3000   # macOS
xdg-open http://localhost:3000  # Linux
start http://localhost:3000     # Windows
```

### Docker 部署（推荐生产环境）

```bash
docker run -d -p 3000:3000 -p 3002:3000 -v tunnelnet-data:/app/db tunnelnet:latest
```

### 配置

- **管理面板**: http://localhost:3000
- **服务器域名**: 默认 `aicq.online:1018`，在管理面板 设置 中修改
- **数据库**: SQLite，无需额外安装

### 服务器要求

- Node.js 18+ 或 Bun 1.0+
- 1GB+ 内存
- 公网 IP 或已配置域名解析

---

## 客户端使用

### 一键安装

```bash
# 安装 Bun（如已安装可跳过）
curl -fsSL https://bun.sh/install | bash
```

### 一键运行

只需 **8位密钥** 和 **本地端口** 两个参数：

```bash
bun tunnel-client.ts --key ABCD1234 --port 8080
```

完整参数：

| 参数 | 缩写 | 说明 | 默认值 |
|------|------|------|--------|
| `--key` | `-k` | 8位隧道密钥（必填） | - |
| `--port` | `-p` | 本地服务端口（必填） | - |
| `--server` | `-s` | 服务器地址 | `aicq.online:1018` |
| `--host` | `-h` | 本地服务地址 | `localhost` |

### 使用示例

```bash
# 将本地 8080 端口映射到公网
bun tunnel-client.ts --key ABCD1234 --port 8080

# 指定自定义服务器和本地地址
bun tunnel-client.ts --key ABCD1234 --port 3000 --server myserver.com:8080 --host 127.0.0.1

# 缩写形式
bun tunnel-client.ts -k ABCD1234 -p 8080
```

连接成功后，你的本地服务将通过以下地址对外访问：

```
http://aicq.online:1018/ABCD1234
```

---

## 工作原理

```
外部用户
    │
    ▼
http://aicq.online:1018/ABCD1234/api/users
    │
    ▼
Tunnel Server（公网服务器）
    │  WebSocket 隧道
    ▼
Tunnel Client（本地运行）
    │  HTTP 转发
    ▼
localhost:8080/api/users（本地服务）
```

1. 在管理面板创建隧道，获得 8 位密钥
2. 在本地运行客户端，输入密钥和本地端口
3. 外部通过 `http://aicq.online:1018/密钥` 访问本地服务

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 3000 | 管理面板（Dashboard） |
| 3002 | 隧道服务（Tunnel Server） |
| 1018 | 公网访问端口（可配置） |

---

## 技术栈

- **Dashboard**: Next.js 16 + TypeScript + Tailwind CSS + shadcn/ui
- **Tunnel Server**: Bun + WebSocket (ws) + HTTP Proxy
- **Tunnel Client**: Bun + WebSocket
- **Database**: SQLite + Prisma ORM
