import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/config - 获取服务器配置
export async function GET() {
  try {
    let config = await db.serverConfig.findFirst();
    if (!config) {
      config = await db.serverConfig.create({
        data: { serverDomain: 'aicq.online:7739' },
      });
    }
    return NextResponse.json({
      serverDomain: config.serverDomain,
    });
  } catch (error) {
    return NextResponse.json(
      { error: '获取配置失败', details: String(error) },
      { status: 500 }
    );
  }
}

// POST /api/config - 更新服务器配置
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { serverDomain } = body;

    if (!serverDomain || typeof serverDomain !== 'string') {
      return NextResponse.json(
        { error: 'serverDomain 不能为空' },
        { status: 400 }
      );
    }

    // 验证域名格式
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?(\:[0-9]+)?$/;
    if (!domainRegex.test(serverDomain)) {
      return NextResponse.json(
        { error: '域名格式无效' },
        { status: 400 }
      );
    }

    let config = await db.serverConfig.findFirst();
    if (config) {
      config = await db.serverConfig.update({
        where: { id: config.id },
        data: { serverDomain: serverDomain.trim() },
      });
    } else {
      config = await db.serverConfig.create({
        data: { serverDomain: serverDomain.trim() },
      });
    }

    return NextResponse.json({
      serverDomain: config.serverDomain,
      message: '配置已更新',
    });
  } catch (error) {
    return NextResponse.json(
      { error: '更新配置失败', details: String(error) },
      { status: 500 }
    );
  }
}
