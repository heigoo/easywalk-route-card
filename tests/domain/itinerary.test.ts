/**
 * 路段身份、失效与采纳机制（T06、T07、T22；第 4.5、8.3、8.5 节）。
 * 末尾为 Task 3 / R-B：歇脚点候选一键转休息点。
 */
import { describe, expect, it } from 'vitest';
import type { Fact, RestNode } from '../../shared/contracts/domain';
import { activeSequence, unknownFact } from '../../shared/contracts/domain';
import { computeInputFingerprint } from '../../src/domain/fingerprint';
import {
  addVisitNode,
  adoptAllMapLegs,
  applyMatrixEdges,
  applyWalkingFactor,
  confirmEntrance,
  convertRestCandidateToRestNode,
  createEmptyItinerary,
  moveNode,
  restoreLegToMapValue,
  restoreNode,
  setEndpoint,
  setManualLegTime,
  skipNode,
  updateNode,
  updatePlaceCoordinate,
  upsertNodeFacilityFact,
  upsertPlace,
} from '../../src/domain/itinerary';
import { makePlace } from '../helpers';

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
  const leg = Object.values(it.legs).find((l) => l.fromNodeId === it.origin!.id && l.toNodeId === aId)!;
  it = setManualLegTime(it, leg.id, { walkingSeconds: 12 * 60 });
  return { it, pO, pA, pB, aId, legId: leg.id };
}

describe('路段身份（T06）', () => {
  it('A→B 与 B→A 不混用：重排后新方向不得复用原时间', () => {
    const { it, aId } = setup(); // 起点→A→终点
    const pC = makePlace('示例景点C', 116.402, 39.912);
    let it2 = upsertPlace(it, pC);
    it2 = addVisitNode(it2, pC.id, { visitSeconds: 20 * 60, insideWalkSeconds: 0 });
    const cId = it2.nodeOrder[1];
    const legAC = Object.values(it2.legs).find((l) => l.fromNodeId === aId && l.toNodeId === cId)!;
    it2 = setManualLegTime(it2, legAC.id, { walkingSeconds: 8 * 60 });
    expect(it2.legs[legAC.id].state).toBe('ready');

    // 重排为 起点→C→A→终点：相邻对 (C,A) 是全新方向
    const reordered = moveNode(it2, cId, -1);
    const legCA = Object.values(reordered.legs).find(
      (l) => l.fromNodeId === cId && l.toNodeId === aId,
    )!;
    expect(legCA).toBeDefined();
    expect(legCA.id).not.toBe(legAC.id);
    expect(legCA.state).toBe('missing'); // 不沿用 A→C 的 8 分钟
    expect(legCA.effectiveWalkingSeconds).toBeNull();
    // 原 A→C 路段保留在集合中（供再次调整复用），但不被新序列引用
    expect(reordered.legs[legAC.id]).toBeDefined();
    expect(reordered.legs[legAC.id].effectiveWalkingSeconds).toBe(8 * 60);
  });

  it('入口坐标修改后相关边失效，旧时间不顶替新路段', () => {
    const { it, pA, aId, legId } = setup();
    const updated = updatePlaceCoordinate(it, pA.id, { longitude: 116.401, latitude: 39.911 });
    const newLeg = Object.values(updated.legs).find(
      (l) => l.fromNodeId === updated.origin!.id && l.toNodeId === aId,
    )!;
    expect(newLeg.id).not.toBe(legId);
    expect(newLeg.state).toBe('missing');
    expect(newLeg.effectiveWalkingSeconds).toBeNull();
    expect(updated.places[pA.id].coordinateRevision).toBe(1);
  });

  it('已确认同一入口的相邻节点生成零衔接边，不请求地图', () => {
    let { it } = setup();
    const pShared = makePlace('示例同入口景点', 116.405, 39.913, false);
    it = upsertPlace(it, pShared);
    it = addVisitNode(it, pShared.id, { visitSeconds: 10 * 60, insideWalkSeconds: 0 });
    it = addVisitNode(it, pShared.id, { visitSeconds: 15 * 60, insideWalkSeconds: 0 });
    // 入口未确认：不生成零衔接边
    expect(Object.values(it.legs).some((l) => l.durationSource === 'same-entrance')).toBe(false);
    const confirmed = confirmEntrance(it, pShared.id, true);
    const zero = Object.values(confirmed.legs).find((l) => l.durationSource === 'same-entrance');
    expect(zero).toBeDefined();
    expect(zero!.effectiveWalkingSeconds).toBe(0);
    expect(zero!.state).toBe('ready');
  });
});

