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
| `--http-port` | HTTP 独立端口模式 | false |
| `--subdomain` | 子域名前缀（如 `myagent`） | - |

### 使用示例

```bash
# 子域名模式（推荐！）
# 映射到 http://myagent.tunnel.aicq.online，直接通过域名访问
tunnel-p2p-client -k YOUR_TOKEN -p 8080 --subdomain myagent

# HTTP 独立端口模式
# 每个隧道分配独立端口，如 http://aicq.online:7900
tunnel-p2p-client -k YOUR_TOKEN -p 3000 --http-port

# 指定自定义服务器
tunnel-p2p-client -k YOUR_TOKEN -p 80 -s your-server.com:7739

# 强制使用中继模式（禁用 P2P）
tunnel-p2p-client -k YOUR_TOKEN -p 8080 --no-p2p
```

## 子域名模式（推荐）

子域名模式是最优雅的内网穿透方式，通过三级域名直接访问本地服务，无需端口号、无需路径前缀。

### 原理

- `*.tunnel.aicq.online` 的 DNS 已通配解析到服务器 IP
- 服务端在 7740 端口监听子域名路由请求（Caddy/Nginx 反向代理到此端口）
- 根据请求的 HTTP Host 头自动匹配子域名，转发到对应的隧道客户端
- 客户端指定子域名前缀（如 `myagent`），服务端自动注册

### 使用方法

```bash
# 将本地 8768 端口映射到 http://myagent.tunnel.aicq.online
tunnel-p2p-client -k YOUR_TOKEN -p 8768 --subdomain myagent
```

启动后会显示：
```
[OK] 隧道已建立
[OK] 隧道编码: XXXXXXXX
[子域名] localhost:8768 -> http://myagent.tunnel.aicq.online
```

访问 `http://myagent.tunnel.aicq.online` 即可直接使用本地服务。

### 子域名规则

- 只能包含小写字母、数字和连字符
- 长度 3-63 个字符
- 不能以连字符开头或结尾
- 保留名称（www, api, admin, mail, ftp, ns, dns, mx）不可使用
- 如果子域名已被其他在线隧道占用，会收到错误提示

### 冲突处理

如果请求的子域名已被其他隧道占用：
```
[子域名] 注册失败: 子域名 'myagent' 已被其他隧道占用
```
此时需要换一个子域名前缀。如果占用者已离线，系统会自动释放子域名供新连接使用。

## P2P 模式

默认启用，自动按优先级选择最佳连接方式：

| 优先级 | 模式 | 说明 |
|--------|------|------|
| 1 | **IPv6 直连** | 公网 IPv6 无 NAT，直接连接，延迟最低 |
| 2 | **UPnP IPv4** | 路由器自动端口映射，非 CGNAT 环境可用 |
| 3 | **中继模式** | 流量经服务器转发，任何网络环境都可用 |

P2P 直连成功后，访问者的流量**不经过服务器**，直接连接到你的机器，降低服务器负载。

## HTTP 独立端口模式

路径前缀模式（`domain:7739/TUNNEL_CODE/`）需要对 HTML/CSS/JS/重定向等做大量路径重写，容易出现遗漏导致资源加载失败。

**HTTP 独立端口模式**为每个隧道分配独立的 HTTP 公网端口（如 `aicq.online:7900`），访问者直接访问该端口，**无需任何路径重写**，彻底解决地址问题。

```bash
# 使用 HTTP 独立端口模式
tunnel-p2p-client -k YOUR_TOKEN -p 8080 --http-port
```

启动后会显示：
```
[OK] 隧道已建立
[OK] 隧道编码: XXXXXXXX
[HTTP端口] localhost:8080 -> http://aicq.online:7900 (公网端口: 7900)
```

访问 `http://aicq.online:7900` 即可直接使用本地服务，所有路径原样透传。

### 服务端配置

HTTP 独立端口范围默认 7900-7999，可通过环境变量配置：
```bash
export HTTP_PORT_START=7900
export HTTP_PORT_END=7999
```

确保服务器防火墙放行该端口范围。

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

### 子域名路由配置

子域名模式需要在服务端配置反向代理（Caddy/Nginx），将 `*.tunnel.aicq.online` 的流量转发到隧道服务器的子域名端口（默认 7740）。

**Caddy 配置示例：**

```caddyfile
*.tunnel.aicq.online {
    reverse_proxy localhost:7740
}
```

**Nginx 配置示例：**

