import { PrismaClient } from '@prisma/client';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';
import path from 'path';

// 动态解析数据库绝对路径
function resolveDbPath(): string {
  const envUrl = process.env.DATABASE_URL || '';
  const dbFile = envUrl.replace(/^file:/, '');
  if (!dbFile) return path.resolve(__dirname, '../../db/custom.db');
  if (path.isAbsolute(dbFile)) return dbFile;
  return path.resolve(__dirname, dbFile);
}

const ABS_DB_PATH = resolveDbPath();
process.env.DATABASE_URL = `file:${ABS_DB_PATH}`;

const prisma = new PrismaClient();

const PORT = parseInt(process.env.TUNNEL_PORT || '3002', 10);
const HOST = process.env.TUNNEL_HOST || '::';

console.log(`[DB] 数据库路径: ${ABS_DB_PATH}`);

// 活跃隧道连接
const activeTunnels = new Map<string, WebSocket>();
const tunnelMeta = new Map<string, { connectedAt: Date; bytesIn: number; bytesOut: number; requestCount: number }>();
// 挂起的响应 handler: requestId -> handler function
const pendingRequests = new Map<string, (msg: any) => void>();

async function getServerDomain(): Promise<string> {
  const config = await prisma.serverConfig.findFirst();
  return config?.serverDomain || 'aicq.online:7739';
}

function log(tunnelId: string, action: string, message: string, ip?: string, bytesIn = 0, bytesOut = 0) {
  prisma.tunnelLog.create({
    data: { tunnelId, action, message, ip, bytesIn, bytesOut }
  }).catch(() => {});
}

// 生成转发 ID
function genId(): string {
  const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let r = '';
  for (let i = 0; i < 12; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

// WebSocket server for tunnel clients
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const key = url.searchParams.get('key');

  if (!key) {
    ws.send(JSON.stringify({ type: 'error', message: '缺少 key 参数' }));
    ws.close(1008, 'Missing key');
    return;
  }

  const tunnel = await prisma.tunnel.findFirst({
    where: {
      OR: [
        { tunnelCode: key.toUpperCase() },
        { authToken: key },
      ]
    }
  });

  if (!tunnel) {
    ws.send(JSON.stringify({ type: 'error', message: `认证失败：无效的密钥 "${key}"` }));
    ws.close(1008, 'Authentication failed');
    return;
  }

  const serverDomain = await getServerDomain();

  // 如果该隧道已有旧连接，先关闭
  const existingWs = activeTunnels.get(tunnel.tunnelCode);
  if (existingWs && existingWs.readyState === WebSocket.OPEN) {
    existingWs.close(4000, 'Replaced by new connection');
  }

  await prisma.tunnel.update({
    where: { id: tunnel.id },
    data: { status: 'online' }
  });

  activeTunnels.set(tunnel.tunnelCode, ws);
  tunnelMeta.set(tunnel.tunnelCode, { connectedAt: new Date(), bytesIn: 0, bytesOut: 0, requestCount: 0 });

  log(tunnel.id, 'connect', `隧道已连接: ${tunnel.tunnelCode}`, req.socket.remoteAddress);

  ws.send(JSON.stringify({
    type: 'connected',
    message: '隧道已建立',
    tunnelCode: tunnel.tunnelCode,
    localPort: tunnel.localPort,
    publicUrl: `http://${serverDomain}/${tunnel.tunnelCode}`,
    serverDomain,
  }));

  // 统一消息处理（Bug 8: 不再多次注册 handler）
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'pong') {
        return; // 心跳响应
      }

      if (msg.type === 'response' && msg.id) {
        // 查找挂起的请求 handler
        const handler = pendingRequests.get(msg.id);
        if (handler) {
          handler(msg);
          pendingRequests.delete(msg.id);
        }
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
    }).catch(() => {});

    log(tunnel.id, 'disconnect', `隧道已断开: ${tunnel.tunnelCode}`);
  });

  ws.on('error', (err) => {
    log(tunnel.id, 'error', `隧道错误: ${err.message}`);
  });
});

// 主动断开指定隧道的 WebSocket 连接
function disconnectTunnel(tunnelCode: string) {
  const ws = activeTunnels.get(tunnelCode);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(4001, 'Tunnel deleted');
  }
  activeTunnels.delete(tunnelCode);
  tunnelMeta.delete(tunnelCode);
}

