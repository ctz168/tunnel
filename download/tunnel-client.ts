#!/usr/bin/env bun
/**
 * TunnelNet Client - 固定域名内网穿透客户端
 *
 * 使用方法:
 *   bun tunnel-client.ts --server ws://your-server.com:3002 --token YOUR_TOKEN --subdomain myapp --local-port 8080
 *
 * 参数:
 *   --server       隧道服务器 WebSocket 地址 (必填)
 *   --token        隧道认证 Token (必填)
 *   --subdomain    分配的子域名 (必填)
 *   --local-port   本地服务端口 (必填)
 *   --local-host   本地服务地址 (默认: localhost)
 */

import WebSocket from 'ws';
import http from 'http';
import { URL } from 'url';

interface ClientConfig {
  server: string;
  token: string;
  subdomain: string;
  localPort: number;
  localHost: string;
}

function parseArgs(): ClientConfig {
  const args = process.argv.slice(2);
  const config: Partial<ClientConfig> = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--server':
        config.server = args[++i];
        break;
      case '--token':
        config.token = args[++i];
        break;
      case '--subdomain':
        config.subdomain = args[++i];
        break;
      case '--local-port':
        config.localPort = parseInt(args[++i], 10);
        break;
      case '--local-host':
        config.localHost = args[++i];
        break;
    }
  }

  if (!config.server || !config.token || !config.subdomain || !config.localPort) {
    console.error('❌ 缺少必填参数');
    console.error('');
    console.error('使用方法:');
    console.error('  bun tunnel-client.ts --server <ws地址> --token <token> --subdomain <子域名> --local-port <端口>');
    console.error('');
    console.error('示例:');
    console.error('  bun tunnel-client.ts --server ws://tunnel.example.com:3002 --token abc123... --subdomain myapp --local-port 8080');
    process.exit(1);
  }

  return {
    server: config.server!,
    token: config.token!,
    subdomain: config.subdomain!,
    localPort: config.localPort!,
    localHost: config.localHost || 'localhost',
  };
}

class TunnelClient {
  private config: ClientConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests = new Map<string, {
    resolve: (data: { statusCode: number; headers: Record<string, string>; body?: string }) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private requestCount = 0;
  private startTime = Date.now();

  constructor(config: ClientConfig) {
    this.config = config;
  }

  start() {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║        TunnelNet Client - 隧道客户端          ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`📡 服务器地址: ${this.config.server}`);
    console.log(`🌐 子域名:     ${this.config.subdomain}.tunnel.local`);
    console.log(`💻 本地地址:   ${this.config.localHost}:${this.config.localPort}`);
    console.log('');
    console.log('⏳ 正在连接隧道服务器...');

    this.connect();
  }

  private connect() {
    const wsUrl = `${this.config.server}/ws?token=${encodeURIComponent(this.config.token)}&subdomain=${encodeURIComponent(this.config.subdomain)}`;

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error(`❌ 连接失败: ${err}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('✅ 隧道连接已建立！');
      console.log('');
      this.printStatus();
      this.startStatusTimer();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case 'connected':
            console.log(`✅ ${msg.message}`);
            break;

          case 'ping':
            // 响应心跳
            this.ws?.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'request':
            this.handleProxyRequest(msg);
            break;

          case 'error':
            console.error(`❌ 服务器错误: ${msg.message}`);
            break;
        }
      } catch {
        // 忽略非 JSON 消息
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log('');
      console.log(`🔌 隧道连接已断开 (code: ${code}, reason: ${reason || 'unknown'})`);
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`❌ WebSocket 错误: ${err.message}`);
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

    const options = {
      hostname: this.config.localHost,
      port: this.config.localPort,
      path: msg.url,
      method: msg.method,
      headers: filteredHeaders,
    };

    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);

        // 过滤响应头
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

    if (body) {
      req.write(body);
    }
    req.end();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, Math.random() * 3), 30000);
    console.log(`⏳ ${Math.round(delay / 1000)}s 后尝试重新连接...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private statusTimer: ReturnType<typeof setInterval> | null = null;

  private startStatusTimer() {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = setInterval(() => this.printStatus(), 30000);
  }

  private printStatus() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const uptimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

    console.log(`📊 运行时间: ${uptimeStr} | 已处理请求: ${this.requestCount}`);
  }
}

// 启动客户端
const config = parseArgs();
const client = new TunnelClient(config);
client.start();

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n👋 正在关闭隧道连接...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 正在关闭隧道连接...');
  process.exit(0);
});
