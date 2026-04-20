import { PrismaClient } from '@prisma/client';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';

const prisma = new PrismaClient();
const PORT = 3002;

// Map: subdomain -> WebSocket connection (tunnel client)
const activeTunnels = new Map<string, WebSocket>();
// Map: subdomain -> metadata
const tunnelMeta = new Map<string, { connectedAt: Date; bytesIn: number; bytesOut: number; requestCount: number }>();

function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function log(tunnelId: string, action: string, message: string, ip?: string, bytesIn = 0, bytesOut = 0) {
  prisma.tunnelLog.create({
    data: { tunnelId, action, message, ip, bytesIn, bytesOut }
  }).catch(() => {});
}

// WebSocket server for tunnel clients to connect
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');
  const subdomain = url.searchParams.get('subdomain');

  if (!token || !subdomain) {
    ws.send(JSON.stringify({ type: 'error', message: '缺少 token 或 subdomain 参数' }));
    ws.close(1008, 'Missing parameters');
    return;
  }

  // Verify token
  const tunnel = await prisma.tunnel.findFirst({
    where: { authToken: token, subdomain }
  });

  if (!tunnel) {
    ws.send(JSON.stringify({ type: 'error', message: '认证失败：无效的 token 或子域名' }));
    ws.close(1008, 'Authentication failed');
    return;
  }

  // Update tunnel status
  await prisma.tunnel.update({
    where: { id: tunnel.id },
    data: { status: 'online' }
  });

  // Register tunnel
  activeTunnels.set(subdomain, ws);
  tunnelMeta.set(subdomain, { connectedAt: new Date(), bytesIn: 0, bytesOut: 0, requestCount: 0 });

  log(tunnel.id, 'connect', `隧道已连接: ${subdomain}.tunnel.local`, req.socket.remoteAddress);

  ws.send(JSON.stringify({ type: 'connected', message: '隧道已建立', subdomain }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'pong') {
        // Heartbeat response
      }
    } catch {
      // Binary data pass-through (for future use)
    }
  });

  ws.on('close', async () => {
    activeTunnels.delete(subdomain);
    tunnelMeta.delete(subdomain);

    await prisma.tunnel.update({
      where: { id: tunnel.id },
      data: { status: 'offline' }
    });

    log(tunnel.id, 'disconnect', `隧道已断开: ${subdomain}`);
  });

  ws.on('error', (err) => {
    log(tunnel.id, 'error', `隧道错误: ${err.message}`);
  });
});

// API handler for management requests
async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = req.url || '';
  const method = req.method || 'GET';

  // GET /api/tunnel/status - get all tunnel statuses
  if (url === '/api/tunnel/status' && method === 'GET') {
    const tunnels = await prisma.tunnel.findMany({
      orderBy: { createdAt: 'desc' }
    });

    const statusMap: Record<string, { online: boolean; connectedAt?: Date; bytesIn: number; bytesOut: number; requestCount: number }> = {};

    for (const [sub, meta] of tunnelMeta.entries()) {
      statusMap[sub] = { online: true, connectedAt: meta.connectedAt, bytesIn: meta.bytesIn, bytesOut: meta.bytesOut, requestCount: meta.requestCount };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tunnels, status: statusMap }));
    return true;
  }

  // GET /api/tunnel/logs/:tunnelId
  const logsMatch = url.match(/^\/api\/tunnel\/logs\/(.+)$/);
  if (logsMatch && method === 'GET') {
    const tunnelId = logsMatch[1];
    const logs = await prisma.tunnelLog.findMany({
      where: { tunnelId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ logs }));
    return true;
  }

  return false;
}

// HTTP server - single request handler
const server = http.createServer(async (req, res) => {
  const url = req.url || '';

  // Handle management API requests first
  if (url.startsWith('/api/tunnel/')) {
    const handled = await handleApiRequest(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API not found' }));
    }
    return;
  }

  const host = req.headers.host || '';

  // Skip localhost requests that are not API (admin dashboard is on port 3000)
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未知路由' }));
    return;
  }

  // Extract subdomain from host header (e.g., myapp.tunnel.local -> myapp)
  const subdomain = host.split('.')[0];

  const ws = activeTunnels.get(subdomain);

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '隧道未连接', subdomain }));
    return;
  }

  // Find tunnel record
  const tunnel = await prisma.tunnel.findUnique({
    where: { subdomain }
  });

  if (!tunnel) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '隧道不存在' }));
    return;
  }

  // Update stats
  const meta = tunnelMeta.get(subdomain);
  if (meta) {
    meta.requestCount++;
  }

  // Collect request body
  const chunks: Buffer[] = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('base64');

    // Forward request through WebSocket tunnel
    const forwardId = generateToken();
    const forwardMsg = JSON.stringify({
      type: 'request',
      id: forwardId,
      method: req.method,
      url: req.url,
      headers: req.headers,
      body
    });

    ws.send(forwardMsg);

    // Track bytes
    const bytesIn = Buffer.byteLength(body, 'base64');
    if (meta) meta.bytesIn += bytesIn;

    log(tunnel.id, 'request', `${req.method} ${req.url}`, req.socket.remoteAddress, bytesIn);

    // Set up response handler
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
        // Ignore non-JSON messages
      }
    }

    ws.on('message', handler);
  });
});

// Handle WebSocket upgrade for tunnel clients
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

// Heartbeat check
setInterval(() => {
  for (const [subdomain, ws] of activeTunnels.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`[Tunnel Server] 运行中，端口: ${PORT}`);
  console.log(`[Tunnel Server] WebSocket 端点: ws://localhost:${PORT}/ws`);
  console.log(`[Tunnel Server] API 端点: http://localhost:${PORT}/api/tunnel/`);
});