describe('采纳与离线（第 8.5 节）', () => {
  it('采纳地图值后可离线保存；恢复为地图值后回到待获取', () => {
    const { it, aId } = setup();
    const withAmap = applyMatrixEdges(it, [
      {
        fromNodeId: it.origin!.id,
        toNodeId: aId,
        fromCoordinateRevision: 0,
        toCoordinateRevision: 0,
        distanceMeters: 900,
        rawWalkingSeconds: 720,
        provider: 'amap',
        providerApiVersion: 'v5',
        fetchedAt: '2026-09-22T01:00:00.000Z',
        state: 'ready',
      },
    ]);
    const amapLeg = Object.values(withAmap.legs)[0];
    expect(amapLeg.durationSource).toBe('amap');
    expect(amapLeg.effectiveWalkingSeconds).toBe(720);

    const { itinerary: adopted, adoptedCount } = adoptAllMapLegs(withAmap, '2026-09-22T02:00:00.000Z');
    expect(adoptedCount).toBe(1);
    const adoptedLeg = Object.values(adopted.legs)[0];
    expect(adoptedLeg.durationSource).toBe('adopted');
    expect(adoptedLeg.adoptedAt).toBe('2026-09-22T02:00:00.000Z');

    const restored = restoreLegToMapValue(adopted, adoptedLeg.id);
    const restoredLeg = restored.legs[adoptedLeg.id];
    expect(restoredLeg.state).toBe('missing');
    expect(restoredLeg.durationSource).toBe('manual');
    expect(restoredLeg.effectiveWalkingSeconds).toBeNull();
    expect(restoredLeg.adoptedAt).toBeNull();
  });

  it('已采纳路段不随步速因子变化，也不被新地图值静默覆盖', () => {
    const { it, aId } = setup();
    const withAmap = applyMatrixEdges(it, [
      {
        fromNodeId: it.origin!.id,
        toNodeId: aId,
        fromCoordinateRevision: 0,
        toCoordinateRevision: 0,
        distanceMeters: 900,
        rawWalkingSeconds: 720,
        provider: 'amap',
        providerApiVersion: 'v5',
        fetchedAt: '2026-09-22T01:00:00.000Z',
        state: 'ready',
      },
    ]);
    const { itinerary: adopted } = adoptAllMapLegs(withAmap, '2026-09-22T02:00:00.000Z');
    const factored = applyWalkingFactor(adopted, 2);
    const legId = Object.keys(factored.legs)[0];
    expect(factored.legs[legId].effectiveWalkingSeconds).toBe(720); // 采纳值锁定时点

    const refetched = applyMatrixEdges(factored, [
      {
        fromNodeId: factored.origin!.id,
        toNodeId: aId,
        fromCoordinateRevision: 0,
        toCoordinateRevision: 0,
        distanceMeters: 800,
        rawWalkingSeconds: 600,
        provider: 'amap',
        providerApiVersion: 'v5',
        fetchedAt: '2026-09-22T03:00:00.000Z',
        state: 'ready',
      },
    ]);
    expect(refetched.legs[legId].effectiveWalkingSeconds).toBe(720); // 未被覆盖
    expect(refetched.legs[legId].durationSource).toBe('adopted');
  });

  it('adoptAllMapLegs 只采纳 amap 路段：manual 与已采纳路段不受影响', () => {
    const { it, aId } = setup();
    // 起点→A 为手动填写；A→终点写入地图值
    const manualLegId = Object.values(it.legs).find((l) => l.fromNodeId === it.origin!.id)!.id;
    const withAmap = applyMatrixEdges(it, [
      {
        fromNodeId: aId,
        toNodeId: it.destination!.id,
        fromCoordinateRevision: 0,
        toCoordinateRevision: 0,
        distanceMeters: 500,
        rawWalkingSeconds: 400,
        provider: 'amap',
        providerApiVersion: 'v5',
        fetchedAt: '2026-09-22T01:00:00.000Z',
        state: 'ready',
      },
    ]);

    const { itinerary: adopted, adoptedCount } = adoptAllMapLegs(withAmap, '2026-09-22T02:00:00.000Z');
    expect(adoptedCount).toBe(1);
    // manual 路段原样保留
    expect(adopted.legs[manualLegId]).toEqual(withAmap.legs[manualLegId]);
    expect(adopted.legs[manualLegId].durationSource).toBe('manual');
    const adoptedLeg = Object.values(adopted.legs).find((l) => l.fromNodeId === aId)!;
    expect(adoptedLeg.durationSource).toBe('adopted');
    expect(adoptedLeg.adoptedAt).toBe('2026-09-22T02:00:00.000Z');

    // 再次执行不重复采纳、不改写既有 adoptedAt
    const again = adoptAllMapLegs(adopted, '2026-09-22T03:00:00.000Z');
    expect(again.adoptedCount).toBe(0);
    expect(again.itinerary.legs[adoptedLeg.id].adoptedAt).toBe('2026-09-22T02:00:00.000Z');
  });
});

