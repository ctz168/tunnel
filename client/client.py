#!/usr/bin/env python3
"""
Tunnel Client - 内网穿透客户端 (Python + aiohttp)
支持 P2P 模式 (UPnP) 和中继模式
用法: python client.py --key <认证令牌> --port <本地端口> [--server aicq.online:7739]
"""
import argparse
import asyncio
import base64
import json
import signal
import socket
import struct
import sys
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

import aiohttp
from aiohttp import web


# ======================== UPnP (无外部依赖) ========================

def _get_local_ip():
    """获取本机局域网 IP"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return '127.0.0.1'


def _ssdp_discover():
    """SSDP 发现 UPnP 网关设备"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(3)
        msg = (
            'M-SEARCH * HTTP/1.1\r\n'
            'HOST:239.255.255.250:1900\r\n'
            'MAN:"ssdp:discover"\r\n'
            'MX:2\r\n'
            'ST:urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n'
            '\r\n'
        ).encode()
        sock.sendto(msg, ('239.255.255.250', 1900))
        while True:
            data, _ = sock.recvfrom(2048)
            for line in data.decode('utf-8', errors='ignore').split('\r\n'):
                if line.lower().startswith('location:'):
                    return line.split(':', 1)[1].strip()
    except Exception:
        return None


def _get_control_url(location_url):
    """从设备描述 XML 获取 WANIPConnection 控制地址"""
    try:
        with urllib.request.urlopen(location_url, timeout=5) as resp:
            root = ET.fromstring(resp.read())
        for svc in root.iter():
            if svc.tag.endswith('service'):
                st = svc.find('{*}serviceType')
                if st is not None and 'WANIPConnection' in st.text:
                    cu = svc.find('{*}controlURL')
                    if cu is not None and cu.text:
                        base = urllib.parse.urlparse(location_url)
                        url = cu.text
                        if not url.startswith('http'):
                            url = f'{base.scheme}://{base.netloc}{url}'
                        return url
    except Exception:
        return None


def _soap_call(control_url, action, fields):
    """发送 UPnP SOAP 请求"""
    body = ('<?xml version="1.0"?>'
            '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
            's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
            '<s:Body><u:' + action +
            ' xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">'
            + ''.join(f'<{k}>{v}</{k}>' for k, v in fields.items())
            + '</u:' + action + '></s:Body></s:Envelope>')
    req = urllib.request.Request(control_url, data=body.encode(), headers={
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': f'"urn:schemas-upnp-org:service:WANIPConnection:1#{action}"',
    })
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def upnp_open(port, internal_port, internal_ip, desc='Tunnel'):
    """通过 UPnP 开放公网端口，返回 True 成功"""
    loc = _ssdp_discover()
    if not loc:
        return False
    ctrl = _get_control_url(loc)
    if not ctrl:
        return False
    return _soap_call(ctrl, 'AddPortMapping', {
        'NewRemoteHost': '', 'NewExternalPort': str(port),
        'NewInternalPort': str(internal_port), 'NewInternalClient': internal_ip,
        'NewProtocol': 'TCP', 'NewEnabled': '1',
        'NewPortMappingDescription': desc, 'NewLeaseDuration': '0',
    })


def upnp_close(port):
    """关闭 UPnP 端口映射"""
    loc = _ssdp_discover()
    if not loc:
        return
    ctrl = _get_control_url(loc)
    if not ctrl:
        return
    _soap_call(ctrl, 'DeletePortMapping', {
        'NewRemoteHost': '', 'NewExternalPort': str(port), 'NewProtocol': 'TCP',
    })


# ======================== P2P HTTP 反向代理 ========================

class P2PProxy:
    """轻量 HTTP 反向代理：监听公网端口，转发到本地服务"""

    def __init__(self, listen_host: str, listen_port: int,
                 target_host: str, target_port: int):
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.target_host = target_host
        self.target_port = target_port
        self.runner: web.AppRunner | None = None
        self.session: aiohttp.ClientSession | None = None

    async def start(self):
        self.session = aiohttp.ClientSession()
        app = web.Application()
        app.router.add_route('*', '/{path_info:.*}', self._handler)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, self.listen_host, self.listen_port)
        await site.start()

    async def stop(self):
        if self.runner:
            await self.runner.cleanup()
            self.runner = None
        if self.session:
            await self.session.close()
            self.session = None

    async def _handler(self, request: web.Request) -> web.Response:
        target = f"http://{self.target_host}:{self.target_port}{request.path}"
        if request.query_string:
            target += f"?{request.query_string}"
        headers = {k: v for k, v in request.headers.items()
                   if k.lower() not in ('host', 'connection', 'transfer-encoding')}
        body = await request.read()
        try:
            async with self.session.request(
                request.method, target, headers=headers, data=body
            ) as resp:
                resp_body = await resp.read()
                pass_headers = {k: v for k, v in resp.headers.items()
                                if k.lower() not in ('transfer-encoding', 'connection', 'content-length')}
                return web.Response(status=resp.status, body=resp_body, headers=pass_headers)
        except Exception as e:
            return web.Response(status=502, text=f"P2P proxy error: {e}")


