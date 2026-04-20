import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/tunnels/[id]/logs - 获取隧道日志
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const action = searchParams.get('action');

    // 验证隧道是否存在
    const tunnel = await db.tunnel.findUnique({ where: { id } });
    if (!tunnel) {
      return NextResponse.json({ error: '隧道不存在' }, { status: 404 });
    }

    const whereClause: Record<string, unknown> = { tunnelId: id };
    if (action) {
      whereClause.action = action;
    }

    const [logs, total] = await Promise.all([
      db.tunnelLog.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 200),
        skip: offset,
      }),
      db.tunnelLog.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      logs,
      total,
      limit,
      offset,
    });
  } catch (error) {
    return NextResponse.json(
      { error: '获取日志失败', details: String(error) },
      { status: 500 }
    );
  }
}
