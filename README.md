# Tunnel Client

安全、便捷的内网穿透客户端，支持 IPv6/IPv4 P2P 直连与服务端中继双模式。

## 安装

```bash
pip install tunnel-client
```

## 使用

```bash
tunnel-client --key YOUR_TOKEN --port 8080
```

### 参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-k, --key` | 认证令牌（必填） | - |
| `-p, --port` | 本地服务端口 | 8080 |
| `-s, --server` | 服务器地址 | aicq.online:7739 |
| `--host` | 本地服务地址 | localhost |
| `--p2p-port` | P2P 监听端口 | 与本地端口相同 |
| `--no-p2p` | 禁用 P2P | false |

### 示例

```bash
tunnel-client -k YOUR_TOKEN -p 3000
tunnel-client -k YOUR_TOKEN -p 80 -s aicq.online:7739
tunnel-client -k YOUR_TOKEN -p 8080 --no-p2p
```

## P2P 模式

默认启用，自动按优先级选择最佳连接方式：

1. **IPv6 直连** — 公网 IPv6 无 NAT，直接可达（优先）
2. **UPnP IPv4** — 路由器端口映射（非 CGNAT 环境）
3. **中继模式** — 所有流量经服务端转发（保底）

## 源码运行

```bash
python -m tunnel_client --key YOUR_TOKEN --port 8080
```

## License

MIT
