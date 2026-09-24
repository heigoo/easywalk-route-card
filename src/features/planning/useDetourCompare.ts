/**
 * 歇脚绕行对照（Task 4 / R-D；R03“绕路步行必须纳入计算”补课）。
 * - 对序列中每个未跳过的 rest 节点，相邻两段都有步行数据时，发起一次“上一站→下一站”直达对照查询
 *   （走既有 fetchWalkingMatrix，单 pair；同一 triple 只查一次）；
 * - 对照边只作会话内对照：仅存 hook/会话内存，不写行程结构、绝不落盘（持久化白名单不变）；
 * - 失败/不可达不自动重试轰炸，界面留“绕行对比待补充”并可手动“重试对比”；
 * - 上一站/下一站缺坐标直接“绕行对比待补充”，不发起查询；绝不用直线距离（straightLineMeters）或估算冒充；
 * - 比较口径：两段取当前展示的有效步行时长（effectiveWalkingSeconds，含手动/采纳值），
 *   直达对照的原始时长按同一 walkingFactor 折算后再比较（与 deriveEffectiveWalkSeconds 同口径），
 *   展示时注明“按当前步行倍数估算”。绕行两段本就作为真实路段进入既有汇总，不重复额外累加（R04）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Gcj02Coordinate, Itinerary, Leg, RouteNode } from '../../../shared/contracts/domain';
import { activeSequence } from '../../../shared/contracts/domain';
import { ceilMinutes } from '../../domain/format';
import { computeInputFingerprint } from '../../domain/fingerprint';
import { deriveEffectiveWalkSeconds } from '../../domain/itinerary';
import { fetchWalkingMatrix, type MatrixNodeInput } from '../../services/api';

/** 单条绕行对照结果；directRawWalkingSeconds 为直达原始步行秒（amap 基准值） */
export type DetourCompare =
  | { status: 'loading' }
  | { status: 'ready'; directRawWalkingSeconds: number }
  | { status: 'unreachable' }
  | { status: 'failed' };

/** key = tripleKey（上一站|休息点|下一站|两端坐标版本） */
export type DetourCompareMap = Record<string, DetourCompare>;

/** 对照不可得时的统一文案：待补充，绝不用直线距离/估算冒充 */
export const DETOUR_PENDING_TEXT = '绕行对比待补充';

export interface DetourTriple {
  key: string;
  restId: string;
  prevId: string;
  nextId: string;
  fromCoordinateRevision: number;
  toCoordinateRevision: number;
  prevLocation: Gcj02Coordinate | null;
  nextLocation: Gcj02Coordinate | null;
  /** 两段当前展示步行时长之和（秒）；任一段缺失为 null（不参与对比） */
  viaSeconds: number | null;
}

export interface DetourRequest {
  key: string;
  restId: string;
  fromNodeId: string;
  toNodeId: string;
  nodes: [MatrixNodeInput, MatrixNodeInput];
  pairs: [{ fromId: string; toId: string }];
}

export interface DetourNotice {
  text: string;
  /** 对照失败/不可达后可手动重试（不自动重试） */
  retryable: boolean;
}

/** 序列条目的地点与坐标版本（端点与节点同一口径） */
function seqRefOf(
  it: Itinerary,
  id: string,
): { placeId: string; coordinateRevision: number; location: Gcj02Coordinate | null } | null {
  if (it.origin?.id === id || it.destination?.id === id) {
    const endpoint = it.origin?.id === id ? it.origin : it.destination;
    const place = endpoint ? it.places[endpoint.placeId] : undefined;
    return place
      ? { placeId: place.id, coordinateRevision: place.coordinateRevision, location: place.location }
      : null;
  }
  const node: RouteNode | undefined = it.nodes[id];
  if (!node) return null;
  const place = it.places[node.placeId];
  return place
    ? { placeId: place.id, coordinateRevision: place.coordinateRevision, location: place.location }
    : null;
}

