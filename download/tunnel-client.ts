#!/usr/bin/env bun
/**
 * TunnelNet Client - 内网穿透客户端
 *
 * 使用方法:
 *   bun tunnel-client.ts --key ABCD1234 --port 8080
 *
 * 参数:
 *   --key         8位隧道密钥 (必填，从 Dashboard 获取)
 *   --port        本地服务端口 (必填)
 *   --server      服务器地址 (默认: aicq.online:1018)
 *   --host        本地服务地址 (默认: localhost)
 */

import WebSocket from 'ws';
import http from 'http';

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
    }
  }

  if (!config.key || !config.localPort) {
    console.error('');
    console.error('  TunnelNet Client - 内网穿透客户端');
    console.error('');
    console.error('  用法: bun tunnel-client.ts --key <8位密钥> --port <本地端口>');
    console.error('');
    console.error('  参数:');
    console.error('    --key,  -k    8位隧道密钥 (必填)');
    console.error('    --port, -p    本地服务端口 (必填)');
    console.error('    --server,-s   服务器地址 (默认: aicq.online:1018)');
    console.error('    --host, -h    本地地址 (默认: localhost)');
    console.error('');
    console.error('  示例:');
    console.error('    bun tunnel-client.ts --key ABCD1234 --port 8080');
    console.error('');
    process.exit(1);
  }

  return {
    server: config.server || 'aicq.online:1018',
    key: config.key!.toUpperCase(),
    localPort: config.localPort!,
    localHost: config.localHost || 'localhost',
  };
}

class TunnelClient {
  private config: ClientConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private requestCount = 0;
  private startTime = Date.now();
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ClientConfig) {
    this.config = config;
  }

  start() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║        TunnelNet Client v1.0              ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`  服务器:   ${this.config.server}`);
    console.log(`  密钥:     ${this.config.key}`);
    console.log(`  本地:     ${this.config.localHost}:${this.config.localPort}`);
    console.log('');
    console.log('  正在连接隧道服务器...');
    console.log('');

    this.connect();
  }

  private connect() {
    // 确定服务器 WebSocket 地址
    const serverHttp = this.config.server.startsWith('http')
      ? this.config.server
      : `http://${this.config.server}`;
    const wsUrl = serverHttp.replace(/^http/, 'ws') + `/ws?key=${encodeURIComponent(this.config.key)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error(`  连接失败: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('  隧道连接已建立！');
      this.startStatusTimer();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'connected':
            console.log(`  公网地址: http://${this.config.server}/${msg.tunnelCode}`);
            console.log('');
            break;

          case 'ping':
            this.ws?.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'request':
            this.handleProxyRequest(msg);
            break;

          case 'error':
            console.error(`  错误: ${msg.message}`);
            break;
        }
      } catch {
        // 忽略
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`  连接断开 (code: ${code})`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`  错误: ${err.message}`);
    });
  }

  private handleProxyRequest(msg: { id: string; method: string; url: string; headers: Record<string, string>; body?: string }) {
    const body = msg.body ? Buffer.from(msg.body, 'base64') : undefined;

    // 过滤不需要转发的头
    const filteredHeaders: Record<string, string> = {};
    const skipHeaders = ['host', 'connection', 'transfer-encoding'];
    for (const [key, value] of Object.entries(msg.headers)) {
      if (!skipHeaders.includes(key.toLowerCase()) && typeof value === 'string') {
        filteredHeaders[key] = value;
      }
    }

    const req = http.request({
      hostname: this.config.localHost,
      port: this.config.localPort,
      path: msg.url,
      method: msg.method,
      headers: filteredHeaders,
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
    const delay = Math.min(1000 * Math.pow(2, Math.random() * 3), 30000);
    console.log(`  ${Math.round(delay / 1000)}s 后重连...`);
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
    console.log(`  [${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}] 请求: ${this.requestCount} | 公网: http://${this.config.server}/${this.config.key}`);
  }
}

const config = parseArgs();
const client = new TunnelClient(config);
client.start();

process.on('SIGINT', () => { console.log('\n  关闭连接...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n  关闭连接...'); process.exit(0); });
