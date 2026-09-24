/**
 * 服务端入口（设计文档第 7 章）：组装 Fastify 实例并注册路由。
 * buildServer() 导出便于测试通过 inject() 做路由级测试；
 * 仅在直接运行（tsx server/index.ts）时才监听端口。
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { getConfig } from './env';
import apiRoutes, { type ApiRouteOptions } from './routes/api';

export interface BuildServerOptions {
  /** 覆盖 Key 来源（测试注入） */
  getAmapKey?: () => string | null;
  /** 注入伪造的高德客户端（测试不访问真实网络） */
  amapClient?: ApiRouteOptions['amapClient'];
  /** 覆盖矩阵预算默认值（测试用） */
  budgetDefaults?: ApiRouteOptions['budgetDefaults'];
  now?: () => number;
  genRequestId?: () => string;
}

export async function buildServer(overrides: BuildServerOptions = {}): Promise<FastifyInstance> {
  // M38：保留最小结构化日志（不打印 Key/完整上游 URL）
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'test' ? 'silent' : 'warn',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  // 全局错误处理：统一映射为错误契约（第 7.1 节），不泄露堆栈与凭据
  // M38：用户可见文案走中文白名单；细节只进诊断字段
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;
    request.log.error({ requestId, code: error.code, statusCode: error.statusCode }, 'api error');
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .status(400)
        .send({ code: 'INVALID_INPUT', message: '请求正文超过 64 KiB 限制', retryable: false, fieldErrors: [], requestId });
    }
    if (error.code === 'FST_ERR_CTP_INVALID_JSON' || error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply
        .status(400)
        .send({ code: 'INVALID_INPUT', message: '请求正文不是合法 JSON', retryable: false, fieldErrors: [], requestId });
    }
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      return reply
        .status(500)
        .send({ code: 'INTERNAL_ERROR', message: '服务端内部错误', retryable: false, fieldErrors: [], requestId });
    }
    return reply
      .status(statusCode)
      .send({ code: 'INVALID_INPUT', message: '请求不合法', retryable: false, fieldErrors: [], requestId });
  });

  app.setNotFoundHandler((request, reply) => {
    reply
      .status(404)
      .send({ code: 'INVALID_INPUT', message: '接口不存在', retryable: false, fieldErrors: [], requestId: request.id });
  });

  // 健康检查
  app.get('/api/health', async () => ({ status: 'ok' }));

  await app.register(apiRoutes, {
    getAmapKey: overrides.getAmapKey ?? (() => getConfig().amapKey),
    amapClient: overrides.amapClient,
    budgetDefaults: overrides.budgetDefaults,
    now: overrides.now,
    genRequestId: overrides.genRequestId ?? (() => randomUUID()),
  });

  return app;
}

// 直接运行时才监听（被测试 import 时不占用端口）
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = getConfig();
  buildServer()
    .then((app) => app.listen({ port: config.port, host: '127.0.0.1' }))
    .then(() => {
      console.log(`EasyWalk API 已启动：http://127.0.0.1:${config.port}`);
      if (!config.amapKey) {
        console.warn('未配置 AMAP_WEB_SERVICE_KEY，地图相关接口将返回 AMAP_NOT_CONFIGURED。');
      }
    })
    .catch((error) => {
      console.error('服务端启动失败：', error);
      process.exit(1);
    });
}
