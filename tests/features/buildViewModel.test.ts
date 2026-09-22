/**
 * CardViewModel 构建（第 10.2 节；验证用例 T01/T02/T15 的卡片侧口径）。
 * 含开放时间提醒三态文案（R-A2）。
 */
import { describe, expect, it } from 'vitest';
import type { Fact, OpeningSchedule, PlaceRef } from '../../shared/contracts/domain';
import { unknownFact } from '../../shared/contracts/domain';
import { computeStats, evaluateConstraints } from '../../src/domain/compute';
import { synthesizeCardStatus } from '../../src/domain/status';
import { updateNode } from '../../src/domain/itinerary';
import { buildCardViewModel } from '../../src/features/route-card/buildViewModel';
import type { NodeBlock } from '../../src/features/route-card/viewModel';
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

// ---------------------------------------------------------------------------
// R-A2：开放时间提醒三态文案
// ---------------------------------------------------------------------------

function scheduleFact(value: OpeningSchedule | null, note: string | null): Fact<OpeningSchedule> {
  return {
    value,
    sourceType: 'user',
    sourceName: null,
    sourceReference: null,
    fetchedAt: null,
    reviewState: 'userChecked',
    checkedAt: '2026-09-22T00:00:00.000Z',
    applicableDate: '2026-10-01',
    note,
  };
}

/** 替换示例景点A的开放事实后构建视图模型，并取该节点的提醒文本 */
function openingNotices(mutate: (place: PlaceRef) => PlaceRef): string[] {
  const base = buildUnifiedSample();
  const aId = base.nodeOrder[0];
  const placeId = base.nodes[aId].placeId;
  const it = { ...base, places: { ...base.places, [placeId]: mutate(base.places[placeId]) } };
  const vm = vmFor(it);
  const node = vm.blocks.find((b): b is NodeBlock => b.kind === 'node' && b.titleText === '示例景点A');
  return (node?.notices ?? []).map((n) => n.text);
}

