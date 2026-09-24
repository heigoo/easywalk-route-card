/**
 * CardViewModel 构建（第 10.2 节；验证用例 T01/T02/T15 的卡片侧口径）。
 * 含开放时间提醒三态文案（R-A2）。
 */
import { describe, expect, it } from 'vitest';
import type { Fact, OpeningSchedule, PlaceRef } from '../../shared/contracts/domain';
import { unknownFact } from '../../shared/contracts/domain';
import { computeStats, evaluateConstraints } from '../../src/domain/compute';
import { synthesizeCardStatus } from '../../src/domain/status';
import { convertRestCandidateToRestNode, updateNode, upsertNodeFacilityFact } from '../../src/domain/itinerary';
import { buildCardViewModel } from '../../src/features/route-card/buildViewModel';
import type { NodeBlock } from '../../src/features/route-card/viewModel';
import { detourTripleOf, type DetourCompareMap } from '../../src/features/planning/useDetourCompare';
import { buildUnifiedSample } from '../helpers';
import { SAMPLE } from '../helpers';

function vmFor(it: ReturnType<typeof buildUnifiedSample>, detourCompares?: DetourCompareMap) {
  const stats = computeStats(it);
  const verdicts = evaluateConstraints(it, stats);
  const status = synthesizeCardStatus(it, stats, verdicts);
  return buildCardViewModel({
    itinerary: it,
    stats,
    verdicts,
    status,
    detourCompares: detourCompares ?? {},
    now: '2026-09-22T04:00:00.000Z',
  });
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

// ---------------------------------------------------------------------------
// Task 3 / R-B：候选转休息点后的卡片一致性
// ---------------------------------------------------------------------------

describe('候选转休息点后的卡片一致性（Task 3 / R-B）', () => {
  it('转换后“歇脚点候选”提醒随记录移除消失，休息点行按既有规则显示座位状态', () => {
    const base = buildUnifiedSample();
    const aId = base.nodeOrder[0];
    const withCandidate = {
      ...base,
      facilities: [
        ...base.facilities,
        {
          id: 'f-convert',
          kind: 'rest-candidate' as const,
          placeId: base.nodes[aId].placeId,
          target: { type: 'node' as const, nodeId: aId },
          facts: {
            name: candidateFact('长椅休息区', true),
            seat: candidateFact(true, true),
          },
        },
      ],
    };
    const before = vmFor(withCandidate);
    const beforeNode = before.blocks.find(
      (b): b is NodeBlock => b.kind === 'node' && b.titleText === '示例景点A',
    );
    expect(beforeNode?.notices.map((n) => n.text)).toContain('歇脚点候选：长椅休息区（你已核对：可坐）');

    const { itinerary: after } = convertRestCandidateToRestNode(withCandidate, 'f-convert', aId);
    const vm = vmFor(after);
    // 原候选提醒消失（记录已迁移，不重复提醒）
    const allNotices = vm.blocks.flatMap((b) => (b.kind === 'node' ? b.notices.map((n) => n.text) : []));
    expect(allNotices.some((t) => t.includes('歇脚点候选'))).toBe(false);
    // 代之以常规休息点行：名称来自候选；座位已核对（true）不再提示“待确认”
    const restBlock = vm.blocks.find((b): b is NodeBlock => b.kind === 'node' && b.titleText === '长椅休息区');
    expect(restBlock).toBeDefined();
    expect(restBlock!.role).toBe('rest');
    expect(restBlock!.badges.map((b) => b.text)).toContain('休息点');
    expect(restBlock!.notices.some((n) => n.text === '是否有座位待确认')).toBe(false);
  });

  it('厕所途经节点与编辑区同口径：途经（不计坐休分界），不写坐下歇、不问座位', () => {
    const base = buildUnifiedSample();
    const aId = base.nodeOrder[0];
    let withToilet = upsertNodeFacilityFact(base, aId, 'toilet', 'name', candidateFact('东侧公厕', true));
    withToilet = upsertNodeFacilityFact(
      withToilet,
      aId,
      'toilet',
      'location',
      candidateFact({ longitude: 116.4, latitude: 39.91 }, true),
    );
    const toiletId = withToilet.facilities.find((f) => f.kind === 'toilet')!.id;
    const { itinerary: after } = convertRestCandidateToRestNode(withToilet, toiletId, aId);
    const vm = vmFor(after);
    const restBlock = vm.blocks.find((b): b is NodeBlock => b.kind === 'node' && b.titleText === '东侧公厕');
    expect(restBlock).toBeDefined();
    expect(restBlock!.metaLines).toEqual(['途经（不计坐休分界）']);
    expect(restBlock!.badges.map((b) => b.text)).toContain('途经');
    expect(restBlock!.notices.some((n) => n.text === '是否有座位待确认')).toBe(false);
    expect(restBlock!.metaLines.some((m) => m.includes('坐下歇'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 4 / R-D：歇脚绕行对比（会话内对照，不落盘）
// ---------------------------------------------------------------------------

/** 统一样例里休息点的提醒文本（休息点夹在 A、B 之间，两段 8+10=18 分钟） */
function restNotices(
  it: ReturnType<typeof buildUnifiedSample>,
  compares: DetourCompareMap,
): string[] {
  const vm = vmFor(it, compares);
  const node = vm.blocks.find((b): b is NodeBlock => b.kind === 'node' && b.titleText === '示例休息点');
  return (node?.notices ?? []).map((n) => n.text);
}

describe('歇脚绕行对比（Task 4 / R-D）', () => {
  const base = buildUnifiedSample();
  const restId = base.nodeOrder[1];
  const key = detourTripleOf(base, restId)!.key;

  it('对照可得且多走：显示“歇脚绕行：比直达多走约 X 分钟”并注明按当前步行倍数估算', () => {
    // 两段 8+10=18 分钟、直达 15 分钟 → 多走约 3 分钟（分钟向上取整）
    const texts = restNotices(base, { [key]: { status: 'ready', directRawWalkingSeconds: 15 * 60 } });
    expect(texts).toContain('歇脚绕行：比直达多走约 3 分钟（按当前步行倍数估算）');
  });

  it('差值≤0：显示“与直达相当/更近”，不夸大绕行成本', () => {
    const texts = restNotices(base, { [key]: { status: 'ready', directRawWalkingSeconds: 20 * 60 } });
    expect(texts).toContain('歇脚绕行：与直达相当/更近（按当前步行倍数估算）');
  });

  it('口径固化：直达原始时长按同一 walkingFactor 折算后再比较', () => {
    // 倍数 2：两段手动值按当前展示口径不变（18 分钟），直达 15 分钟折算为 30 分钟 → 判为相当/更近
    const slower = { ...base, constraints: { ...base.constraints, walkingFactor: 2 } };
    const texts = restNotices(slower, { [key]: { status: 'ready', directRawWalkingSeconds: 15 * 60 } });
    expect(texts).toContain('歇脚绕行：与直达相当/更近（按当前步行倍数估算）');
  });

  it('对照失败/不可达/未取得：一律“绕行对比待补充”，绝不用直线距离或估算冒充', () => {
    for (const compares of [
      { [key]: { status: 'failed' as const } },
      { [key]: { status: 'unreachable' as const } },
      {},
    ]) {
      const texts = restNotices(base, compares);
      expect(texts).toContain('绕行对比待补充');
      expect(texts.some((t) => /多走|相当|直线/.test(t))).toBe(false);
    }
  });

  it('缺坐标（下一站无坐标）：待补充，不显示任何对比数值', () => {
    const bId = base.nodeOrder[2];
    const pB = base.places[base.nodes[bId].placeId];
    const noCoord = {
      ...base,
      places: { ...base.places, [pB.id]: { ...pB, location: null } },
    };
    const texts = restNotices(noCoord, { [key]: { status: 'ready', directRawWalkingSeconds: 15 * 60 } });
    expect(texts).toContain('绕行对比待补充');
    expect(texts.some((t) => /多走|相当|直线/.test(t))).toBe(false);
  });
});
