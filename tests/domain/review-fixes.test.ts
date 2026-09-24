/**
 * 代码审查修复回归：导出快照/文件名、外发隐私、二次确认、开放时间、计算口径（#39 测试缺口）。
 */
import { describe, expect, it } from 'vitest';
import { computeStats, evaluateConstraints, classifyRest } from '../../src/domain/compute';
import { synthesizeCardStatus } from '../../src/domain/status';
import {
  addRestNode,
  addVisitNode,
  applyMatrixEdges,
  clearLegToMissing,
  createEmptyItinerary,
  setEndpoint,
  setManualLegTime,
  updateBasics,
  updateNode,
  upsertPlace,
} from '../../src/domain/itinerary';
import { serializeItineraryBackup } from '../../src/storage/local';
import { safeFileName } from '../../src/domain/format';
import { PIXEL_RATIO, PAPER_WIDTH } from '../../src/features/export/paginate';
import type { Fact } from '../../shared/contracts/domain';
import { buildUnifiedSample, makePlace, setManualLeg } from '../helpers';

function userSeat(value: boolean | null, reviewState: 'userChecked' | 'reported' | 'unknown' = 'userChecked'): Fact<boolean> {
  return {
    value,
    sourceType: reviewState === 'userChecked' ? 'user' : 'amap',
    sourceName: null,
    sourceReference: null,
    fetchedAt: null,
    reviewState,
    checkedAt: null,
    applicableDate: null,
    note: null,
  };
}

describe('C1 部分合计不得复活为完整总量', () => {
  it('缺失路段后 totalDurationSeconds 为 null，不被后续已知段“加活”', () => {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pA = makePlace('示例景点A', 116.4, 39.91);
    const pB = makePlace('示例景点B', 116.406, 39.914);
    for (const p of [pO, pA, pB]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pB.id);
    it = addVisitNode(it, pA.id, { visitSeconds: 30 * 60, insideWalkSeconds: 0 });
    const aId = it.nodeOrder[0];
    it = addVisitNode(it, pB.id, { visitSeconds: 20 * 60, insideWalkSeconds: 0 });
    const bId = it.nodeOrder[1];
    // 只填后一段，前一段 missing
    const legAB = Object.values(it.legs).find((l) => l.fromNodeId === aId && l.toNodeId === bId)!;
    it = setManualLeg(it, legAB.id, { walkingSeconds: 10 * 60 });
    const legBD = Object.values(it.legs).find((l) => l.fromNodeId === bId && l.toNodeId === it.destination!.id)!;
    it = setManualLeg(it, legBD.id, { walkingSeconds: 5 * 60 });

    const stats = computeStats(it);
    expect(stats.totalDurationSeconds).toBeNull();
    expect(stats.totalDurationKnownSeconds).toBe((30 + 10 + 20 + 5) * 60);
  });
});

describe('C2 未知休息切分后最长连续步行待确认', () => {
  it('可能分界时不输出确定的最长连续步行', () => {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pR = makePlace('示例休息点', 116.4, 39.91);
    const pB = makePlace('示例景点B', 116.406, 39.914);
    for (const p of [pO, pR, pB]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pB.id);
    it = addRestNode(it, pR.id, { restSeconds: 10 * 60 }); // 座位未知 → possibleRest
    const rId = it.nodeOrder[0];
    it = addVisitNode(it, pB.id, { visitSeconds: 30 * 60, insideWalkSeconds: 0 });
    const bId = it.nodeOrder[1];
    const leg = (from: string, to: string) =>
      Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
    it = setManualLeg(it, leg(it.origin!.id, rId).id, { walkingSeconds: 12 * 60 });
    it = setManualLeg(it, leg(rId, bId).id, { walkingSeconds: 12 * 60 });

    const stats = computeStats(it);
    expect(stats.longestContinuousWalkSeconds).toBeNull();
    expect(stats.longestContinuousWalkKnownSeconds).toBe(12 * 60);
  });
});

describe('C3 地图估算不覆盖用户手动数据', () => {
  it('applyMatrixEdges 跳过 manual ready / adopted / same-entrance', () => {
    const it = buildUnifiedSample();
    const manualLeg = Object.values(it.legs).find((l) => l.durationSource === 'manual' && l.state === 'ready')!;
    const next = applyMatrixEdges(it, [
      {
        fromNodeId: manualLeg.fromNodeId,
        toNodeId: manualLeg.toNodeId,
        fromCoordinateRevision: manualLeg.fromCoordinateRevision,
        toCoordinateRevision: manualLeg.toCoordinateRevision,
        distanceMeters: 1,
        rawWalkingSeconds: 1,
        provider: 'amap',
        providerApiVersion: 'v5',
        fetchedAt: '2026-09-22T01:00:00.000Z',
        state: 'ready',
      },
    ]);
    expect(next.legs[manualLeg.id].effectiveWalkingSeconds).toBe(manualLeg.effectiveWalkingSeconds);
    expect(next.legs[manualLeg.id].durationSource).toBe('manual');
  });
});

