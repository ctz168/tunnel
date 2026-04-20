#!/usr/bin/env bun
/**
 * TunnelNet Client - 内网穿透客户端（纯 CLI，支持 IPv6）
 *
 * 用法:
 *   tunnelnet --key <8位密钥> --port <本地端口>
 *
 * 参数:
 *   --key         8位隧道密钥 (必填)
 *   --port        本地服务端口 (必填)
 *   --server      服务器地址 (默认: aicq.online:1018)
 *   --host        本地服务地址 (默认: localhost)
 *
 * 示例:
 *   tunnelnet --key ABCD1234 --port 8080
 *   tunnelnet -k ABCD1234 -p 3000 -s aicq.online:1018
 *   tunnelnet -k ABCD1234 -p 3000 -s [2001:db8::1]:1018
 */

import WebSocket from 'ws';
import http from 'http';
import dns from 'dns';

interface ClientConfig {
  server: string;
  key: string;
  localPort: number;
  localHost: string;
}

function parseArgs(): ClientConfig {
  const args = process.argv.slice(2);
  const config: Partial<ClientConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--server': case '-s':
        config.server = args[++i];
        break;
      case '--key': case '-k':
        config.key = args[++i];
        break;
      case '--port': case '-p':
        config.localPort = parseInt(args[++i], 10);
        break;
      case '--host': case '-h':
        config.localHost = args[++i];
        break;
      case '--help':
        printHelp();
        process.exit(0);
    }
  }

  if (!config.key || !config.localPort) {
    printHelp();
    process.exit(1);
  }

  return {
    server: config.server || 'aicq.online:1018',
    key: config.key!.toUpperCase().trim(),
    localPort: config.localPort!,
    localHost: config.localHost || 'localhost',
  };
}

function printHelp() {
  console.log('');
  console.log('  TunnelNet Client v1.2 - 内网穿透客户端 (IPv6/IPv4)');
  console.log('');
  console.log('  用法: tunnelnet --key <8位密钥> --port <本地端口> [选项]');
  console.log('');
  console.log('  必填参数:');
  console.log('    --key,  -k    8位隧道密钥 (从管理面板获取)');
  console.log('    --port, -p    本地服务端口号 (如 8080)');
  console.log('');
  console.log('  可选参数:');
  console.log('    --server,-s   服务器地址 (默认: aicq.online:1018)');
  console.log('    --host, -h    本地服务地址 (默认: localhost)');
  console.log('    --help        显示帮助信息');
  console.log('');
}

function buildWsUrl(server: string, key: string): string {
  if (server.startsWith('http://') || server.startsWith('https://')) {
    return server.replace(/^http/, 'ws') + `/ws?key=${encodeURIComponent(key)}`;
  }
  if (server.startsWith('ws://') || server.startsWith('wss://')) {
    return server + `/ws?key=${encodeURIComponent(key)}`;
  }
  if (server.startsWith('[')) {
    return `ws://${server}/ws?key=${encodeURIComponent(key)}`;
  }
  return `ws://${server}/ws?key=${encodeURIComponent(key)}`;
}

