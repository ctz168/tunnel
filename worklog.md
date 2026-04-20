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
