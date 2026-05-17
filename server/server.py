"""
Tunnel Server - 基于 aiohttp 的内网穿透服务端
类似 ngrok，用户可通过固定域名 (默认 aicq.online:7739) 将本地服务暴露到公网
"""
from __future__ import annotations

import os
import re
import sys
import json
import time
from functools import partial
import secrets
import asyncio
import base64
import uuid
import logging
import traceback
from datetime import datetime, timezone

from aiohttp import web
import aiosqlite
from jinja2 import Environment, FileSystemLoader

# 导入数据库模块
import db as tunnel_db

# ======================== 配置 ========================
DB_PATH = os.environ.get("DB_PATH", "data/tunnel.db")
SERVER_PORT = int(os.environ.get("SERVER_PORT", "7739"))
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))
LOG_FILE = os.path.join(LOG_DIR, "server.log")
PWD_FILE = os.path.join(os.path.dirname(__file__), "pwd.txt")

# 管理会话：token -> {"created_at": ...}
_admin_sessions: dict[str, dict] = {}
SESSION_MAX_AGE = 86400 * 7  # 7 天

# ======================== 日志配置 ========================
os.makedirs(LOG_DIR, exist_ok=True)

logger = logging.getLogger("tunnel")
logger.setLevel(logging.DEBUG)
logger.propagate = False

# 文件 handler（全量日志）
_fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
_fh.setLevel(logging.DEBUG)
_fh.setFormatter(logging.Formatter(
    "%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
))
logger.addHandler(_fh)

# 控制台 handler（INFO+）
_ch = logging.StreamHandler(sys.stdout)
_ch.setLevel(logging.INFO)
_ch.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))
logger.addHandler(_ch)

logger.info(f"日志文件: {LOG_FILE}")

# ======================== 全局状态 ========================
# 活跃的 WebSocket 隧道连接：code -> WebSocket
active_tunnels: dict[str, web.WebSocketResponse] = {}

# WebSocket 连接的隧道元信息：code -> {"tunnel_id": ..., "tunnel_name": ...}
tunnel_ws_info: dict[str, dict] = {}

# 隧道运行时统计：code -> {connected_at, bytes_in, bytes_out, request_count}
tunnel_meta: dict[str, dict] = {}

# 待处理的隧道请求 Future：request_id -> asyncio.Future
pending_requests: dict[str, asyncio.Future] = {}

# 全局数据库连接
_db: aiosqlite.Connection | None = None

# Jinja2 模板环境（延迟初始化）
_template_env: Environment | None = None

# 隧道编码正则：8 位大写字母 + 数字（至少含一个字母）
CODE_RE = re.compile(r"^[A-Z0-9]{8}$")

# 不允许转发到客户端的 hop-by-hop 请求头
_HOP_BY_HOP = frozenset({
    "host", "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "transfer-encoding", "upgrade",
})


# ======================== 工具函数 ========================

def _get_db() -> aiosqlite.Connection:
    """获取全局数据库连接，若未初始化则抛出断言错误"""
    assert _db is not None, "数据库连接尚未初始化"
    return _db


def _get_template_env() -> Environment:
    """获取 Jinja2 模板环境（懒加载，仅初始化一次）"""
    global _template_env
    if _template_env is None:
        tpl_dir = os.path.join(os.path.dirname(__file__), "templates")
        _template_env = Environment(
            loader=FileSystemLoader(tpl_dir),
            autoescape=True,
        )
    return _template_env


async def _get_server_domain() -> str:
    """从数据库读取当前服务器域名"""
    config = await tunnel_db.get_config(_get_db())
    return config.get("domain", "aicq.online:7739")


def _validate_domain(domain: str) -> tuple[bool, str]:
    """
    验证域名格式是否合法
    返回 (是否合法, 错误信息)
    """
    if not domain or not isinstance(domain, str):
        return False, "域名不能为空"
    if len(domain) > 253:
        return False, "域名长度不能超过 253 个字符"

    # 分离 host 和 port
    if ":" in domain:
        parts = domain.rsplit(":", 1)
        host, port = parts[0], parts[1]
        if not port.isdigit() or not (1 <= int(port) <= 65535):
            return False, "端口号无效，需为 1-65535"
    else:
        host = domain

    # 基本域名格式检查
    if "." not in host:
        return False, "域名必须包含至少一个点号 (.)"
    if not re.match(r"^[a-zA-Z0-9]([a-zA-Z0-9.\-]*[a-zA-Z0-9])?$", host):
        return False, "域名包含非法字符"

    return True, ""


