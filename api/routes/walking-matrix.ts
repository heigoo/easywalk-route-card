/**
 * POST /api/routes/walking-matrix（IGA Pages Function，设计文档第 7.2/7.4 节）。
 * 业务逻辑与本地 Fastify 适配服务共用 server/api-core.ts；
 * 正文 64 KiB 限制与非 JSON 正文由 walkingMatrixFromText 守卫，错误契约与本地一致。
 */
import { createApiCore } from '../../server/api-core';
import { getConfig } from '../../server/env';

const core = createApiCore({ getAmapKey: () => getConfig().amapKey });

export async function POST(request: Request): Promise<Response> {
  const result = await core.walkingMatrixFromText(await request.text());
  return Response.json(result.body, { status: result.status });
}