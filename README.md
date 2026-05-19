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
| `--tcp-ports` | TCP 转发端口，逗号分隔（如 `22,3306`） | - |

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

## TCP 转发（SSH、数据库等）

客户端支持将本地 TCP 服务（如 SSH、MySQL、Redis）通过隧道暴露到公网。服务端会为每个 TCP 端口自动分配一个公网端口。

### 使用方法

```bash
# 转发 SSH（本地端口 22）
tunnel-p2p-client -k YOUR_TOKEN -p 8080 --tcp-ports 22

# 转发 SSH + MySQL
tunnel-p2p-client -k YOUR_TOKEN -p 8080 --tcp-ports 22,3306

# 转发自定义端口
tunnel-p2p-client -k YOUR_TOKEN -p 8080 --tcp-ports 22,3306,6379
```

启动后客户端会显示分配的公网端口：

```
[TCP] ssh -> localhost:22 (公网端口: 7800)
[TCP] mysql -> localhost:3306 (公网端口: 7801)
```

然后从外部连接：

```bash
ssh -p 7800 root@aicq.online           # SSH
mysql -h aicq.online -P 7801 -u root   # MySQL
```

### 服务端配置

TCP 转发需要服务端开放端口范围（默认 7800-7899），可通过环境变量配置：

```bash
export TCP_PORT_START=7800
export TCP_PORT_END=7899
```

确保服务器防火墙放行该端口范围。

---

## Termux + Ubuntu SSH 隧道部署指南

在安卓手机上通过 Termux 运行 Ubuntu（proot-distro），并通过隧道将 SSH 暴露到公网的完整步骤。

### 1. 安装 Termux 和 Ubuntu

```bash
# 在 Termux 中安装 proot-distro
pkg install proot-distro

# 安装 Ubuntu
proot-distro install ubuntu

# 登录 Ubuntu
proot-distro login ubuntu
```

### 2. 安装并配置 SSH 服务

```bash
# 安装 SSH 服务器
apt update && apt install openssh-server -y

# 配置允许密码登录
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config

# 允许 root 登录
sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# 关闭特权分离（proot 环境必须）
echo "UsePrivilegeSeparation no" >> /etc/ssh/sshd_config

# 修改监听端口为高位端口（proot 无法绑定 1024 以下端口）
echo "Port 8022" >> /etc/ssh/sshd_config

# 设置 root 密码
passwd
# 输入你想设置的 SSH 登录密码
```

### 3. 启动 SSH 服务

```bash
# 生成 host key
ssh-keygen -A

# 创建必要目录
mkdir -p /run/sshd

# 直接启动 sshd（proot 下 systemctl/service 不可靠）
/usr/sbin/sshd

# 验证 SSH 是否在运行
ssh -p 8022 root@127.0.0.1
# 输入密码，能登录即成功
```

> **注意**：Termux proot 环境下 `ps aux` 和 `ss -tlnp` 无法正常显示进程和端口，用 `ssh -p 8022 root@127.0.0.1` 自连测试最可靠。

### 4. 安装隧道客户端

```bash
# 安装 Python 和 pip（如果还没有）
apt install python3 python3-pip -y

# 安装隧道客户端（v2.5.1+）
pip install tunnel-p2p-client --break-system-packages
```

### 5. 启动隧道（带 TCP 转发）

```bash
tunnel-p2p-client --key YOUR_TOKEN --port 12345 --tcp-ports 8022
```

启动成功后会显示：

```
Tunnel Client v2.5.1 (IPv6/IPv4 P2P + Relay + Path-Rewrite + TCP)
[OK] 隧道已建立
[OK] 隧道编码: XXXXXXXX
[TCP] tcp-8022 -> localhost:8022 (公网端口: 7800)
```

### 6. 从外部 SSH 连接

```bash
ssh -p 7800 root@aicq.online
# 输入你在步骤 2 中设置的密码
```

### 常见问题

**Q: sshd 启动报 `Bind to port 22 failed: Permission denied`**
A: proot 没有真正的 root 权限，无法绑定 1024 以下端口。改用高位端口（如 8022），并在 `/etc/ssh/sshd_config` 中添加 `Port 8022`。

**Q: 密码输入正确但 SSH 登录被拒绝**
A: 检查 `PasswordAuthentication yes` 和 `PermitRootLogin yes` 是否生效：
```bash
/usr/sbin/sshd -T -f /etc/ssh/sshd_config | grep -i password
/usr/sbin/sshd -T -f /etc/ssh/sshd_config | grep -i permitrootlogin
```

**Q: 隧道 TCP 转发显示端口但连不上**
A: 确保服务端防火墙开放了 7800-7899 端口范围，且服务端已更新到支持 TCP 转发的版本。

**Q: 每次重启 Ubuntu 后需要重新启动 sshd**
A: 可以在 `~/.bashrc` 末尾添加自动启动：
```bash
echo '/usr/sbin/sshd 2>/dev/null' >> ~/.bashrc
```

## License

MIT