describe('输入指纹（第 8.2 节）', () => {
  it('标题变化不改变指纹；节点顺序与坐标变化改变指纹', () => {
    const { it, aId, pA } = setup();
    const fp1 = computeInputFingerprint(it);
    const renamed = updateNode({ ...it, title: '新标题' }, aId, it.nodes[aId]);
    expect(computeInputFingerprint(renamed)).toBe(fp1);

    const reordered = { ...it, nodeOrder: [...it.nodeOrder] };
    expect(computeInputFingerprint(reordered)).toBe(fp1); // 顺序未实际变化

    const moved = updatePlaceCoordinate(it, pA.id, { longitude: 116.401, latitude: 39.911 });
    expect(computeInputFingerprint(moved)).not.toBe(fp1);
  });
});

// ---------------------------------------------------------------------------
// Task 3 / R-B：歇脚点候选一键转休息点（事实来源可追溯）
// ---------------------------------------------------------------------------

/** 候选写入事实（来源可追溯：高德地图搜索＋候选 POI id＋获取/核对时间） */
function candidateFact<T>(value: T | null, overrides: Partial<Fact<T>> = {}): Fact<T> {
  return {
    value,
    sourceType: 'user',
    sourceName: '高德地图搜索',
    sourceReference: 'poi-rest-1',
    fetchedAt: '2026-09-22T05:00:00.000Z',
    reviewState: 'userChecked',
    checkedAt: '2026-09-22T05:10:00.000Z',
    applicableDate: null,
    note: '经你从地图候选确认，出发前请再核对',
    ...overrides,
  };
}

/** 样例：起点→景点A（挂歇脚点候选）→景点B；A→B 段有手动时间 */
function setupCandidate(facts: Record<string, Fact<unknown>>) {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pA = makePlace('示例景点A', 116.4, 39.91);
  const pB = makePlace('示例景点B', 116.402, 39.912);
  for (const p of [pO, pA, pB]) it = upsertPlace(it, p);
  it = setEndpoint(it, 'origin', pO.id);
  it = addVisitNode(it, pA.id, { visitSeconds: 30 * 60, insideWalkSeconds: 0 });
  const aId = it.nodeOrder[0];
  it = addVisitNode(it, pB.id, { visitSeconds: 20 * 60, insideWalkSeconds: 0 });
  const bId = it.nodeOrder[1];
  for (const [key, fact] of Object.entries(facts)) {
    it = upsertNodeFacilityFact(it, aId, 'rest-candidate', key, fact);
  }
  const legBetween = (from: string, to: string) =>
    Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
  const legOA = legBetween(it.origin!.id, aId);
  const legAB = legBetween(aId, bId);
  it = setManualLegTime(it, legOA.id, { walkingSeconds: 12 * 60 });
  it = setManualLegTime(it, legAB.id, { walkingSeconds: 10 * 60 });
  const facilityId = it.facilities.find((f) => f.kind === 'rest-candidate')!.id;
  return { it, oId: it.origin!.id, aId, bId, facilityId, legOA: legOA.id, legAB: legAB.id };
}

