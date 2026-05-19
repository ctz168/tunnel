#!/usr/bin/env python3
"""
Tunnel Client - 内网穿透客户端 (Python + aiohttp)
支持 IPv6/IPv4 P2P 直连 + 服务端中继双模式

P2P 策略 (优先级):
  1. IPv6 直连 — 公网 IPv6 无 NAT，直接可达
  2. UPnP IPv4 — 路由器端口映射，适用于非 CGNAT 环境
  3. 中继模式   — 所有流量经服务端转发 (保底)

用法:
  pip install tunnel-p2p-client
  tunnel-p2p-client --key <认证令牌> --port <本地端口>

  或从源码:
  python -m tunnel_client --key <认证令牌> --port 8080
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import signal
import socket
import sys
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET

import aiohttp
from aiohttp import web


# ======================== 网络探测 (IPv4 + IPv6) ========================

def get_local_ip() -> str:
    """获取本机局域网 IPv4 地址"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def get_public_ipv6() -> str | None:
    """
    检测本机公网 IPv6 地址。
    通过向 Google DNS (2001:4860:4860::8888) 发起 UDP 连接，
    操作系统会自动选择合适的出站 IPv6 源地址。
    返回 None 表示没有可用的公网 IPv6。
    """
    try:
        s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
        s.settimeout(5)
        s.connect(("2001:4860:4860::8888", 80))
        addr = s.getsockname()[0]
        s.close()
        # 过滤掉非公网地址: 链路本地 (fe80), 回环 (::1), 唯一本地 (fc/fd)
        if not addr:
            return None
        if addr.startswith("fe80") or addr.startswith("::1"):
            return None
        if addr.startswith("fc") or addr.startswith("fd"):
            return None
        if addr == "::":
            return None
        return addr
    except Exception:
        return None


def test_ipv6_connectivity() -> bool:
    """测试 IPv6 互联网是否真正可达 (TCP 连接测试)"""
    # 依次尝试多个知名 IPv6 地址
    targets = [
        ("2001:4860:4860::8888", 80),   # Google DNS
        ("2400:3200::1", 80),            # 阿里 DNS
        ("2402:4e00::", 80),             # 腾讯 DNS
    ]
    for host, port in targets:
        try:
            s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
            s.settimeout(3)
            s.connect((host, port))
            s.close()
            return True
        except Exception:
            continue
    return False


# ======================== UPnP (IPv4 端口映射, 无外部依赖) ========================