function createLookup(hostname: string) {
  return (_opts: unknown, callback: (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void) => {
    if (/^(\d+\.){3}\d+$/.test(hostname)) {
      return callback(null, hostname, 4);
    }
    if (hostname.startsWith('[')) {
      const addr = hostname.replace(/^\[|\]$/g, '').split(':')[0];
      return callback(null, addr || hostname, 6);
    }

    dns.resolve6(hostname, (err6, addresses6) => {
      dns.resolve4(hostname, (err4, addresses4) => {
        if (addresses6 && addresses6.length > 0) {
          callback(null, addresses6[0], 6);
        } else if (addresses4 && addresses4.length > 0) {
          callback(null, addresses4[0], 4);
        } else {
          callback(err6 || err4 || new Error(`无法解析 ${hostname}`));
        }
      });
    });
  };
}

// 检查本地服务是否可用
function checkLocalService(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: host,
      port: port,
      path: '/',
      method: 'GET',
      timeout: 3000,
      family: host.includes(':') ? 6 : undefined,
    }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

class TunnelClient {
  private config: ClientConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCount = 0;
  private bytesIn = 0;
  private bytesOut = 0;
  private startTime = Date.now();
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private isShuttingDown = false;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  start() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║       TunnelNet Client v1.2 (IPv6/IPv4)       ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  服务器:   ${this.config.server}`);
    console.log(`  密钥:     ${this.config.key}`);
    console.log(`  本地:     ${this.config.localHost}:${this.config.localPort}`);
    console.log('');
    this.connect();
  }

  private async connect() {
    // Bug 9: 检查本地服务
    console.log(`  [检查] 正在检测本地服务 ${this.config.localHost}:${this.config.localPort}...`);
    const localOk = await checkLocalService(this.config.localHost, this.config.localPort);
    if (!localOk) {
      console.log(`  [警告] 本地服务 ${this.config.localHost}:${this.config.localPort} 似乎未运行`);
      console.log(`  [警告] 隧道仍将建立，但请求可能无法转发`);
    } else {
      console.log(`  [OK]   本地服务可达`);
    }

    const wsUrl = buildWsUrl(this.config.server, this.config.key);
    console.log(`  [连接] ${wsUrl.replace(/key=[^&]+/, 'key=***')}`);

    try {
      this.ws = new WebSocket(wsUrl, {
        lookup: createLookup(new URL(wsUrl).hostname),
        handshakeTimeout: 15000,
      });
    } catch (err) {
      console.error(`  [错误] 连接创建失败: ${err}`);
      this.scheduleReconnect();
      return;
    }

    // 连接超时
    const connTimeout = setTimeout(() => {
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
        console.log(`  [超时] 连接超时 (15s)`);
        this.ws.terminate();
      }
    }, 15000);

    this.ws.on('open', () => {
      clearTimeout(connTimeout);
      this.reconnectAttempts = 0;
      this.startStatusTimer();
      console.log(`  [OK]   WebSocket 已连接，等待隧道建立...`);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'connected':
            console.log(`  [OK]   隧道已建立`);
            console.log(`  [OK]   公网地址: ${msg.publicUrl}`);
            console.log('');
            console.log(`  ─────────────────────────────────────────────`);
            console.log(`  访问 ${msg.publicUrl} 即可映射到本地 ${this.config.localHost}:${this.config.localPort}`);
            console.log(`  按 Ctrl+C 断开连接`);
            console.log(`  ─────────────────────────────────────────────`);
            console.log('');
            break;

          case 'ping':
            this.ws?.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'request':
            this.handleProxyRequest(msg);
            break;

          case 'error':
            console.error(`  [错误] ${msg.message}`);
            if (msg.message.includes('无效的密钥') || msg.message.includes('认证失败')) {
              console.error(`  [错误] 密钥无效，请检查: ${this.config.key}`);
              this.isShuttingDown = true;
              process.exit(1);
            }
            break;
        }
      } catch {
        // 忽略
      }
    });

    this.ws.on('close', (code) => {
      clearTimeout(connTimeout);
      if (this.statusTimer) clearInterval(this.statusTimer);
      if (this.isShuttingDown) return;
      console.log(`  [断开] WebSocket 关闭 (code: ${code})`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      clearTimeout(connTimeout);
      if (this.isShuttingDown) return;
      console.error(`  [错误] ${err.message}`);
    });
  }

  private handleProxyRequest(msg: { id: string; method: string; url: string; headers: Record<string, string>; body?: string }) {
    const body = msg.body ? Buffer.from(msg.body, 'base64') : undefined;

    const filteredHeaders: Record<string, string> = {};
    const skipHeaders = ['host', 'connection', 'transfer-encoding', 'keep-alive'];
    for (const [key, value] of Object.entries(msg.headers)) {
      if (!skipHeaders.includes(key.toLowerCase()) && typeof value === 'string') {
        filteredHeaders[key] = value;
      }
    }

    // 解析本地地址 - 支持 IPv6
    let localHostname = this.config.localHost;
    let localFamily: 4 | 6 | undefined;

    if (localHostname.startsWith('[')) {
      localHostname = localHostname.replace(/^\[|\]$/g, '');
      localFamily = 6;
    } else if (localHostname === '::1' || localHostname.includes(':')) {
      localFamily = 6;
    }

    const startTime = Date.now();
    const req = http.request({
      hostname: localHostname,
      port: this.config.localPort,
      path: msg.url,
      method: msg.method,
      headers: filteredHeaders,
      family: localFamily,
      timeout: 30000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const respHeaders: Record<string, string> = {};
        const skipRespHeaders = ['transfer-encoding', 'connection', 'keep-alive'];
        for (const [key, value] of Object.entries(res.headers)) {
          if (!skipRespHeaders.includes(key.toLowerCase()) && typeof value === 'string') {
            respHeaders[key] = value;
          }
        }
        if (bodyBuffer.length > 0) {
          respHeaders['content-length'] = bodyBuffer.length.toString();
        }

        this.ws?.send(JSON.stringify({
          type: 'response',
          id: msg.id,
          statusCode: res.statusCode,
          headers: respHeaders,
          body: bodyBuffer.length > 0 ? bodyBuffer.toString('base64') : undefined,
        }));

        this.requestCount++;
        this.bytesIn += (msg.body ? Buffer.byteLength(msg.body, 'base64') : 0);
        this.bytesOut += bodyBuffer.length;

        const elapsed = Date.now() - startTime;
        console.log(`  [代理] ${msg.method} ${msg.url} → ${res.statusCode} (${elapsed}ms)`);
      });
    });

    req.on('error', (err) => {
      this.ws?.send(JSON.stringify({
        type: 'response',
        id: msg.id,
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: '本地服务不可用', details: err.message })).toString('base64'),
      }));
      console.error(`  [代理] ${msg.method} ${msg.url} → 502 (${err.message})`);
    });

    req.on('timeout', () => {
      req.destroy();
      this.ws?.send(JSON.stringify({
        type: 'response',
        id: msg.id,
        statusCode: 504,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: '本地服务超时' })).toString('base64'),
      }));
      console.error(`  [代理] ${msg.method} ${msg.url} → 504 (超时)`);
    });

    if (body && body.length > 0) req.write(body);
    req.end();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.isShuttingDown) return;
    const delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)), 30000);
    this.reconnectAttempts++;
    const secs = Math.round(delay / 1000);
    console.log(`  [重连] ${secs}s 后重新连接... (第${this.reconnectAttempts}次)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startStatusTimer() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => this.printStatus(), 60000);
  }

  private printStatus() {
    const up = Math.floor((Date.now() - this.startTime) / 1000);
    const h = Math.floor(up / 3600);
    const m = Math.floor((up % 3600) / 60);
    const s = up % 60;
    const upTime = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    console.log(`  [状态] 运行 ${upTime} | 请求: ${this.requestCount} | ↑${this.bytesOut} ↓${this.bytesIn} bytes | http://${this.config.server}/${this.config.key}`);
  }
}

const config = parseArgs();
const client = new TunnelClient(config);
client.start();

process.on('SIGINT', () => {
  console.log('\n  关闭连接...');
  client['isShuttingDown'] = true;
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n  关闭连接...');
  client['isShuttingDown'] = true;
  process.exit(0);
});