describe('歇脚点候选一键转休息点（Task 3 / R-B）', () => {
  it('在指定站点之后插入休息点并移除候选记录，受影响路段回到待补充', () => {
    const { it, oId, aId, bId, facilityId, legOA, legAB } = setupCandidate({
      name: candidateFact('长椅休息区'),
      seat: candidateFact(true),
    });
    const { itinerary: next, nodeId } = convertRestCandidateToRestNode(
      it,
      facilityId,
      aId,
      '2026-09-22T06:00:00.000Z',
    );
    expect(nodeId).not.toBeNull();
    // 顺序：插入在指定站点之后、下一站之前
    expect(next.nodeOrder).toEqual([aId, nodeId, bId]);
    expect(activeSequence(next)).toEqual([oId, aId, nodeId!, bId]);
    // 原 rest-candidate 设施记录移除（卡片候选提醒随之消失）
    expect(next.facilities.some((f) => f.id === facilityId)).toBe(false);
    // 新的两段受影响路段回待补充，不用旧时间顶替
    const legAR = Object.values(next.legs).find((l) => l.fromNodeId === aId && l.toNodeId === nodeId)!;
    const legRB = Object.values(next.legs).find((l) => l.fromNodeId === nodeId && l.toNodeId === bId)!;
    expect(legAR.state).toBe('missing');
    expect(legAR.effectiveWalkingSeconds).toBeNull();
    expect(legRB.state).toBe('missing');
    expect(legRB.effectiveWalkingSeconds).toBeNull();
    // 未受影响的上一段保留原值；旧 A→B 段不再被当前序列引用
    expect(next.legs[legOA].effectiveWalkingSeconds).toBe(12 * 60);
    const referenced = new Set(
      activeSequence(next).slice(1).map((id, i) => `${activeSequence(next)[i]}>${id}`),
    );
    expect(referenced.has(`${aId}>${bId}`)).toBe(false);
    expect(next.legs[legAB].effectiveWalkingSeconds).toBe(10 * 60); // 保留但不被引用
  });

  it('seat 事实整份迁移：来源与核对字段原样保留；无 seat 事实→unknownFact', () => {
    const seat = candidateFact<boolean>(true);
    const { it, aId, facilityId } = setupCandidate({ name: candidateFact('长椅休息区'), seat });
    const { itinerary: next, nodeId } = convertRestCandidateToRestNode(it, facilityId, aId);
    const node = next.nodes[nodeId!] as RestNode;
    // 整份 Fact 原样迁移，来源可追溯
    expect(node.seatFact).toEqual(seat);
    expect(node.seatFact.sourceName).toBe('高德地图搜索');
    expect(node.seatFact.sourceReference).toBe('poi-rest-1');
    expect(node.seatFact.checkedAt).toBe('2026-09-22T05:10:00.000Z');
    expect(node.seatFact.reviewState).toBe('userChecked');
    expect(node.seatFact.note).toBe('经你从地图候选确认，出发前请再核对');
    // 新休息点的其余字段口径：休息时长未知、无备注
    expect(node.restSeconds).toBeNull();
    expect(node.notes).toBe('');
    expect(node.skipped).toBe(false);

    // 无 seat 事实 → unknownFact（未知不等于没有）
    const bare = setupCandidate({ name: candidateFact('长椅休息区') });
    const res = convertRestCandidateToRestNode(bare.it, bare.facilityId, bare.aId);
    expect((res.itinerary.nodes[res.nodeId!] as RestNode).seatFact).toEqual(unknownFact<boolean>());
  });

  it('名称缺失→“未命名歇脚点”；候选事实带坐标则写入地点坐标，缺失→null 且入口未确认', () => {
    const noName = setupCandidate({ seat: candidateFact(true) });
    const r1 = convertRestCandidateToRestNode(noName.it, noName.facilityId, noName.aId);
    const place1 = r1.itinerary.places[(r1.itinerary.nodes[r1.nodeId!] as RestNode).placeId];
    expect(place1.name).toBe('未命名歇脚点');
    expect(place1.location).toBeNull();
    expect(place1.entranceConfirmed).toBe(false);
    expect(place1.openingDescription.value).toBeNull(); // 开放事实走 unknownFact
    expect(place1.openingSchedule.value).toBeNull();

    const withLoc = setupCandidate({
      name: candidateFact('长椅休息区'),
      location: candidateFact({ longitude: 116.401, latitude: 39.911 }),
    });
    const r2 = convertRestCandidateToRestNode(withLoc.it, withLoc.facilityId, withLoc.aId);
    const place2 = r2.itinerary.places[(r2.itinerary.nodes[r2.nodeId!] as RestNode).placeId];
    expect(place2.location).toEqual({ longitude: 116.401, latitude: 39.911 });
  });

  it('非 rest-candidate 设施记录或不存在的记录：不转换，行程原样返回', () => {
    const { it, aId, facilityId } = setupCandidate({ name: candidateFact('长椅休息区') });
    const withToilet = upsertNodeFacilityFact(it, aId, 'toilet', 'open', candidateFact('8:00-18:00'));
    const toiletId = withToilet.facilities.find((f) => f.kind === 'toilet')!.id;
    const wrongKind = convertRestCandidateToRestNode(withToilet, toiletId, aId);
    expect(wrongKind.nodeId).toBeNull();
    expect(wrongKind.itinerary).toBe(withToilet);
    const missing = convertRestCandidateToRestNode(withToilet, '不存在的设施记录', aId);
    expect(missing.nodeId).toBeNull();
    expect(missing.itinerary).toBe(withToilet);
    // 合法候选仍可转换
    expect(convertRestCandidateToRestNode(withToilet, facilityId, aId).nodeId).not.toBeNull();
  });

  it('转换出的休息点遵循既有跳过/恢复规则（资料保留）', () => {
    const { it, oId, aId, bId, facilityId } = setupCandidate({
      name: candidateFact('长椅休息区'),
      seat: candidateFact(true),
    });
    const { itinerary: next, nodeId } = convertRestCandidateToRestNode(it, facilityId, aId);
    const skipped = skipNode(next, nodeId!);
    expect(skipped.nodes[nodeId!].skipped).toBe(true);
    expect(activeSequence(skipped)).toEqual([oId, aId, bId]);
    // 资料保留：座位事实与来源仍在
    expect((skipped.nodes[nodeId!] as RestNode).seatFact.sourceName).toBe('高德地图搜索');
    const restored = restoreNode(skipped, nodeId!);
    expect(restored.nodes[nodeId!].skipped).toBe(false);
    expect(activeSequence(restored)).toEqual([oId, aId, nodeId!, bId]);
  });
});
