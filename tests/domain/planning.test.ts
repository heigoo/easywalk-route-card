/**
 * 规划候选应用（第 6.5、8.3 节；验证用例 T08/T09 的应用侧）。
 */
import { describe, expect, it } from 'vitest';
import { computeStats } from '../../src/domain/compute';
import { applyPlannerCandidate, edgeKey } from '../../src/domain/planning';
import {
  addVisitNode,
  adoptAllMapLegs,
  setEndpoint,
  upsertPlace,
  createEmptyItinerary,
} from '../../src/domain/itinerary';
import { makePlace, setManualLeg } from '../helpers';

/** 起点→A→B→终点，A 必去、B 可选 */
function setup() {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pA = makePlace('示例景点A', 116.4, 39.91);
  const pB = makePlace('示例景点B', 116.41, 39.92);
  const pD = makePlace('示例终点', 116.42, 39.93);
  for (const p of [pO, pA, pB, pD]) it = upsertPlace(it, p);
  it = setEndpoint(it, 'origin', pO.id);
  it = setEndpoint(it, 'destination', pD.id);
  it = addVisitNode(it, pA.id, { required: true, visitSeconds: 30 * 60, insideWalkSeconds: 0 });
  const aId = it.nodeOrder[0];
  it = addVisitNode(it, pB.id, { required: false, visitSeconds: 20 * 60, insideWalkSeconds: 0 });
  const bId = it.nodeOrder[1];
  return { it, aId, bId, oId: it.origin!.id, dId: it.destination!.id };
}

describe('applyPlannerCandidate（第 6.5 节）', () => {
  it('按候选顺序重排；被省略的可选景点保留资料但不进入路线', () => {
    const { it, aId, bId, oId, dId } = setup();
    // 候选：起点→B→A→终点（重排），省略的可选景点为空（B 保留）
    const reordered = applyPlannerCandidate(
      it,
      { nodeOrder: [oId, bId, aId, dId], adoptedLegKeys: [] },
      [],
    );
    expect(reordered.nodeOrder).toEqual([bId, aId]);
    expect(computeStats(reordered).totalWalkSeconds).toBeNull(); // 新相邻关系待获取

    // 候选省略 B：B 仍在 nodes 中保留资料
    const dropped = applyPlannerCandidate(it, { nodeOrder: [oId, aId, dId], adoptedLegKeys: [] }, []);
    expect(dropped.nodeOrder).toEqual([aId, bId]);
    expect(dropped.nodes[bId]).toBeDefined();
  });

  it('跳过状态不被应用候选改变', () => {
    const { it, aId, bId, oId, dId } = setup();
    const skipped = { ...it, nodes: { ...it.nodes, [bId]: { ...it.nodes[bId], skipped: true } } };
    const applied = applyPlannerCandidate(skipped, { nodeOrder: [oId, aId, dId], adoptedLegKeys: [] }, []);
    expect(applied.nodes[bId].skipped).toBe(true);
  });

  it('候选采用的边按会话内地图值写入；未采用的边保持待获取', () => {
    const { it, aId, oId, dId } = setup();
    const fetchedAt = '2026-09-22T05:00:00.000Z';
    const edges = [
      {
        fromNodeId: oId,
        toNodeId: aId,
        distanceMeters: 800,
        rawWalkingSeconds: 600,
        provider: 'amap',
        providerApiVersion: 'v5',
        fetchedAt,
        state: 'ready' as const,
      },
    ];
    const applied = applyPlannerCandidate(
      it,
      { nodeOrder: [oId, aId, dId], adoptedLegKeys: [edgeKey(oId, aId)] },
      edges,
    );
    const leg = Object.values(applied.legs).find((l) => l.fromNodeId === oId && l.toNodeId === aId)!;
    expect(leg.durationSource).toBe('amap');
    expect(leg.effectiveWalkingSeconds).toBe(600);
    expect(leg.state).toBe('ready');
    // 未采用的 A→终点 边仍待获取
    const other = Object.values(applied.legs).find((l) => l.fromNodeId === aId && l.toNodeId === dId)!;
    expect(other.state).toBe('missing');
  });

  it('已采纳路段不被候选应用覆盖（第 8.5 节）', () => {
    const { it, aId, oId, dId } = setup();
    // 先手动填 O→A 并采纳（模拟会话内已采纳）
    const leg = Object.values(it.legs).find((l) => l.fromNodeId === oId && l.toNodeId === aId)!;
    const withManual = setManualLeg(it, leg.id, { walkingSeconds: 700 });
    // 手动值本身不会被覆盖（durationSource=manual）
    const applied = applyPlannerCandidate(
      withManual,
      { nodeOrder: [oId, aId, dId], adoptedLegKeys: [edgeKey(oId, aId)] },
      [
        {
          fromNodeId: oId,
          toNodeId: aId,
          distanceMeters: 900,
          rawWalkingSeconds: 500,
          provider: 'amap',
          providerApiVersion: 'v5',
          fetchedAt: '2026-09-22T05:00:00.000Z',
          state: 'ready' as const,
        },
      ],
    );
    // C3：手动已填值不被地图/候选静默覆盖
    const appliedLeg = Object.values(applied.legs).find((l) => l.fromNodeId === oId && l.toNodeId === aId)!;
    expect(appliedLeg.effectiveWalkingSeconds).toBe(700);
    expect(appliedLeg.durationSource).toBe('manual');

    // 已采纳（adopted）路段则保持采纳值不被覆盖
    const { itinerary: adopted } = adoptAllMapLegs(
      applyPlannerCandidate(
        it,
        { nodeOrder: [oId, aId, dId], adoptedLegKeys: [edgeKey(oId, aId)] },
        [
          {
            fromNodeId: oId,
            toNodeId: aId,
            distanceMeters: 800,
            rawWalkingSeconds: 600,
            provider: 'amap',
            providerApiVersion: 'v5',
            fetchedAt: '2026-09-22T05:00:00.000Z',
            state: 'ready' as const,
          },
        ],
      ),
      '2026-09-22T06:00:00.000Z',
    );
    const applied2 = applyPlannerCandidate(
      adopted,
      { nodeOrder: [oId, aId, dId], adoptedLegKeys: [edgeKey(oId, aId)] },
      [
        {
          fromNodeId: oId,
          toNodeId: aId,
          distanceMeters: 700,
          rawWalkingSeconds: 400,
          provider: 'amap',
          providerApiVersion: 'v5',
          fetchedAt: '2026-09-22T07:00:00.000Z',
          state: 'ready' as const,
        },
      ],
    );
    const adoptedLeg = Object.values(applied2.legs).find((l) => l.fromNodeId === oId && l.toNodeId === aId)!;
    expect(adoptedLeg.durationSource).toBe('adopted');
    expect(adoptedLeg.effectiveWalkingSeconds).toBe(600);
  });
});