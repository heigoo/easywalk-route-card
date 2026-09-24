/**
 * 设施备注对话框（Task 3 / R-A1、M-R03）：
 * 附近厕所/歇脚点候选检索与逐属性确认写入（来源可追溯）、
 * 直线距离红线标注、无坐标不请求、地图未配置与失败可重试的降级口径。
 * 另含 Task 1 / R-E 覆盖保护：未改动不重写、显式回退二次确认、候选事实不被手动事实覆盖。
 * 与 planning.test.tsx 一致：用 fetch 桩模拟本站 API，不访问网络。
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Fact, FacilityKind, FacilityTarget, Itinerary, PlaceRef } from '../../shared/contracts/domain';
import { FacilityDialog } from '../../src/features/facilities/FacilityDialog';
import {
  addVisitNode,
  convertRestCandidateToRestNode,
  upsertFacilityFactForTarget,
  upsertNodeFacilityFact,
  upsertPlace,
} from '../../src/domain/itinerary';
import type { PlaceSearchItem } from '../../shared/contracts/api';
import { makeItinerary, makePlace } from '../helpers';

/** 行程样例：一个带（或不带）坐标的景点节点 */
function fixture(location: PlaceRef['location']): { it: Itinerary; nodeId: string } {
  let it = makeItinerary();
  const place: PlaceRef = { ...makePlace('示例景点A', 116.4, 39.91), location };
  it = upsertPlace(it, place);
  it = addVisitNode(it, place.id, { visitSeconds: 30 * 60, insideWalkSeconds: 5 * 60 });
  return { it, nodeId: it.nodeOrder[0] };
}

function poi(
  id: string,
  name: string,
  straightLineMeters: number | null,
  location: PlaceSearchItem['location'] = { longitude: 116.41, latitude: 39.911 },
): PlaceSearchItem {
  return {
    id,
    name,
    district: '示例区',
    address: '示例路 1 号',
    location,
    entranceStatus: 'pending',
    openingHoursText: null,
    straightLineMeters,
  };
}

/** 附近检索成功桩：按 NearbyData 契约回包 */
function stubNearby(items: PlaceSearchItem[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        requestId: 'r',
        data: { items, nextPage: null, source: '高德地图搜索', fetchedAt: '2026-09-22T05:00:00.000Z' },
        warnings: [],
      }),
    }),
  );
}

/** 附近检索失败桩：按统一错误契约回包 */
function stubError(code: string, retryable: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code, message: '上游失败', retryable, fieldErrors: [], requestId: 'r' }),
    }),
  );
}

/** 取某类别写入的事实表（按 factKey 归拢） */
function writtenFacts(onSave: ReturnType<typeof vi.fn>, kind: FacilityKind): Record<string, Fact<unknown>> {
  const out: Record<string, Fact<unknown>> = {};
  for (const call of onSave.mock.calls) {
    const [target, k, key, fact] = call as [FacilityTarget, FacilityKind, string, Fact<unknown>];
    if (target.type === 'node' && k === kind) out[key] = fact;
  }
  return out;
}

/** 已核对事实样例（来源可追溯：高德地图搜索＋POI id＋核对时间） */
function checkedFact(value: unknown): Fact<unknown> {
  return {
    value,
    sourceType: 'user',
    sourceName: '高德地图搜索',
    sourceReference: 'poi-1',
    fetchedAt: '2026-09-22T05:00:00.000Z',
    reviewState: 'userChecked',
    checkedAt: '2026-09-22T05:10:00.000Z',
    applicableDate: '2026-10-01',
    note: null,
  };
}

/** 带预置事实的行程样例 */
function fixtureWithFacts(seeds: Array<[FacilityKind, string, Fact<unknown>]>): { it: Itinerary; nodeId: string } {
  const base = fixture({ longitude: 116.4, latitude: 39.91 });
  let it = base.it;
  for (const [kind, key, fact] of seeds) {
    it = upsertNodeFacilityFact(it, base.nodeId, kind, key, fact);
  }
  return { it, nodeId: base.nodeId };
}

