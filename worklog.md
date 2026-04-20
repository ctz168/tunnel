---
Task ID: 1
Agent: Main Agent
Task: TunnelNet 项目功能完善 - 域名设置、8位密钥路径路由、纯CLI客户端、部署脚本

Work Log:
- 检查项目当前状态，确认架构已基本到位（schema已有tunnelCode+ServerConfig，路径路由已实现，客户端已是CLI）
- 同步 mini-services/tunnel-server 的 prisma schema 与主项目一致
- 更新 tunnel-server: 支持从 ServerConfig 读取域名，连接时告知客户端公网URL
- 优化 tunnel-client: 纯CLI模式，增强帮助信息和错误提示，改进重连逻辑
- 创建 install-server.sh: 服务端一键安装部署脚本（检测系统、安装Bun、初始化DB、启动服务）
- 创建 install-client.sh: 客户端一键安装脚本（安装Bun+ws、创建全局tunnelnet命令）
- 编写完整 README: 架构说明、服务端/客户端部署命令、使用流程、参数说明
- 修复 Prisma Client 生成问题: tunnel-server 需要复制主项目的 .prisma/client
- 添加 package.json 脚本: setup, tunnel:dev, tunnel:start, db:generate
- 验证: Next.js build 成功，tunnel-server 启动成功

Stage Summary:
- 所有功能已实现并验证通过
- 关键文件: mini-services/tunnel-server/index.ts, download/tunnel-client.ts, download/install-server.sh, download/install-client.sh, download/README.md
- 客户端纯CLI，只需 --key + --port 即可运行
- 服务端域名默认 aicq.online:1018，可在Dashboard中修改
- 路径路由模式: http://域名/8位密钥

---
Task ID: 2
Agent: Main Agent
Task: 添加 IPv6 支持

Work Log:
- tunnel-server: 添加 TUNNEL_HOST 环境变量，默认 `::` (IPv6 dual-stack)
- tunnel-server: 本地回环检测增加 ::1 和 ::ffff:127.* 支持
- tunnel-server: 启动日志显示实际监听地址和协议族 (IPv4/IPv6)
- tunnel-client: 添加 IPv6 DNS 解析器，优先解析 AAAA 记录，回退 A 记录
- tunnel-client: 支持 IPv6 服务器地址格式 [2001:db8::1]:port
- tunnel-client: 本地服务支持 IPv6 地址 ::1 和 [::1]
- Next.js Dashboard: dev 命令添加 -H :: 参数
- Next.js Dashboard: start 命令添加 HOST=:: 环境变量
- 验证: tunnel-server 成功启动监听 IPv6 :::3002
- 验证: Next.js build 成功

Stage Summary:
- 所有组件已支持 IPv6 dual-stack (同时兼容 IPv4)
- 关键变更: server.listen(PORT, '::'), next dev -H ::, 自定义 DNS lookup

---
Task ID: 3
Agent: Main Agent + Sub-agent
Task: 全流程测试 TunnelNet 并修复所有 Bug

Work Log:
- 启动 tunnel-server 和 Next.js Dashboard 进行全流程测试
- 发现并修复 Bug 1: tunnel-server 本地请求拦截过于激进（删除 isLocal 逻辑）
- 发现并修复 Bug 2: tunnel-server .env 中引号导致 DATABASE_URL 解析错误
- 发现并修复 Bug 3: SQLite 相对路径在 Prisma 中解析异常（多个 .db 文件被创建）
  - 修复: 所有 .env 使用绝对路径 file:/home/z/my-project/db/custom.db
  - tunnel-server 代码中动态解析绝对路径 (resolveDbPath)
- 发现并修复 Bug 4: Prisma 缓存导致 .next/ 需要清理
- E2E 测试全流程通过: 创建隧道 → 客户端连接 → HTTP代理转发 → 路径保持

Stage Summary:
- 修复了 4 个 Bug
- API CRUD 全部通过
- WebSocket 客户端连接正常
- HTTP 代理转发正常（路径保持正确）
- 关键修改文件: mini-services/tunnel-server/index.ts, mini-services/tunnel-server/.env