# ======================== 隧道客户端 ========================

class TunnelClient:
    def __init__(self, server: str, key: str, local_port: int, local_host: str,
                 p2p: bool, p2p_port: int):
        self.server = server
        self.key = key
        self.local_port = local_port
        self.local_host = local_host
        self.p2p = p2p
        self.p2p_port = p2p_port
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.session: aiohttp.ClientSession | None = None
        self.req_count = 0
        self.start_time = time.time()
        self.retry_count = 0
        self._running = True
        self._status_task: asyncio.Task | None = None
        self._p2p_proxy: P2PProxy | None = None
        self._p2p_ok = False
        self._public_ip = ""
        self._tunnel_code = ""

    async def start(self):
        print(f"\n  Tunnel Client v2.0 (P2P + Relay)")
        print(f"  服务器:   {self.server}")
        print(f"  密钥:     {self.key[:16]}...")
        print(f"  本地:     {self.local_host}:{self.local_port}")
        print(f"  P2P:      {'启用 (端口 ' + str(self.p2p_port) + ')' if self.p2p else '禁用'}")
        print()

        self.session = aiohttp.ClientSession()
        while self._running:
            try:
                await self._connect()
            except aiohttp.WSServerHandshakeError as e:
                print(f"  [错误] 握手失败: {e}")
            except aiohttp.ClientError as e:
                print(f"  [错误] 连接失败: {e}")
            except Exception as e:
                print(f"  [错误] {e}")

            if not self._running:
                break
            # 断开时清理 P2P
            await self._stop_p2p()
            await self._reconnect()

    async def _connect(self):
        base = self.server if self.server.startswith("http") else f"http://{self.server}"
        ws_url = base.replace("http", "ws") + f"/ws?key={self.key}"

        async with self.session.ws_connect(ws_url) as ws:
            self.ws = ws
            self.retry_count = 0
            print("  [连接中]...")

            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    await self._handle(data)
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    print(f"  [错误] WebSocket: {ws.exception()}")
                    break
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING):
                    break

    async def _handle(self, data: dict):
        t = data.get("type")

        if t == "connected":
            url = data.get("public_url", "")
            self._tunnel_code = data.get("tunnel_code", "")
            # 服务器告知客户端的公网 IP
            self._public_ip = data.get("client_ip", "")
            print(f"  [OK] 隧道已建立")
            print(f"  [OK] 隧道编码: {self._tunnel_code}")
            print(f"  [OK] 中继地址: {url}")

            # 上报客户端本地信息
            if self.ws and not self.ws.closed:
                await self.ws.send_json({
                    "type": "client_info",
                    "local_port": self.local_port,
                    "local_host": self.local_host,
                })

            # 尝试 P2P
            if self.p2p:
                await self._try_p2p()

            if self._status_task:
                self._status_task.cancel()
            self._status_task = asyncio.create_task(self._status_loop(self._tunnel_code))

        elif t == "ping":
            if self.ws and not self.ws.closed:
                await self.ws.send_json({"type": "pong"})

        elif t == "request":
            # 中继模式才处理转发请求（P2P 模式下服务器不会发请求）
            await self._proxy_request(data)

        elif t == "error":
            print(f"  [错误] {data.get('message', '未知错误')}")

    async def _try_p2p(self):
        """尝试通过 UPnP 建立 P2P 直连"""
        if not self._public_ip:
            print(f"  [P2P] 未能获取公网 IP，使用中继模式")
            return

        local_ip = _get_local_ip()
        desc = f"Tunnel-{self._tunnel_code or self.key[:8]}"

        print(f"  [P2P] 尝试 UPnP 端口映射...")
        print(f"  [P2P] 公网 IP: {self._public_ip}")
        print(f"  [P2P] 局域网 IP: {local_ip}")
        print(f"  [P2P] 映射: {self._public_ip}:{self.p2p_port} -> {local_ip}:{self.p2p_port}")

        if not upnp_open(self.p2p_port, self.p2p_port, local_ip, desc):
            print(f"  [P2P] UPnP 失败，使用中继模式")
            print(f"  [P2P] 提示: 路由器可能未开启 UPnP，或处于 CGNAT 网络")
            return

        # UPnP 成功，启动 P2P 代理
        try:
            self._p2p_proxy = P2PProxy("0.0.0.0", self.p2p_port,
                                        self.local_host, self.local_port)
            await self._p2p_proxy.start()
            self._p2p_ok = True
            public_url = f"http://{self._public_ip}:{self.p2p_port}"
            print(f"  [P2P] UPnP 端口映射成功!")
            print(f"  [P2P] 直连地址: {public_url}")

            # 告知服务器 P2P 地址
            if self.ws and not self.ws.closed:
                await self.ws.send_json({
                    "type": "p2p_info",
                    "public_url": public_url,
                })
        except Exception as e:
            print(f"  [P2P] 代理启动失败: {e}")
            upnp_close(self.p2p_port)

    async def _stop_p2p(self):
        """清理 P2P 资源"""
        if self._p2p_proxy:
            await self._p2p_proxy.stop()
            self._p2p_proxy = None
        if self._p2p_ok and self.p2p_port:
            upnp_close(self.p2p_port)
            print(f"  [P2P] 已清理 UPnP 端口映射")
        self._p2p_ok = False

    async def _proxy_request(self, data: dict):
        """中继模式：通过 WebSocket 转发 HTTP 请求"""
        req_id = data["id"]
        method = data["method"]
        url_path = data["url"]
        headers = {k: v for k, v in data.get("headers", {}).items()
                   if k.lower() not in ("host", "connection", "transfer-encoding")}
        body_b64 = data.get("body")
        body = base64.b64decode(body_b64) if body_b64 else None

        target = f"http://{self.local_host}:{self.local_port}{url_path}"

        try:
            async with self.session.request(method, target, headers=headers, data=body) as resp:
                resp_body = await resp.read()
                resp_headers = {k: v for k, v in resp.headers.items()
                                if k.lower() not in ("transfer-encoding", "connection")}
                payload = {
                    "type": "response",
                    "id": req_id,
                    "status_code": resp.status,
                    "headers": resp_headers,
                    "body": base64.b64encode(resp_body).decode() if resp_body else None,
                }
        except Exception as e:
            payload = {
                "type": "response",
                "id": req_id,
                "status_code": 502,
                "headers": {"Content-Type": "application/json"},
                "body": base64.b64encode(json.dumps({"error": str(e)}).encode()).decode(),
            }

        if self.ws and not self.ws.closed:
            await self.ws.send_json(payload)
            self.req_count += 1

    async def _status_loop(self, code: str):
        while self._running:
            await asyncio.sleep(60)
            elapsed = int(time.time() - self.start_time)
            h, m, s = elapsed // 3600, (elapsed % 3600) // 60, elapsed % 60
            mode = "P2P" if self._p2p_ok else "中继"
            base = self.server if self.server.startswith("http") else f"http://{self.server}"
            print(f"  [状态] {h:02d}:{m:02d}:{s:02d} | 模式: {mode} | 请求: {self.req_count} | {base}/{code}")

    async def _reconnect(self):
        if not self._running:
            return
        delay = min(1 * (2 ** self.retry_count), 30)
        self.retry_count += 1
        print(f"  [重连] {delay}s 后...")
        await asyncio.sleep(delay)

    async def close(self):
        self._running = False
        await self._stop_p2p()
        if self._status_task:
            self._status_task.cancel()
        if self.ws and not self.ws.closed:
            await self.ws.close()
        if self.session:
            await self.session.close()


