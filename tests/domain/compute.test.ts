﻿/**
 * 统一样例与可信状态计算口径（验证用例 T01～T04，对应需求 10.3、R04）。
 */
import { describe, expect, it } from 'vitest';
import { computeStats, evaluateConstraints } from '../../src/domain/compute';
import {
  addRestNode,
  addVisitNode,
  applyWalkingFactor,
  createEmptyItinerary,
  setEndpoint,
  setManualLegTime,
  skipNode,
  updateNode,
  upsertPlace,
} from '../../src/domain/itinerary';
import { buildUnifiedSample, makePlace, SAMPLE } from '../helpers';

describe('统一样例（T01）', () => {
  it('总步行 43 分钟、全程 100 分钟、最长连续 28 分钟', () => {
    const it = buildUnifiedSample();
    const stats = computeStats(it);
    expect(stats.totalWalkSeconds).toBe(SAMPLE.totalWalk);
    expect(stats.totalDurationSeconds).toBe(SAMPLE.totalDuration);
    expect(stats.longestContinuousWalkSeconds).toBe(SAMPLE.longest);
    expect(stats.plannedRestCount).toBe(1);
    expect(stats.missingFields).toHaveLength(0);
  });

  it('同一入口零衔接边不计步行、不请求地图', () => {
    const it = buildUnifiedSample();
    const zero = Object.values(it.legs).find((l) => l.durationSource === 'same-entrance');
    expect(zero).toBeDefined();
    expect(zero!.effectiveWalkingSeconds).toBe(0);
  });

  it('连续步行上限 20 分钟时不得判为满足（T01 附加）', () => {
    const it = buildUnifiedSample();
    it.constraints.maxContinuousWalkSeconds = 20 * 60;
    const verdicts = evaluateConstraints(it, computeStats(it));
    expect(verdicts.continuousWalk).toBe('FAIL');
  });
});

describe('缺失数据与下界（T02）', () => {
  it('删除 A 园内步行：显示已知 35 分钟＋1 项待补充，连续步行待确认', () => {
    const it = buildUnifiedSample();
    const aId = it.nodeOrder[0];
    const next = updateNode(it, aId, { insideWalkSeconds: null });
    const stats = computeStats(next);
    expect(stats.totalWalkSeconds).toBeNull();
    expect(stats.totalWalkKnownSeconds).toBe(SAMPLE.knownWithoutAInside);
    expect(stats.missingFields).toHaveLength(1);
    expect(stats.longestContinuousWalkSeconds).toBeNull();
  });
});

describe('未知休息与连续步行（T03）', () => {
  it('未知是否可坐的休息按“可能分界”切分下界，不错误断言确定超限', () => {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pR = makePlace('示例休息点', 116.4, 39.91);
    const pB = makePlace('示例景点B', 116.406, 39.914);
    for (const p of [pO, pR, pB]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pB.id);
    it = addRestNode(it, pR.id, { restSeconds: 10 * 60 }); // seatFact 未知
    const rId = it.nodeOrder[0];
    it = addVisitNode(it, pB.id, { visitSeconds: 30 * 60, insideWalkSeconds: null });
    const bId = it.nodeOrder[1];

    const leg = (from: string, to: string) =>
      Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
    it = setManualLegTime(it, leg(it.origin!.id, rId).id, { walkingSeconds: 12 * 60 });
    it = setManualLegTime(it, leg(rId, bId).id, { walkingSeconds: 12 * 60 });
    it.constraints.maxContinuousWalkSeconds = 20 * 60;

    const stats = computeStats(it);
    const verdicts = evaluateConstraints(it, stats);
    // 若前后相加为 24 分钟会误判 FAIL；正确口径是下界 12 分钟且结论 UNKNOWN
    expect(stats.longestContinuousWalkKnownSeconds).toBe(12 * 60);
    expect(verdicts.continuousWalk).not.toBe('FAIL');
  });

  it('已确认可坐但低于最低休息时长的休息：不作为确定分界', () => {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pR = makePlace('示例休息点', 116.4, 39.91);
    const pB = makePlace('示例景点B', 116.406, 39.914);
    for (const p of [pO, pR, pB]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pB.id);
    it = addRestNode(it, pR.id, { restSeconds: 5 * 60 });
    const rId = it.nodeOrder[0];
    it = updateNode(it, rId, {
      seatFact: {
        value: true, sourceType: 'user', sourceName: null, sourceReference: null,
        fetchedAt: null, reviewState: 'userChecked', checkedAt: null, applicableDate: null, note: null,
      },
    });
    it = addVisitNode(it, pB.id, { visitSeconds: 30 * 60, insideWalkSeconds: null });
    const bId = it.nodeOrder[1];
    const leg = (from: string, to: string) =>
      Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
    it = setManualLegTime(it, leg(it.origin!.id, rId).id, { walkingSeconds: 12 * 60 });
    it = setManualLegTime(it, leg(rId, bId).id, { walkingSeconds: 12 * 60 });
    it.constraints.minRestSeconds = 10 * 60;
    it.constraints.maxContinuousWalkSeconds = 20 * 60;

    const verdicts = evaluateConstraints(it, computeStats(it));
    expect(verdicts.continuousWalk).not.toBe('FAIL');
  });
});

