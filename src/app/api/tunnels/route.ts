import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/tunnels - 获取所有隧道
export async function GET() {
  try {
    const tunnels = await db.tunnel.findMany({
      orderBy: { createdAt: 'desc' },
    });

    // 尝试获取隧道服务器实时状态
    let serverStatus: Record<string, unknown> = {};
    try {
      const statusRes = await fetch('http://localhost:3002/api/tunnel/status', {
        signal: AbortSignal.timeout(2000),
      });
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        serverStatus = statusData.status || {};
      }
    } catch {
      // 隧道服务器不可用
    }

    // 获取服务器配置
    let serverConfig = await db.serverConfig.findFirst();
    const serverDomain = serverConfig?.serverDomain || 'aicq.online:1018';

    const enrichedTunnels = tunnels.map((tunnel) => ({
      ...tunnel,
      serverStatus: serverStatus[tunnel.tunnelCode] || null,
      publicUrl: `http://${serverDomain}/${tunnel.tunnelCode}`,
    }));

    return NextResponse.json({ tunnels: enrichedTunnels, serverDomain });
  } catch (error) {
    return NextResponse.json(
      { error: '获取隧道列表失败', details: String(error) },
      { status: 500 }
    );
  }
}

// 生成8位隧道密钥
function generateTunnelCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉容易混淆的 I O 0 1
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 生成认证 Token
function generateToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// POST /api/tunnels - 创建新隧道
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, localPort, localHost, description } = body;

    if (!name || !localPort) {
      return NextResponse.json(
        { error: '缺少必填字段：name, localPort' },
        { status: 400 }
      );
    }

    const port = parseInt(localPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return NextResponse.json(
        { error: '端口号无效，必须在 1-65535 之间' },
        { status: 400 }
      );
    }

    // 生成唯一的8位隧道密钥
    let tunnelCode = generateTunnelCode();
    let attempts = 0;
    while (await db.tunnel.findUnique({ where: { tunnelCode } }) && attempts < 100) {
      tunnelCode = generateTunnelCode();
      attempts++;
    }

    if (attempts >= 100) {
      return NextResponse.json(
        { error: '生成隧道密钥失败，请重试' },
        { status: 500 }
      );
    }

    // 获取服务器域名
    let serverConfig = await db.serverConfig.findFirst();
    const serverDomain = serverConfig?.serverDomain || 'aicq.online:1018';

    const tunnel = await db.tunnel.create({
      data: {
        name,
        tunnelCode,
        localPort: port,
        localHost: localHost || 'localhost',
        protocol: 'http',
        description: description || null,
        maxConn: 10,
        authToken: generateToken(),
        status: 'offline',
      },
    });

    return NextResponse.json({
      tunnel,
      publicUrl: `http://${serverDomain}/${tunnel.tunnelCode}`,
      serverDomain,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: '创建隧道失败', details: String(error) },
      { status: 500 }
    );
  }
}
