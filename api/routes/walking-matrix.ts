/**
 * POST /api/routes/walking-matrix（IGA Pages Function，设计文档第 7.2/7.4 节）。
 * 业务逻辑与本地 Fastify 适配服务共用 server/api-core.ts；
 * 正文 64 KiB 限制与非 JSON 正文由 walkingMatrixFromText 守卫，错误契约与本地一致。
 * M23：按 Content-Length 预拒超大正文；简单每 IP 窗口限流，降低持 Key 开放代理风险。
 */
import { createApiCore, MATRIX_BODY_LIMIT_BYTES } from '../../server/api-core';
import { getConfig } from '../../server/env';

const core = createApiCore({ getAmapKey: () => getConfig().amapKey });

/** 每 IP 每分钟请求上限（单实例内存计数；部署多实例时为近似值） */
const RATE_LIMIT_PER_MINUTE = 30;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

function rateLimited(ip: string, now = Date.now()): boolean {
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_PER_MINUTE;
}

export async function POST(request: Request): Promise<Response> {
  const ip = clientIp(request);
  if (rateLimited(ip)) {
    return Response.json(
      {
        code: 'AMAP_QUOTA_EXCEEDED',
        message: '请求过于频繁，请稍后再试',
        retryable: true,
        fieldErrors: [],
        requestId: crypto.randomUUID(),
      },
      { status: 429 },
    );
  }
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (contentLength > MATRIX_BODY_LIMIT_BYTES) {
    return Response.json(
      {
        code: 'INVALID_INPUT',
        message: '请求正文超过 64 KiB 限制',
        retryable: false,
        fieldErrors: [],
        requestId: crypto.randomUUID(),
      },
      { status: 400 },
    );
  }
  const result = await core.walkingMatrixFromText(await request.text());
  return Response.json(result.body, { status: result.status });
}