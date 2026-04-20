#!/usr/bin/env bun
/**
 * TunnelNet Client - 内网穿透客户端（纯 CLI）
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
 *   tunnelnet -k ABCD1234 -p 8080 -s aicq.online:1018
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
  console.log('  TunnelNet Client v1.0 - 内网穿透客户端');
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
  console.log('  示例:');
  console.log('    tunnelnet --key ABCD1234 --port 8080');
  console.log('    tunnelnet -k ABCD1234 -p 3000 -s aicq.online:1018');
  console.log('    tunnelnet -k ABCD1234 -p 443 -h 192.168.1.100');
  console.log('');
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
    console.log('  ║           TunnelNet Client v1.0               ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  服务器:   ${this.config.server}`);
    console.log(`  密钥:     ${this.config.key}`);
    console.log(`  本地:     ${this.config.localHost}:${this.config.localPort}`);
    console.log('');
    this.connect();
  }

  private connect() {
    const serverHttp = this.config.server.startsWith('http')
      ? this.config.server
      : `http://${this.config.server}`;
    const wsUrl = serverHttp.replace(/^http/, 'ws') + `/ws?key=${encodeURIComponent(this.config.key)}`;

    try {
      this.ws = new WebSocket(wsUrl);
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
    console.log(`  [状态] 运行 ${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')} | 请求: ${this.requestCount} | 公网: http://${this.config.server}/${this.config.key}`);
  }
}

const config = parseArgs();
const client = new TunnelClient(config);
client.start();

process.on('SIGINT', () => { console.log('\n  关闭连接...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n  关闭连接...'); process.exit(0); });
