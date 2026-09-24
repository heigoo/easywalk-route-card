/**
 * 领域数据契约（详细设计说明书第 4 章）。
 * 前后端共享的类型与 Zod 约束；计算口径见 src/domain。
 * 注意：schema 按依赖顺序声明，避免暂存死区与循环引用。
 */
import { z } from 'zod';

/** 当前存储结构版本；未识别的 schemaVersion 不静默覆盖 */
export const SCHEMA_VERSION = 1;

/** 时间长度内部统一为非负整数秒；未知一律为 null，不用 0 / 空串 / -1 代替 */
export const secondsSchema = z.number().int().nonnegative();
/** 距离内部统一为米；未知为 null */
export const metersSchema = z.number().int().nonnegative();

/** GCJ-02 坐标，经度在前、纬度在后 */
export interface Gcj02Coordinate {
  longitude: number;
  latitude: number;
}
export const coordinateSchema = z
  .object({
    longitude: z.number().finite().min(-180).max(180),
    latitude: z.number().finite().min(-90).max(90),
  })
  .refine((c) => !(c.latitude === 0 && c.longitude === 0), {
    message: '坐标不能为原点占位',
  });

/** 事实来源类型（第 4.4 节） */
export const sourceTypeSchema = z.enum(['user', 'amap', 'unknown']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

/** 核对状态：未知 / 报告 / 用户已核对 */
export const reviewStateSchema = z.enum(['unknown', 'reported', 'userChecked']);
export type ReviewState = z.infer<typeof reviewStateSchema>;

const factBaseShape = {
  sourceType: sourceTypeSchema,
  sourceName: z.string().nullable(),
  sourceReference: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  reviewState: reviewStateSchema,
  checkedAt: z.string().nullable(),
  applicableDate: z.string().nullable(),
  note: z.string().nullable(),
};

/** 逐属性事实（第 4.4 节）：每个属性独立记录 */
export interface Fact<T> {
  value: T | null;
  sourceType: SourceType;
  sourceName: string | null;
  sourceReference: string | null;
  fetchedAt: string | null;
  reviewState: ReviewState;
  checkedAt: string | null;
  applicableDate: string | null;
  note: string | null;
}

export function unknownFact<T>(): Fact<T> {
  return {
    value: null,
    sourceType: 'unknown',
    sourceName: null,
    sourceReference: null,
    fetchedAt: null,
    reviewState: 'unknown',
    checkedAt: null,
    applicableDate: null,
    note: null,
  };
}

export function userFact<T>(value: T, note: string | null = null): Fact<T> {
  return { ...unknownFact<T>(), value, sourceType: 'user', reviewState: 'userChecked', note };
}

/** 明确开放时间窗；空数组＝该日不开放；value=null＝未知 */
export interface OpeningWindow {
  startLocalTime: string; // "HH:mm"
  endLocalTime: string; // "HH:mm"
}
export interface OpeningSchedule {
  applicableDate: string; // YYYY-MM-DD
  timezone: string;
  windows: OpeningWindow[];
}
export const openingScheduleSchema = z.object({
  applicableDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1),
  windows: z.array(
    z.object({
      startLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
      endLocalTime: z.string().regex(/^\d{2}:\d{2}$/),
    }),
  ),
});

export const placeRefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  providerPoiId: z.string().nullable(),
  location: coordinateSchema.nullable(),
  coordinateRevision: z.number().int().nonnegative(),
  entranceConfirmed: z.boolean(),
  openingDescription: z.object({ ...factBaseShape, value: z.string().nullable() }),
  openingSchedule: z.object({
    ...factBaseShape,
    value: openingScheduleSchema.nullable(),
  }),
});

/** 地点引用（第 4.3 节）：地点名不等于入口已确认 */
export type PlaceRef = z.infer<typeof placeRefSchema>;

/** 游览活动（timeline 模式有序项） */
export const activityKindSchema = z.enum(['walk', 'rest', 'other']);
export type ActivityKind = z.infer<typeof activityKindSchema>;
export const visitActivitySchema = z.object({
  id: z.string().min(1),
  kind: activityKindSchema,
  durationSeconds: secondsSchema.nullable(),
  seatFact: z.object({ ...factBaseShape, value: z.boolean().nullable() }),
});
export type VisitActivity = z.infer<typeof visitActivitySchema>;

/** 活动计划：aggregate 用合计；timeline 用有序序列 */
export const activityPlanSchema = z.object({
  mode: z.enum(['aggregate', 'timeline']),
  completeness: z.enum(['complete', 'incomplete']),
  items: z.array(visitActivitySchema),
});
export type ActivityPlan = z.infer<typeof activityPlanSchema>;

export const visitNodeSchema = z.object({
  kind: z.literal('visit'),
  id: z.string().min(1),
  placeId: z.string().min(1),
  required: z.boolean(),
  skipped: z.boolean(),
  visitSeconds: secondsSchema.nullable(),
  insideWalkSeconds: secondsSchema.nullable(),
  activityPlan: activityPlanSchema.nullable(),
  notes: z.string(),
});
export type VisitNode = z.infer<typeof visitNodeSchema>;

export const restNodeSchema = z.object({
  kind: z.literal('rest'),
  id: z.string().min(1),
  placeId: z.string().min(1),
  /** 休息点也可整点跳过（保留资料可恢复），口径与景点一致（第 8.3 节） */
  skipped: z.boolean(),
  restSeconds: secondsSchema.nullable(),
  seatFact: z.object({ ...factBaseShape, value: z.boolean().nullable() }),
  notes: z.string(),
});
export type RestNode = z.infer<typeof restNodeSchema>;

export const routeNodeSchema = z.discriminatedUnion('kind', [visitNodeSchema, restNodeSchema]);
export type RouteNode = z.infer<typeof routeNodeSchema>;

