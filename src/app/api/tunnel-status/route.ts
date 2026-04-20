import { NextResponse } from 'next/server';

// GET /api/tunnel-status - 获取隧道服务器实时状态
export async function GET() {
  try {
    const statusRes = await fetch('http://localhost:3002/api/tunnel/status', {
      signal: AbortSignal.timeout(3000),
    });

    if (!statusRes.ok) {
      return NextResponse.json(
        { error: '隧道服务器不可用', status: 'offline' },
        { status: 503 }
      );
    }

    const data = await statusRes.json();
    return NextResponse.json({ status: 'online', ...data });
  } catch {
    return NextResponse.json(
      { error: '隧道服务器不可用', status: 'offline' },
      { status: 503 }
    );
  }
}
