/**
 * 待补充路段收集与取数状态（R07 V1.1）。
 */
import { describe, expect, it } from 'vitest';
import {
  addVisitNode,
  createEmptyItinerary,
  setEndpoint,
  skipNode,
  upsertPlace,
} from '../../src/domain/itinerary';
import {
  collectPendingLegs,
  markLegsFetchFailed,
  markLegsFetching,
} from '../../src/domain/pendingLegs';
import { makePlace, setManualLeg } from '../helpers';

function setup() {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pA = makePlace('示例景点A', 116.4, 39.91);
  const pB = makePlace('示例景点B', 116.406, 39.914);
  for (const p of [pO, pA, pB]) it = upsertPlace(it, p);
  it = setEndpoint(it, 'origin', pO.id);
  it = setEndpoint(it, 'destination', pB.id);
  it = addVisitNode(it, pA.id, { visitSeconds: 30 * 60, insideWalkSeconds: 0 });
  const aId = it.nodeOrder[0];
  const legOA = Object.values(it.legs).find(
    (l) => l.fromNodeId === it.origin!.id && l.toNodeId === aId,
  )!;
  it = setManualLeg(it, legOA.id, { walkingSeconds: 12 * 60 });
  return { it, pO, pA, pB, aId, legOA: legOA.id };
}

describe('collectPendingLegs（R07 V1.1）', () => {
  it('只统计有效序列上 missing|stale 的相邻路段；已有时间的边不进待补全', () => {
    const { it } = setup();
    const report = collectPendingLegs(it);
    // 起点→A 已手动填写；A→终点 missing
    expect(report.pendingCount).toBe(1);
    expect(report.fetchable).toHaveLength(1);
    expect(report.fetchable[0].toNodeId).toBe(it.destination!.id);
    expect(report.missingPlaceNames).toEqual([]);
  });

  it('跳站后新邻接边进入待补全，旧边不冒充', () => {
    const { it, aId } = setup();
    const pC = makePlace('示例景点C', 116.402, 39.912);
    let it2 = upsertPlace(it, pC);
    it2 = addVisitNode(it2, pC.id, { visitSeconds: 20 * 60, insideWalkSeconds: 0 });
    const cId = it2.nodeOrder[1];
    const legAC = Object.values(it2.legs).find(
      (l) => l.fromNodeId === aId && l.toNodeId === cId,
    )!;
    it2 = setManualLeg(it2, legAC.id, { walkingSeconds: 8 * 60 });
    it2 = skipNode(it2, aId);
    const report = collectPendingLegs(it2);
    const pairs = report.fetchable.map((e) => `${e.fromNodeId}>${e.toNodeId}`);
    expect(pairs).toContain(`${it2.origin!.id}>${cId}`);
    expect(pairs).not.toContain(`${aId}>${cId}`);
  });

  it('缺坐标地点不进入 fetchable，只报地点名', () => {
    const { it, pA, aId } = setup();
    const noCoord = { ...pA, location: null as null, coordinateRevision: pA.coordinateRevision + 1 };
    const it2 = upsertPlace(it, noCoord);
    const report = collectPendingLegs(it2);
    expect(report.fetchable.every((e) => e.fromNodeId !== aId && e.toNodeId !== aId)).toBe(true);
    expect(report.missingPlaceNames).toContain('示例景点A');
  });

  it('markLegsFetching：无旧时长→loading；有旧时长→stale。失败 loading 回 missing', () => {
    const { it } = setup();
    const report = collectPendingLegs(it);
    const legId = report.fetchable[0].legId;
    const loading = markLegsFetching(it, [legId]);
    expect(loading.legs[legId].state).toBe('loading');
    const failed = markLegsFetchFailed(loading, [legId]);
    expect(failed.legs[legId].state).toBe('missing');

    const readyLeg = Object.values(it.legs).find((l) => l.state === 'ready')!;
    const stale = markLegsFetching(it, [readyLeg.id]);
    expect(stale.legs[readyLeg.id].state).toBe('stale');
    expect(stale.legs[readyLeg.id].effectiveWalkingSeconds).toBe(12 * 60);
  });
});
