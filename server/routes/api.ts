/**
 * 本地 Fastify 适配服务（设计文档第 7.1/7.2 节）：
 *   GET  /api/places/search
 *   GET  /api/places/nearby
 *   POST /api/routes/walking-matrix（正文限制 64 KiB）
 *
 * 业务逻辑全部在 server/api-core.ts，与线上 IGA Pages Functions 共用；
 * 本文件只做 Fastify 的请求/响应对接，正文超限与非 JSON 正文由 Fastify 解析层拦截，
 * 并在 server/index.ts 的全局错误处理器中映射为同一错误契约。
 */
import type { FastifyPluginAsync } from 'fastify';
import { createApiCore, MATRIX_BODY_LIMIT_BYTES, type ApiCoreOptions } from '../api-core';

export type ApiRouteOptions = ApiCoreOptions;

const apiRoutes: FastifyPluginAsync<ApiRouteOptions> = async (app, opts) => {
  const core = createApiCore(opts);

  // GET /api/places/search（第 7.2 节）
  app.get('/api/places/search', async (request, reply) => {
    const result = await core.searchPlaces(request.query as Record<string, unknown>);
    return reply.status(result.status).send(result.body);
  });

  // GET /api/places/nearby（第 7.2 节）
  app.get('/api/places/nearby', async (request, reply) => {
    const result = await core.nearby(request.query as Record<string, unknown>);
    return reply.status(result.status).send(result.body);
  });

  // POST /api/routes/walking-matrix（第 7.2/7.4 节）
  app.post('/api/routes/walking-matrix', { bodyLimit: MATRIX_BODY_LIMIT_BYTES }, async (request, reply) => {
    const result = await core.walkingMatrix(request.body);
    return reply.status(result.status).send(result.body);
  });
};

export default apiRoutes;