/** 从行程里取某类别已存事实（按 factKey 归拢） */
function storedFacts(it: Itinerary | null, kind: FacilityKind): Record<string, Fact<unknown>> {
  const out: Record<string, Fact<unknown>> = {};
  for (const rec of it?.facilities ?? []) {
    if (rec.kind !== kind) continue;
    for (const [key, fact] of Object.entries(rec.facts)) out[key] = fact as Fact<unknown>;
  }
  return out;
}

/**
 * 弹层宿主：像真实应用一样把写入落到行程再回传弹层，
 * 用于验证“未变化不重写/候选事实不被覆盖”（需看到写入后的真实存储结果）。
 */
function Host({
  initial,
  nodeId,
  onCalls,
  onClose,
  storeRef,
}: {
  initial: Itinerary;
  nodeId: string;
  onCalls: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  storeRef: { current: Itinerary | null };
}) {
  const [it, setIt] = useState(initial);
  storeRef.current = it;
  return (
    <FacilityDialog
      open
      node={it.nodes[nodeId]}
      itinerary={it}
      onClose={onClose}
      onSave={(t, k, key, fact) => {
        onCalls(t, k, key, fact);
        setIt((prev) => upsertFacilityFactForTarget(prev, t, k, key, fact));
      }}
    />
  );
}

describe('附近候选检索（Task 3 子任务 3.1）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('候选列表渲染：名称/地址/直线距离＋“直线距离，非步行路程”＋“待核对”', async () => {
    const user = userEvent.setup();
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubNearby([poi('poi-1', '公园东门厕所', 120), poi('poi-2', '湖边公厕', null)]);
    render(<FacilityDialog open node={it.nodes[nodeId]} itinerary={it} onClose={() => undefined} onSave={vi.fn()} />);

    // 半径默认 500 米
    expect(screen.getByLabelText('搜索半径')).toHaveValue('500');
    await user.click(screen.getByRole('button', { name: '搜索' }));

    expect(await screen.findByText('公园东门厕所')).toBeInTheDocument();
    expect(screen.getByText('湖边公厕')).toBeInTheDocument();
    expect(screen.getByText('直线约 120 米')).toBeInTheDocument();
    expect(screen.getByText('直线距离未知')).toBeInTheDocument();
    // 直线距离红线文案紧邻距离展示（每条候选一份）
    expect(screen.getAllByText('直线距离，非步行路程')).toHaveLength(2);
    expect(screen.getAllByText('待核对')).toHaveLength(2);
  });

  it('空结果：提示可换类别/半径或手动记录', async () => {
    const user = userEvent.setup();
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubNearby([]);
    render(<FacilityDialog open node={it.nodes[nodeId]} itinerary={it} onClose={() => undefined} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('附近没有找到候选，可换类别/半径或手动记录')).toBeInTheDocument();
  });

  it('站点无坐标：不发起请求并提示先确认地图位置，手动录入不受影响', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { it, nodeId } = fixture(null);
    render(<FacilityDialog open node={it.nodes[nodeId]} itinerary={it} onClose={() => undefined} onSave={vi.fn()} />);

    expect(screen.getByText('该站点还没有地图坐标，请先在搜索地点中确认地图位置')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    // 手动设施录入不受影响
    expect(screen.getByLabelText('厕所开放情况')).toBeInTheDocument();
    expect(screen.getByLabelText('是否可坐')).toBeInTheDocument();
  });

  it('地图服务未配置：持久提示口径，手动录入仍可用', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubError('AMAP_NOT_CONFIGURED', false);
    render(<FacilityDialog open node={it.nodes[nodeId]} itinerary={it} onClose={() => undefined} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: '搜索' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('地图服务未配置');
    expect(alert.textContent).toContain('手动填写不受影响');

    // 手动录入可用：直接核对厕所开放并确认修改
    await user.selectOptions(screen.getByLabelText('厕所开放情况'), 'checked');
    await user.type(screen.getByLabelText('开放时段说明'), '全天开放');
    await user.click(screen.getByRole('button', { name: '确认修改' }));
    const facts = writtenFacts(onSave, 'toilet');
    expect(facts.open?.value).toBe('全天开放');
  });

  it('检索失败：持久提示“附近检索失败，可重试”，点重试后可成功', async () => {
    const user = userEvent.setup();
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubError('UPSTREAM_TIMEOUT', true);
    render(<FacilityDialog open node={it.nodes[nodeId]} itinerary={it} onClose={() => undefined} onSave={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '搜索' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('附近检索失败，可重试');

    stubNearby([poi('poi-1', '公园东门厕所', 120)]);
    await user.click(within(alert).getByRole('button', { name: '重试' }));
    expect(await screen.findByText('公园东门厕所')).toBeInTheDocument();
  });
});

