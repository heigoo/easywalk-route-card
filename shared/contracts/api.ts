/**
 * 本站 API 契约（详细设计说明书第 7 章）。
 * 浏览器与服务端同源 JSON 请求；服务端只代理设计列出的高德接口。
 */
import { z } from 'zod';
import { coordinateSchema } from './domain';

/** 统一成功响应 */
export interface ApiSuccess<T> {
  requestId: string;
  data: T;
  warnings: string[];
}
/** 统一错误响应：字段错误指向具体字段，不带上游堆栈与凭据 */
export interface ApiError {
  code: string;
  message: string;
  retryable: boolean;
  fieldErrors: Array<{ field: string; message: string }>;
  requestId: string;
}

/** 地点搜索候选（第 7.2 节） */
export interface PlaceSearchItem {
  id: string;
  name: string;
  district: string;
  address: string;
  location: { longitude: number; latitude: number } | null;
  /** 无入口证据时恒为待确认 */
  entranceStatus: 'confirmed' | 'pending';
}
export const placeSearchItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  district: z.string(),
  address: z.string(),
  location: coordinateSchema.nullable(),
  entranceStatus: z.enum(['confirmed', 'pending']),
});

export const placesSearchQuerySchema = z.object({
  keyword: z.string().trim().min(1).max(60),
  city: z.string().trim().min(1).max(60),
  page: z.number().int().min(1).max(20),
});

export const nearbyQuerySchema = z.object({
  longitude: z.number().finite().min(-180).max(180),
  latitude: z.number().finite().min(-90).max(90),
  category: z.enum(['TOILET', 'REST_CANDIDATE']),
  radiusMeters: z.number().int().min(1).max(2000),
  page: z.number().int().min(1).max(20),
});

/** 步行矩阵请求节点（第 7.2 节） */
export const matrixNodeSchema = z.object({
  id: z.string().min(1).max(64),
  placeId: z.string().min(1),
  longitude: z.number().finite().min(-180).max(180),
  latitude: z.number().finite().min(-90).max(90),
  coordinateRevision: z.number().int().nonnegative(),
});
export const matrixPairSchema = z
  .object({
    fromId: z.string().min(1).max(64),
    toId: z.string().min(1).max(64),
  })
  .refine((p) => p.fromId !== p.toId, { message: '不接受相同逻辑 id 的自环' });

export const walkingMatrixBodySchema = z
  .object({
    requestId: z.string().min(1).max(64),
    inputFingerprint: z.string().min(1).max(128),
    nodes: z.array(matrixNodeSchema).min(2).max(12),
    pairs: z.array(matrixPairSchema).min(1).max(64),
  })
  .refine((b) => new Set(b.nodes.map((n) => n.id)).size === b.nodes.length, {
    message: '节点 id 在请求内必须唯一',
  })
  .refine(
    (b) => {
      const ids = new Set(b.nodes.map((n) => n.id));
      return b.pairs.every((p) => ids.has(p.fromId) && ids.has(p.toId));
    },
    { message: 'pairs 引用的节点必须存在' },
  );

export type WalkingMatrixRequest = z.infer<typeof walkingMatrixBodySchema>;

/** 矩阵边：缺失时长与失败不能转换成零时长 ready 边 */
export interface MatrixEdge {
  fromId: string;
  toId: string;
  fromCoordinateRevision: number;
  toCoordinateRevision: number;
  state: 'ready' | 'unreachable';
  distanceMeters: number | null;
  rawWalkingSeconds: number | null;
  provider: string;
  providerApiVersion: string | null;
  fetchedAt: string;
  reportedFeatures: Array<{ kind: string; note: string }>;
}
export const matrixEdgeSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  fromCoordinateRevision: z.number().int().nonnegative(),
  toCoordinateRevision: z.number().int().nonnegative(),
  state: z.enum(['ready', 'unreachable']),
  distanceMeters: z.number().int().nonnegative().nullable(),
  rawWalkingSeconds: z.number().int().nonnegative().nullable(),
  provider: z.string(),
  providerApiVersion: z.string().nullable(),
  fetchedAt: z.string(),
  reportedFeatures: z.array(z.object({ kind: z.string(), note: z.string() })),
});

export const matrixFailureSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  code: z.string(),
  retryable: z.boolean(),
});

export const queryCoverageSchema = z.enum(['complete', 'partial', 'failed']);

export interface WalkingMatrixData {
  edges: MatrixEdge[];
  failures: Array<{ fromId: string; toId: string; code: string; retryable: boolean }>;
  queryCoverage: 'complete' | 'partial' | 'failed';
  fetchedAt: string;
}

/** 错误码（第 7.3 节） */
export const API_ERROR_CODES = [
  'INVALID_INPUT',
  'AMAP_NOT_CONFIGURED',
  'AMAP_AUTH_ERROR',
  'AMAP_QUOTA_EXCEEDED',
  'UPSTREAM_TIMEOUT',
  'ROUTE_UNREACHABLE',
  'UPSTREAM_DATA_INVALID',
  'REQUEST_CANCELLED',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
