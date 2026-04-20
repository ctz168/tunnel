import { PrismaClient } from '@prisma/client';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';

const prisma = new PrismaClient();
const PORT = 3002;

// Map: tunnelCode -> WebSocket connection (tunnel client)
const activeTunnels = new Map<string, WebSocket>();
// Map: tunnelCode -> metadata
const tunnelMeta = new Map<string, { connectedAt: Date; bytesIn: number; bytesOut: number; requestCount: number }>();

function log(tunnelId: string, action: string, message: string, ip?: string, bytesIn = 0, bytesOut = 0) {
  prisma.tunnelLog.create({
    data: { tunnelId, action, message, ip, bytesIn, bytesOut }
  }).catch(() => {});
}

// WebSocket server for tunnel clients to connect
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const key = url.searchParams.get('key');

  if (!key) {
    ws.send(JSON.stringify({ type: 'error', message: '缺少 key 参数' }));
    ws.close(1008, 'Missing key');
    return;
  }

  // 查找匹配的隧道：tunnelCode 或 authToken === key
  const tunnel = await prisma.tunnel.findFirst({
    where: {
      OR: [
        { tunnelCode: key },
        { authToken: key },
      ]
    }
  });

  if (!tunnel) {
    ws.send(JSON.stringify({ type: 'error', message: `认证失败：无效的密钥 "${key}"` }));
    ws.close(1008, 'Authentication failed');
    return;
  }

  // 更新隧道状态
  await prisma.tunnel.update({
    where: { id: tunnel.id },
    data: { status: 'online' }
  });

  // 注册隧道 (用 tunnelCode 作为键)
  activeTunnels.set(tunnel.tunnelCode, ws);
  tunnelMeta.set(tunnel.tunnelCode, { connectedAt: new Date(), bytesIn: 0, bytesOut: 0, requestCount: 0 });

  log(tunnel.id, 'connect', `隧道已连接: ${tunnel.tunnelCode}`, req.socket.remoteAddress);

  ws.send(JSON.stringify({
    type: 'connected',
    message: '隧道已建立',
    tunnelCode: tunnel.tunnelCode,
    localPort: tunnel.localPort,
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'pong') {
        // 心跳响应
      }
    } catch {
      // 忽略非 JSON
    }
  });

  ws.on('close', async () => {
    activeTunnels.delete(tunnel.tunnelCode);
    tunnelMeta.delete(tunnel.tunnelCode);

    await prisma.tunnel.update({
      where: { id: tunnel.id },
      data: { status: 'offline' }
    });

    log(tunnel.id, 'disconnect', `隧道已断开: ${tunnel.tunnelCode}`);
  });

  ws.on('error', (err) => {
    log(tunnel.id, 'error', `隧道错误: ${err.message}`);
  });
});

// API 管理接口
async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const urlPath = (req.url || '').split('?')[0];
  const method = req.method || 'GET';

  // GET /api/tunnel/status
  if (urlPath === '/api/tunnel/status' && method === 'GET') {
    const tunnels = await prisma.tunnel.findMany({ orderBy: { createdAt: 'desc' } });
    const statusMap: Record<string, { online: boolean; connectedAt?: Date; bytesIn: number; bytesOut: number; requestCount: number }> = {};
    for (const [code, meta] of tunnelMeta.entries()) {
      statusMap[code] = { online: true, connectedAt: meta.connectedAt, bytesIn: meta.bytesIn, bytesOut: meta.bytesOut, requestCount: meta.requestCount };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tunnels, status: statusMap }));
    return true;
  }

  return false;
}

// 生成转发 ID
function genId(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = ''; for (let i = 0; i < 12; i++) r += c[Math.floor(Math.random() * c.length)]; return r;
}

// HTTP 服务器 - 单一请求处理
const server = http.createServer(async (req, res) => {
  const url = req.url || '';

  // 1) 管理 API 优先
  if (url.startsWith('/api/tunnel/')) {
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API not found' }));
    }
    return;
  }

  // 2) 跳过本地请求
  const host = req.headers.host || '';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未知路由' }));
    return;
  }

  // 3) 从 URL 路径中提取 tunnelCode
  // 路径格式: /{tunnelCode}/... 或 /{tunnelCode}
  const pathMatch = url.match(/^\/([a-zA-Z0-9]{8})(\/.*)?$/);
  if (!pathMatch) {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>TunnelNet</h1><p>无效的隧道地址。请使用 8 位隧道密钥访问。</p>');
    return;
  }

  const tunnelCode = pathMatch[1];
  const remainingPath = pathMatch[2] || '/';

  const ws = activeTunnels.get(tunnelCode);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '隧道未连接', code: tunnelCode }));
    return;
  }

  // 查找隧道记录
  const tunnel = await prisma.tunnel.findUnique({ where: { tunnelCode } });
  if (!tunnel) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '隧道不存在' }));
    return;
  }

  // 更新统计
  const meta = tunnelMeta.get(tunnelCode);
  if (meta) meta.requestCount++;

  // 收集请求体
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('base64');

    // 通过 WebSocket 转发请求
    const forwardId = genId();

    // 构建转发的头，去掉 Host 并保留其他
    const fwdHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && k.toLowerCase() !== 'host') {
        fwdHeaders[k] = v;
      }
    }

    ws.send(JSON.stringify({
      type: 'request',
      id: forwardId,
      method: req.method,
      url: remainingPath,
      headers: fwdHeaders,
      body,
    }));

    // 跟踪字节数
    const bytesIn = Buffer.byteLength(body, 'base64');
    if (meta) meta.bytesIn += bytesIn;
    log(tunnel.id, 'request', `${req.method} ${remainingPath}`, req.socket.remoteAddress, bytesIn);

    // 设置响应处理
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '网关超时' }));
      }
      cleanup();
    }, 30000);

    function cleanup() {
      clearTimeout(timeout);
      ws.removeListener('message', handler);
    }

    function handler(data: Buffer) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'response' && msg.id === forwardId) {
          cleanup();
          const bodyBuffer = msg.body ? Buffer.from(msg.body, 'base64') : Buffer.alloc(0);

          const bytesOut = bodyBuffer.length;
          if (meta) meta.bytesOut += bytesOut;

          const headers: Record<string, string> = {};
          if (msg.headers) {
            for (const [key, value] of Object.entries(msg.headers)) {
              if (typeof value === 'string') {
                headers[key] = value;
              }
            }
          }

          res.writeHead(msg.statusCode || 200, headers);
          res.end(bodyBuffer);
        }
      } catch {
        // 忽略非 JSON
      }
    }

    ws.on('message', handler);
  });
});

// WebSocket 升级
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url || '/', `http://localhost:${PORT}`).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// 心跳检测
setInterval(() => {
  for (const [, ws] of activeTunnels.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`[Tunnel Server] 运行中，端口: ${PORT}`);
  console.log(`[Tunnel Server] WebSocket: ws://localhost:${PORT}/ws?key=<8位密钥>`);
  console.log(`[Tunnel Server] 公网路由: http://<域名>/{8位密钥}/...`);
});
