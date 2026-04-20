import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/tunnels/[id] - 获取单个隧道详情
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tunnel = await db.tunnel.findUnique({
      where: { id },
      include: {
        logs: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!tunnel) {
      return NextResponse.json({ error: '隧道不存在' }, { status: 404 });
    }

    // 获取实时状态
    let serverStatus = null;
    try {
      const statusRes = await fetch('http://localhost:3002/api/tunnel/status', {
        signal: AbortSignal.timeout(3000),
      });
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        serverStatus = statusData.status?.[tunnel.tunnelCode] || null;
      }
    } catch {
      // 忽略
    }

    return NextResponse.json({ tunnel, serverStatus });
  } catch (error) {
    return NextResponse.json(
      { error: '获取隧道详情失败', details: String(error) },
      { status: 500 }
    );
  }
}

// DELETE /api/tunnels/[id] - 删除隧道
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tunnel = await db.tunnel.findUnique({ where: { id } });

    if (!tunnel) {
      return NextResponse.json({ error: '隧道不存在' }, { status: 404 });
    }

    // 删除隧道（级联删除日志）
    await db.tunnel.delete({ where: { id } });

    return NextResponse.json({ message: '隧道已删除' });
  } catch (error) {
    return NextResponse.json(
      { error: '删除隧道失败', details: String(error) },
      { status: 500 }
    );
  }
}

// PATCH /api/tunnels/[id] - 更新隧道配置
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, localPort, localHost, protocol, description, maxConn } = body;

    const tunnel = await db.tunnel.findUnique({ where: { id } });

    if (!tunnel) {
      return NextResponse.json({ error: '隧道不存在' }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (localPort !== undefined) updateData.localPort = parseInt(localPort, 10);
    if (localHost !== undefined) updateData.localHost = localHost;
    if (protocol !== undefined) updateData.protocol = protocol;
    if (description !== undefined) updateData.description = description;
    if (maxConn !== undefined) updateData.maxConn = maxConn;

    const updated = await db.tunnel.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({ tunnel: updated });
  } catch (error) {
    return NextResponse.json(
      { error: '更新隧道失败', details: String(error) },
      { status: 500 }
    );
  }
}
