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
      // 隧道服务器不可用（开发模式或服务器未部署），使用数据库状态
    }

    const enrichedTunnels = tunnels.map((tunnel) => ({
      ...tunnel,
      serverStatus: serverStatus[tunnel.subdomain] || null,
    }));

    return NextResponse.json({ tunnels: enrichedTunnels });
  } catch (error) {
    return NextResponse.json(
      { error: '获取隧道列表失败', details: String(error) },
      { status: 500 }
    );
  }
}

// 生成随机认证 Token
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
    const { name, subdomain, localPort, localHost, protocol, description, maxConn } = body;

    // 验证必填字段
    if (!name || !subdomain || !localPort) {
      return NextResponse.json(
        { error: '缺少必填字段：name, subdomain, localPort' },
        { status: 400 }
      );
    }

    // 验证子域名格式
    const subdomainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
    if (!subdomainRegex.test(subdomain.toLowerCase())) {
      return NextResponse.json(
        { error: '子域名格式无效，只允许小写字母、数字和连字符' },
        { status: 400 }
      );
    }

    // 验证端口号
    const port = parseInt(localPort, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return NextResponse.json(
        { error: '端口号无效，必须在 1-65535 之间' },
        { status: 400 }
      );
    }

    // 检查子域名是否已存在
    const existing = await db.tunnel.findUnique({
      where: { subdomain: subdomain.toLowerCase() },
    });

    if (existing) {
      return NextResponse.json(
        { error: `子域名 "${subdomain}" 已被使用` },
        { status: 409 }
      );
    }

    // 创建隧道
    const tunnel = await db.tunnel.create({
      data: {
        name,
        subdomain: subdomain.toLowerCase(),
        localPort: port,
        localHost: localHost || 'localhost',
        protocol: protocol || 'http',
        description: description || null,
        maxConn: maxConn || 10,
        authToken: generateToken(),
        status: 'offline',
      },
    });

    return NextResponse.json({ tunnel }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: '创建隧道失败', details: String(error) },
      { status: 500 }
    );
  }
}
