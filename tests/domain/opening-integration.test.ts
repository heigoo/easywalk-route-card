/**
 * 开放时间进入计算链路的集成验证（R-A2）：
 * 保守解析文本 → 写入 user/userChecked 的 openingSchedule → computeStats 既有链路生效：
 * 等待开门计入总用时、超过闭门时间给出闭门冲突提醒（不改 compute 口径）。
 */
import { describe, expect, it } from 'vitest';
import { computeStats, evaluateConstraints } from '../../src/domain/compute';
import { synthesizeCardStatus } from '../../src/domain/status';
import {
  addVisitNode,
  createEmptyItinerary,
  setEndpoint,
  upsertPlace,
} from '../../src/domain/itinerary';
import { openingScheduleFromText } from '../../src/domain/opening';
import type { Itinerary } from '../../shared/contracts/domain';
import { makePlace, setManualLeg } from '../helpers';

const TRAVEL_DATE = '2026-10-01';

/** 起点→景点A→终点；A 的开放时段由文本保守解析后按“写入并标记核对”写入 */
function withOpening(openText: string, departure: string, visitSeconds: number): Itinerary {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pA = makePlace('示例景点A', 116.4, 39.91);
  const pD = makePlace('示例终点', 116.406, 39.914);
  it = { ...it, travelDate: TRAVEL_DATE, departureLocalTime: departure };

  const schedule = openingScheduleFromText(openText, TRAVEL_DATE, 'Asia/Shanghai');
  expect(schedule).not.toBeNull();
  // 模拟 NodeEditDialog“写入并标记核对”产出的 user/userChecked 事实（自动解析标记）
  pA.openingSchedule = {
    value: schedule!,
    sourceType: 'user',
    sourceName: '高德地图搜索',
    sourceReference: null,
    fetchedAt: '2026-09-22T00:00:00.000Z',
    reviewState: 'userChecked',
    checkedAt: '2026-09-22T00:00:00.000Z',
    applicableDate: TRAVEL_DATE,
    note: '自动解析自地图文本，请核对',
  };
  for (const p of [pO, pA, pD]) it = upsertPlace(it, p);
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

describe('开放时间进入计算链路（R-A2 集成）', () => {
  it('到达早于开门：等待时间计入 totalDurationSeconds', () => {
    // 08:00 出发、15 分钟走到 → 08:15 到达，08:30 开门：等待 15 分钟
    const it = withOpening('每日 08:30-17:00', '08:00', 60 * 60);
    const stats = computeStats(it);
    // 15 步行 + 15 等待开门 + 60 停留 + 10 步行 = 100 分钟
    expect(stats.totalDurationSeconds).toBe(100 * 60);
    expect(stats.totalDurationKnownSeconds).toBe(100 * 60);
    expect(stats.closingConflicts).toHaveLength(0);
  });

  it('分日文本按出游日求值（周一至周五覆盖 2026-10-01 周四）：等待开门同样计入总用时', () => {
    const it = withOpening('周一至周五 08:30-17:00', '08:00', 60 * 60);
    const stats = computeStats(it);
    // 15 步行 + 15 等待开门 + 60 停留 + 10 步行 = 100 分钟
    expect(stats.totalDurationSeconds).toBe(100 * 60);
  });

  it('到达已开门：不产生等待', () => {
    const it = withOpening('每日 08:30-17:00', '09:00', 60 * 60);
    const stats = computeStats(it);
    // 15 步行 + 60 停留 + 10 步行 = 85 分钟
    expect(stats.totalDurationSeconds).toBe(85 * 60);
  });

  it('离开晚于闭门：产生闭门冲突并进入状态提醒', () => {
    // 08:00 出发 08:15 到达，停留 60 分钟至 09:15，09:00 闭门
    const it = withOpening('每日 08:00-09:00', '08:00', 60 * 60);
    const stats = computeStats(it);
    expect(stats.closingConflicts).toHaveLength(1);
    expect(stats.closingConflicts[0].label).toContain('可能超过闭门时间');

    const status = synthesizeCardStatus(it, stats, evaluateConstraints(it, stats));
    expect(status.kind).toBe('draft');
    expect(
      status.notices.some((n) => n.severity === 'warning' && n.text.includes('可能超过闭门时间')),
    ).toBe(true);
  });
});
