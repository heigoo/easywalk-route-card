/**
 * GET /api/places/nearby（IGA Pages Function，设计文档第 7.2 节）。
 * 业务逻辑与本地 Fastify 适配服务共用 server/api-core.ts；Key 只从服务端环境变量读取。
 */
import { createApiCore } from '../../server/api-core';
import { getConfig } from '../../server/env';

const core = createApiCore({ getAmapKey: () => getConfig().amapKey });

export async function GET(request: Request): Promise<Response> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  const result = await core.nearby(query);
  return Response.json(result.body, { status: result.status });
}