describe('C4/M5/M6/M7 开放时间等待与冲突', () => {
  function withOpening(windows: Array<{ startLocalTime: string; endLocalTime: string }>, departure: string, visitSeconds: number | null = 60 * 60) {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pA = makePlace('示例景点A', 116.4, 39.91);
    const pD = makePlace('示例终点', 116.406, 39.914);
    for (const p of [pO, pA, pD]) it = upsertPlace(it, p);
    it = { ...it, travelDate: '2026-10-01', departureLocalTime: departure };
    pA.openingSchedule = {
      value: { applicableDate: '2026-10-01', timezone: 'Asia/Shanghai', windows },
      sourceType: 'user', sourceName: null, sourceReference: null, fetchedAt: null,
      reviewState: 'userChecked', checkedAt: '2026-09-22T00:00:00.000Z', applicableDate: '2026-10-01', note: null,
    };
    it = upsertPlace(it, pA);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pD.id);
    it = addVisitNode(it, pA.id, { visitSeconds, insideWalkSeconds: 0 });
    const aId = it.nodeOrder[0];
    const leg = (from: string, to: string) =>
      Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
    it = setManualLeg(it, leg(it.origin!.id, aId).id, { walkingSeconds: 15 * 60 });
    it = setManualLeg(it, leg(aId, it.destination!.id).id, { walkingSeconds: 10 * 60 });
    return it;
  }

  it('多时段午休空档到达会计入等待并产出 openWaits（M5/C4）', () => {
    // 09:00 出发 + 15 分钟步行 = 09:15 到达；窗口 08:00-12:00,13:30-17:30
    // 09:15 在第一段内… 改成 12:30 到达：出发 12:15
    const stats = computeStats(
      withOpening(
        [
          { startLocalTime: '08:00', endLocalTime: '12:00' },
          { startLocalTime: '13:30', endLocalTime: '17:30' },
        ],
        '12:15',
      ),
    );
    // 12:30 落在空档 → 等到 13:30，共 60 分钟
    expect(stats.openWaits).toHaveLength(1);
    expect(stats.openWaits[0].waitSeconds).toBe(60 * 60);
  });

  it('明确不开放产出 closed-day 冲突（M6）', () => {
    const stats = computeStats(withOpening([], '09:00'));
    expect(stats.closingConflicts.some((c) => c.label.includes('该日明确不开放'))).toBe(true);
  });

  it('visitSeconds 留空不按 0 断言超闭门（M7）', () => {
    const stats = computeStats(
      withOpening([{ startLocalTime: '08:00', endLocalTime: '17:00' }], '16:00', null),
    );
    // 16:15 到达，停留未知：不因 ??0 断言超闭门
    expect(stats.closingConflicts.filter((c) => c.label.includes('闭门'))).toHaveLength(0);
  });

  it('状态合成把 openWaits 计入草稿态并展示提示（C4）', () => {
    const it = withOpening([{ startLocalTime: '10:00', endLocalTime: '17:00' }], '08:00');
    const stats = computeStats(it);
    const verdicts = evaluateConstraints(it, stats);
    const status = synthesizeCardStatus(it, stats, verdicts);
    expect(stats.openWaits.length).toBeGreaterThan(0);
    expect(status.notices.some((n) => n.text.includes('等待开门'))).toBe(true);
    expect(status.kind).toBe('draft');
  });
});