function legBetween(it: Itinerary, fromId: string, toId: string): Leg | undefined {
  return Object.values(it.legs).find((l) => l.fromNodeId === fromId && l.toNodeId === toId);
}

/** 当前展示的步行时长（与界面同一口径）；未就绪一律 null（未知不等于没有） */
function legWalkSeconds(leg: Leg | undefined): number | null {
  if (!leg || (leg.state !== 'ready' && leg.state !== 'stale')) return null;
  return leg.effectiveWalkingSeconds;
}

/** 休息点的绕行 triple（含对照 key）；非休息点/序列两端/无相邻两段时为 null */
export function detourTripleOf(it: Itinerary, restId: string): DetourTriple | null {
  const node = it.nodes[restId];
  if (!node || node.kind !== 'rest' || node.skipped) return null;
  const seq = activeSequence(it);
  const idx = seq.indexOf(restId);
  if (idx <= 0 || idx >= seq.length - 1) return null;
  const prevId = seq[idx - 1];
  const nextId = seq[idx + 1];
  const from = seqRefOf(it, prevId);
  const to = seqRefOf(it, nextId);
  if (!from || !to) return null;
  const a = legWalkSeconds(legBetween(it, prevId, restId));
  const b = legWalkSeconds(legBetween(it, restId, nextId));
  return {
    key: [prevId, restId, nextId, from.coordinateRevision, to.coordinateRevision].join('|'),
    restId,
    prevId,
    nextId,
    fromCoordinateRevision: from.coordinateRevision,
    toCoordinateRevision: to.coordinateRevision,
    prevLocation: from.location,
    nextLocation: to.location,
    viaSeconds: a !== null && b !== null ? a + b : null,
  };
}

/** 可发起直达对照查询的请求：两段有步行数据且上一站/下一站坐标可用（缺坐标→标待补充、不查询） */
export function detourRequestFor(it: Itinerary, restId: string): DetourRequest | null {
  const t = detourTripleOf(it, restId);
  if (!t || t.viaSeconds === null || !t.prevLocation || !t.nextLocation) return null;
  const from: MatrixNodeInput = {
    id: t.prevId,
    placeId: seqRefOf(it, t.prevId)!.placeId,
    longitude: t.prevLocation.longitude,
    latitude: t.prevLocation.latitude,
    coordinateRevision: t.fromCoordinateRevision,
  };
  const to: MatrixNodeInput = {
    id: t.nextId,
    placeId: seqRefOf(it, t.nextId)!.placeId,
    longitude: t.nextLocation.longitude,
    latitude: t.nextLocation.latitude,
    coordinateRevision: t.toCoordinateRevision,
  };
  return {
    key: t.key,
    restId: t.restId,
    fromNodeId: t.prevId,
    toNodeId: t.nextId,
    nodes: [from, to],
    pairs: [{ fromId: t.prevId, toId: t.nextId }],
  };
}

/** 尚无会话结果、需要补查的对照请求（同一 triple 只查一次） */
export function pendingDetourRequests(it: Itinerary, compares: DetourCompareMap): DetourRequest[] {
  const out: DetourRequest[] = [];
  for (const id of activeSequence(it)) {
    if (it.nodes[id]?.kind !== 'rest') continue;
    const req = detourRequestFor(it, id);
    if (req && !(req.key in compares)) out.push(req);
  }
  return out;
}

/** 直达对照查询（单 pair）：失败/不可达只返回结论，不自动重试 */
export async function fetchDetourCompare(
  req: DetourRequest,
  inputFingerprint: string,
): Promise<DetourCompare> {
  try {
    const matrix = await fetchWalkingMatrix({
      requestId: `detour-${req.key}`,
      inputFingerprint,
      nodes: req.nodes,
      pairs: req.pairs,
    });
    const edge = matrix.edges.find((e) => e.fromId === req.fromNodeId && e.toId === req.toNodeId);
    if (!edge) return { status: 'failed' };
    if (edge.state !== 'ready' || edge.rawWalkingSeconds === null) return { status: 'unreachable' };
    return { status: 'ready', directRawWalkingSeconds: edge.rawWalkingSeconds };
  } catch {
    return { status: 'failed' };
  }
}

