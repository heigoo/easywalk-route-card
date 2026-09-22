/**
 * 高德 v5 响应 → 本站契约的归一化纯函数（设计文档第 7.2/7.5 节）。
 * 所有函数对缺失字段、空字符串、空数组显式判空：
 * 不抛异常，而是返回错误（AmapError）或空值；无效数值绝不强制当作 0。
 */
import type { PlaceSearchItem } from '../../shared/contracts/api';
import { AmapError, amapInfocodeToFailureCode } from './errors';

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: AmapError };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** 保留 6 位小数（第 7.6 节：小数按官方要求控制在不超过 6 位） */
const round6 = (n: number): number => Number(n.toFixed(6));

function toTrimmedString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * 高德业务成功判定（第 7.5 节）：必须 status==='1' 且 infocode==='10000'。
 * HTTP 200 不等于业务成功；失败时按 infocode 映射到本站错误码。
 * 返回 null 表示业务成功，否则返回归一化错误。
 */
export function checkAmapBusinessSuccess(body: unknown): AmapError | null {
  if (!isObject(body)) {
    return new AmapError('UPSTREAM_DATA_INVALID', '上游响应结构异常');
  }
  if (body.status === '1' && body.infocode === '10000') return null;
  const info = toTrimmedString(body.info);
  return new AmapError(
    amapInfocodeToFailureCode(body.infocode),
    info.length > 0 ? info : '高德业务错误',
  );
}

/** 解析 "lng,lat" 为坐标并保留 6 位小数；任何非法形态返回 null（不当有效数据） */
function parseLocation(raw: unknown): { longitude: number; latitude: number } | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split(',');
  if (parts.length !== 2) return null;
  const longitude = Number(parts[0].trim());
  const latitude = Number(parts[1].trim());
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  return { longitude: round6(longitude), latitude: round6(latitude) };
}

/**
 * district 取区县名：优先 adname；缺失时回退地址串（契约要求 string，不做不可靠的地址抽取）。
 */
function pickDistrict(poi: Record<string, unknown>): string {
  const adname = toTrimmedString(poi.adname);
  if (adname.length > 0) return adname;
  return toTrimmedString(poi.address);
}

/** 开放时间参考文本的最大长度（契约约定 200 字符以内） */
const OPENING_HOURS_MAX_LENGTH = 200;

/**
 * 提取 poi.business 里的开放时间参考文本（原样文本，不做任何语义解析）：
 * 取值优先级 opening_hours（string 或 string[]，数组元素 trim 后用'；'连接）→ opentime_week → opentime_today；
 * 每级 trim 后为空视为缺失，继续尝试下一键；截断到 200 字符以内；完全缺失返回 null。
 * 只做 trim/截断清洗，绝不解析成结构化时段——这是地图参考文本，待用户核对，不代表此刻开放。
 */
function extractOpeningHoursText(poi: Record<string, unknown>): string | null {
  const business = isObject(poi.business) ? poi.business : null;
  if (!business) return null;
  const candidates: unknown[] = [
    business.opening_hours,
    business.opentime_week,
    business.opentime_today,
  ];
  for (const candidate of candidates) {
    let text: string;
    if (Array.isArray(candidate)) {
      text = candidate
        .filter((seg): seg is string => typeof seg === 'string')
        .map((seg) => seg.trim())
        .filter((seg) => seg.length > 0)
        .join('；');
    } else if (typeof candidate === 'string') {
      text = candidate.trim();
    } else {
      continue; // 非 string/数组视为缺失，尝试下一键
    }
    if (text.length > 0) return text.slice(0, OPENING_HOURS_MAX_LENGTH);
  }
  return null;
}

export interface PlacesPage {
  items: PlaceSearchItem[];
  /** 本页满 10 条时给出下一页页码，否则 null（不承诺全量覆盖） */
  nextPage: number | null;
}

/**
 * pois[] → PlaceSearchItem[]（第 7.2/7.5 节）：
 * entranceStatus 无入口证据恒为 'pending'；空 pois 数组是合法空结果。
 * openingHoursText 统一按 extractOpeningHoursText 提取；
 * straightLineMeters 由调用方按数据源决定（文本搜索无距离，恒 null）。
 */
