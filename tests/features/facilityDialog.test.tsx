/**
 * 设施备注对话框（Task 3 / R-A1、M-R03）：
 * 附近厕所/歇脚点候选检索与逐属性确认写入（来源可追溯）、
 * 直线距离红线标注、无坐标不请求、地图未配置与失败可重试的降级口径。
 * 与 planning.test.tsx 一致：用 fetch 桩模拟本站 API，不访问网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Fact, FacilityKind, FacilityTarget, Itinerary, PlaceRef } from '../../shared/contracts/domain';
import { FacilityDialog } from '../../src/features/facilities/FacilityDialog';
import { addVisitNode, upsertPlace } from '../../src/domain/itinerary';
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

function poi(id: string, name: string, straightLineMeters: number | null): PlaceSearchItem {
  return {
    id,
    name,
    district: '示例区',
    address: '示例路 1 号',
    location: { longitude: 116.41, latitude: 39.911 },
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
    for (const key of ['name', 'address', 'open']) {
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