describe('开放时间提醒三态（R-A2）', () => {
  const schedule: OpeningSchedule = {
    applicableDate: '2026-10-01',
    timezone: 'Asia/Shanghai',
    windows: [{ startLocalTime: '08:00', endLocalTime: '18:30' }],
  };

  it('reported/amap 来源：地图参考（待核对）＋原文', () => {
    const texts = openingNotices((p) => ({
      ...p,
      openingDescription: {
        value: '每日 08:00-18:30',
        sourceType: 'amap',
        sourceName: '高德地图搜索',
        sourceReference: null,
        fetchedAt: '2026-09-22T00:00:00.000Z',
        reviewState: 'reported',
        checkedAt: null,
        applicableDate: null,
        note: '地图参考，待核对，不代表此刻开放',
      },
    }));
    expect(texts).toContain('开放时间（地图参考，待核对）：每日 08:00-18:30');
  });

  it('自动解析（note 含“自动解析”）：自动解析自地图文本，请核对＋HH:mm-HH:mm', () => {
    const texts = openingNotices((p) => ({
      ...p,
      openingSchedule: scheduleFact(schedule, '自动解析自地图文本，请核对'),
    }));
    expect(texts).toContain('开放时间（自动解析自地图文本，请核对）：08:00-18:30');
  });

  it('userChecked 手动时段：你已核对＋HH:mm-HH:mm', () => {
    const texts = openingNotices((p) => ({
      ...p,
      openingSchedule: scheduleFact(schedule, '手动填写'),
    }));
    expect(texts).toContain('开放时间（你已核对）：08:00-18:30');
  });

  it('userChecked 当天不开放（空窗口）也有明确文案', () => {
    const texts = openingNotices((p) => ({
      ...p,
      openingSchedule: scheduleFact({ ...schedule, windows: [] }, '手动填写'),
    }));
    expect(texts).toContain('开放时间（你已核对）：当天不开放');
  });

  it('userChecked 仅说明文本：你已核对＋原文', () => {
    const texts = openingNotices((p) => ({
      ...p,
      openingDescription: {
        value: '周一闭馆',
        sourceType: 'user',
        sourceName: null,
        sourceReference: null,
        fetchedAt: null,
        reviewState: 'userChecked',
        checkedAt: '2026-09-22T00:00:00.000Z',
        applicableDate: '2026-10-01',
        note: '手动填写',
      },
    }));
    expect(texts).toContain('开放时间（你已核对）：周一闭馆');
  });

  it('无值：只显示“待确认”，不显示看似完整的开放结论', () => {
    const texts = openingNotices((p) => p);
    expect(texts).toContain('开放时间待确认');
    expect(texts.some((t) => t.includes('开放时间（'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 3 / M-R03：附近厕所/歇脚点候选写入后的提醒措辞
// ---------------------------------------------------------------------------

/** 候选写入事实（Task 3 来源口径）；checked=false 表示用户留了“待确认”（未知） */
function candidateFact<T>(value: T | null, checked: boolean): Fact<T> {
  return {
    value,
    sourceType: 'user',
    sourceName: '高德地图搜索',
    sourceReference: 'poi-1',
    fetchedAt: '2026-09-22T05:00:00.000Z',
    reviewState: checked ? 'userChecked' : 'unknown',
    checkedAt: checked ? '2026-09-22T05:00:00.000Z' : null,
    applicableDate: null,
    note: checked ? '经你从地图候选确认，出发前请再核对' : null,
  };
}

/** 在示例景点A节点上挂一条设施记录后构建视图模型，取该节点的提醒文本 */
function facilityNoticesOnA(kind: 'toilet' | 'rest-candidate', facts: Record<string, Fact<unknown>>): string[] {
  const base = buildUnifiedSample();
  const aId = base.nodeOrder[0];
  const it = {
    ...base,
    facilities: [
      ...base.facilities,
      {
        id: `f-${kind}`,
        kind,
        placeId: base.nodes[aId].placeId,
        target: { type: 'node' as const, nodeId: aId },
        facts,
      },
    ],
  };
  const vm = vmFor(it);
  const node = vm.blocks.find((b): b is NodeBlock => b.kind === 'node' && b.titleText === '示例景点A');
  return (node?.notices ?? []).map((n) => n.text);
}

describe('设施候选提醒（Task 3 / M-R03）', () => {
  it('歇脚点候选提醒措辞含“候选”，座位未知保持“座位待确认”，不暗示有空位', () => {
    const texts = facilityNoticesOnA('rest-candidate', {
      name: candidateFact('长椅休息区', true),
      seat: unknownFact(),
    });
    expect(texts).toContain('歇脚点候选：长椅休息区（座位待确认）');
    expect(texts.some((t) => t.includes('候选'))).toBe(true);
    expect(texts.some((t) => /空位|免费|随便坐/.test(t))).toBe(false);
  });

  it('歇脚点候选：可坐/不可坐显示“你已核对”，措辞仍含“候选”', () => {
    expect(
      facilityNoticesOnA('rest-candidate', { name: candidateFact('长椅休息区', true), seat: candidateFact(true, true) }),
    ).toContain('歇脚点候选：长椅休息区（你已核对：可坐）');
    expect(
      facilityNoticesOnA('rest-candidate', { name: candidateFact('长椅休息区', true), seat: candidateFact(false, true) }),
    ).toContain('歇脚点候选：长椅休息区（你已核对：不可坐）');
  });

  it('厕所候选带名称提醒；开放未知保持“待确认”，不显示开放结论', () => {
    const unknownTexts = facilityNoticesOnA('toilet', {
      name: candidateFact('公园东门厕所', true),
      open: unknownFact(),
    });
    expect(unknownTexts).toContain('厕所：公园东门厕所（待确认）');
    expect(unknownTexts.some((t) => t.includes('开放时间（'))).toBe(false);
    const checkedTexts = facilityNoticesOnA('toilet', {
      name: candidateFact('公园东门厕所', true),
      open: candidateFact('8:00-18:00', true),
    });
    expect(checkedTexts).toContain('厕所：公园东门厕所（你已核对：8:00-18:00）');
  });
});
