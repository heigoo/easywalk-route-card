/**
 * CardViewModel 构建（第 10.2 节；验证用例 T01/T02/T15 的卡片侧口径）。
 */
import { describe, expect, it } from 'vitest';
import { computeStats, evaluateConstraints } from '../../src/domain/compute';
import { synthesizeCardStatus } from '../../src/domain/status';
import { updateNode } from '../../src/domain/itinerary';
import { buildCardViewModel } from '../../src/features/route-card/buildViewModel';
import { buildUnifiedSample } from '../helpers';
import { SAMPLE } from '../helpers';

function vmFor(it: ReturnType<typeof buildUnifiedSample>) {
  const stats = computeStats(it);
  const verdicts = evaluateConstraints(it, stats);
  const status = synthesizeCardStatus(it, stats, verdicts);
  return buildCardViewModel({ itinerary: it, stats, verdicts, status, now: '2026-09-22T04:00:00.000Z' });
}

describe('CardViewModel（第 10.2 节）', () => {
  it('统一样例：摘要 43/100/28/1，状态 complete，块顺序 header→summary→node…→source', () => {
    const vm = vmFor(buildUnifiedSample());
    // 样例未命名 → 使用“未命名行程”兜底（第 4.2 节）
    expect(vm.meta.titleText).toBe('未命名行程');
    expect(vm.status.kind).toBe('complete');

    const summary = vm.blocks.find((b) => b.kind === 'summary');
    expect(summary).toBeDefined();
    if (summary?.kind === 'summary') {
      const byKey = Object.fromEntries(summary.items.map((i) => [i.key, i]));
      expect(byKey.totalWalk.valueText).toBe('43');
      expect(byKey.totalWalk.unitText).toBe('分钟');
      expect(byKey.totalDuration.valueText).toBe('100');
      expect(byKey.longestWalk.valueText).toBe('28');
      expect(byKey.restCount.valueText).toBe('1');
      expect(byKey.totalWalk.state).toBe('known');
    }

    const kinds = vm.blocks.map((b) => b.kind);
    expect(kinds[0]).toBe('header');
    expect(kinds[1]).toBe('summary');
    expect(kinds[kinds.length - 1]).toBe('source');
    // 来源块整张卡只出现一次
    expect(kinds.filter((k) => k === 'source')).toHaveLength(1);

    // 节点编号：仅景点有 indexText
    const nodes = vm.blocks.filter((b) => b.kind === 'node');
    const visits = nodes.filter((n) => n.kind === 'node' && (n as { role?: string }).role === 'visit');
    expect(visits.map((v) => (v as { indexText?: string }).indexText)).toEqual(['1', '2']);
  });

  it('缺 A 园内步行：状态 draft，摘要注明已知 35 分钟＋1 项待补充', () => {
    const it = buildUnifiedSample();
    const aId = it.nodeOrder[0];
    const vm = vmFor(updateNode(it, aId, { insideWalkSeconds: null }));
    expect(vm.status.kind).toBe('draft');
    const summary = vm.blocks.find((b) => b.kind === 'summary');
    if (summary?.kind === 'summary') {
      const totalWalk = summary.items.find((i) => i.key === 'totalWalk');
      expect(totalWalk?.state).toBe('partial');
      expect(totalWalk?.noteText).toContain('另有 1 项待补充');
    }
  });

  it('无有效景点：blocked，来源块仍保留', () => {
    const it = buildUnifiedSample();
    const allSkipped = {
      ...it,
      nodeOrder: it.nodeOrder.map((id) => id),
      nodes: Object.fromEntries(Object.entries(it.nodes).map(([k, n]) => [k, { ...n, skipped: true }])),
    };
    const vm = vmFor(allSkipped as ReturnType<typeof buildUnifiedSample>);
    expect(vm.status.kind).toBe('blocked');
    expect(vm.blocks.some((b) => b.kind === 'source')).toBe(true);
  });

  it('空标题使用“未命名行程”；日期为空不显示精确到达', () => {
    const it = { ...buildUnifiedSample(), title: '  ', travelDate: null, departureLocalTime: null };
    const vm = vmFor(it as ReturnType<typeof buildUnifiedSample>);
    expect(vm.meta.titleText).toBe('未命名行程');
    expect(vm.meta.dateText).toBeNull();
  });

  it('已知超限时状态 violated，且 node 与 leg 块齐全', () => {
    const it = buildUnifiedSample();
    it.constraints.maxContinuousWalkSeconds = 20 * 60;
    const vm = vmFor(it);
    expect(vm.status.kind).toBe('violated');
    expect(vm.blocks.some((b) => b.kind === 'leg')).toBe(true);
    expect(SAMPLE.totalWalk).toBe(43 * 60);
  });
});