// API 管理接口
async function handleApiRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const urlPath = (req.url || '').split('?')[0];
  const method = req.method || 'GET';

  // GET /api/tunnel/status
  if (urlPath === '/api/tunnel/status' && method === 'GET') {
    const serverDomain = await getServerDomain();
    const statusMap: Record<string, { online: boolean; connectedAt?: Date; bytesIn: number; bytesOut: number; requestCount: number }> = {};
    for (const [code, meta] of tunnelMeta.entries()) {
      statusMap[code] = {
        online: true,
        connectedAt: meta.connectedAt,
        bytesIn: meta.bytesIn,
        bytesOut: meta.bytesOut,
        requestCount: meta.requestCount,
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: statusMap, serverDomain }));
    return true;
  }

  // DELETE /api/tunnel/{tunnelCode} - 删除隧道并断开连接
  if (urlPath.match(/^\/api\/tunnel\/[a-zA-Z0-9]+$/) && method === 'DELETE') {
    const tunnelCode = urlPath.split('/').pop()!.toUpperCase();
    const tunnel = await prisma.tunnel.findUnique({ where: { tunnelCode } });
    if (!tunnel) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '隧道不存在' }));
      return true;
    }
    disconnectTunnel(tunnelCode);
    await prisma.tunnel.delete({ where: { id: tunnel.id } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: '隧道已删除' }));
    return true;
  }

  return false;
}

// HTTP 服务器 - 隧道转发
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

  // 2) 从 URL 路径中提取 tunnelCode
  // 路径格式: /{tunnelCode}/... 或 /{tunnelCode}
  const pathMatch = url.match(/^\/([a-zA-Z0-9]{8})(\/.*)?$/);
  if (!pathMatch) {
    const serverDomain = await getServerDomain();
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<h1>TunnelNet</h1><p>无效的隧道地址。请使用 8 位隧道密钥访问: <code>http://${serverDomain}/XXXXXXXX</code></p>`);
    return;
  }

  const tunnelCode = pathMatch[1].toUpperCase();
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

  // 收集请求体（Bug 10: 使用正确的事件监听）
  const bodyChunks: Buffer[] = [];
  let bodyComplete = false;

  const forwardRequest = (body: Buffer) => {
    bodyComplete = true;
    const forwardId = genId();

    // 构建转发的头
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
      body: body.length > 0 ? body.toString('base64') : undefined,
    }));

    // Bug 11: 使用原始 body 长度而非 base64 编码后长度
    const bytesIn = body.length;
    if (meta) meta.bytesIn += bytesIn;
    log(tunnel.id, 'request', `${req.method} ${remainingPath}`, req.socket.remoteAddress, bytesIn);

    // 超时
    const timeout = setTimeout(() => {
      pendingRequests.delete(forwardId);
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '网关超时' }));
      }
    }, 30000);

    // Bug 8: 使用 Map 管理挂起的 handler，不再重复 addListener
    pendingRequests.set(forwardId, (msg: any) => {
      clearTimeout(timeout);
      const bodyBuffer = msg.body ? Buffer.from(msg.body, 'base64') : Buffer.alloc(0);
      if (meta) meta.bytesOut += bodyBuffer.length;

      const headers: Record<string, string> = {};
      if (msg.headers) {
        for (const [key, value] of Object.entries(msg.headers)) {
          if (typeof value === 'string') {
            headers[key] = value;
          }
        }
      }

      if (!res.headersSent) {
        res.writeHead(msg.statusCode || 200, headers);
      }
      res.end(bodyBuffer);
    });
  };

  req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
  req.on('end', () => {
    if (!bodyComplete) {
      forwardRequest(Buffer.concat(bodyChunks));
    }
  });
  // GET/HEAD/DELETE 等无 body 的请求可能不触发 'end'
  // 这里加一个安全检查
  req.on('aborted', () => {
    if (!bodyComplete) {
      forwardRequest(Buffer.concat(bodyChunks));
    }
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

// 心跳检测 (Bug 7: 检测无响应的连接)
const pingIntervals = new Map<string, NodeJS.Timer>();
setInterval(() => {
  for (const [code, ws] of activeTunnels.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
      // 如果 10 秒内没收到 pong，关闭连接
      const timer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          console.log(`[心跳超时] ${code} 无响应，关闭连接`);
          ws.terminate();
        }
        pingIntervals.delete(code);
      }, 10000);
      pingIntervals.set(code, timer);
    }
  }
}, 30000);

// 清理心跳计时器
wss.on('connection', (ws, req) => {
  ws.on('pong', () => {
    // 找到对应的 timer 并清除
    // 通过 tunnelCode 反查
    for (const [code, timer] of pingIntervals.entries()) {
      if (activeTunnels.get(code) === ws) {
        clearTimeout(timer);
        pingIntervals.delete(code);
        break;
      }
    }
  });
});

server.listen(PORT, HOST, async () => {
  const domain = await getServerDomain();
  const addr = server.address();
  const listenInfo = typeof addr === 'object' && addr ? `${addr.family} ${addr.address}:${addr.port}` : `${HOST}:${PORT}`;
  console.log('');
  console.log('  TunnelNet Server v1.2 (IPv6/IPv4 dual-stack)');
  console.log(`  监听: ${listenInfo}`);
  console.log(`  域名: ${domain}`);
  console.log(`  WebSocket: ws://${domain}/ws?key=<8位密钥>`);
  console.log(`  公网路由: http://${domain}/<8位密钥>/...`);
  console.log('');
});
