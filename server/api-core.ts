/**
 * 三个 API 端点的框架无关实现（设计文档第 7.1/7.2 节）。
 *
 * 本地开发由 Fastify 适配服务（server/routes/api.ts）调用，线上由 IGA Pages Functions
 * （api/ 目录）调用同一份实现，避免两条部署路径的行为漂移。
 *
 * HTTP 状态约定（响应体始终是统一错误契约 {code,message,retryable,fieldErrors,requestId}）：
 * - 400：INVALID_INPUT（zod 校验失败、正文超限/非 JSON）；
 * - 429：AMAP_QUOTA_EXCEEDED；504：UPSTREAM_TIMEOUT；502：AMAP_AUTH_ERROR、UPSTREAM_DATA_INVALID；
 * - 200 + 错误体：AMAP_NOT_CONFIGURED（服务端配置状态）、ROUTE_UNREACHABLE 与 REQUEST_CANCELLED
 *   （业务级明确状态，供前端据此提示，不视为传输层失败）。
 *
 * 安全边界（第 7.1/11.1 节）：不接受任意上游 URL、请求头或客户端提供的 Key；
 * 响应与日志绝不携带 Key 或完整上游 URL。
 */
import type { ZodError } from 'zod';
import {
  nearbyQuerySchema,
  placesSearchQuerySchema,
  walkingMatrixBodySchema,
  type ApiError,
  type MatrixEdge,
  type WalkingMatrixData,
} from '../shared/contracts/api';
import type { FailureCode } from '../shared/contracts/domain';
import { createAmapClient, type AmapClient } from './amap/client';
import { createBudget, MATRIX_BUDGET_DEFAULTS, type BudgetConfig } from './amap/budget';
import { AmapError, ERROR_RETRYABLE, isAmapError } from './amap/errors';

/** 第 7.2 节：正文限制 64 KiB */
export const MATRIX_BODY_LIMIT_BYTES = 64 * 1024;

/** 框架无关的响应：状态码 + 统一契约响应体 */
export interface CoreResult {
  status: number;
  body: unknown;
}

export interface ApiCoreOptions {
  /** 返回当前服务端配置的高德 Key；未配置返回 null */
  getAmapKey: () => string | null;
  /** 测试注入的客户端；未提供时按 Key 创建真实客户端 */
  amapClient?: AmapClient;
  /** 覆盖矩阵预算默认值（测试用） */
  budgetDefaults?: Partial<BudgetConfig>;
  /** 可注入的时钟 */
  now?: () => number;
  /** requestId 生成器 */
  genRequestId?: () => string;
}

export interface ApiCore {
  /** GET /api/places/search；query 为未经解析的原始查询串键值 */
  searchPlaces(query: Record<string, unknown>): Promise<CoreResult>;
  /** GET /api/places/nearby；query 为未经解析的原始查询串键值 */
  nearby(query: Record<string, unknown>): Promise<CoreResult>;
  /** POST /api/routes/walking-matrix；rawBody 为已解析的 JSON 正文 */
  walkingMatrix(rawBody: unknown): Promise<CoreResult>;
  /** POST /api/routes/walking-matrix；rawText 为原始正文文本，自带 64 KiB 与非 JSON 守卫 */
  walkingMatrixFromText(rawText: string): Promise<CoreResult>;
}

interface MatrixFailureItem {
  fromId: string;
  toId: string;
  code: string;
  retryable: boolean;
}

type MatrixOutcome =
  | { kind: 'edge'; edge: MatrixEdge }
  | { kind: 'failure'; failure: MatrixFailureItem };

const BUDGET_POLL_MS = 50; // 预算暂时繁忙时的轮询间隔
const PROVIDER = 'amap';
const PROVIDER_API_VERSION = 'v5';

function fieldErrorsFromZod(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join('.') : 'body',
    message: issue.message,
  }));
}

function retryableOf(code: string): boolean {
  return code in ERROR_RETRYABLE ? ERROR_RETRYABLE[code as FailureCode] : false;
}

/** HTTP 状态映射：见文件头注释 */
function statusOf(code: string): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'AMAP_QUOTA_EXCEEDED':
      return 429;
    case 'UPSTREAM_TIMEOUT':
      return 504;
    case 'AMAP_AUTH_ERROR':
    case 'UPSTREAM_DATA_INVALID':
      return 502;
    default:
      return 200; // AMAP_NOT_CONFIGURED / ROUTE_UNREACHABLE / REQUEST_CANCELLED
  }
}