describe('候选逐属性确认写入（Task 3 子任务 3.2）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('厕所候选：逐属性确认后写入 facts 含 sourceName/sourceReference/checkedAt，并标“已记录”', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubNearby([poi('poi-1', '公园东门厕所', 120)]);
    render(<FacilityDialog open node={it.nodes[nodeId]} itinerary={it} onClose={() => undefined} onSave={onSave} />);

    await user.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByText('公园东门厕所');
    await user.click(screen.getByRole('button', { name: '记录到此站' }));

    // 展开逐属性确认区（不是直接落库）；开放情况默认“待确认”
    const group = screen.getByRole('group', { name: '逐属性确认' });
    expect(within(group).getByLabelText('开放情况')).toHaveValue('unknown');
    await user.selectOptions(within(group).getByLabelText('开放情况'), 'checked');
    await user.type(within(group).getByLabelText('开放时段说明'), '8:00-18:00');
    await user.click(within(group).getByRole('button', { name: '确认写入' }));

    expect(screen.getByText('已记录')).toBeInTheDocument();

    const facts = writtenFacts(onSave, 'toilet');
    expect(facts.name?.value).toBe('公园东门厕所');
    expect(facts.address?.value).toBe('示例路 1 号');
    expect(facts.open?.value).toBe('8:00-18:00');
    // 候选坐标随确认写入落到 location 事实（每键一个 Fact，与 name/address 同结构）
    expect(facts.location?.value).toEqual({ longitude: 116.41, latitude: 39.911 });
    for (const key of ['name', 'address', 'location', 'open']) {
      const fact = facts[key];
      expect(fact.sourceType).toBe('user');
      expect(fact.sourceName).toBe('高德地图搜索');
      expect(fact.sourceReference).toBe('poi-1');
      expect(fact.fetchedAt).toBe('2026-09-22T05:00:00.000Z');
      expect(fact.reviewState).toBe('userChecked');
      expect(fact.checkedAt).toBeTruthy();
      expect(fact.applicableDate).toBe('2026-10-01');
    }
  });

  it('歇脚处候选：是否可坐三态且默认“待确认”，默认写入记为未知（不默认可坐/不可坐）', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubNearby([poi('poi-9', '长椅休息区', 80)]);
    render(<FacilityDialog open node={it.nodes[nodeId]} itinerary={it} onClose={() => undefined} onSave={onSave} />);

    await user.selectOptions(screen.getByLabelText('类别'), 'REST_CANDIDATE');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByText('长椅休息区');
    await user.click(screen.getByRole('button', { name: '记录到此站' }));

    const group = screen.getByRole('group', { name: '逐属性确认' });
    const seatSelect = within(group).getByLabelText('是否可坐');
    expect(seatSelect).toHaveValue('unknown');
    expect(within(group).getAllByRole('option').map((o) => o.textContent)).toEqual(['待确认', '可坐', '不可坐']);

    // 不改默认值直接写入：座位记为未知，绝不记成“可坐/不可坐”
    await user.click(within(group).getByRole('button', { name: '确认写入' }));
    let facts = writtenFacts(onSave, 'rest-candidate');
    expect(facts.name?.value).toBe('长椅休息区');
    expect(facts.seat?.value).toBeNull();
    expect(facts.seat?.reviewState).toBe('unknown');

    // 再次记录：核对为“不可坐”后写入
    await user.click(screen.getByRole('button', { name: '记录到此站' }));
    const group2 = screen.getByRole('group', { name: '逐属性确认' });
    await user.selectOptions(within(group2).getByLabelText('是否可坐'), 'no');
    await user.click(within(group2).getByRole('button', { name: '确认写入' }));
    facts = writtenFacts(onSave, 'rest-candidate');
    expect(facts.seat?.value).toBe(false);
    expect(facts.seat?.reviewState).toBe('userChecked');
    expect(facts.seat?.sourceName).toBe('高德地图搜索');
  });
});