/**
 * 会话内对照缓存（仅内存）：不写行程、不落盘，刷新页面即消失；
 * 供编辑行（hook 状态）与卡片（buildViewModel）共用同一份对照结果。
 */
const sessionCompares: DetourCompareMap = {};

export function rememberDetourCompare(key: string, entry: DetourCompare): void {
  sessionCompares[key] = entry;
}

export function forgetDetourCompare(key: string): void {
  delete sessionCompares[key];
}

export function sessionDetourCompares(): DetourCompareMap {
  return { ...sessionCompares };
}

export function clearDetourCompares(): void {
  for (const key of Object.keys(sessionCompares)) delete sessionCompares[key];
}

/**
 * 休息点的歇脚绕行展示文案；null＝两段步行数据未齐，暂不展示对比（两段自身已按既有规则标待补充）。
 * 对照失败/不可达/缺坐标/未取得一律“绕行对比待补充”，绝不用直线距离或估算冒充。
 */
export function detourNoticeFor(
  it: Itinerary,
  restId: string,
  compares: DetourCompareMap,
): DetourNotice | null {
  const t = detourTripleOf(it, restId);
  if (!t || t.viaSeconds === null) return null;
  if (!t.prevLocation || !t.nextLocation) return { text: DETOUR_PENDING_TEXT, retryable: false };
  const entry = compares[t.key];
  if (!entry) return { text: DETOUR_PENDING_TEXT, retryable: false };
  if (entry.status === 'loading') return { text: '歇脚绕行对比：查询中…', retryable: false };
  if (entry.status !== 'ready') return { text: DETOUR_PENDING_TEXT, retryable: true };
  // 口径：两段取当前展示的有效步行时长；直达原始时长按同一 walkingFactor 折算后再比较
  const direct = deriveEffectiveWalkSeconds(entry.directRawWalkingSeconds, it) ?? 0;
  const delta = t.viaSeconds - direct;
  const text =
    delta > 0 ? `歇脚绕行：比直达多走约 ${ceilMinutes(delta)} 分钟` : '歇脚绕行：与直达相当/更近';
  return { text: `${text}（按当前步行倍数估算）`, retryable: false };
}

export interface UseDetourCompareResult {
  compares: DetourCompareMap;
  /** 手动重试该休息点的直达对照（失败/不可达后由用户触发，绝不自动重试） */
  retry: (restId: string) => void;
}

/** 歇脚绕行对照编排：结果仅存会话内存，不写行程、不落盘 */
export function useDetourCompare(it: Itinerary): UseDetourCompareResult {
  const [compares, setCompares] = useState<DetourCompareMap>(() => sessionDetourCompares());
  const inFlightRef = useRef<Set<string>>(new Set());

  const remember = useCallback((key: string, entry: DetourCompare) => {
    rememberDetourCompare(key, entry);
    setCompares(sessionDetourCompares());
  }, []);

  const load = useCallback(
    (req: DetourRequest) => {
      if (inFlightRef.current.has(req.key) || req.key in sessionDetourCompares()) return;
      inFlightRef.current.add(req.key);
      remember(req.key, { status: 'loading' });
      void fetchDetourCompare(req, computeInputFingerprint(it)).then((entry) => {
        inFlightRef.current.delete(req.key);
        remember(req.key, entry);
      });
    },
    [it, remember],
  );

  useEffect(() => {
    for (const req of pendingDetourRequests(it, sessionDetourCompares())) load(req);
  }, [it, load]);

  const retry = useCallback(
    (restId: string) => {
      const req = detourRequestFor(it, restId);
      if (!req) return;
      forgetDetourCompare(req.key);
      inFlightRef.current.delete(req.key);
      setCompares(sessionDetourCompares());
      load(req);
    },
    [it, load],
  );

  return { compares, retry };
}
