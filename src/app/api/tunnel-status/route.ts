import { NextResponse } from 'next/server';

// GET /api/tunnel-status - 获取隧道服务器实时状态
export async function GET() {
  try {
    const statusRes = await fetch('http://localhost:3002/api/tunnel/status', {
      signal: AbortSignal.timeout(3000),
    });

    if (!statusRes.ok) {
      // 隧道服务器 HTTP 不可达
      return NextResponse.json({ status: 'offline', tunnels: {} });
    }

    const data = await statusRes.json();
    return NextResponse.json({ status: 'online', ...data });
  } catch {
    // 隧道服务器完全不可用
    return NextResponse.json({ status: 'offline', tunnels: {} });
  }
}