function normalizePois(
  body: unknown,
  page: number,
  extractStraightLine: (poi: Record<string, unknown>) => number | null = () => null,
): NormalizeResult<PlacesPage> {
  const businessError = checkAmapBusinessSuccess(body);
  if (businessError) return { ok: false, error: businessError };
  const pois = (body as Record<string, unknown>).pois;
  if (!Array.isArray(pois)) {
    return { ok: false, error: new AmapError('UPSTREAM_DATA_INVALID', '上游缺少 pois 数组') };
  }
  const items: PlaceSearchItem[] = [];
  for (const raw of pois) {
    if (!isObject(raw)) continue;
    const id = toTrimmedString(raw.id);
    if (id.length === 0) continue; // 无 id 的候选无法被引用，跳过
    items.push({
      id,
      name: toTrimmedString(raw.name),
      district: pickDistrict(raw),
      address: toTrimmedString(raw.address),
      location: parseLocation(raw.location),
      entranceStatus: 'pending',
      openingHoursText: extractOpeningHoursText(raw),
      straightLineMeters: extractStraightLine(raw),
    });
  }
  return { ok: true, value: { items, nextPage: pois.length === 10 ? page + 1 : null } };
}

/**
 * 地点文本搜索归一化：文本搜索无距查询中心的距离信息，
 * straightLineMeters 恒为 null（未知不等于没有，绝不默认 0）。
 */
export function normalizeTextSearch(body: unknown, page: number): NormalizeResult<PlacesPage> {
  return normalizePois(body, page);
}

/**
 * 周边搜索归一化（第 7.5 节）：poi.distance 是距查询中心的直线距离，
 * 用 parseNumericString 解析为 straightLineMeters（非法/缺失→null，绝不当作 0）。
 * 直线距离仅作候选排序参考，不能作为步行耗时或路程依据（沿用本文件既有的 distance 决策）。
 */
export function normalizeAround(body: unknown, page: number): NormalizeResult<PlacesPage> {
  return normalizePois(body, page, (poi) => parseNumericString(poi.distance));
}

/**
 * 数值字符串验证后转换（第 7.5 节）：空串、非法值、负数均返回 null，绝不当作 0。
 * 结果四舍五入为非负整数，满足契约的 int 约束。
 */
export function parseNumericString(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed);
}

export interface WalkingNormalized {
  /** 米 */
  distanceMeters: number;
  /** 秒（上游 cost.duration 原文） */
  rawWalkingSeconds: number;
  /** 正向观察：walk_type=20 记录为“高德标注阶梯”；未返回不代表没有台阶 */
  reportedFeatures: Array<{ kind: string; note: string }>;
}

/**
 * 步行路径归一化（第 7.5 节）：
 * 在字段有效且适用于当前步行请求的路径中选 cost.duration 最短的一条；
 * paths 缺失/空数组记 UPSTREAM_DATA_INVALID；无有效路径记 ROUTE_UNREACHABLE（区分于网络故障）。
 */
export function normalizeWalking(body: unknown): NormalizeResult<WalkingNormalized> {
  const businessError = checkAmapBusinessSuccess(body);
  if (businessError) return { ok: false, error: businessError };
  const route = (body as Record<string, unknown>).route;
  if (!isObject(route)) {
    return { ok: false, error: new AmapError('UPSTREAM_DATA_INVALID', '上游缺少 route 结构') };
  }
  const paths = route.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: new AmapError('UPSTREAM_DATA_INVALID', '上游 paths 缺失或为空') };
  }
  let best: { duration: number; distance: number; steps: unknown } | null = null;
  for (const raw of paths) {
    if (!isObject(raw)) continue;
    const cost = isObject(raw.cost) ? raw.cost : null;
    const duration = parseNumericString(cost ? cost.duration : null);
    const distance = parseNumericString(raw.distance);
    if (duration === null || distance === null) continue; // 无效路径跳过，不当 0
    if (best === null || duration < best.duration) {
      best = { duration, distance, steps: raw.steps };
    }
  }
  if (best === null) {
    return { ok: false, error: new AmapError('ROUTE_UNREACHABLE', '上游未提供有效步行路径') };
  }
  const reportedFeatures: Array<{ kind: string; note: string }> = [];
  if (Array.isArray(best.steps)) {
    for (const step of best.steps) {
      if (isObject(step) && String(step.walk_type) === '20') {
        reportedFeatures.push({ kind: 'stairs', note: '高德标注阶梯' });
        break;
      }
    }
  }
  return {
    ok: true,
    value: {
      distanceMeters: best.distance,
      rawWalkingSeconds: best.duration,
      reportedFeatures,
    },
  };
}
