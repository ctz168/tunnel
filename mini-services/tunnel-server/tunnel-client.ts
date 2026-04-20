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
 *                 支持 IPv6: -s [2001:db8::1]:1018
 *   --host        本地服务地址 (默认: localhost)
 *                 支持 IPv6: -h ::1 或 [::1]
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
  console.log('  TunnelNet Client v1.1 - 内网穿透客户端 (IPv6/IPv4)');
  console.log('');
  console.log('  用法: tunnelnet --key <8位密钥> --port <本地端口> [选项]');
  console.log('');
  console.log('  必填参数:');
  console.log('    --key,  -k    8位隧道密钥 (从管理面板获取)');
  console.log('    --port, -p    本地服务端口号 (如 8080)');
  console.log('');
  console.log('  可选参数:');
  console.log('    --server,-s   服务器地址 (默认: aicq.online:1018)');
  console.log('                  支持 IPv6: [2001:db8::1]:1018');
  console.log('    --host, -h    本地服务地址 (默认: localhost)');
  console.log('                  支持 IPv6: ::1 或 [::1]');
  console.log('    --help        显示帮助信息');
  console.log('');
  console.log('  示例:');
  console.log('    tunnelnet --key ABCD1234 --port 8080');
  console.log('    tunnelnet -k ABCD1234 -p 3000 -s aicq.online:1018');
  console.log('    tunnelnet -k ABCD1234 -p 3000 -s [2001:db8::1]:1018');
  console.log('    tunnelnet -k ABCD1234 -p 443 -h 192.168.1.100');
  console.log('');
}

/**
 * 将 server 地址解析为 WebSocket URL
 * 支持: domain:port, [ipv6]:port, ipv4:port, http(s)://...
 */
function buildWsUrl(server: string, key: string): string {
  if (server.startsWith('http://') || server.startsWith('https://')) {
    return server.replace(/^http/, 'ws') + `/ws?key=${encodeURIComponent(key)}`;
  }
  if (server.startsWith('ws://') || server.startsWith('wss://')) {
    return server + `/ws?key=${encodeURIComponent(key)}`;
  }
  // IPv6 字面量 [addr]:port
  if (server.startsWith('[')) {
    return `ws://${server}/ws?key=${encodeURIComponent(key)}`;
  }
  // 域名或 IPv4
  return `ws://${server}/ws?key=${encodeURIComponent(key)}`;
}

/**
 * IPv6 自定义 DNS 解析器 - 优先 IPv6 (AAAA)，回退 IPv4 (A)
 */
function createLookup(hostname: string) {
  return (opts: unknown, callback: (err: NodeJS.ErrnoException | null, address?: string, family?: number) => void) => {
    // 已经是 IP 地址
    if (/^(\\d+\\.){3}\\d+$/.test(hostname)) {
      return callback(null, hostname, 4);
    }
    if (hostname.startsWith('[')) {
      const addr = hostname.replace(/^\[|\]$/g, '').split(':')[0];
      return callback(null, addr || hostname, 6);
    }

    // 同时解析 AAAA (IPv6) 和 A (IPv4)，优先 IPv6
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

class TunnelClient {
  private config: ClientConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCount = 0;
  private startTime = Date.now();
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  start() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║       TunnelNet Client v1.1 (IPv6/IPv4)       ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  服务器:   ${this.config.server}`);
    console.log(`  密钥:     ${this.config.key}`);
    console.log(`  本地:     ${this.config.localHost}:${this.config.localPort}`);
    console.log('');
    this.connect();
  }

  private connect() {
    const wsUrl = buildWsUrl(this.config.server, this.config.key);
    console.log(`  连接中:   ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl, {
        lookup: createLookup(new URL(wsUrl).hostname),
      });
    } catch (err) {
      console.error(`  [错误] 连接失败: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.startStatusTimer();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'connected':
            console.log(`  [OK] 隧道已建立`);
            console.log(`  [OK] 公网地址: ${msg.publicUrl}`);
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
            if (msg.message.includes('无效的密钥')) {
              console.error(`  [错误] 请检查密钥是否正确: ${this.config.key}`);
              process.exit(1);
            }
            break;
        }
      } catch {
        // 忽略
      }
    });

    this.ws.on('close', (code) => {
      if (this.statusTimer) clearInterval(this.statusTimer);
      console.log(`  [断开] 连接关闭 (code: ${code})`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`  [错误] ${err.message}`);
    });
  }

  private handleProxyRequest(msg: { id: string; method: string; url: string; headers: Record<string, string>; body?: string }) {
    const body = msg.body ? Buffer.from(msg.body, 'base64') : undefined;

    const filteredHeaders: Record<string, string> = {};
    const skipHeaders = ['host', 'connection', 'transfer-encoding'];
    for (const [key, value] of Object.entries(msg.headers)) {
      if (!skipHeaders.includes(key.toLowerCase()) && typeof value === 'string') {
        filteredHeaders[key] = value;
      }
    }

    // 解析本地地址 - 支持 IPv6 字面量 [::1] 或裸 ::1
    let localHostname = this.config.localHost;
    const localPort = this.config.localPort;
    let localFamily: 4 | 6 | undefined;

    if (localHostname.startsWith('[')) {
      // [::1] 形式
      localHostname = localHostname.replace(/^\[|\]$/g, '');
      localFamily = 6;
    } else if (localHostname === '::1' || localHostname.includes(':')) {
      // 裸 IPv6 地址
      localFamily = 6;
    }

    const req = http.request({
      hostname: localHostname,
      port: localPort,
      path: msg.url,
      method: msg.method,
      headers: filteredHeaders,
      family: localFamily,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const respHeaders: Record<string, string> = {};
        const skipRespHeaders = ['transfer-encoding', 'connection'];
        for (const [key, value] of Object.entries(res.headers)) {
          if (!skipRespHeaders.includes(key.toLowerCase()) && typeof value === 'string') {
            respHeaders[key] = value;
          }
        }
        this.ws?.send(JSON.stringify({
          type: 'response',
          id: msg.id,
          statusCode: res.statusCode,
          headers: respHeaders,
          body: bodyBuffer.toString('base64'),
        }));
        this.requestCount++;
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
    });

    if (body) req.write(body);
    req.end();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts, 5)), 30000);
    this.reconnectAttempts++;
    console.log(`  [重连] ${Math.round(delay / 1000)}s 后重新连接... (第${this.reconnectAttempts}次)`);
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
    console.log(`  [状态] 运行 ${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')} | 请求: ${this.requestCount} | http://${this.config.server}/${this.config.key}`);
  }
}

const config = parseArgs();
const client = new TunnelClient(config);
client.start();

process.on('SIGINT', () => { console.log('\n  关闭连接...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n  关闭连接...'); process.exit(0); });