export const endpointSchema = z.object({
  id: z.string().min(1),
  placeId: z.string().min(1),
  role: z.enum(['origin', 'destination']),
});
export type Endpoint = z.infer<typeof endpointSchema>;
export type EndpointRole = Endpoint['role'];

/** 设施记录（第 4.4 节）：target 明确归属 place / node / leg */
export const facilityKindSchema = z.enum(['toilet', 'rest-candidate', 'stairs']);
export type FacilityKind = z.infer<typeof facilityKindSchema>;
export const facilityTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('place'), placeId: z.string().min(1) }),
  z.object({ type: z.literal('node'), nodeId: z.string().min(1) }),
  z.object({ type: z.literal('leg'), legId: z.string().min(1) }),
]);
export type FacilityTarget = z.infer<typeof facilityTargetSchema>;
export const facilityRecordSchema = z.object({
  id: z.string().min(1),
  kind: facilityKindSchema,
  placeId: z.string().nullable(),
  target: facilityTargetSchema,
  facts: z.record(z.string(), z.unknown()),
  /** 同站多条候选的区分键（地图候选 POI id）；手动/旧数据为 null 或缺省 */
  recordKey: z.string().nullable().optional(),
});
export type FacilityRecord = z.infer<typeof facilityRecordSchema>;

/** 路段交通方式：首轮不自动优化公交换乘 */
export const legModeSchema = z.enum(['walking', 'manual-transfer']);
export type LegMode = z.infer<typeof legModeSchema>;

export const durationSourceSchema = z.enum(['amap', 'adopted', 'manual', 'same-entrance']);
export type DurationSource = z.infer<typeof durationSourceSchema>;

export const legStateSchema = z.enum(['missing', 'loading', 'ready', 'stale', 'unreachable', 'failed']);
export type LegState = z.infer<typeof legStateSchema>;

/** 归一化错误码（第 7.3 节），不含 Key、完整上游地址或堆栈 */
export const failureCodeSchema = z.enum([
  'INVALID_INPUT',
  'AMAP_NOT_CONFIGURED',
  'AMAP_AUTH_ERROR',
  'AMAP_QUOTA_EXCEEDED',
  'UPSTREAM_TIMEOUT',
  'ROUTE_UNREACHABLE',
  'UPSTREAM_DATA_INVALID',
  'REQUEST_CANCELLED',
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;

export const legSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  fromPlaceId: z.string().min(1),
  toPlaceId: z.string().min(1),
  fromCoordinateRevision: z.number().int().nonnegative(),
  toCoordinateRevision: z.number().int().nonnegative(),
  mode: legModeSchema,
  distanceMeters: metersSchema.nullable(),
  rawWalkingSeconds: secondsSchema.nullable(),
  effectiveWalkingSeconds: secondsSchema.nullable(),
  totalTravelSeconds: secondsSchema.nullable(),
  durationSource: durationSourceSchema,
  adoptedAt: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  providerApiVersion: z.string().nullable(),
  provider: z.string().nullable(),
  state: legStateSchema,
  failureCode: failureCodeSchema.nullable(),
  /** 地图报告属性（如阶梯），未核实，按持久化白名单不落盘；.default([]) 保证旧数据仍可解析 */
  reportedFeatures: z.array(z.object({ kind: z.string(), note: z.string() })).default([]),
});
/** 路段（第 4.5 节）：以起止逻辑节点身份及坐标版本关联 */
export type Leg = z.infer<typeof legSchema>;

/** 规划约束（第 4.6 节）：未设置的上限为 null */
export const constraintsSchema = z.object({
  maxTotalWalkSeconds: secondsSchema.nullable(),
  maxContinuousWalkSeconds: secondsSchema.nullable(),
  minRestSeconds: secondsSchema.nullable(),
  latestEndLocal: z.string().nullable(),
  walkingFactor: z.number().positive().finite(),
  passageRequirements: z.array(z.string()),
});
export type Constraints = z.infer<typeof constraintsSchema>;

/** 行程（第 4.2 节）：一次行程按单日出游设计 */
export const itinerarySchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  title: z.string(),
  city: z.string(),
  travelDate: z.string().nullable(),
  departureLocalTime: z.string().nullable(),
  timezone: z.string().min(1),
  places: z.record(z.string(), placeRefSchema),
  origin: endpointSchema.nullable(),
  destination: endpointSchema.nullable(),
  nodes: z.record(z.string(), routeNodeSchema),
  nodeOrder: z.array(z.string()),
  facilities: z.array(facilityRecordSchema),
  legs: z.record(z.string(), legSchema),
  constraints: constraintsSchema,
  updatedAt: z.string(),
});
export type Itinerary = z.infer<typeof itinerarySchema>;

/** 有效路线序列＝起点＋未跳过节点＋终点 */
export function activeSequence(it: Itinerary): string[] {
  const ids: string[] = [];
  if (it.origin) ids.push(it.origin.id);
  for (const id of it.nodeOrder) {
    const n = it.nodes[id];
    if (n && !n.skipped) ids.push(id);
  }
  if (it.destination) ids.push(it.destination.id);
  return ids;
}

/** 有效景点数量（跳过的不计；起终点不重复计为景点） */
export function activeVisitCount(it: Itinerary): number {
  return it.nodeOrder.filter((id) => {
    const n = it.nodes[id];
    return n?.kind === 'visit' && !n.skipped;
  }).length;
}

/** 活动节点上限（自动规划，含起终点与独立休息点；第 6.1 节） */
export const MAX_ACTIVITY_NODES = 12;
/** 景点数量上限（首轮；第 6.1 节） */
export const MAX_VISIT_NODES = 6;
