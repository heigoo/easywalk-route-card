/**
 * 本站 API 客户端（第 3.2 节）：受限请求参数、取消、请求关联与响应解析。
 * 前端只调用本站固定 API，不接触高德 Key。
 */
import type { ApiError, ApiSuccess, PlaceSearchItem } from '../../shared/contracts/api';

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requestId: string,
  ) {
    super(message);
  }
}

async function parseJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ApiRequestError('UPSTREAM_DATA_INVALID', '响应解析失败', false, '');
  }
}

async function request<T>(path: string, init: RequestInit & { requestId: string }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const body = (await parseJson(res)) as ApiSuccess<T> | ApiError;
  if ('code' in body && 'message' in body) {
    throw new ApiRequestError(body.code, body.message, body.retryable, body.requestId);
  }
  return (body as ApiSuccess<T>).data;
}

export interface PlacesSearchData {
  items: PlaceSearchItem[];
  nextPage: number | null;
}

export function searchPlaces(
  keyword: string,
  city: string,
  page: number,
  signal?: AbortSignal,
  requestId?: string,
): Promise<PlacesSearchData> {
  const params = new URLSearchParams({ keyword, city, page: String(page) });
  return request<PlacesSearchData>(`/api/places/search?${params.toString()}`, {
    method: 'GET',
    signal,
    requestId: requestId ?? crypto.randomUUID(),
  });
}

export interface NearbyData extends PlacesSearchData {
  source: string;
  fetchedAt: string;
}

export function searchNearby(
  longitude: number,
  latitude: number,
  category: 'TOILET' | 'REST_CANDIDATE',
  radiusMeters: number,
  page: number,
  signal?: AbortSignal,
): Promise<NearbyData> {
  const params = new URLSearchParams({
    longitude: String(longitude),
    latitude: String(latitude),
    category,
    radiusMeters: String(radiusMeters),
    page: String(page),
  });
  return request<NearbyData>(`/api/places/nearby?${params.toString()}`, {
    method: 'GET',
    signal,
    requestId: crypto.randomUUID(),
  });
}

export interface MatrixNodeInput {
  id: string;
  placeId: string;
  longitude: number;
  latitude: number;
  coordinateRevision: number;
}

export interface WalkingMatrixData {
  edges: Array<{
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
  }>;
  failures: Array<{ fromId: string; toId: string; code: string; retryable: boolean }>;
  queryCoverage: 'complete' | 'partial' | 'failed';
  fetchedAt: string;
}

export function fetchWalkingMatrix(
  body: {
    requestId: string;
    inputFingerprint: string;
    nodes: MatrixNodeInput[];
    pairs: Array<{ fromId: string; toId: string }>;
  },
  signal?: AbortSignal,
): Promise<WalkingMatrixData> {
  return request<WalkingMatrixData>('/api/routes/walking-matrix', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
    requestId: body.requestId,
  });
}