```nginx
server {
    listen 80;
    server_name *.tunnel.aicq.online;

    location / {
        proxy_pass http://127.0.0.1:7740;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
    }
}
```

**注意：** 反向代理必须透传 `Host` 头（子域名路由依赖此头部识别目标隧道）。

### 服务端环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `SERVER_PORT` | 主服务端口 | 7739 |
| `SUBDOMAIN_PORT` | 子域名路由端口 | 7740 |
| `SUBDOMAIN_BASE` | 子域名基础域名 | tunnel.aicq.online |
| `HTTP_PORT_START` | HTTP 独立端口起始 | 7900 |
| `HTTP_PORT_END` | HTTP 独立端口结束 | 7999 |
| `TCP_PORT_START` | TCP 端口起始 | 7800 |
| `TCP_PORT_END` | TCP 端口结束 | 7899 |
| `DB_PATH` | 数据库路径 | data/tunnel.db |

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

## 三种 HTTP 访问模式对比

| 特性 | 子域名模式 | HTTP 独立端口 | 路径前缀 |
|------|-----------|-------------|---------|
| 访问地址 | `http://myapp.tunnel.aicq.online` | `http://aicq.online:7900` | `http://aicq.online:7739/XXXXXXXX/` |
| 端口号 | 80（默认） | 非标准端口 | 7739 |
| 路径重写 | 不需要 | 不需要 | 需要 |
| 配置复杂度 | 需配置反向代理 | 无 | 无 |
| 适用场景 | **生产环境（推荐）** | 快速测试 | 兼容旧版 |

---

## 纯 Ubuntu SSH 隧道部署指南

在标准 Ubuntu 系统（物理机、VM、云服务器）上通过隧道将 SSH 暴露到公网的完整步骤。

### 1. 安装并配置 SSH 服务

大多数 Ubuntu 已预装 openssh-server，如未安装：

```bash
# 安装 SSH 服务器
sudo apt update && sudo apt install openssh-server -y

# 确认 SSH 已启动（默认端口 22）
sudo systemctl start ssh
sudo systemctl enable ssh   # 开机自启
```

### 2. 配置允许 root 密码登录（可选）

如果需要 root 直接登录：

```bash
# 允许 root 密码登录
sudo sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
sudo sed -i 's/PermitRootLogin prohibit-password/PermitRootLogin yes/' /etc/ssh/sshd_config

# 确保密码认证开启
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config
sudo sed -i 's/PasswordAuthentication no/PasswordAuthentication yes/' /etc/ssh/sshd_config

# 重启 SSH 使配置生效
sudo systemctl restart ssh

# 设置 root 密码（如果还没有）
sudo passwd root
```

> 如果只需普通用户登录，可跳过此步，直接用普通用户 SSH 连接即可。

### 3. 安装隧道客户端

```bash
# 安装 Python 和 pip（如果还没有）
sudo apt install python3 python3-pip -y

# 安装隧道客户端（v2.7.0+）
pip install tunnel-p2p-client --break-system-packages
```

### 4. 启动隧道（带 TCP 转发）

```bash
tunnel-p2p-client --key YOUR_TOKEN --port 8080 --tcp-ports 22
```

启动成功后会显示：

```
Tunnel Client v2.7.0 (IPv6/IPv4 P2P + Relay + HTTP-Port + TCP + Subdomain)
[OK] 隧道已建立
[OK] 隧道编码: XXXXXXXX
[TCP] tcp-22 -> localhost:22 (公网端口: 7800)
```

### 5. 从外部 SSH 连接

```bash
ssh -p 7800 root@aicq.online
# 或用普通用户
ssh -p 7800 youruser@aicq.online
```

### 常见问题

**Q: SSH 服务未运行**
A: 检查并启动：
```bash
sudo systemctl status ssh
sudo systemctl start ssh
```

**Q: 防火墙阻止了本地 SSH**
A: 放行 22 端口：
```bash
sudo ufw allow 22
```

**Q: 隧道 TCP 转发显示端口但连不上**
A: 确保服务端防火墙开放了 7800-7899 端口范围，且服务端已更新到支持 TCP 转发的版本。

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

# 安装隧道客户端（v2.7.0+）
pip install tunnel-p2p-client --break-system-packages
```

### 5. 启动隧道（带 TCP 转发）

```bash
tunnel-p2p-client --key YOUR_TOKEN --port 12345 --tcp-ports 8022
```

启动成功后会显示：

```
Tunnel Client v2.7.0 (IPv6/IPv4 P2P + Relay + HTTP-Port + TCP + Subdomain)
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