def _now_iso() -> str:
    """返回当前 UTC 时间的 ISO 格式字符串"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# 默认说明页 HTML（当路径不匹配隧道编码时展示）
_DEFAULT_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tunnel - 内网穿透服务</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .card { background: #1e293b; border-radius: 16px; padding: 48px; max-width: 560px; width: 90%; box-shadow: 0 25px 50px rgba(0,0,0,.4); }
  h1 { font-size: 28px; margin-bottom: 8px; }
  .subtitle { color: #94a3b8; margin-bottom: 24px; }
  .code-box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; font-family: monospace; font-size: 14px; margin: 16px 0; word-break: break-all; color: #38bdf8; }
  .steps { margin-top: 24px; }
  .steps h3 { color: #38bdf8; margin-bottom: 12px; }
  .steps ol { padding-left: 20px; color: #cbd5e1; line-height: 2; }
  .footer { margin-top: 32px; text-align: center; color: #475569; font-size: 13px; }
</style>
</head>
<body>
<div class="card">
  <h1>&#x1F310; Tunnel</h1>
  <p class="subtitle">安全、便捷的内网穿透服务</p>
  <p>当前可用域名：<strong id="domain"></strong></p>
  <div class="steps">
    <h3>使用方式</h3>
    <ol>
      <li>通过管理面板创建一个隧道，获取 <b>隧道编码</b> 和 <b>认证令牌</b></li>
      <li>在本地运行 Tunnel 客户端，使用令牌连接服务端</li>
      <li>访问 <code>http://域名/隧道编码/</code> 即可访问本地服务</li>
    </ol>
  </div>
  <p class="footer">Powered by Tunnel &copy; 2025</p>
</div>
<script>document.getElementById('domain').textContent = location.host || window.__DOMAIN__;</script>
</body>
</html>"""


# ======================== 启动与清理 ========================

async def on_startup(app: web.Application):
    """服务启动时初始化数据库、打印横幅"""
    global _db

    # 初始化数据库表结构
    await tunnel_db.init_db()

    # 建立全局数据库连接（后续请求复用）
    _db = await aiosqlite.connect(DB_PATH)

    # 打印启动横幅
    domain = await _get_server_domain()
    banner = f"""
╔══════════════════════════════════════════════════╗
║              Tunnel Server 已启动              ║
╠══════════════════════════════════════════════════╣
║  域名  : {domain:<38s}║
║  端口  : {SERVER_PORT:<38d}║
║  地址  : http://0.0.0.0:{SERVER_PORT:<27d}║
╚══════════════════════════════════════════════════╝"""
    logger.info(f"域名: {domain}  端口: {SERVER_PORT}")
    logger.info(f"地址: http://0.0.0.0:{SERVER_PORT}")
    print(banner)


async def on_cleanup(app: web.Application):
    """服务关闭时清理所有资源"""
    global _db

    # 关闭所有活跃的 WebSocket 连接
    for code, ws in list(active_tunnels.items()):
        try:
            await ws.close(code=4001, message=b"Server shutting down")
        except Exception:
            pass
    active_tunnels.clear()
    tunnel_ws_info.clear()
    tunnel_meta.clear()

    # 取消所有待处理请求
    for req_id, future in list(pending_requests.items()):
        if not future.done():
            future.set_exception(Exception("Server shutting down"))
    pending_requests.clear()

    # 关闭数据库连接
    if _db:
        try:
            await _db.close()
        except Exception:
            pass
        _db = None

    logger.info("服务已停止，资源已释放。")


# ======================== 页面路由 ========================

async def index_handler(request: web.Request) -> web.Response:
    """GET / — 首页，渲染 Jinja2 模板"""
    domain = await _get_server_domain()
    try:
        tpl = _get_template_env().get_template("index.html")
        html = tpl.render(domain=domain)
        return web.Response(text=html, content_type="text/html", charset="utf-8")
    except Exception:
        logger.exception("模板渲染失败")
        # 模板加载失败时返回内嵌默认页
        html = _DEFAULT_HTML.replace("window.__DOMAIN__", f"'{domain}'")
        return web.Response(text=html, content_type="text/html", charset="utf-8")


# ======================== 认证 API ========================

def _is_setup_done() -> bool:
    """检查是否已设置管理密码"""
    return os.path.exists(PWD_FILE)