def main():
    parser = argparse.ArgumentParser(description="Tunnel Client v2.0 (P2P + Relay)")
    parser.add_argument("-k", "--key", required=True, help="认证令牌")
    parser.add_argument("-p", "--port", type=int, default=8080, help="本地服务端口 (默认: 8080)")
    parser.add_argument("-s", "--server", default="aicq.online:7739", help="服务器地址 (默认: aicq.online:7739)")
    parser.add_argument("--host", default="localhost", help="本地服务地址 (默认: localhost)")
    parser.add_argument("--p2p-port", type=int, default=0, help="P2P 公网端口 (默认: 与本地端口相同)")
    parser.add_argument("--no-p2p", action="store_true", help="禁用 P2P，强制使用中继模式")
    args = parser.parse_args()

    p2p_enabled = not args.no_p2p
    p2p_port = args.p2p_port if args.p2p_port > 0 else args.port

    client = TunnelClient(
        server=args.server, key=args.key.strip(),
        local_port=args.port, local_host=args.host,
        p2p=p2p_enabled, p2p_port=p2p_port,
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def _signal_handler():
        asyncio.ensure_future(client.close())

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, _signal_handler)

    try:
        loop.run_until_complete(client.start())
    except KeyboardInterrupt:
        pass
    finally:
        loop.run_until_complete(client.close())
        loop.close()
        print("\n  已关闭")


if __name__ == "__main__":
    main()
