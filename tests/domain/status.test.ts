/**
 * 卡片状态合成（第 5.4 节）：blocked / violated / draft / complete。
 */
import { describe, expect, it } from 'vitest';
import { computeStats, evaluateConstraints } from '../../src/domain/compute';
import { synthesizeCardStatus } from '../../src/domain/status';
import {
  addVisitNode,
  createEmptyItinerary,
  setEndpoint,
  setManualLegTime,
  updateConstraints,
  updateNode,
  upsertPlace,
} from '../../src/domain/itinerary';
import { makePlace } from '../helpers';

function base() {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pB = makePlace('示例景点B', 116.406, 39.914);
  for (const p of [pO, pB]) it = upsertPlace(it, p);
  it = setEndpoint(it, 'origin', pO.id);
  it = setEndpoint(it, 'destination', pB.id);
  it = addVisitNode(it, pB.id, { visitSeconds: 30 * 60, insideWalkSeconds: 5 * 60 });
  const bId = it.nodeOrder[0];
  const leg = Object.values(it.legs).find((l) => l.fromNodeId === it.origin!.id && l.toNodeId === bId)!;
  it = setManualLegTime(it, leg.id, { walkingSeconds: 10 * 60 });
  return it;
}

function statusOf(it: ReturnType<typeof base>) {
  const stats = computeStats(it);
  return synthesizeCardStatus(it, stats, evaluateConstraints(it, stats));
}

describe('卡片状态合成', () => {
  it('没有有效景点 → blocked', () => {
    const it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
    expect(statusOf(it).kind).toBe('blocked');
  });

  it('园内步行大于停留 → blocked（结构性无效）', () => {
    const it = base();
    const bId = it.nodeOrder[0];
    const bad = updateNode(it, bId, { insideWalkSeconds: 40 * 60 });
    expect(statusOf(bad).kind).toBe('blocked');
  });

  it('已知超限 → violated，且保留具体提示', () => {
    const it = updateConstraints(base(), { maxTotalWalkSeconds: 5 * 60 });
    const status = statusOf(it);
    expect(status.kind).toBe('violated');
    expect(status.notices.some((n) => n.text.includes('超过你设置的上限'))).toBe(true);
  });

  it('数据缺失 → draft，提示已知部分与待补充项', () => {
    const it = base();
    const bId = it.nodeOrder[0];
    const missing = updateNode(it, bId, { insideWalkSeconds: null });
    const status = statusOf(missing);
    expect(status.kind).toBe('draft');
    expect(status.notices.some((n) => n.text.includes('待补充'))).toBe(true);
  });

  it('数据完整且无已知冲突 → complete', () => {
    expect(statusOf(base()).kind).toBe('complete');
  });
});