def _read_password() -> str:
    """读取密码文件（明文）"""
    if os.path.exists(PWD_FILE):
        with open(PWD_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    return ""


def _check_session(request: web.Request) -> bool:
    """检查请求中是否携带有效的管理员 session"""
    token = request.cookies.get("tunnel_admin") or request.headers.get("X-Admin-Token", "")
    if not token:
        return False
    session = _admin_sessions.get(token)
    if not session:
        return False
    # 检查是否过期
    if time.time() - session["created_at"] > SESSION_MAX_AGE:
        _admin_sessions.pop(token, None)
        return False
    return True


def _gen_session_token() -> str:
    """生成随机的 session token"""
    return secrets.token_hex(32)


async def auth_check_handler(request: web.Request) -> web.Response:
    """GET /api/auth/check — 检查是否已设置密码 + 是否已登录"""
    return web.json_response({
        "setup_done": _is_setup_done(),
        "logged_in": _check_session(request),
    })


async def auth_setup_handler(request: web.Request) -> web.Response:
    """POST /api/auth/setup — 首次设置密码"""
    if _is_setup_done():
        return web.json_response({"error": "密码已设置，无法重复设置"}, status=400)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "无效请求"}, status=400)

    password = body.get("password", "")
    if len(password) < 4:
        return web.json_response({"error": "密码长度至少 4 位"}, status=400)

    # 明文写入 pwd.txt
    with open(PWD_FILE, "w", encoding="utf-8") as f:
        f.write(password)

    # 自动登录
    token = _gen_session_token()
    _admin_sessions[token] = {"created_at": time.time()}
    logger.info("管理员密码已设置")

    resp = web.json_response({"success": True})
    resp.set_cookie("tunnel_admin", token, max_age=SESSION_MAX_AGE, httponly=True)
    return resp


async def auth_login_handler(request: web.Request) -> web.Response:
    """POST /api/auth/login — 登录"""
    if not _is_setup_done():
        return web.json_response({"error": "请先设置密码"}, status=400)
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "无效请求"}, status=400)

    password = body.get("password", "")
    stored = _read_password()
    if password != stored:
        return web.json_response({"error": "密码错误"}, status=401)

    token = _gen_session_token()
    _admin_sessions[token] = {"created_at": time.time()}
    logger.info("管理员登录成功")

    resp = web.json_response({"success": True})
    resp.set_cookie("tunnel_admin", token, max_age=SESSION_MAX_AGE, httponly=True)
    return resp


async def auth_logout_handler(request: web.Request) -> web.Response:
    """POST /api/auth/logout — 登出"""
    token = request.cookies.get("tunnel_admin", "")
    _admin_sessions.pop(token, None)
    resp = web.json_response({"success": True})
    resp.del_cookie("tunnel_admin")
    return resp


# ======================== JSON API 路由 ========================

async def get_config_handler(request: web.Request) -> web.Response:
    """GET /api/config — 获取服务器配置"""
    config = await tunnel_db.get_config(_get_db())
    return web.json_response(config)


async def update_config_handler(request: web.Request) -> web.Response:
    """POST /api/config — 更新服务器域名"""
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "请求体不是合法的 JSON"}, status=400)

    domain = body.get("domain", "").strip()
    if not domain:
        return web.json_response({"error": "缺少 domain 字段"}, status=400)

    # 校验域名格式
    ok, msg = _validate_domain(domain)
    if not ok:
        return web.json_response({"error": f"域名格式不合法：{msg}"}, status=400)

    result = await tunnel_db.set_config(_get_db(), domain)
    return web.json_response({"success": True, **result})


async def list_tunnels_handler(request: web.Request) -> web.Response:
    """GET /api/tunnels — 列出所有隧道（脱敏 auth_token，管理端返回完整 token）"""
    is_admin = _check_session(request)
    tunnels = await tunnel_db.list_tunnels(_get_db())
    safe_list = []
    for t in tunnels:
        safe = dict(t)
        if is_admin:
            safe["token_prefix"] = t["auth_token"][:8]
            # 管理员可以看到完整 token
        else:
            safe["token_prefix"] = t["auth_token"][:8]
        del safe["auth_token"]
        safe_list.append(safe)
    return web.json_response({"tunnels": safe_list})


async def get_tunnel_token_handler(request: web.Request) -> web.Response:
    """GET /api/tunnels/{tunnel_id}/token — 获取隧道完整认证令牌（需登录）"""
    tunnel_id = request.match_info["tunnel_id"]
    tunnels = await tunnel_db.list_tunnels(_get_db())
    target = next((t for t in tunnels if t["id"] == tunnel_id), None)
    if not target:
        return web.json_response({"error": "隧道不存在"}, status=404)
    return web.json_response({"auth_token": target["auth_token"]})


