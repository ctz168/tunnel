# TunnelNet - 固定域名内网穿透服务

类似 ngrok 的内网穿透工具，使用**固定域名 + 8位密钥路径**的访问方式，无需动态域名分配。

## 特性

- **固定地址** - 每个隧道绑定唯一 8 位密钥，公网地址永久不变
- **纯 CLI 客户端** - 只需一个命令即可建立隧道，无需界面
- **Web 管理面板** - 服务端可视化面板，管理隧道、查看日志、监控流量
- **路径路由** - 基于 `/{8位密钥}` 路径转发，无需 DNS 配置
- **WebSocket 隧道** - 长连接，稳定可靠，自动重连

## 架构

```
用户浏览器 --> http://aicq.online:1018/ABCD1234
                        |
              TunnelNet Server (HTTP反向代理)
                        |
              WebSocket 隧道 (双向转发)
                        |
              TunnelNet Client (CLI)
                        |
              本地服务 (localhost:8080)
```

---

## 服务端部署

### 一行命令安装部署

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/yourname/tunnelnet/main/download/install-server.sh) 1018
```

### 手动安装（3步）

```bash
# 第1步: 安装 Bun（如果还没有）
curl -fsSL https://bun.sh/install | bash

# 第2步: 克隆并初始化项目
git clone https://github.com/yourname/tunnelnet.git && cd tunnelnet
bun run setup

# 第3步: 启动服务（两个终端分别运行）
# 终端1 - 隧道服务:
bun run tunnel:dev
# 终端2 - 管理面板:
bun run dev

# 浏览器打开 http://localhost:3000
```

### 生产部署

```bash
bun run build

# 终端1 - 隧道服务:
bun run tunnel:start
# 终端2 - Dashboard:
bun run start
```

### 服务端命令汇总

| 命令 | 说明 |
|------|------|
| `bun run setup` | 一键初始化（安装依赖+建表+生成客户端） |
| `bun run db:push` | 同步数据库结构 |
| `bun run db:generate` | 生成 Prisma 客户端 |
| `bun run tunnel:dev` | 开发模式启动隧道服务（热重载） |
| `bun run tunnel:start` | 生产模式启动隧道服务 |
| `bun run dev` | 开发模式启动 Dashboard |
| `bun run build` | 构建 Dashboard 生产版本 |
| `bun run start` | 生产模式启动 Dashboard |

---

## 客户端使用

### 一行命令安装

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/yourname/tunnelnet/main/download/install-client.sh)
```

### 直接运行（无需安装）

```bash
# 只需 Bun + 依赖，直接运行
bun add ws
bun tunnel-client.ts --key <8位密钥> --port <本地端口>
```

### 连接隧道

```bash
# 最简用法 - 只需密钥和端口
tunnelnet --key ABCD1234 --port 8080

# 指定服务器（默认 aicq.online:1018）
tunnelnet --key ABCD1234 --port 8080 --server aicq.online:1018

# 指定本地地址
tunnelnet --key ABCD1234 --port 8080 --host 192.168.1.100

# 短参数格式
tunnelnet -k ABCD1234 -p 8080
```

连接成功后:

```
  TunnelNet Client v1.0
  服务器:   aicq.online:1018
  密钥:     ABCD1234
  本地:     localhost:8080

  [OK] 隧道已建立
  [OK] 公网地址: http://aicq.online:1018/ABCD1234
```

### 客户端参数

| 参数 | 缩写 | 必填 | 说明 | 默认值 |
|------|------|------|------|--------|
| `--key` | `-k` | 是 | 8位隧道密钥（Dashboard 创建时生成） | - |
| `--port` | `-p` | 是 | 本地服务端口 | - |
| `--server` | `-s` | 否 | 服务器地址 | `aicq.online:1018` |
| `--host` | `-h` | 否 | 本地服务地址 | `localhost` |

---

## 使用流程

### 1. 服务端：创建隧道

打开 Dashboard `http://服务器地址`，点击「创建隧道」：
- 名称：我的网站
- 本地端口：8080
- 本地地址：localhost

创建后获得 **8位密钥**（如 `ABCD1234`）。

### 2. 客户端：连接隧道

```bash
tunnelnet --key ABCD1234 --port 8080
```

### 3. 公网访问

任何人通过 `http://aicq.online:1018/ABCD1234` 即可访问本地 8080 端口的服务。

---

## 配置说明

### 域名设置

Dashboard 右上角齿轮 -> 修改「服务器域名」，默认 `aicq.online:1018`。修改后客户端连接时会自动获取。

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DATABASE_URL` | 数据库路径 | `file:db/custom.db` |
| `TUNNEL_PORT` | 隧道服务端口 | `3002` |

### 端口说明

| 服务 | 默认端口 | 说明 |
|------|---------|------|
| Dashboard | 3000 | Next.js 管理面板 |
| Tunnel Server | 3002 | 隧道代理服务 |

---

## 技术栈

- **Dashboard**: Next.js 16 + TypeScript + Tailwind CSS + shadcn/ui
- **Tunnel Server**: Bun + WebSocket (ws) + HTTP + Prisma
- **Tunnel Client**: Bun + WebSocket (ws) + HTTP（纯 CLI，无界面）
- **数据库**: SQLite + Prisma ORM

---

## 项目结构

```
tunnelnet/
├── prisma/schema.prisma              # 数据库模型
├── mini-services/tunnel-server/
│   ├── index.ts                      # 隧道服务核心
│   ├── tunnel-client.ts              # 客户端脚本
│   ├── prisma/schema.prisma          # 共享数据库模型
│   └── package.json
├── src/app/
│   ├── page.tsx                      # Dashboard 主页
│   ├── api/
│   │   ├── config/route.ts           # 域名配置 API
│   │   ├── tunnel-status/route.ts    # 隧道实时状态
│   │   └── tunnels/                  # 隧道 CRUD + 日志
│   └── components/ui/                # shadcn/ui 组件
├── download/
│   ├── tunnel-client.ts              # 客户端独立脚本
│   ├── install-server.sh             # 服务端一键部署脚本
│   ├── install-client.sh             # 客户端一键安装脚本
│   └── README.md
└── package.json
```

## License

MIT