function errorBody(
  code: string,
  message: string,
  fieldErrors: Array<{ field: string; message: string }>,
  requestId: string,
): ApiError {
  return { code, message, retryable: retryableOf(code), fieldErrors, requestId };
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createApiCore(opts: ApiCoreOptions): ApiCore {
  const now = opts.now ?? (() => Date.now());
  const genRequestId =
    opts.genRequestId ??
    (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  /** 客户端缓存：按 Key 复用，避免每请求重建 */
  let cachedKey: string | null = null;
  let cachedClient: AmapClient | null = null;
  function resolveClient(key: string): AmapClient {
    if (opts.amapClient) return opts.amapClient;
    if (cachedClient && cachedKey === key) return cachedClient;
    cachedKey = key;
    cachedClient = createAmapClient({ apiKey: key, now });
    return cachedClient;
  }

  async function searchPlaces(query: Record<string, unknown>): Promise<CoreResult> {
    const requestId = genRequestId();
    const parsed = placesSearchQuerySchema.safeParse({
      keyword: firstString(query.keyword),
      city: firstString(query.city),
      page: firstString(query.page) === undefined ? 1 : Number(firstString(query.page)),
    });
    if (!parsed.success) {
      return {
        status: 400,
        body: errorBody('INVALID_INPUT', '请求参数校验失败', fieldErrorsFromZod(parsed.error), requestId),
      };
    }
    const key = opts.getAmapKey();
    if (!key) {
      return {
        status: statusOf('AMAP_NOT_CONFIGURED'),
        body: errorBody('AMAP_NOT_CONFIGURED', '服务端未配置高德 Web 服务 Key', [], requestId),
      };
    }
    try {
      const data = await resolveClient(key).textSearch(parsed.data);
      return { status: 200, body: { requestId, data, warnings: [] as string[] } };
    } catch (error) {
      const normalized = isAmapError(error)
        ? error
        : new AmapError('UPSTREAM_DATA_INVALID', '上游调用异常');
      return {
        status: statusOf(normalized.code),
        body: errorBody(normalized.code, normalized.message, [], requestId),
      };
    }
  }

  async function nearby(query: Record<string, unknown>): Promise<CoreResult> {
    const requestId = genRequestId();
    const parsed = nearbyQuerySchema.safeParse({
      longitude: firstString(query.longitude) === undefined ? Number.NaN : Number(firstString(query.longitude)),
      latitude: firstString(query.latitude) === undefined ? Number.NaN : Number(firstString(query.latitude)),
      category: firstString(query.category),
      radiusMeters: firstString(query.radiusMeters) === undefined ? 500 : Number(firstString(query.radiusMeters)),
      page: firstString(query.page) === undefined ? 1 : Number(firstString(query.page)),
    });
    if (!parsed.success) {
      return {
        status: 400,
        body: errorBody('INVALID_INPUT', '请求参数校验失败', fieldErrorsFromZod(parsed.error), requestId),
      };
    }
    const key = opts.getAmapKey();
    if (!key) {
      return {
        status: statusOf('AMAP_NOT_CONFIGURED'),
        body: errorBody('AMAP_NOT_CONFIGURED', '服务端未配置高德 Web 服务 Key', [], requestId),
      };
    }
    try {
      const data = await resolveClient(key).around(parsed.data);
      return { status: 200, body: { requestId, data, warnings: [] as string[] } };
    } catch (error) {
      const normalized = isAmapError(error)
        ? error
        : new AmapError('UPSTREAM_DATA_INVALID', '上游调用异常');
      return {
        status: statusOf(normalized.code),
        body: errorBody(normalized.code, normalized.message, [], requestId),
      };
    }
  }

  async function walkingMatrix(rawBody: unknown): Promise<CoreResult> {
    const parsed = walkingMatrixBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        status: 400,
        body: errorBody(
          'INVALID_INPUT',
          '请求参数校验失败',
          fieldErrorsFromZod(parsed.error),
          genRequestId(),
        ),
      };
    }
    const body = parsed.data;
    // 第 7.2 节：requestId 为本次请求关联标识，原样回传便于前端关联
    const requestId = body.requestId;
    const key = opts.getAmapKey();
    if (!key) {
      return {
        status: statusOf('AMAP_NOT_CONFIGURED'),
        body: errorBody('AMAP_NOT_CONFIGURED', '服务端未配置高德 Web 服务 Key', [], requestId),
      };
    }
    const client = resolveClient(key);
    const nodeById = new Map(body.nodes.map((node) => [node.id, node]));

    // 第 7.2 节：重复边去重，只查询请求明确列出的边
    const uniquePairs: Array<{ fromId: string; toId: string }> = [];
    const seen = new Set<string>();
    for (const pair of body.pairs) {
      const pairKey = `${pair.fromId}->${pair.toId}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      uniquePairs.push(pair);
    }

    const budget = createBudget({ ...MATRIX_BUDGET_DEFAULTS, ...opts.budgetDefaults, now });
    const outcomes = new Map<string, MatrixOutcome>();

    const runEdge = async (pair: { fromId: string; toId: string }): Promise<void> => {
      const fromNode = nodeById.get(pair.fromId);
      const toNode = nodeById.get(pair.toId);
      if (!fromNode || !toNode) return; // schema 已保证引用存在
      const pairKey = `${pair.fromId}->${pair.toId}`;

      // 第 7.4 节：预算控制并发与速率；用尽/到期后排队边不再发起上游调用
      for (;;) {
        if (budget.tryAcquire()) break;
        if (!budget.canStart()) {
          outcomes.set(pairKey, {
            kind: 'failure',
            failure: {
              fromId: pair.fromId,
              toId: pair.toId,
              code: 'REQUEST_CANCELLED',
              retryable: ERROR_RETRYABLE.REQUEST_CANCELLED,
            },
          });
          return;
        }
        await sleep(BUDGET_POLL_MS);
      }

      const fetchedAt = new Date(now()).toISOString();
      try {
        const result = await client.walking({
          origin: { longitude: fromNode.longitude, latitude: fromNode.latitude },
          destination: { longitude: toNode.longitude, latitude: toNode.latitude },
        });
        outcomes.set(pairKey, {
          kind: 'edge',
          edge: {
            fromId: pair.fromId,
            toId: pair.toId,
            fromCoordinateRevision: fromNode.coordinateRevision,
            toCoordinateRevision: toNode.coordinateRevision,
            state: 'ready',
            distanceMeters: result.distanceMeters,
            rawWalkingSeconds: result.rawWalkingSeconds,
            provider: PROVIDER,
            providerApiVersion: PROVIDER_API_VERSION,
            fetchedAt,
            reportedFeatures: result.reportedFeatures,
          },
        });
      } catch (error) {
        const normalized = isAmapError(error)
          ? error
          : new AmapError('UPSTREAM_DATA_INVALID', '上游调用异常');
        if (normalized.code === 'ROUTE_UNREACHABLE') {
          // 第 7.3 节：明确不可达是单边业务状态，仍算“明确结果”
          outcomes.set(pairKey, {
            kind: 'edge',
            edge: {
              fromId: pair.fromId,
              toId: pair.toId,
              fromCoordinateRevision: fromNode.coordinateRevision,
              toCoordinateRevision: toNode.coordinateRevision,
              state: 'unreachable',
              distanceMeters: null,
              rawWalkingSeconds: null,
              provider: PROVIDER,
              providerApiVersion: PROVIDER_API_VERSION,
              fetchedAt,
              reportedFeatures: [],
            },
          });
        } else {
          outcomes.set(pairKey, {
            kind: 'failure',
            failure: {
              fromId: pair.fromId,
              toId: pair.toId,
              code: normalized.code,
              retryable: normalized.retryable,
            },
          });
        }
      } finally {
        budget.release();
      }
    };

    await Promise.all(uniquePairs.map((pair) => runEdge(pair)));

    // 按请求中边的顺序输出，保证确定性
    const edges: MatrixEdge[] = [];
    const failures: MatrixFailureItem[] = [];
    for (const pair of uniquePairs) {
      const outcome = outcomes.get(`${pair.fromId}->${pair.toId}`);
      if (!outcome) continue;
      if (outcome.kind === 'edge') edges.push(outcome.edge);
      else failures.push(outcome.failure);
    }

    // 第 7.2 节：queryCoverage —— 全部明确结果（含不可达）为 complete；
    // 部分失败/未知为 partial；没有任何明确结果为 failed
    const queryCoverage: WalkingMatrixData['queryCoverage'] =
      edges.length === uniquePairs.length
        ? 'complete'
        : failures.length === uniquePairs.length
          ? 'failed'
          : 'partial';

    const data: WalkingMatrixData & { inputFingerprint: string } = {
      edges,
      failures,
      queryCoverage,
      fetchedAt: new Date(now()).toISOString(),
      inputFingerprint: body.inputFingerprint,
    };
    return { status: 200, body: { requestId, data, warnings: [] as string[] } };
  }

  /** 正文守卫：超限与非 JSON 与 Fastify 适配层返回同一错误契约 */
  async function walkingMatrixFromText(rawText: string): Promise<CoreResult> {
    if (new TextEncoder().encode(rawText).length > MATRIX_BODY_LIMIT_BYTES) {
      return {
        status: 400,
        body: errorBody('INVALID_INPUT', '请求正文超过 64 KiB 限制', [], genRequestId()),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      return {
        status: 400,
        body: errorBody('INVALID_INPUT', '请求正文不是合法 JSON', [], genRequestId()),
      };
    }
    return walkingMatrix(parsed);
  }

  return { searchPlaces, nearby, walkingMatrix, walkingMatrixFromText };
}