async def create_tunnel_handler(request: web.Request) -> web.Response:
    """POST /api/tunnels — 创建新隧道，返回完整信息（含 auth_token）"""
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "请求体不是合法的 JSON"}, status=400)

    name = body.get("name", "").strip()
    description = body.get("description", "").strip()
    auth_token = body.get("auth_token", "").strip() or None

    # 参数校验
    if not name:
        return web.json_response({"error": "缺少 name 字段"}, status=400)
    if auth_token and len(auth_token) < 4:
        return web.json_response({"error": "自定义令牌长度至少 4 位"}, status=400)

    tunnel = await tunnel_db.create_tunnel(
        _get_db(), name=name, description=description, auth_token=auth_token,
    )

    # 记录日志
    await tunnel_db.add_log(
        _get_db(), tunnel["id"], "create",
        f"隧道已创建：{tunnel['code']}", request.remote or "",
    )

    return web.json_response({"success": True, "tunnel": tunnel})


async def delete_tunnel_handler(request: web.Request) -> web.Response:
    """DELETE /api/tunnels/{tunnel_id} — 删除隧道，同时断开其 WebSocket 连接"""
    tunnel_id = request.match_info["tunnel_id"]

    # 先查找隧道信息（用于获取 code 以断开 WebSocket）
    tunnels = await tunnel_db.list_tunnels(_get_db())
    target = next((t for t in tunnels if t["id"] == tunnel_id), None)

    deleted = await tunnel_db.delete_tunnel(_get_db(), tunnel_id)
    if not deleted:
        return web.json_response({"error": "隧道不存在"}, status=404)

    # 如果该隧道有活跃的 WebSocket 连接，主动断开
    if target:
        code = target["code"]
        if code in active_tunnels:
            ws = active_tunnels.pop(code)
            try:
                await ws.close(code=4001, message=b"Tunnel deleted")
            except Exception:
                pass
            tunnel_meta.pop(code, None)
            tunnel_ws_info.pop(code, None)

    return web.json_response({"success": True, "message": "隧道已删除"})


async def get_logs_handler(request: web.Request) -> web.Response:
    """GET /api/tunnels/{tunnel_id}/logs — 获取隧道的操作日志"""
    tunnel_id = request.match_info["tunnel_id"]

    # 验证隧道是否存在
    tunnels = await tunnel_db.list_tunnels(_get_db())
    if not any(t["id"] == tunnel_id for t in tunnels):
        return web.json_response({"error": "隧道不存在"}, status=404)

    logs = await tunnel_db.get_logs(_get_db(), tunnel_id)
    return web.json_response({"logs": logs})


async def get_tunnel_status_handler(request: web.Request) -> web.Response:
    """GET /api/tunnel-status — 获取所有隧道的实时状态（含在线统计）"""
    domain = await _get_server_domain()

    # 从内存中的 tunnel_meta 获取实时统计数据
    status_map: dict[str, dict] = {}
    for code, meta in tunnel_meta.items():
        status_map[code] = {
            "online": True,
            "connected_at": meta.get("connected_at", ""),
            "bytes_in": meta.get("bytes_in", 0),
            "bytes_out": meta.get("bytes_out", 0),
            "request_count": meta.get("request_count", 0),
        }

    return web.json_response({
        "tunnels": status_map,
        "domain": domain,
    })


# ======================== WebSocket 隧道端点 ========================