describe('设施事实覆盖保护（Task 1 / R-E）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('未改动不重写：直接“确认修改”不覆盖既有事实的来源与核对字段', async () => {
    const user = userEvent.setup();
    const onCalls = vi.fn();
    const onClose = vi.fn();
    const storeRef: { current: Itinerary | null } = { current: null };
    const { it, nodeId } = fixtureWithFacts([
      ['toilet', 'open', checkedFact('8:00-18:00')],
      ['rest-candidate', 'name', checkedFact('长椅休息区')],
      ['rest-candidate', 'address', checkedFact('湖边长廊西侧')],
      ['rest-candidate', 'seat', checkedFact(true)],
      ['stairs', 'exists', checkedFact(false)],
    ]);
    render(<Host initial={it} nodeId={nodeId} onCalls={onCalls} onClose={onClose} storeRef={storeRef} />);

    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 零写入即证明原事实（含 sourceName/checkedAt 等来源字段）未被重写
    expect(onCalls).not.toHaveBeenCalled();
    const toilet = storedFacts(storeRef.current, 'toilet');
    expect(toilet.open).toEqual(checkedFact('8:00-18:00'));
    expect(toilet.open.sourceName).toBe('高德地图搜索');
    expect(toilet.open.checkedAt).toBe('2026-09-22T05:10:00.000Z');
    expect(storedFacts(storeRef.current, 'rest-candidate').seat).toEqual(checkedFact(true));
    expect(storedFacts(storeRef.current, 'stairs').exists).toEqual(checkedFact(false));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('显式回退需二次确认：点名属性；取消保持原事实与草稿，确认后退回待确认', async () => {
    const user = userEvent.setup();
    const onCalls = vi.fn();
    const onClose = vi.fn();
    const storeRef: { current: Itinerary | null } = { current: null };
    const openFact = checkedFact('8:00-18:00');
    const { it, nodeId } = fixtureWithFacts([['toilet', 'open', openFact]]);
    render(<Host initial={it} nodeId={nodeId} onCalls={onCalls} onClose={onClose} storeRef={storeRef} />);

    await user.selectOptions(screen.getByLabelText('厕所开放情况'), 'unknown');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 回退确认框点名属性；确认前不写入、不关闭
    const confirmBox = screen.getByRole('dialog', { name: '退回待确认？' });
    expect(within(confirmBox).getByText(/将把已核对的「厕所开放情况」退回待确认/)).toBeInTheDocument();
    expect(onCalls).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // 取消：放弃本次回退提交，原事实保持原样，草稿保留、弹层不关闭
    await user.click(within(confirmBox).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '退回待确认？' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('厕所开放情况')).toHaveValue('unknown');
    expect(storedFacts(storeRef.current, 'toilet').open).toEqual(openFact);
    expect(onCalls).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认修改' })).toBeInTheDocument();

    // 重做并确认：回退执行，事实回到“待确认”（unknown）
    await user.click(screen.getByRole('button', { name: '确认修改' }));
    await user.click(within(screen.getByRole('dialog', { name: '退回待确认？' })).getByRole('button', { name: '确认退回' }));
    const stored = storedFacts(storeRef.current, 'toilet').open;
    expect(stored.reviewState).toBe('unknown');
    expect(stored.value).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('候选事实保护：候选写入的带来源事实不被“确认修改”的无来源手动事实覆盖', async () => {
    const user = userEvent.setup();
    const onCalls = vi.fn();
    const onClose = vi.fn();
    const storeRef: { current: Itinerary | null } = { current: null };
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubNearby([poi('poi-1', '公园东门厕所', 120)]);
    render(<Host initial={it} nodeId={nodeId} onCalls={onCalls} onClose={onClose} storeRef={storeRef} />);

    // 候选逐属性确认写入：带来源（高德地图搜索＋POI id）
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByText('公园东门厕所');
    await user.click(screen.getByRole('button', { name: '记录到此站' }));
    const group = screen.getByRole('group', { name: '逐属性确认' });
    await user.selectOptions(within(group).getByLabelText('开放情况'), 'checked');
    await user.type(within(group).getByLabelText('开放时段说明'), '8:00-18:00');
    await user.click(within(group).getByRole('button', { name: '确认写入' }));
    // name/address/location/open 四键各一个 Fact
    expect(onCalls).toHaveBeenCalledTimes(4);

    // 不动手动区直接“确认修改”：候选事实（含 location）不被无来源手动事实覆盖
    await user.click(screen.getByRole('button', { name: '确认修改' }));
    expect(onCalls).toHaveBeenCalledTimes(4);
    const stored = storedFacts(storeRef.current, 'toilet');
    expect(stored.name?.sourceName).toBe('高德地图搜索');
    expect(stored.name?.sourceReference).toBe('poi-1');
    expect(stored.name?.checkedAt).toBeTruthy();
    expect(stored.open?.value).toBe('8:00-18:00');
    expect(stored.open?.reviewState).toBe('userChecked');
    expect(stored.open?.sourceName).toBe('高德地图搜索');
  });

  it('回退与其他改动同次保存：确认后一并提交，取消则整体不提交', async () => {
    const user = userEvent.setup();
    const onCalls = vi.fn();
    const onClose = vi.fn();
    const storeRef: { current: Itinerary | null } = { current: null };
    const { it, nodeId } = fixtureWithFacts([
      ['toilet', 'open', checkedFact('8:00-18:00')],
      ['rest-candidate', 'name', checkedFact('长椅休息区')],
      ['rest-candidate', 'seat', checkedFact(true)],
      ['stairs', 'exists', checkedFact(false)],
    ]);
    render(<Host initial={it} nodeId={nodeId} onCalls={onCalls} onClose={onClose} storeRef={storeRef} />);

    // 三个“已核对→待确认”回退＋一处正常改动（名称）
    await user.selectOptions(screen.getByLabelText('厕所开放情况'), 'unknown');
    await user.selectOptions(screen.getByLabelText('是否可坐'), 'unknown');
    await user.selectOptions(screen.getByLabelText('台阶情况'), 'unknown');
    await user.clear(screen.getByLabelText('名称'));
    await user.type(screen.getByLabelText('名称'), '湖边长廊长椅');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 确认框点名全部回退属性，不含正常改动的属性
    const confirmBox = screen.getByRole('dialog', { name: '退回待确认？' });
    const desc = within(confirmBox).getByText(/^将把已核对的/);
    expect(desc.textContent).toContain('「厕所开放情况」');
    expect(desc.textContent).toContain('「是否可坐」');
    expect(desc.textContent).toContain('「台阶情况」');
    expect(desc.textContent).not.toContain('「名称」');

    // 取消：整体不提交本次“确认修改”（连同其他改动一并放弃）
    await user.click(within(confirmBox).getByRole('button', { name: '取消' }));
    expect(onCalls).not.toHaveBeenCalled();
    expect(storedFacts(storeRef.current, 'rest-candidate').name?.value).toBe('长椅休息区');

    // 确认：回退与名称改动一并提交
    await user.click(screen.getByRole('button', { name: '确认修改' }));
    await user.click(within(screen.getByRole('dialog', { name: '退回待确认？' })).getByRole('button', { name: '确认退回' }));
    expect(onCalls).toHaveBeenCalledTimes(4);
    expect(storedFacts(storeRef.current, 'toilet').open?.reviewState).toBe('unknown');
    expect(storedFacts(storeRef.current, 'rest-candidate').seat?.reviewState).toBe('unknown');
    expect(storedFacts(storeRef.current, 'stairs').exists?.reviewState).toBe('unknown');
    const name = storedFacts(storeRef.current, 'rest-candidate').name;
    expect(name?.value).toBe('湖边长廊长椅');
    expect(name?.reviewState).toBe('userChecked');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Task 8（R-B 收尾）：候选写入保留坐标，转换休息点带出坐标
// ---------------------------------------------------------------------------

describe('候选坐标写入与转换（Task 8 / R-B 收尾）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('候选带坐标：location 事实含坐标与来源字段，转为休息点后新地点坐标正确', async () => {
    const user = userEvent.setup();
    const onCalls = vi.fn();
    const onClose = vi.fn();
    const storeRef: { current: Itinerary | null } = { current: null };
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubNearby([poi('poi-1', '长椅休息区', 80)]);
    render(<Host initial={it} nodeId={nodeId} onCalls={onCalls} onClose={onClose} storeRef={storeRef} />);

    // 搜索→写入：歇脚处候选逐属性确认后写入
    await user.selectOptions(screen.getByLabelText('类别'), 'REST_CANDIDATE');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByText('长椅休息区');
    await user.click(screen.getByRole('button', { name: '记录到此站' }));
    const group = screen.getByRole('group', { name: '逐属性确认' });
    await user.selectOptions(within(group).getByLabelText('是否可坐'), 'yes');
    await user.click(within(group).getByRole('button', { name: '确认写入' }));

    // location 事实：坐标对象＋与 name/address 同规格的来源字段
    const facts = writtenFacts(onCalls, 'rest-candidate');
    expect(facts.location?.value).toEqual({ longitude: 116.41, latitude: 39.911 });
    expect(facts.location?.sourceType).toBe('user');
    expect(facts.location?.sourceName).toBe('高德地图搜索');
    expect(facts.location?.sourceReference).toBe('poi-1');
    expect(facts.location?.fetchedAt).toBe('2026-09-22T05:00:00.000Z');
    expect(facts.location?.reviewState).toBe('userChecked');
    expect(facts.location?.checkedAt).toBeTruthy();
    expect(facts.location?.applicableDate).toBe('2026-10-01');

    // 转换：走真实领域函数，新地点带出候选坐标（可自动获取步行数据与绕行对比）
    const rec = storeRef.current!.facilities.find((f) => f.kind === 'rest-candidate')!;
    const { itinerary: next, nodeId: restId } = convertRestCandidateToRestNode(storeRef.current!, rec.id, nodeId);
    expect(restId).not.toBeNull();
    const place = next.places[next.nodes[restId!].placeId];
    expect(place.location).toEqual({ longitude: 116.41, latitude: 39.911 });
  });

  it('候选无坐标（location:null）：location 记为未知，转换后仍无坐标（走“位置待确认”提示）', async () => {
    const user = userEvent.setup();
    const onCalls = vi.fn();
    const onClose = vi.fn();
    const storeRef: { current: Itinerary | null } = { current: null };
    const { it, nodeId } = fixture({ longitude: 116.4, latitude: 39.91 });
    stubNearby([poi('poi-2', '长椅休息区', 80, null)]);
    render(<Host initial={it} nodeId={nodeId} onCalls={onCalls} onClose={onClose} storeRef={storeRef} />);

    await user.selectOptions(screen.getByLabelText('类别'), 'REST_CANDIDATE');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await screen.findByText('长椅休息区');
    await user.click(screen.getByRole('button', { name: '记录到此站' }));
    const group = screen.getByRole('group', { name: '逐属性确认' });
    await user.selectOptions(within(group).getByLabelText('是否可坐'), 'yes');
    await user.click(within(group).getByRole('button', { name: '确认写入' }));

    // 候选无坐标：location 记为未知（未知不等于没有），不猜坐标
    const facts = writtenFacts(onCalls, 'rest-candidate');
    expect(facts.location?.value).toBeNull();
    expect(facts.location?.reviewState).toBe('unknown');
    expect(facts.location?.sourceType).toBe('unknown');
    expect(facts.location?.sourceName).toBeNull();

    // 转换后新地点仍无坐标：UI 据此提示“位置待确认，暂不能自动获取步行数据”（App 用例断言该文案）
    const rec = storeRef.current!.facilities.find((f) => f.kind === 'rest-candidate')!;
    const { itinerary: next, nodeId: restId } = convertRestCandidateToRestNode(storeRef.current!, rec.id, nodeId);
    expect(restId).not.toBeNull();
    const place = next.places[next.nodes[restId!].placeId];
    expect(place.location).toBeNull();
  });
});
