/**
 * 高德 v5 客户端（设计文档第 7.4/7.5 节）。
 * - 固定上游主机 https://restapi.amap.com，路径与参数严格按第 7.5 节表；
 * - Key 只由本客户端附加，绝不记录完整坐标与查询串（日志最多操作类型+归一化错误）；
 * - 单次请求超时 8 秒；仅对网络类短暂故障重试一次；无效 Key/参数/配额错误不重试。
 */
import type { PlaceSearchItem } from '../../shared/contracts/api';
import { AmapError, isAmapError } from './errors';
import {
  checkAmapBusinessSuccess,
  normalizeAround,
  normalizeTextSearch,
  normalizeWalking,
  type WalkingNormalized,
} from './normalize';

const UPSTREAM_BASE = 'https://restapi.amap.com'; // 第 7.5 节：主机固定
const DEFAULT_TIMEOUT_MS = 8000; // 第 7.4 节：单次请求超时 8 秒
const MAX_ATTEMPTS = 2; // 第 7.4 节：网络类短暂故障仅重试一次

/** 第 7.2 节：首轮周边检索关键词由服务端固定，不由客户端任意指定 */
const CATEGORY_KEYWORDS = {
  TOILET: '公共厕所',
  REST_CANDIDATE: '休息区',
} as const;
export type NearbyCategory = keyof typeof CATEGORY_KEYWORDS;

export interface PlacesQuery {
  keyword: string;
  city: string;
  page: number;
}

export interface NearbyQuery {
  longitude: number;
  latitude: number;
  category: NearbyCategory;
  radiusMeters: number;
  page: number;
}

export interface WalkingQuery {
  origin: { longitude: number; latitude: number };
  destination: { longitude: number; latitude: number };
}

export interface PlacesResult {
  items: PlaceSearchItem[];
  nextPage: number | null;
}

export interface AmapClient {
  textSearch(query: PlacesQuery): Promise<PlacesResult>;
  around(query: NearbyQuery): Promise<PlacesResult>;
  walking(query: WalkingQuery): Promise<WalkingNormalized>;
}

export interface AmapClientOptions {
  apiKey: string;
  /** 可注入的 fetch 实现（测试用伪造实现，不访问真实网络） */
  fetchImpl?: typeof fetch;
  /** 可注入的时钟 */
  now?: () => number;
  /** 请求超时，默认 8000ms */
  timeoutMs?: number;
  /** 结构化日志：仅操作类型、归一化错误码与耗时，不含坐标与查询串 */
  logger?: (entry: { op: string; code: string | null; durationMs: number; attempt: number }) => void;
}

const round6 = (n: number): number => Number(n.toFixed(6));

/** 第 7.6 节：发送坐标经度在前、纬度在后，小数不超过 6 位 */
function formatCoordinate(coordinate: { longitude: number; latitude: number }): string {
  return `${round6(coordinate.longitude)},${round6(coordinate.latitude)}`;
}

export function createAmapClient(options: AmapClientOptions): AmapClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? (() => undefined);

  function buildUrl(path: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params);
    query.set('key', options.apiKey); // Key 只由服务端附加（第 7.1/11.1 节）
    return `${UPSTREAM_BASE}${path}?${query.toString()}`;
  }

  /** 把未知异常归入归一化错误；AbortError/TypeError 视为网络类短暂故障 */
  function toAmapError(error: unknown): AmapError {
    if (isAmapError(error)) return error;
    const name = error !== null && typeof error === 'object' ? String((error as { name?: unknown }).name) : '';
    if (name === 'AbortError') {
      return new AmapError('UPSTREAM_TIMEOUT', '上游请求超时', { transient: true });
    }
    if (error instanceof TypeError) {
      // DNS/连接重置等网络类短暂故障：重试一次后仍失败统一报 UPSTREAM_TIMEOUT（无可用上游响应）
      return new AmapError('UPSTREAM_TIMEOUT', '上游网络故障', { transient: true });
    }
    return new AmapError('UPSTREAM_DATA_INVALID', '上游调用异常');
  }

  /**
   * 调用高德并返回业务成功后的 JSON 体。
   * HTTP 200 不等于业务成功（第 7.3 节）：必须再校验 status 与 infocode。
   */
  async function call(op: string, path: string, params: Record<string, string>): Promise<unknown> {
    let lastTransient: AmapError | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const startedAt = now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetchImpl(buildUrl(path, params), { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) {
          // 非 2xx：429 视为配额/QPS；408/504 视为可重试的网关超时；其余按上游数据异常处理（不重试）
          if (response.status === 429) throw new AmapError('AMAP_QUOTA_EXCEEDED', '上游访问频率限制');
          if (response.status === 408 || response.status === 504) {
            throw new AmapError('UPSTREAM_TIMEOUT', '上游网关超时', { transient: true });
          }
          throw new AmapError('UPSTREAM_DATA_INVALID', `上游 HTTP ${response.status}`);
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new AmapError('UPSTREAM_DATA_INVALID', '上游响应非合法 JSON');
        }
        const businessError = checkAmapBusinessSuccess(body);
        if (businessError) throw businessError; // 配额/鉴权/参数错误：一律不重试
        logger({ op, code: null, durationMs: now() - startedAt, attempt: attempt + 1 });
        return body;
      } catch (error) {
        const normalized = toAmapError(error);
        logger({ op, code: normalized.code, durationMs: now() - startedAt, attempt: attempt + 1 });
        if (normalized.transient && attempt === 0) {
          lastTransient = normalized;
          continue; // 第 7.4 节：网络类短暂故障仅重试一次
        }
        throw normalized;
      }
    }
    throw lastTransient ?? new AmapError('UPSTREAM_TIMEOUT', '上游请求失败');
  }

  return {
    async textSearch(query: PlacesQuery): Promise<PlacesResult> {
      const body = await call('place.text', '/v5/place/text', {
        keywords: query.keyword,
        region: query.city, // 第 7.2 节：city 映射到高德 region
        page_size: '10', // 第 7.5 节：本站固定每页 10 条
        page_num: String(query.page),
        show_fields: 'business',
      });
      const result = normalizeTextSearch(body, query.page);
      if (!result.ok) throw result.error;
      return result.value;
    },

    async around(query: NearbyQuery): Promise<PlacesResult> {
      const body = await call('place.around', '/v5/place/around', {
        location: formatCoordinate({ longitude: query.longitude, latitude: query.latitude }),
        keywords: CATEGORY_KEYWORDS[query.category],
        radius: String(query.radiusMeters),
        page_size: '10',
        page_num: String(query.page),
        show_fields: 'business',
      });
      const result = normalizeAround(body, query.page);
      if (!result.ok) throw result.error;
      return result.value;
    },

    async walking(query: WalkingQuery): Promise<WalkingNormalized> {
      const body = await call('direction.walking', '/v5/direction/walking', {
        origin: formatCoordinate(query.origin),
        destination: formatCoordinate(query.destination),
        show_fields: 'cost', // 第 7.5 节：总耗时从 cost.duration 读取
      });
      const result = normalizeWalking(body);
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
}