async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    """
    GET /ws?key=<auth_token 或 tunnel_code>
    隧道客户端通过此 WebSocket 连接到服务端，接收转发请求并返回响应。
    """
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    # ---- 验证连接密钥 ----
    key = request.query.get("key", "").strip()
    if not key:
        await ws.close(code=4001, message=b"Missing authentication key")
        return ws

    db = _get_db()

    # 优先按 auth_token 查找，其次按 code 查找
    tunnel = await tunnel_db.get_tunnel_by_token(db, key)
    if not tunnel:
        # 尝试按隧道编码查找
        tunnel = await tunnel_db.get_tunnel(db, key)
    if not tunnel:
        await ws.close(code=4003, message=b"Invalid key: tunnel not found")
        return ws

    code = tunnel["code"]

    # ---- 如果已有同编码的连接，先关闭旧连接 ----
    if code in active_tunnels:
        old_ws = active_tunnels[code]
        try:
            await old_ws.close(code=4008, message=b"Replaced by new connection")
        except Exception:
            pass
        # 清理旧连接的元数据
        tunnel_meta.pop(code, None)
        tunnel_ws_info.pop(code, None)

    # ---- 注册新连接 ----
    active_tunnels[code] = ws
    tunnel_ws_info[code] = {
        "tunnel_id": tunnel["id"],
        "tunnel_name": tunnel["name"],
    }
    tunnel_meta[code] = {
        "connected_at": _now_iso(),
        "bytes_in": 0,
        "bytes_out": 0,
        "request_count": 0,
    }

    # 更新数据库状态为在线
    await tunnel_db.update_tunnel_status(db, code, "online")

    # 记录客户端 IP (必须在 send_json 之前获取)
    peer_ip = request.remote or ""

    # 发送连接成功消息给客户端
    domain = await _get_server_domain()
    await ws.send_json({
        "type": "connected",
        "tunnel_code": code,
        "public_url": f"http://{domain}/{code}",
        "client_ip": peer_ip,
    })

    # 清除旧的 P2P 地址（客户端重连后需要重新上报）
    await tunnel_db.update_tunnel_p2p_info(db, code, None, None)

    # 记录连接日志
    await tunnel_db.add_log(
        db, tunnel["id"], "connect",
        f"客户端已连接 (IP: {peer_ip})", peer_ip,
    )

    # ---- 心跳机制 ----
    pong_received = asyncio.Event()

    async def heartbeat_loop():
        """每 30 秒发送 ping，10 秒内未收到 pong 则关闭连接"""
        while not ws.closed:
            await asyncio.sleep(30)
            if ws.closed:
                break
            pong_received.clear()
            try:
                await ws.send_json({"type": "ping"})
            except Exception:
                break
            # 等待 10 秒内收到 pong
            try:
                await asyncio.wait_for(pong_received.wait(), timeout=10)
            except asyncio.TimeoutError:
                # 心跳超时，关闭连接
                print(f"[Tunnel] 隧道 {code} 心跳超时，断开连接")
                try:
                    await ws.close(code=4008, message=b"Heartbeat timeout")
                except Exception:
                    pass
                break

    hb_task = asyncio.create_task(heartbeat_loop())

    # ---- 消息循环 ----
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue

                msg_type = data.get("type")

                if msg_type == "pong":
                    # 收到心跳响应
                    pong_received.set()

                elif msg_type == "client_info":
                    # 客户端上报本地端口和地址
                    c_port = data.get("local_port")
                    c_host = data.get("local_host", "localhost")
                    if c_port:
                        try:
                            await tunnel_db.update_tunnel_client_info(
                                db, code, int(c_port), str(c_host),
                            )
                            logger.info(f"隧道 {code} 客户端上报地址: {c_host}:{c_port}")
                        except Exception as e:
                            logger.error(f"更新隧道 {code} 客户端信息失败: {e}")

                elif msg_type == "p2p_info":
                    # 客户端上报 P2P 信息 (IPv6/UPnP/Dual)
                    # 新格式: {"urls": [{"url": "...", "type": "ipv6|upnp"}], "mode": "ipv6|upnp|dual"}
                    # 兼容旧格式: {"public_url": "http://..."}
                    urls = data.get("urls")
                    mode = data.get("mode", "")
                    legacy_url = data.get("public_url", "").strip()

                    if urls and isinstance(urls, list):
                        # 新格式: 多 URL + 模式
                        p2p_json = json.dumps({"urls": urls, "mode": mode}, ensure_ascii=False)
                        first_url = urls[0].get("url", "") if urls else ""
                        try:
                            await tunnel_db.update_tunnel_p2p_info(db, code, p2p_json, first_url)
                            mode_labels = {"ipv6": "IPv6 直连", "upnp": "UPnP IPv4", "dual": "IPv6 + UPnP 双栈"}
                            logger.info(f"隧道 {code} P2P 模式: {mode_labels.get(mode, mode)}")
                            for u in urls:
                                logger.info(f"  -> {u.get('type', '?')}: {u.get('url', '')}")
                        except Exception as e:
                            logger.error(f"更新隧道 {code} P2P 信息失败: {e}")
                    elif legacy_url:
                        # 兼容旧版客户端 (单 URL)
                        p2p_json = json.dumps({"urls": [{"url": legacy_url, "type": "upnp"}], "mode": "upnp"}, ensure_ascii=False)
                        try:
                            await tunnel_db.update_tunnel_p2p_info(db, code, p2p_json, legacy_url)
                            logger.info(f"隧道 {code} P2P 已启用 (旧格式): {legacy_url}")
                        except Exception as e:
                            logger.error(f"更新隧道 {code} P2P 地址失败: {e}")

                elif msg_type == "response":
                    # 收到隧道客户端返回的 HTTP 响应
                    req_id = data.get("id", "")
                    future = pending_requests.get(req_id)
                    if future and not future.done():
                        future.set_result(data)

            elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                break

    except asyncio.CancelledError:
        pass
    finally:
        # 取消心跳任务
        hb_task.cancel()
        try:
            await hb_task
        except asyncio.CancelledError:
            pass

        # 仅当当前连接仍为该 code 的活跃连接时才清理
        if active_tunnels.get(code) is ws:
            del active_tunnels[code]
            tunnel_meta.pop(code, None)
            tunnel_ws_info.pop(code, None)

            # 更新数据库状态为离线
            try:
                await tunnel_db.update_tunnel_status(db, code, "offline")
                await tunnel_db.add_log(
                    db, tunnel["id"], "disconnect",
                    f"客户端已断开 (IP: {peer_ip})", peer_ip,
                )
            except Exception:
                pass

        # 释放该隧道所有待处理的请求（避免请求端永久挂起）
        for req_id in list(pending_requests.keys()):
            if req_id.startswith(f"{code}-"):
                future = pending_requests.pop(req_id, None)
                if future and not future.done():
                    future.set_exception(Exception("Tunnel disconnected"))

    return ws