def _ssdp_discover():
    """SSDP 发现 UPnP 网关设备"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(3)
        msg = (
            "M-SEARCH * HTTP/1.1\r\n"
            "HOST:239.255.255.250:1900\r\n"
            'MAN:"ssdp:discover"\r\n'
            "MX:2\r\n"
            "ST:urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n"
            "\r\n"
        ).encode()
        sock.sendto(msg, ("239.255.255.250", 1900))
        while True:
            data, _ = sock.recvfrom(2048)
            for line in data.decode("utf-8", errors="ignore").split("\r\n"):
                if line.lower().startswith("location:"):
                    return line.split(":", 1)[1].strip()
    except Exception:
        return None


def _get_control_url(location_url):
    """从设备描述 XML 获取 WANIPConnection 控制地址"""
    try:
        with urllib.request.urlopen(location_url, timeout=5) as resp:
            root = ET.fromstring(resp.read())
        for svc in root.iter():
            if svc.tag.endswith("service"):
                st = svc.find("{*}serviceType")
                if st is not None and "WANIPConnection" in st.text:
                    cu = svc.find("{*}controlURL")
                    if cu is not None and cu.text:
                        base = urllib.parse.urlparse(location_url)
                        url = cu.text
                        if not url.startswith("http"):
                            url = f"{base.scheme}://{base.netloc}{url}"
                        return url
    except Exception:
        return None


def _soap_call(control_url, action, fields):
    """发送 UPnP SOAP 请求"""
    body = (
        '<?xml version="1.0"?>'
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" '
        's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        "<s:Body><u:" + action
        + ' xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">'
        + "".join(f"<{k}>{v}</{k}>" for k, v in fields.items())
        + "</u:" + action + "></s:Body></s:Envelope>"
    )
    req = urllib.request.Request(
        control_url,
        data=body.encode(),
        headers={
            "Content-Type": 'text/xml; charset="utf-8"',
            "SOAPAction": f'"urn:schemas-upnp-org:service:WANIPConnection:1#{action}"',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def upnp_open(port, internal_port, internal_ip, desc="Tunnel"):
    """通过 UPnP 开放公网 IPv4 端口，返回 True 成功"""
    loc = _ssdp_discover()
    if not loc:
        return False
    ctrl = _get_control_url(loc)
    if not ctrl:
        return False
    return _soap_call(
        ctrl,
        "AddPortMapping",
        {
            "NewRemoteHost": "",
            "NewExternalPort": str(port),
            "NewInternalPort": str(internal_port),
            "NewInternalClient": internal_ip,
            "NewProtocol": "TCP",
            "NewEnabled": "1",
            "NewPortMappingDescription": desc,
            "NewLeaseDuration": "0",
        },
    )


def upnp_close(port):
    """关闭 UPnP 端口映射"""
    loc = _ssdp_discover()
    if not loc:
        return
    ctrl = _get_control_url(loc)
    if not ctrl:
        return
    _soap_call(
        ctrl,
        "DeletePortMapping",
        {"NewRemoteHost": "", "NewExternalPort": str(port), "NewProtocol": "TCP"},
    )


# ======================== 隧道路径重写 (核心修复) ========================

# JS 拦截器：注入到 HTML 页面中，在运行时为所有 fetch/XHR/DOM 绝对路径
# 自动添加隧道路径前缀，这样被代理的 Web 应用无需任何修改即可在
# http://tunnel-server/TUNNEL_CODE/ 下正常工作。
# 参考 IDE 项目 browser.py 的 _inject_script_interceptor 技术。
_TUNNEL_JS_INTERCEPTOR = r"""<script data-tunnel-interceptor="1">(function(){
var P="/__TUNNEL_CODE__";
function _rp(u){if(typeof u!=="string")return u;if(u.charAt(0)==="/"&&!u.startsWith(P+"/"))return P+u;return u}
var _f=window.fetch;window.fetch=function(i,o){if(typeof i==="string")i=_rp(i);else if(i&&typeof i==="object"&&typeof i.url==="string"){try{var n=new Request(_rp(i.url),i);i=n}catch(e){}}return _f.call(this,i,o)};
var _xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){if(typeof u==="string")arguments[1]=_rp(u);var r=_xo.apply(this,arguments);if(typeof u==="string"&&_rp(u)!==u)try{this.setRequestHeader("X-Tunnel-Prefix",P)}catch(e){}return r};
var _ES=window.EventSource;if(_ES){var _ESOrig=_ES;window.EventSource=function(u,c){if(typeof u==="string")u=_rp(u);return new _ESOrig(u,c)};window.EventSource.prototype=_ESOrig.prototype;window.EventSource.CONNECTING=_ESOrig.CONNECTING;window.EventSource.OPEN=_ESOrig.OPEN;window.EventSource.CLOSED=_ESOrig.CLOSED}
var _ps=history.pushState;history.pushState=function(s,t,u){if(typeof u==="string")arguments[2]=_rp(u);return _ps.apply(this,arguments)};
var _rs=history.replaceState;history.replaceState=function(s,t,u){if(typeof u==="string")arguments[2]=_rp(u);return _rs.apply(this,arguments)};
var _wo=window.open;window.open=function(u,t,f){if(typeof u==="string")u=_rp(u);return _wo.call(this,u,t,f)};
var _hd=Object.getOwnPropertyDescriptor(Location.prototype,"href");if(_hd){Object.defineProperty(Location.prototype,"href",{get:function(){return _hd.get.call(this)},set:function(v){_hd.set.call(this,_rp(v))},configurable:true})}
var _la=Location.prototype.assign;Location.prototype.assign=function(u){return _la.call(this,_rp(u))};
var _lr=Location.prototype.replace;Location.prototype.replace=function(u){return _lr.call(this,_rp(u))};
var _ahd=Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype,"href");if(_ahd){Object.defineProperty(HTMLAnchorElement.prototype,"href",{get:function(){return _ahd.get.call(this)},set:function(v){_ahd.set.call(this,_rp(v))},configurable:true})}
var _ssd=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,"src");if(_ssd){Object.defineProperty(HTMLScriptElement.prototype,"src",{get:function(){return _ssd.get.call(this)},set:function(v){_ssd.set.call(this,_rp(v))},configurable:true})}
var _lhd=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,"href");if(_lhd){Object.defineProperty(HTMLLinkElement.prototype,"href",{get:function(){return _lhd.get.call(this)},set:function(v){_lhd.set.call(this,_rp(v))},configurable:true})}
var _isd=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");if(_isd){Object.defineProperty(HTMLImageElement.prototype,"src",{get:function(){return _isd.get.call(this)},set:function(v){_isd.set.call(this,_rp(v))},configurable:true})}
document.addEventListener("click",function(e){var el=e.target;while(el&&el.tagName!=="A")el=el.parentElement;if(el&&el.tagName==="A"){var h=el.getAttribute("href");if(h&&h.charAt(0)==="/"&&!h.startsWith(P+"/"))try{el.setAttribute("href",P+h)}catch(ex){}}},true);
var _A=["src","href","action"];var _ob=new MutationObserver(function(mu){for(var i=0;i<mu.length;i++){var an=mu[i].addedNodes;for(var j=0;j<an.length;j++){var nd=an[j];if(nd.nodeType!==1)continue;_A.forEach(function(a){var v=nd.getAttribute(a);if(v&&v.charAt(0)==="/"&&!v.startsWith(P+"/"))nd.setAttribute(a,P+v)});if(nd.querySelectorAll)_A.forEach(function(a){nd.querySelectorAll("["+a+'^="/"]').forEach(function(el){var v=el.getAttribute(a);if(v&&!v.startsWith(P+"/"))el.setAttribute(a,P+v)})})}}});_ob.observe(document.documentElement,{childList:true,subtree:true});
})();</script>"""


def _rewrite_html(body: bytes, prefix: str) -> bytes:
    """重写 HTML 响应体中的绝对路径，并注入 JS 拦截器。

    参考 IDE 项目 browser.py 的 _rewrite_html_urls 技术，适配隧道路径前缀模式。
    1. 将各标签 href/src/action 的绝对路径改为带前缀的路径
    2. 将 CSS 中 url(/...) 改为 url(PREFIX/...)
    3. 重写 srcset 属性
    4. 在 </head> 前注入 JS 拦截器脚本
    """
    try:
        text = body.decode("utf-8", errors="replace")
    except Exception:
        return body

    # 1) HTML 属性: 按 IDE browser.py 的方式，对每种标签分别处理
    #    避免过于宽泛的正则误匹配
    tag_attrs = [
        (r'(<link\s[^>]*?href\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<script\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<img\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<a\s[^>]*?href\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<iframe\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<form\s[^>]*?action\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<source\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<video\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<audio\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<embed\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<object\s[^>]*?data\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<input\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<area\s[^>]*?href\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<button\s[^>]*?formaction\s*=\s*["\'])/', rf'\1{prefix}/'),
        (r'(<track\s[^>]*?src\s*=\s*["\'])/', rf'\1{prefix}/'),
    ]
    for pattern, replacement in tag_attrs:
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

    # 2) CSS url(): url(/...) → url(PREFIX/...)
    text = re.sub(r'(url\(\s*["\']?\s*)/', rf'\1{prefix}/', text)

    # 3) srcset 属性
    def _rewrite_srcset(m):
        attr_pfx = m.group(1)
        srcset_val = m.group(2)
        quote = m.group(3)
        parts = srcset_val.split(',')
        new_parts = []
        for part in parts:
            part = part.strip()
            if not part:
                continue
            tokens = part.split(None, 1)
            url = tokens[0]
            desc = tokens[1] if len(tokens) > 1 else ''
            if url and url.startswith('/') and not url.startswith(prefix + '/'):
                url = prefix + url
            new_parts.append(url + (' ' + desc if desc else ''))
        return attr_pfx + ', '.join(new_parts) + quote

    text = re.sub(
        r'((?:srcset|data-srcset)\s*=\s*["\'])([^"\']*)(["\'])',
        _rewrite_srcset, text, flags=re.IGNORECASE
    )

    # 4) 注入 JS 拦截器 (在 </head> 之前，确保最先执行)
    js = _TUNNEL_JS_INTERCEPTOR.replace("__TUNNEL_CODE__", prefix.strip("/"))
    if "</head>" in text:
        text = text.replace("</head>", js + "\n</head>", 1)
    elif "</html>" in text:
        text = text.replace("</html>", js + "\n</html>", 1)
    else:
        text += js

    return text.encode("utf-8", errors="replace")


def _rewrite_css(body: bytes, prefix: str) -> bytes:
    """重写 CSS 响应体中的 url() 绝对路径和 @import 绝对路径。"""
    try:
        text = body.decode("utf-8", errors="replace")
    except Exception:
        return body

    # url(/...) → url(PREFIX/...)
    text = re.sub(r'(url\(\s*["\']?\s*)/', rf'\1{prefix}/', text)
    # @import '/...' → @import 'PREFIX/...'
    text = re.sub(r'(@import\s+["\'])/', rf'\1{prefix}/', text)

    return text.encode("utf-8", errors="replace")


def _rewrite_js(body: bytes, prefix: str) -> bytes:
    """重写 JS 响应体中常见的绝对路径模式。

    参考 IDE browser.py 的 _rewrite_js_urls 技术。
    注意：JS 静态重写是有限的，主要靠注入的 JS 拦截器处理运行时路径。
    """
    try:
        text = body.decode("utf-8", errors="replace")
    except Exception:
        return body

    # fetch('/...') → fetch('PREFIX/...')
    text = re.sub(r"(fetch\s*\(\s*['\"])/", rf"\1{prefix}/", text)
    # new URL('/...') → new URL('PREFIX/...')
    text = re.sub(r"(new\s+URL\s*\(\s*['\"])/", rf"\1{prefix}/", text)
    # location.href = '/...' → location.href = 'PREFIX/...'
    text = re.sub(r"(location\.href\s*=\s*['\"])/", rf"\1{prefix}/", text)
    text = re.sub(r"(location\.assign\s*\(\s*['\"])/", rf"\1{prefix}/", text)
    text = re.sub(r"(location\.replace\s*\(\s*['\"])/", rf"\1{prefix}/", text)
    # window.open('/...') → window.open('PREFIX/...')
    text = re.sub(r"(window\.open\s*\(\s*['\"])/", rf"\1{prefix}/", text)

    return text.encode("utf-8", errors="replace")


def _rewrite_redirect_headers(headers: dict, prefix: str) -> dict:
    """重写 3xx 重定向的 Location 头，添加隧道前缀。"""
    location = headers.get("Location", "")
    if location.startswith("/"):
        headers["Location"] = prefix + location
    return headers


def _rewrite_cookie_headers(headers: dict, prefix: str) -> dict:
    """重写 Set-Cookie 的 Path，将 Path=/ 改为 Path=PREFIX/，
    防止 cookie 泄漏到同域名下的其他隧道。"""
    cookie = headers.get("Set-Cookie", "")
    if cookie and "Path=/" in cookie:
        headers["Set-Cookie"] = cookie.replace("Path=/", f"Path={prefix}/")
    return headers


# ======================== P2P HTTP 反向代理 ========================

class P2PProxy:
    """
    轻量 HTTP 反向代理：监听指定地址和端口，转发请求到本地服务。
    支持 IPv4 (0.0.0.0) 和 IPv6 双栈 ([::]) 两种监听模式。
    """

    def __init__(self, listen_host: str, listen_port: int,
                 target_host: str, target_port: int,
                 tunnel_code: str = ""):
        self.listen_host = listen_host
        self.listen_port = listen_port
        self.target_host = target_host
        self.target_port = target_port
        self.tunnel_code = tunnel_code
        self.runner: web.AppRunner | None = None
        self.session: aiohttp.ClientSession | None = None

    async def start(self):
        self.session = aiohttp.ClientSession()
        app = web.Application()
        app.router.add_route("*", "/{path_info:.*}", self._handler)
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
        headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() not in ("host", "connection", "transfer-encoding")
        }
        body = await request.read()
        try:
            async with self.session.request(
                request.method, target, headers=headers, data=body
            ) as resp:
                resp_body = await resp.read()
                pass_headers = {
                    k: v
                    for k, v in resp.headers.items()
                    if k.lower() not in ("transfer-encoding", "connection", "content-length")
                }
                # P2P 直连模式不需要路径重写（浏览器直接访问 IP:PORT，无前缀）
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
        # P2P 模式: "ipv6" | "upnp" | "dual" | "relay"
        self._p2p_mode = "relay"
        self._upnp_opened = False

    async def start(self):
        print(f"\n  Tunnel Client v2.4 (IPv6/IPv4 P2P + Relay + Path-Rewrite)")
        print(f"  服务器:   {self.server}")
        print(f"  密钥:     {self.key[:16]}{'...' if len(self.key) > 16 else ''}")
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
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
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
            # 心跳响应：必须立即回复，不等待任何其他操作
            if self.ws and not self.ws.closed:
                try:
                    await self.ws.send_json({"type": "pong"})
                except Exception:
                    pass

        elif t == "request":
            # 中继模式：用独立任务处理转发请求，不阻塞消息循环
            # 这样心跳 pong 不会被长时间代理请求阻塞
            asyncio.create_task(self._proxy_request_safe(data))

        elif t == "error":
            print(f"  [错误] {data.get('message', '未知错误')}")

    async def _try_p2p(self):
        """
        尝试 P2P 直连，策略:
        1. IPv6 直连 (优先) — 公网 IPv6 无 NAT，成功率高
        2. UPnP IPv4 — 路由器端口映射
        3. 两者都失败 → 中继模式
        """
        local_ip = get_local_ip()
        desc = f"Tunnel-{self._tunnel_code or self.key[:8]}"

        # ---- 第一步: 检测 IPv6 ----
        ipv6_addr = get_public_ipv6()
        ipv6_ok = False
        ipv6_url = ""

        if ipv6_addr:
            print(f"  [P2P] 检测到公网 IPv6: {ipv6_addr}")
            if test_ipv6_connectivity():
                print(f"  [P2P] IPv6 连通性测试: 通过")
                # 尝试在 [::]:port 上启动双栈代理
                try:
                    self._p2p_proxy = P2PProxy(
                        "::", self.p2p_port,
                        self.local_host, self.local_port,
                        self._tunnel_code,
                    )
                    await self._p2p_proxy.start()
                    ipv6_url = f"http://[{ipv6_addr}]:{self.p2p_port}"
                    ipv6_ok = True
                    print(f"  [P2P] IPv6 直连就绪: {ipv6_url}")
                except OSError as e:
                    # 端口被占用等错误
                    print(f"  [P2P] IPv6 代理启动失败: {e}")
                    if self._p2p_proxy:
                        await self._p2p_proxy.stop()
                        self._p2p_proxy = None
            else:
                print(f"  [P2P] IPv6 连通性测试: 失败 (IPv6 不可达)")
        else:
            print(f"  [P2P] 未检测到公网 IPv6 地址")

        # ---- 第二步: 如果 IPv6 失败，尝试 UPnP IPv4 ----
        upnp_ok = False
        ipv4_url = ""

        if not ipv6_ok and self._public_ip:
            print(f"  [P2P] 尝试 UPnP IPv4 端口映射...")
            print(f"  [P2P] 公网 IPv4: {self._public_ip}")
            print(f"  [P2P] 局域网 IP:  {local_ip}")
            print(f"  [P2P] 映射: {self._public_ip}:{self.p2p_port} -> {local_ip}:{self.p2p_port}")

            if upnp_open(self.p2p_port, self.p2p_port, local_ip, desc):
                try:
                    if not self._p2p_proxy:
                        self._p2p_proxy = P2PProxy(
                            "0.0.0.0", self.p2p_port,
                            self.local_host, self.local_port,
                            self._tunnel_code,
                        )
                        await self._p2p_proxy.start()
                    ipv4_url = f"http://{self._public_ip}:{self.p2p_port}"
                    upnp_ok = True
                    self._upnp_opened = True
                    print(f"  [P2P] UPnP 端口映射成功!")
                    print(f"  [P2P] 直连地址: {ipv4_url}")
                except Exception as e:
                    print(f"  [P2P] UPnP 代理启动失败: {e}")
                    upnp_close(self.p2p_port)
            else:
                print(f"  [P2P] UPnP 失败 (路由器未开启 UPnP 或处于 CGNAT)")
        elif not ipv6_ok:
            print(f"  [P2P] 无法获取公网 IPv4 地址，跳过 UPnP")

        # ---- 第三步: 也尝试 UPnP 作为 IPv4 补充 (如果 IPv6 已成功) ----
        if ipv6_ok and not upnp_ok and self._public_ip:
            # IPv6 成功了，也尝试 UPnP 给纯 IPv4 访问者用
            print(f"  [P2P] IPv6 已成功，尝试额外开启 UPnP IPv4 (给纯 IPv4 访问者)...")
            if upnp_open(self.p2p_port, self.p2p_port, local_ip, desc + "-v4"):
                ipv4_url = f"http://{self._public_ip}:{self.p2p_port}"
                upnp_ok = True
                self._upnp_opened = True
                print(f"  [P2P] UPnP IPv4 额外映射成功: {ipv4_url}")
            else:
                print(f"  [P2P] UPnP IPv4 额外映射失败 (纯 IPv4 访问者将使用中继)")

        # ---- 汇总上报 ----
        p2p_urls = []
        if ipv6_ok:
            p2p_urls.append({"url": ipv6_url, "type": "ipv6"})
        if upnp_ok:
            p2p_urls.append({"url": ipv4_url, "type": "upnp"})

        if ipv6_ok and upnp_ok:
            self._p2p_mode = "dual"
        elif ipv6_ok:
            self._p2p_mode = "ipv6"
        elif upnp_ok:
            self._p2p_mode = "upnp"
        else:
            self._p2p_mode = "relay"

        self._p2p_ok = len(p2p_urls) > 0

        # 发送 P2P 信息给服务端
        if self.ws and not self.ws.closed:
            await self.ws.send_json({
                "type": "p2p_info",
                "urls": p2p_urls,
                "mode": self._p2p_mode,
            })

        if not self._p2p_ok:
            print(f"  [P2P] 直连均失败，使用中继模式 (所有流量经服务器转发)")
        else:
            mode_labels = {"ipv6": "IPv6 直连", "upnp": "UPnP IPv4", "dual": "IPv6 + UPnP 双栈"}
            print(f"  [P2P] 模式: {mode_labels.get(self._p2p_mode, self._p2p_mode)}")

    async def _stop_p2p(self):
        """清理 P2P 资源"""
        if self._p2p_proxy:
            await self._p2p_proxy.stop()
            self._p2p_proxy = None
        if self._upnp_opened and self.p2p_port:
            upnp_close(self.p2p_port)
            print(f"  [P2P] 已清理 UPnP 端口映射")
        self._p2p_ok = False
        self._upnp_opened = False
        self._p2p_mode = "relay"

    async def _proxy_request_safe(self, data: dict):
        """安全包装：捕获所有异常，防止后台任务崩溃"""
        try:
            await self._proxy_request(data)
        except Exception as e:
            print(f"  [代理错误] {e}")
            # 尝试返回错误响应给服务端
            try:
                if self.ws and not self.ws.closed:
                    await self.ws.send_json({
                        "type": "response",
                        "id": data.get("id", "unknown"),
                        "status_code": 502,
                        "headers": {"Content-Type": "application/json"},
                        "body": base64.b64encode(json.dumps({"error": str(e)}).encode()).decode(),
                    })
            except Exception:
                pass

    async def _proxy_request(self, data: dict):
        """中继模式：通过 WebSocket 转发 HTTP 请求，并重写响应中的绝对路径。

        当通过 http://tunnel-server/TUNNEL_CODE/ 访问时，浏览器会把
        HTML 中的绝对路径 /api/... /css/... 解析为
        http://tunnel-server/api/...（丢失 /TUNNEL_CODE/ 前缀），
        导致所有资源请求 404。

        修复方式（完全不修改被代理的应用）：
        1. HTML 响应 → 正则替换 href/src/action 的绝对路径 + 注入 JS 拦截器
        2. 3xx 重定向 → 重写 Location 头
        3. Set-Cookie → 重写 Path=/
        """
        req_id = data["id"]
        method = data["method"]
        url_path = data["url"]
        headers = {
            k: v
            for k, v in data.get("headers", {}).items()
            if k.lower() not in ("host", "connection", "transfer-encoding")
        }
        body_b64 = data.get("body")
        body = base64.b64decode(body_b64) if body_b64 else None

        target = f"http://{self.local_host}:{self.local_port}{url_path}"
        prefix = f"/{self._tunnel_code}" if self._tunnel_code else ""

        try:
            # 使用更长的超时（600秒），匹配服务端超时
            timeout = aiohttp.ClientTimeout(total=600)
            async with self.session.request(method, target, headers=headers, data=body, timeout=timeout) as resp:
                resp_body = await resp.read()
                resp_headers = {
                    k: v
                    for k, v in resp.headers.items()
                    if k.lower() not in ("transfer-encoding", "connection")
                }

                # ---- 路径重写 (仅在隧道编码存在时) ----
                if prefix:
                    ct = resp_headers.get("Content-Type", "").lower()
                    status = resp.status

                    # 1) HTML 响应: 重写绝对路径 + 注入 JS 拦截器
                    if "text/html" in ct and resp_body:
                        resp_body = _rewrite_html(resp_body, prefix)

                    # 2) CSS 响应: 重写 url() 和 @import
                    elif "text/css" in ct and resp_body:
                        resp_body = _rewrite_css(resp_body, prefix)

                    # 3) JS 响应: 重写 fetch/location/window.open 等
                    elif ("text/javascript" in ct or "application/javascript" in ct) and resp_body:
                        resp_body = _rewrite_js(resp_body, prefix)

                    # 4) 3xx 重定向: 重写 Location 头 + Set-Cookie Path
                    if status in (301, 302, 303, 307, 308):
                        resp_headers = _rewrite_redirect_headers(resp_headers, prefix)
                        if "Set-Cookie" in resp_headers:
                            resp_headers = _rewrite_cookie_headers(resp_headers, prefix)

                    # 5) 非 3xx 的 Set-Cookie 也要重写 Path
                    elif "Set-Cookie" in resp_headers:
                        resp_headers = _rewrite_cookie_headers(resp_headers, prefix)

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
            mode = self._p2p_mode.upper()
            base = self.server if self.server.startswith("http") else f"http://{self.server}"
            print(f"  [状态] {h:02d}:{m:02d}:{s:02d} | P2P: {mode} | 请求: {self.req_count} | {base}/{code}")

    async def _reconnect(self):
        if not self._running:
            return
        delay = min(1 * (2 ** self.retry_count), 120)
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
    parser = argparse.ArgumentParser(
        description="Tunnel Client v2.4 (IPv6/IPv4 P2P + Relay + Path-Rewrite)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  tunnel-p2p-client --key YOUR_TOKEN --port 8080
  tunnel-p2p-client -k YOUR_TOKEN -p 3000 -s aicq.online:7739
  tunnel-p2p-client -k YOUR_TOKEN -p 80 --no-p2p

P2P 模式 (默认启用):
  优先级: IPv6 直连 > UPnP IPv4 > 中继
  --p2p-port  指定 P2P 监听端口 (默认与本地端口相同)
  --no-p2p     强制禁用 P2P，仅使用中继
        """,
    )
    parser.add_argument("-k", "--key", required=True, help="认证令牌")
    parser.add_argument("-p", "--port", type=int, default=8080, help="本地服务端口 (默认: 8080)")
    parser.add_argument("-s", "--server", default="aicq.online:7739", help="服务器地址 (默认: aicq.online:7739)")
    parser.add_argument("--host", default="localhost", help="本地服务地址 (默认: localhost)")
    parser.add_argument("--p2p-port", type=int, default=0, help="P2P 监听端口 (默认: 与本地端口相同)")
    parser.add_argument("--no-p2p", action="store_true", help="禁用 P2P，强制使用中继模式")
    args = parser.parse_args()

    p2p_enabled = not args.no_p2p
    p2p_port = args.p2p_port if args.p2p_port > 0 else args.port

    client = TunnelClient(
        server=args.server,
        key=args.key.strip(),
        local_port=args.port,
        local_host=args.host,
        p2p=p2p_enabled,
        p2p_port=p2p_port,
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