describe('已知下界超限（T04）', () => {
  it('已知下界超过上限且另有未知项时仍提示确定冲突', () => {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pB = makePlace('示例景点B', 116.406, 39.914);
    for (const p of [pO, pB]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pB.id);
    it = addVisitNode(it, pB.id, { visitSeconds: 30 * 60, insideWalkSeconds: null }); // 未知园内步行
    const bId = it.nodeOrder[0];
    const leg = Object.values(it.legs).find((l) => l.fromNodeId === it.origin!.id && l.toNodeId === bId)!;
    it = setManualLegTime(it, leg.id, { walkingSeconds: 35 * 60 });
    it.constraints.maxTotalWalkSeconds = 30 * 60;

    const stats = computeStats(it);
    const verdicts = evaluateConstraints(it, stats);
    expect(stats.totalWalkSeconds).toBeNull(); // 完整值未知
    expect(stats.totalWalkKnownSeconds).toBe(35 * 60);
    expect(verdicts.totalWalk).toBe('FAIL');
  });
});

describe('步速因子（T07 相关）', () => {
  it('手动时间不乘因子；地图原始值不被覆盖', () => {
    const it = buildUnifiedSample();
    const aId = it.nodeOrder[0];
    const rId = it.nodeOrder[1];
    const leg = Object.values(it.legs).find((l) => l.fromNodeId === aId && l.toNodeId === rId)!;
    expect(leg.durationSource).toBe('manual');
    const withFactor = applyWalkingFactor(it, 1.5);
    const leg2 = withFactor.legs[leg.id];
    expect(leg2.effectiveWalkingSeconds).toBe(SAMPLE.aToRest); // 手动值不变
    expect(withFactor.constraints.walkingFactor).toBe(1.5);
  });
});

describe('开放时间等待（第 5.1 节，东八区口径）', () => {
  function withOpening(departure: string) {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pA = makePlace('示例景点A', 116.4, 39.91);
    const pD = makePlace('示例终点', 116.406, 39.914);
    for (const p of [pO, pA, pD]) it = upsertPlace(it, p);
    it = { ...it, travelDate: '2026-10-01', departureLocalTime: departure };
    pA.openingSchedule = {
      value: { applicableDate: '2026-10-01', timezone: 'Asia/Shanghai', windows: [{ startLocalTime: '08:30', endLocalTime: '17:00' }] },
      sourceType: 'user', sourceName: null, sourceReference: null, fetchedAt: null,
      reviewState: 'userChecked', checkedAt: '2026-09-22T00:00:00.000Z', applicableDate: '2026-10-01', note: null,
    };
    it = upsertPlace(it, pA);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pD.id);
    it = addVisitNode(it, pA.id, { visitSeconds: 60 * 60, insideWalkSeconds: 0 });
    const aId = it.nodeOrder[0];
    const leg = Object.values(it.legs).find((l) => l.fromNodeId === it.origin!.id && l.toNodeId === aId)!;
    it = setManualLegTime(it, leg.id, { walkingSeconds: 15 * 60 });
    const leg2 = Object.values(it.legs).find((l) => l.fromNodeId === aId && l.toNodeId === it.destination!.id)!;
    it = setManualLegTime(it, leg2.id, { walkingSeconds: 10 * 60 });
    return it;
  }

  it('9:00 到达已开放景点：无等待', () => {
    const stats = computeStats(withOpening('09:00'));
    // 15+10 分钟步行 + 60 分钟停留 = 85 分钟
    expect(stats.totalDurationSeconds).toBe(85 * 60);
  });

  it('8:00 出发 15 分钟走到：等待开门 15 分钟计入总用时', () => {
    const stats = computeStats(withOpening('08:00'));
    // 15 步行 + 15 等待 + 60 停留 + 10 步行 = 100 分钟
    expect(stats.totalDurationSeconds).toBe(100 * 60);
  });
});

describe('跳站（T05）', () => {
  it('跳过中间节点后不能用原两段相加作为新直达时间', () => {
    // 构造 起点→C→A，仅填写 O→C 与 C→A 两段；跳过 C 后 O→A 是全新路段
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pC = makePlace('示例景点C', 116.401, 39.911);
    const pA = makePlace('示例景点A', 116.400, 39.910);
    const pD = makePlace('示例终点', 116.406, 39.914);
    for (const p of [pO, pC, pA, pD]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pD.id);
    it = addVisitNode(it, pC.id, { required: false, visitSeconds: 20 * 60, insideWalkSeconds: 0 });
    const cId = it.nodeOrder[0];
    it = addVisitNode(it, pA.id, { required: true, visitSeconds: 30 * 60, insideWalkSeconds: 0 });
    const aId = it.nodeOrder[1];

    const leg = (from: string, to: string) =>
      Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
    it = setManualLegTime(it, leg(it.origin!.id, cId).id, { walkingSeconds: 10 * 60 });
    it = setManualLegTime(it, leg(cId, aId).id, { walkingSeconds: 10 * 60 });
    it = setManualLegTime(it, leg(aId, it.destination!.id).id, { walkingSeconds: 5 * 60 });
    expect(computeStats(it).totalWalkSeconds).toBe(25 * 60); // 跳站前合计完整

    const skipped = skipNode(it, cId);
    const newLeg = Object.values(skipped.legs).find(
      (l) => l.fromNodeId === skipped.origin!.id && l.toNodeId === aId,
    );
    expect(newLeg).toBeDefined();
    expect(newLeg!.state).toBe('missing'); // 新直达段回到待获取
    expect(newLeg!.effectiveWalkingSeconds).toBeNull();
    const stats = computeStats(skipped);
    expect(stats.totalWalkSeconds).toBeNull(); // 旧合计不冒充新结果
    expect(stats.totalWalkKnownSeconds).toBe(5 * 60); // 仅仍有效的 A→终点 段计入已知
  });
});
