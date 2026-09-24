/**
 * 可插入歇脚候选（连续步行超限的有限补救，R03/T08）。
 */
import { describe, expect, it } from 'vitest';
import type { Fact } from '../../shared/contracts/domain';
import { unknownFact } from '../../shared/contracts/domain';
import {
  addVisitNode,
  createEmptyItinerary,
  setEndpoint,
  upsertNodeFacilityFact,
  upsertPlace,
} from '../../src/domain/itinerary';
import {
  insertRestVirtualId,
  listInsertableRestCandidates,
  parseInsertRestVirtualId,
} from '../../src/domain/insertRest';
import { listCandidatePairs, plan } from '../../src/workers/planner';
import { makePlace } from '../helpers';

function fact<T>(value: T, reviewState: Fact<T>['reviewState'] = 'userChecked'): Fact<T> {
  return { ...unknownFact<T>(), value, reviewState, sourceType: 'user' };
}

function setupWithCandidate(seatValue: boolean | null, withLocation: boolean) {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pA = makePlace('示例景点A', 116.4, 39.91);
  const pB = makePlace('示例景点B', 116.41, 39.92);
  for (const p of [pO, pA, pB]) it = upsertPlace(it, p);
  it = setEndpoint(it, 'origin', pO.id);
  it = setEndpoint(it, 'destination', pB.id);
  it = addVisitNode(it, pA.id, {
    required: true,
    visitSeconds: 30 * 60,
    insideWalkSeconds: 20 * 60,
  });
  const aId = it.nodeOrder[0];
  it = addVisitNode(it, pB.id, {
    required: true,
    visitSeconds: 30 * 60,
    insideWalkSeconds: 0,
  });
  const bId = it.nodeOrder[1];
  it = upsertNodeFacilityFact(it, aId, 'rest-candidate', 'name', fact('长椅休息区'), 'poi-r1');
  it = upsertNodeFacilityFact(it, aId, 'rest-candidate', 'seat', fact(seatValue), 'poi-r1');
  if (withLocation) {
    it = upsertNodeFacilityFact(
      it,
      aId,
      'rest-candidate',
      'location',
      fact({ longitude: 116.401, latitude: 39.911 }),
      'poi-r1',
    );
  }
  return { it, oId: it.origin!.id, aId, bId, dId: it.destination!.id };
}

describe('listInsertableRestCandidates', () => {
  it('仅收录已确认可坐且有坐标的 rest-candidate', () => {
    const ok = setupWithCandidate(true, true);
    const list = listInsertableRestCandidates(ok.it);
    expect(list).toHaveLength(1);
    expect(list[0].hostNodeId).toBe(ok.aId);
    expect(parseInsertRestVirtualId(list[0].virtualId)).toBe(
      ok.it.facilities.find((f) => f.kind === 'rest-candidate')!.id,
    );
    expect(insertRestVirtualId('x')).toBe('rest-cand:x');

    expect(listInsertableRestCandidates(setupWithCandidate(true, false).it)).toHaveLength(0);
    expect(listInsertableRestCandidates(setupWithCandidate(false, true).it)).toHaveLength(0);
    expect(listInsertableRestCandidates(setupWithCandidate(null, true).it)).toHaveLength(0);
  });
});

describe('规划器插入歇脚候选', () => {
  it('listCandidatePairs 含挂靠站相邻边上的插入对', () => {
    const { it, oId, aId, bId, dId } = setupWithCandidate(true, true);
    const r = listInsertableRestCandidates(it)[0];
    const pairs = listCandidatePairs(it).map((p) => `${p.from}|${p.to}`);
    // 起点→A→B→终点：A 为挂靠站，应含 起点→R、R→A、A→R、R→B
    expect(pairs).toContain(`${oId}|${r.virtualId}`);
    expect(pairs).toContain(`${r.virtualId}|${aId}`);
    expect(pairs).toContain(`${aId}|${r.virtualId}`);
    expect(pairs).toContain(`${r.virtualId}|${bId}`);
    expect(pairs).not.toContain(`${r.virtualId}|${dId}`);
  });

  it('连续步行超限时有限枚举插入已确认坐位的歇脚候选', () => {
    const { it, oId, aId, bId, dId } = setupWithCandidate(true, true);
    const r = listInsertableRestCandidates(it)[0];
    // 起点→A 20min，A→B 25min，B→终点 5min；园内 A 20min 也算连续前半段——用纯路段制造超限
    // 简化：给边赋值使 起点→A→B 连续 50 分钟，上限 40
    const edges: Record<string, number | null> = {
      [`${oId}|${aId}`]: 20 * 60,
      [`${aId}|${bId}`]: 30 * 60,
      [`${bId}|${dId}`]: 5 * 60,
      [`${oId}|${r.virtualId}`]: 5 * 60,
      [`${r.virtualId}|${aId}`]: 5 * 60,
      [`${aId}|${r.virtualId}`]: 5 * 60,
      [`${r.virtualId}|${bId}`]: 5 * 60,
    };
    const withCons = {
      ...it,
      constraints: { ...it.constraints, maxContinuousWalkSeconds: 40 * 60 },
    };
    // 去掉园内步行干扰
    const clean = {
      ...withCons,
      nodes: {
        ...withCons.nodes,
        [aId]: { ...withCons.nodes[aId], insideWalkSeconds: 0, visitSeconds: 0 },
        [bId]: { ...withCons.nodes[bId], insideWalkSeconds: 0, visitSeconds: 0 },
      },
    };
    const result = plan({ itinerary: clean, edges });
    const withInsert = result.candidates.filter((c) => (c.insertedRests?.length ?? 0) > 0);
    expect(withInsert.length).toBeGreaterThan(0);
    expect(withInsert[0].insertedRests![0].facilityId).toBe(r.facilityId);
    expect(withInsert[0].nodeOrder).toContain(r.virtualId);
  });
});
