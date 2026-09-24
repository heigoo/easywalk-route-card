/**
 * 待补充路段的收集与取数状态（R07 V1.1）。
 * - 只覆盖有效序列上相邻的 missing / stale 路段，不把历史边算进待补全；
 * - 两端坐标齐全才可自动拉矩阵；缺坐标只报地点名，不猜坐标；
 * - 取数中：无旧时长→loading；已有可展示时长→stale（旧值继续展示，不算作完整新结果）；
 * - 失败回到 missing/stale，不把失败写成“无路线”。
 */
import type { Gcj02Coordinate, Itinerary, Leg } from '../../shared/contracts/domain';
import { activeSequence } from '../../shared/contracts/domain';

export interface PendingLegEdge {
  legId: string;
  fromNodeId: string;
  toNodeId: string;
  fromPlaceId: string;
  toPlaceId: string;
  fromCoordinateRevision: number;
  toCoordinateRevision: number;
  fromLocation: Gcj02Coordinate;
  toLocation: Gcj02Coordinate;
}

export interface PendingLegsReport {
  /** 有效序列上 missing|stale 的路段数（含缺坐标无法自动取的） */
  pendingCount: number;
  /** 两端坐标齐全、可自动补全的路段 */
  fetchable: PendingLegEdge[];
  /** 缺坐标导致不能自动取数的地点名（去重） */
  missingPlaceNames: string[];
}

function placeOf(it: Itinerary, id: string) {
  if (it.origin?.id === id) return it.places[it.origin.placeId];
  if (it.destination?.id === id) return it.places[it.destination.placeId];
  const node = it.nodes[id];
  return node ? it.places[node.placeId] : undefined;
}

function legBetween(it: Itinerary, fromId: string, toId: string): Leg | undefined {
  return Object.values(it.legs).find((l) => l.fromNodeId === fromId && l.toNodeId === toId);
}

function isPending(leg: Leg | undefined): leg is Leg {
  return !!leg && (leg.state === 'missing' || leg.state === 'stale');
}

/** 有效序列上待补充路段：可自动取数的边 + 缺坐标地点 */
export function collectPendingLegs(it: Itinerary): PendingLegsReport {
  const seq = activeSequence(it);
  const fetchable: PendingLegEdge[] = [];
  const missingPlaceNames: string[] = [];
  const seenMissing = new Set<string>();
  let pendingCount = 0;

  const noteMissing = (placeName: string | undefined) => {
    const name = placeName?.trim() || '有地点缺少坐标';
    if (!seenMissing.has(name)) {
      seenMissing.add(name);
      missingPlaceNames.push(name);
    }
  };

  for (let i = 0; i < seq.length - 1; i++) {
    const fromId = seq[i];
    const toId = seq[i + 1];
    const leg = legBetween(it, fromId, toId);
    if (!isPending(leg)) continue;
    pendingCount += 1;

    const fromPlace = placeOf(it, fromId);
    const toPlace = placeOf(it, toId);
    if (!fromPlace?.location) {
      noteMissing(fromPlace?.name);
      continue;
    }
    if (!toPlace?.location) {
      noteMissing(toPlace?.name);
      continue;
    }
    fetchable.push({
      legId: leg.id,
      fromNodeId: fromId,
      toNodeId: toId,
      fromPlaceId: fromPlace.id,
      toPlaceId: toPlace.id,
      fromCoordinateRevision: fromPlace.coordinateRevision,
      toCoordinateRevision: toPlace.coordinateRevision,
      fromLocation: fromPlace.location,
      toLocation: toPlace.location,
    });
  }

  return { pendingCount, fetchable, missingPlaceNames };
}

/** 取数开始：无旧时长→loading；已有可展示时长→stale（旧值保留可见，第 4.5 节中间态） */
export function markLegsFetching(it: Itinerary, legIds: string[]): Itinerary {
  const ids = new Set(legIds);
  const legs: Record<string, Leg> = { ...it.legs };
  let changed = false;
  for (const id of ids) {
    const leg = legs[id];
    if (!leg) continue;
    if (leg.state === 'loading' || leg.state === 'stale') continue;
    const hasTimes = leg.effectiveWalkingSeconds !== null;
    const next: Leg = {
      ...leg,
      state: hasTimes ? 'stale' : 'loading',
    };
    legs[id] = next;
    changed = true;
  }
  return changed ? { ...it, legs } : it;
}

/**
 * 取数失败：loading 回到 missing（保持待补充，不写成无路线）；
 * stale 保留旧时长展示，不降级丢值。
 */
export function markLegsFetchFailed(it: Itinerary, legIds: string[]): Itinerary {
  const ids = new Set(legIds);
  const legs: Record<string, Leg> = { ...it.legs };
  let changed = false;
  for (const id of ids) {
    const leg = legs[id];
    if (!leg || leg.state !== 'loading') continue;
    legs[id] = { ...leg, state: 'missing', failureCode: null };
    changed = true;
  }
  return changed ? { ...it, legs } : it;
}