# ======================== HTTP 反向代理（核心隧道转发） ========================

async def tunnel_request_handler(request: web.Request) -> web.Response:
    """
    捕获所有未匹配的路径，判断首段是否为隧道编码：
    - 是 → 通过 WebSocket 转发请求到隧道客户端
    - 否 → 展示默认说明页
    """
    path_info = request.match_info["path_info"]  # 例如 "ABCD1234/api/users"
    first_segment = path_info.split("/", 1)[0].upper()

    # 检查是否匹配 8 位隧道编码格式
    if not CODE_RE.match(first_segment):
        return web.Response(
            text=_DEFAULT_HTML,
            content_type="text/html", charset="utf-8",
        )

    code = first_segment

    # 查找隧道信息
    tunnels_list = await tunnel_db.list_tunnels(_get_db())
    target = next((t for t in tunnels_list if t["code"] == code), None)

    # ---- P2P 模式：智能重定向 ----
    sub_path = path_info[len(first_segment):]
    if not sub_path:
        sub_path = "/"
    if request.query_string:
        sub_path = f"{sub_path}?{request.query_string}"

    if target and target.get("p2p_info"):
        try:
            p2p = json.loads(target["p2p_info"])
            p2p_urls = p2p.get("urls", [])
            p2p_mode = p2p.get("mode", "")

            if p2p_urls:
                # 判断访客 IP 类型: 包含冒号视为 IPv6
                visitor_remote = request.remote or ""
                visitor_is_ipv6 = ":" in visitor_remote

                # 根据访客 IP 选择最佳 P2P 地址
                redirect_url = None
                if visitor_is_ipv6:
                    # IPv6 访问者: 优先 IPv6 地址
                    for entry in p2p_urls:
                        if entry.get("type") == "ipv6":
                            redirect_url = entry["url"]
                            break
                    if not redirect_url:
                        # 没有 IPv6 地址，尝试 UPnP (双栈可能可达)
                        for entry in p2p_urls:
                            if entry.get("type") == "upnp":
                                redirect_url = entry["url"]
                                break
                else:
                    # IPv4 访问者: 优先 UPnP IPv4
                    for entry in p2p_urls:
                        if entry.get("type") == "upnp":
                            redirect_url = entry["url"]
                            break
                    if not redirect_url:
                        # 没有 UPnP，尝试 IPv6 双栈 (可能可达)
                        for entry in p2p_urls:
                            if entry.get("type") == "ipv6":
                                redirect_url = entry["url"]
                                break

                if redirect_url:
                    full_url = redirect_url.rstrip("/") + sub_path
                    raise web.HTTPFound(full_url)
        except (json.JSONDecodeError, KeyError):
            pass

    # 兼容旧版: 仅 public_url 无 p2p_info
    if target and target.get("public_url") and not target.get("p2p_info"):
        p2p_url = target["public_url"].rstrip("/") + sub_path
        raise web.HTTPFound(p2p_url)

    # ---- 中继模式：检查隧道是否在线 ----
    ws = active_tunnels.get(code)
    if not ws or ws.closed:
        return web.json_response(
            {
                "error": "Tunnel offline",
                "message": f"隧道 {code} 当前不在线，请稍后再试",
            },
            status=502,
        )

    # 生成唯一请求 ID（编码前缀便于按隧道清理）
    req_id = f"{code}-{uuid.uuid4().hex[:12]}"

    # 创建 Future 等待隧道客户端返回响应
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    pending_requests[req_id] = future

    try:
        # 读取请求体
        body = await request.read()
        body_b64 = base64.b64encode(body).decode("utf-8") if body else ""

        # 收集请求头，过滤 hop-by-hop 头
        headers = {}
        for key, value in request.headers.items():
            if key.lower() not in _HOP_BY_HOP:
                headers[key] = value

        # 通过 WebSocket 将请求发送给隧道客户端
        await ws.send_json({
            "type": "request",
            "id": req_id,
            "method": request.method,
            "url": sub_path,
            "headers": headers,
            "body": body_b64,
        })

        # 等待响应（30 秒超时）
        try:
            resp_data = await asyncio.wait_for(future, timeout=30)
        except asyncio.TimeoutError:
            return web.json_response(
                {"error": "Gateway Timeout", "message": "隧道客户端响应超时"},
                status=504,
            )

        # ---- 解析隧道客户端返回的响应 ----
        status_code = resp_data.get("status_code", 200)
        resp_headers = resp_data.get("headers", {})
        resp_body_b64 = resp_data.get("body", "")
        resp_body = base64.b64decode(resp_body_b64) if resp_body_b64 else b""

        # 更新隧道统计
        meta = tunnel_meta.get(code, {})
        meta["bytes_in"] = meta.get("bytes_in", 0) + len(body)
        meta["bytes_out"] = meta.get("bytes_out", 0) + len(resp_body)
        meta["request_count"] = meta.get("request_count", 0) + 1

        # 提取 Content-Type 并过滤不应透传的响应头
        content_type = "application/octet-stream"
        pass_headers: dict[str, str] = {}
        for key, value in resp_headers.items():
            lower = key.lower()
            if lower == "content-type":
                content_type = value
            elif lower not in ("transfer-encoding", "connection", "keep-alive", "content-length"):
                pass_headers[key] = value

        return web.Response(
            status=status_code,
            body=resp_body,
            content_type=content_type,
            headers=pass_headers if pass_headers else None,
        )

    except asyncio.CancelledError:
        return web.json_response({"error": "Request cancelled"}, status=499)
    except Exception as e:
        logger.exception(f"隧道转发异常 [{code}]")
        return web.json_response(
            {"error": "Internal Server Error", "message": str(e)},
            status=500,
        )
    finally:
        # 无论如何都清理 pending_requests 中的条目
        pending_requests.pop(req_id, None)


