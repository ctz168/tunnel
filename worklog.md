---
Task ID: 1
Agent: Super Z (Main Agent)
Task: 设计并构建 TunnelNet 固定域名内网穿透管理平台

Work Log:
- 设计项目架构：Dashboard (Next.js) + Tunnel Server (WebSocket微服务) + Tunnel Client (独立脚本) + Database (SQLite/Prisma)
- 创建 Prisma Schema，定义 Tunnel 和 TunnelLog 模型
- 推送 Schema 到数据库 (db:push)
- 创建 Tunnel Server 微服务 (port 3002)：WebSocket连接管理、HTTP反向代理、子域名路由、心跳检测
- 创建 API 路由：GET/POST /api/tunnels、GET/DELETE/PATCH /api/tunnels/[id]、GET /api/tunnels/[id]/logs、GET /api/tunnel-status
- 创建 Tunnel Client 独立脚本 (tunnel-client.ts)：支持命令行参数、自动重连、心跳响应、本地代理转发
- 构建完整 Dashboard 前端界面：统计卡片、隧道列表、创建对话框、详情面板（状态/流量/命令/日志）、Toast通知
- 修复 lint 错误（setState-in-effect）
- 修复模块导入问题（theme-provider）
- 修复 Tunnel Server 路由冲突问题

Stage Summary:
- 完整的 TunnelNet 管理平台已构建完成
- Dashboard 支持隧道CRUD、实时状态展示、连接日志查看
- Tunnel Server 和 Client 代码已就绪，可直接部署使用
- 所有代码通过 lint 检查

---
Task ID: 2
Agent: Super Z (Main Agent)
Task: 升级 TunnelNet - 域名设置、8位密钥、README

Work Log:
- 更新 Prisma Schema: subdomain -> tunnelCode(8位唯一密钥), 新增 ServerConfig 模型
- 重写 Tunnel Server: 从子域名路由改为路径路由 /{tunnelCode}/...，支持 key 参数认证
- 重写 API 路由: 自动生成8位密钥(去混淆字符), 新增 /api/config 服务端配置API
- 重写 Dashboard: 服务器域名设置(默认aicq.online:1018)、新URL格式展示、简化创建表单
- 重写 Tunnel Client: 简化为只需 --key(8位密钥) --port(本地端口)，默认服务器 aicq.online:1018
- 创建 README.md: 服务端一行安装部署命令、客户端一键运行命令

Stage Summary:
- 公网地址格式: http://aicq.online:1018/XXXXXXXX (8位密钥)
- 客户端极简使用: bun tunnel-client.ts --key ABCD1234 --port 8080
- 管理面板支持服务器域名设置
- next build 编译成功，所有 API 正常工作
