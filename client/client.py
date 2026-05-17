#!/usr/bin/env python3
"""
Tunnel Client - 内网穿透客户端 (Python + aiohttp)
用法: python client.py --key <认证令牌> --port <本地端口> [--host localhost] [--server aicq.online:7739]
"""
import argparse
import asyncio
import base64
import json
import signal
import sys
import time

import aiohttp


class TunnelClient:
    def __init__(self, server: str, key: str, local_port: int, local_host: str):
        self.server = server
        self.key = key
        self.local_port = local_port
        self.local_host = local_host
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.session: aiohttp.ClientSession | None = None
        self.req_count = 0
        self.start_time = time.time()
        self.retry_count = 0
        self._running = True
        self._status_task: asyncio.Task | None = None

    async def start(self):
        print(f"\n  Tunnel Client v1.0")
        print(f"  服务器: {self.server}")
        print(f"  密钥:   {self.key[:16]}...")
        print(f"  本地:   {self.local_host}:{self.local_port}\n")

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
            code = data.get("tunnel_code", "")
            print(f"  [OK] 隧道已建立")
            print(f"  [OK] 公网地址: {url}\n")
            if self._status_task:
                self._status_task.cancel()
            self._status_task = asyncio.create_task(self._status_loop(code))

        elif t == "ping":
            if self.ws and not self.ws.closed:
                await self.ws.send_json({"type": "pong"})

        elif t == "request":
            await self._proxy_request(data)

        elif t == "error":
            print(f"  [错误] {data.get('message', '未知错误')}")

    async def _proxy_request(self, data: dict):
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
            base = self.server if self.server.startswith("http") else f"http://{self.server}"
            print(f"  [状态] {h:02d}:{m:02d}:{s:02d} | 请求: {self.req_count} | {base}/{code}")

    async def _reconnect(self):
        if not self._running:
            return
        delay = min(1 * (2 ** self.retry_count), 30)
        self.retry_count += 1
        print(f"  [重连] {delay}s 后...")
        await asyncio.sleep(delay)

    async def close(self):
        self._running = False
        if self._status_task:
            self._status_task.cancel()
        if self.ws and not self.ws.closed:
            await self.ws.close()
        if self.session:
            await self.session.close()


def main():
    parser = argparse.ArgumentParser(description="Tunnel Client v1.0")
    parser.add_argument("-k", "--key", required=True, help="认证令牌（Dashboard 创建时生成）")
    parser.add_argument("-p", "--port", type=int, default=8080, help="本地服务端口 (默认: 8080)")
    parser.add_argument("-s", "--server", default="aicq.online:7739", help="服务器地址 (默认: aicq.online:7739)")
    parser.add_argument("--host", default="localhost", help="本地服务地址 (默认: localhost)")
    args = parser.parse_args()

    client = TunnelClient(server=args.server, key=args.key.strip(),
                          local_port=args.port, local_host=args.host)

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