# ======================== 全局错误中间件 ========================

@web.middleware
async def error_middleware(request: web.Request, handler):
    """捕获所有未处理异常，返回友好错误信息并记录日志"""
    try:
        resp = await handler(request)
        # aiohttp 有时会把状态码 >= 400 的响应标为不 send
        return resp
    except web.HTTPException as e:
        logger.error(f"HTTP异常: {e.status} {request.method} {request.path} - {e.reason}")
        return web.json_response(
            {"error": e.reason, "status": e.status},
            status=e.status,
        )
    except Exception as e:
        logger.exception(f"未捕获异常: {request.method} {request.path}")
        return web.Response(
            text=f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>500 Server Error</title>
<style>body{{font-family:monospace;background:#1a1a2e;color:#eee;padding:40px;max-width:800px;margin:0 auto}}
h1{{color:#e74c3c}}pre{{background:#16213e;padding:16px;border-radius:8px;overflow:auto;font-size:13px;white-space:pre-wrap}}</style></head>
<body><h1>500 Internal Server Error</h1>
<p>Path: {request.method} {request.path}</p>
<p>请查看 <code>data/server.log</code> 获取详细信息</p>
<hr><pre>{traceback.format_exc()}</pre></body></html>""",
            content_type="text/html", charset="utf-8",
            status=500,
        )


# ======================== Debug 日志端点 ========================

async def debug_logs_handler(request: web.Request) -> web.Response:
    """GET /debug/logs — 读取服务器日志文件内容"""
    try:
        if os.path.exists(LOG_FILE):
            with open(LOG_FILE, "r", encoding="utf-8") as f:
                content = f.read()
            # 只返回最后 5000 字符
            if len(content) > 5000:
                content = "... (截断，仅显示最近部分) ...\n\n" + content[-5000:]
            return web.Response(
                text=f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Server Logs</title>
<style>body{{font-family:monospace;background:#0f172a;color:#e2e8f0;padding:20px}}
pre{{background:#1e293b;padding:16px;border-radius:8px;overflow:auto;white-space:pre-wrap;font-size:13px;line-height:1.6}}</style></head>
<body><h2>Server Logs ({LOG_FILE})</h2>
<pre>{content}</pre></body></html>""",
                content_type="text/html", charset="utf-8",
            )
        else:
            return web.Response(text=f"日志文件不存在: {LOG_FILE}", status=404)
    except Exception as e:
        return web.Response(text=f"读取日志失败: {e}", status=500)


# ======================== 应用工厂 ========================

async def on_error_page(request: web.Request) -> web.Response:
    """全局错误兜底 — 捕获所有未处理的 500 错误"""
    status = request.match_info.get("status", "500")
    logger.error(f"未处理异常: {status} {request.method} {request.url}")
    return web.Response(
        text=f"<h1>Server Error {status}</h1><p>请查看 data/server.log 获取详情</p>",
        content_type="text/html", charset="utf-8",
        status=int(status),
    )


def create_app() -> web.Application:
    """创建并配置 aiohttp 应用"""
    app = web.Application(middlewares=[error_middleware])
    app["logger"] = logger
    app["json_dumps"] = partial(json.dumps, ensure_ascii=False)

    # 注册生命周期钩子
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    # ---- 页面路由 ----
    app.router.add_get("/", index_handler)

    # ---- JSON API 路由 ----
    app.router.add_get("/api/config", get_config_handler)
    app.router.add_post("/api/config", update_config_handler)
    app.router.add_get("/api/tunnels", list_tunnels_handler)
    app.router.add_post("/api/tunnels", create_tunnel_handler)
    app.router.add_delete("/api/tunnels/{tunnel_id}", delete_tunnel_handler)
    app.router.add_get("/api/tunnels/{tunnel_id}/logs", get_logs_handler)
    app.router.add_get("/api/tunnels/{tunnel_id}/token", get_tunnel_token_handler)
    app.router.add_get("/api/tunnel-status", get_tunnel_status_handler)

    # ---- 认证路由 ----
    app.router.add_get("/api/auth/check", auth_check_handler)
    app.router.add_post("/api/auth/setup", auth_setup_handler)
    app.router.add_post("/api/auth/login", auth_login_handler)
    app.router.add_post("/api/auth/logout", auth_logout_handler)

    # ---- Debug 端点 ----
    app.router.add_get("/debug/logs", debug_logs_handler)

    # ---- WebSocket 隧道端点 ----
    app.router.add_get("/ws", websocket_handler)

    # ---- 500 错误日志页面 ----
    app.router.add_route("*", "/_error/{status}", on_error_page)

    # ---- HTTP 反向代理（兜底路由，必须放在最后）----
    # 匹配所有未被上述路由捕获的路径，判断首段是否为隧道编码
    app.router.add_route("*", "/{path_info:.+}", tunnel_request_handler)

    logger.info("路由注册完成")

    return app


# ======================== 入口 ========================

if __name__ == "__main__":
    import socket as _sock
    app = create_app()

    # 同时绑定 IPv4 和 IPv6，确保双栈可用
    socks = []
    try:
        s4 = _sock.socket(_sock.AF_INET, _sock.SOCK_STREAM)
        s4.setsockopt(_sock.SOL_SOCKET, _sock.SO_REUSEADDR, 1)
        s4.bind(("0.0.0.0", SERVER_PORT))
        socks.append(s4)
    except OSError as e:
        logger.warning(f"IPv4 绑定失败: {e}")

    try:
        s6 = _sock.socket(_sock.AF_INET6, _sock.SOCK_STREAM)
        s6.setsockopt(_sock.SOL_SOCKET, _sock.SO_REUSEADDR, 1)
        s6.setsockopt(_sock.IPPROTO_IPV6, _sock.IPV6_V6ONLY, 1)
        s6.bind(("::", SERVER_PORT))
        socks.append(s6)
    except OSError as e:
        logger.warning(f"IPv6 绑定失败: {e}")

    logger.info(f"启动 http://0.0.0.0:{SERVER_PORT} + http://[::]:{SERVER_PORT} (IPv4/IPv6 双栈)")
    web.run_app(app, sock=socks, print=None, access_log=None)
