# Tunnel

类似 ngrok 的内网穿透服务，支持 IPv6/IPv4 P2P 直连与服务端中继双模式。

将本地服务暴露到公网，通过固定域名访问，无需公网 IP。

## 快速开始

### 1. 安装客户端

```bash
pip install tunnel-p2p-client
```

### 2. 启动隧道

```bash
tunnel-p2p-client --key YOUR_TOKEN --port 8080
```

连接成功后，你会得到一个公网地址，例如 `http://aicq.online:7739/EAH3WR2X`，任何人都可以通过这个地址访问你本地的 8080 端口服务。

## 客户端参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-k, --key` | 认证令牌（必填，在管理面板创建隧道时获取） | - |
| `-p, --port` | 本地服务端口 | 8080 |
| `-s, --server` | 服务器地址 | aicq.online:7739 |
| `--host` | 本地服务地址 | localhost |
| `--p2p-port` | P2P 直连监听端口 | 与 --port 相同 |
| `--no-p2p` | 禁用 P2P，强制使用中继模式 | false |

### 使用示例

```bash
# 将本地 3000 端口暴露到公网
tunnel-p2p-client -k YOUR_TOKEN -p 3000

# 指定自定义服务器
tunnel-p2p-client -k YOUR_TOKEN -p 80 -s your-server.com:7739

# 强制使用中继模式（禁用 P2P）
tunnel-p2p-client -k YOUR_TOKEN -p 8080 --no-p2p
```

## P2P 模式

默认启用，自动按优先级选择最佳连接方式：

| 优先级 | 模式 | 说明 |
|--------|------|------|
| 1 | **IPv6 直连** | 公网 IPv6 无 NAT，直接连接，延迟最低 |
| 2 | **UPnP IPv4** | 路由器自动端口映射，非 CGNAT 环境可用 |
| 3 | **中继模式** | 流量经服务器转发，任何网络环境都可用 |

P2P 直连成功后，访问者的流量**不经过服务器**，直接连接到你的机器，降低服务器负载。

## 服务端部署

### 一键部署

```bash
git clone https://github.com/ctz168/tunnel.git
cd tunnel/server
sudo bash install.sh
```

部署完成后：
- 管理面板：`http://your-domain:7739`
- 在管理面板创建隧道，获取认证令牌给客户端使用

### 服务管理（systemd）

```bash
systemctl start tunnel      # 启动
systemctl stop tunnel       # 停止
systemctl restart tunnel    # 重启
systemctl status tunnel     # 查看状态
journalctl -u tunnel -f     # 查看日志
```

## 从源码运行

```bash
git clone https://github.com/ctz168/tunnel.git
cd tunnel
python -m tunnel_client --key YOUR_TOKEN --port 8080
```

## License

MIT