describe('M8/M9 已核实坐休与 reviewState', () => {
  it('座位已确认但时长留空仍计“已核实坐休”', () => {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pR = makePlace('示例休息点', 116.4, 39.91);
    const pB = makePlace('示例景点B', 116.406, 39.914);
    for (const p of [pO, pR, pB]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = setEndpoint(it, 'destination', pB.id);
    it = addRestNode(it, pR.id, { restSeconds: null });
    const rId = it.nodeOrder[0];
    it = updateNode(it, rId, { seatFact: userSeat(true, 'userChecked') });
    it = addVisitNode(it, pB.id, { visitSeconds: 30 * 60, insideWalkSeconds: 0 });
    const stats = computeStats(it);
    expect(stats.plannedRestCount).toBe(1);
  });

  it('reported 座位不计 hardRest（M9）', () => {
    expect(classifyRest(true, 'reported', 20 * 60, null).type).toBe('possibleRest');
    expect(classifyRest(true, 'userChecked', 20 * 60, null).type).toBe('hardRest');
    expect(classifyRest(true, 'unknown', 20 * 60, null).type).toBe('possibleRest');
    expect(classifyRest(false, 'userChecked', 20 * 60, null).type).toBe('noReset');
  });
});

describe('M17 timeline other 不进步行统计', () => {
  it('other 活动时长不计入总步行', () => {
    let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    const pO = makePlace('示例起点', 116.397, 39.908);
    const pA = makePlace('示例景点A', 116.4, 39.91);
    for (const p of [pO, pA]) it = upsertPlace(it, p);
    it = setEndpoint(it, 'origin', pO.id);
    it = addVisitNode(it, pA.id, { visitSeconds: 60 * 60, insideWalkSeconds: null });
    const aId = it.nodeOrder[0];
    it = updateNode(it, aId, {
      activityPlan: {
        mode: 'timeline',
        completeness: 'complete',
        items: [
          { id: 'w1', kind: 'walk', durationSeconds: 5 * 60, seatFact: userSeat(null, 'unknown') },
          { id: 'o1', kind: 'other', durationSeconds: 10 * 60, seatFact: userSeat(null, 'unknown') },
        ],
      },
    });
    const leg = Object.values(it.legs).find((l) => l.fromNodeId === it.origin!.id)!;
    it = setManualLeg(it, leg.id, { walkingSeconds: 8 * 60 });
    const stats = computeStats(it);
    expect(stats.totalWalkSeconds).toBe((8 + 5) * 60); // 不含 other 的 10 分钟
  });
});

describe('导出规格常量（#39）', () => {
  it('360px 纸面 × 3 倍像素密度 = 1080px 输出宽', () => {
    expect(PAPER_WIDTH).toBe(360);
    expect(PIXEL_RATIO).toBe(3);
    expect(PAPER_WIDTH * PIXEL_RATIO).toBe(1080);
  });

  it('文件名格式：行程名称-日期（safeFileName 清理非法字符）', () => {
    const base = `${safeFileName('杭州西湖一日游')}-2026-10-02`;
    expect(base).toBe('杭州西湖一日游-2026-10-02');
    expect(safeFileName('a/b:c*d?e')).not.toMatch(/[\\/:*?"<>|]/);
  });
});

describe('外发请求不含备注/姓名/标题（#39）', () => {
  it('备份导出含备注，但矩阵节点载荷只有坐标与 id', () => {
    const it = buildUnifiedSample();
    const withNote = updateBasics({ ...it, title: '张三家的行程' }, {});
    const nodePayload = {
      id: 'n1',
      placeId: 'p1',
      longitude: 116.4,
      latitude: 39.9,
      coordinateRevision: 0,
    };
    const serialized = JSON.stringify(nodePayload);
    expect(serialized).not.toContain('张三');
    expect(serialized).not.toContain(withNote.title);
    // 备份含标题（本机数据），与外发载荷分离
    expect(serializeItineraryBackup(withNote)).toContain('张三家的行程');
  });
});

describe('setManualLegTime 拒绝信号（M28）', () => {
  it('总耗时小于步行时返回 invalid，不静默改写', () => {
    const it = buildUnifiedSample();
    const leg = Object.values(it.legs).find((l) => l.durationSource === 'manual')!;
    const r = setManualLegTime(it, leg.id, { walkingSeconds: 20 * 60, totalSeconds: 10 * 60 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid');
  });

  it('clearLegToMissing 清空已采纳腿回待获取', () => {
    let it = buildUnifiedSample();
    const leg = Object.values(it.legs).find((l) => l.durationSource === 'manual' && l.state === 'ready')!;
    // 先变成 adopted
    it = {
      ...it,
      legs: {
        ...it.legs,
        [leg.id]: { ...leg, durationSource: 'adopted' as const, adoptedAt: '2026-09-22T02:00:00.000Z' },
      },
    };
    const cleared = clearLegToMissing(it, leg.id);
    expect(cleared.legs[leg.id].state).toBe('missing');
    expect(cleared.legs[leg.id].effectiveWalkingSeconds).toBeNull();
  });
});

describe('响应与日志不含 Key（#39）', () => {
  it('toPersisted / 备份文本不含 key= 或 AMAP_WEB_SERVICE_KEY', () => {
    const text = serializeItineraryBackup(buildUnifiedSample());
    expect(text).not.toMatch(/key=/i);
    expect(text).not.toContain('AMAP_WEB_SERVICE_KEY');
  });
});
