/**
 * 组件级验证（需求 A01/A07/A10、D11、T13）：
 * 添加节点、局部取消不改原数据、跳过可选景点、保存反馈、阻止导出提示。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/app/App';
import {
  addVisitNode,
  adoptAllMapLegs,
  applyMatrixEdges,
  createEmptyItinerary,
  setEndpoint,
  upsertPlace,
} from '../../src/domain/itinerary';
import { makePlace, setManualLeg } from '../helpers';

function fileOf(text: string): File {
  return new File([text], 'backup.json', { type: 'application/json' });
}

/** 备份样例：只有一个景点的行程 */
function backupWithPlace(name: string): File {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const p = makePlace(name, 116.4, 39.91);
  it = upsertPlace(it, p);
  it = addVisitNode(it, p.id, { visitSeconds: 30 * 60, insideWalkSeconds: 0 });
  return fileOf(JSON.stringify(it));
}

function matrixEdge(fromNodeId: string, toNodeId: string, rawWalkingSeconds: number) {
  return {
    fromNodeId,
    toNodeId,
    fromCoordinateRevision: 0,
    toCoordinateRevision: 0,
    distanceMeters: rawWalkingSeconds * 2,
    rawWalkingSeconds,
    provider: 'amap',
    providerApiVersion: 'v5',
    fetchedAt: '2026-09-22T05:00:00.000Z',
    state: 'ready' as const,
  };
}

/** 备份样例：起点→A→C→E，三段分别为 amap / manual / 已采纳（采纳时间固定为 2026-09-01） */
function backupWithThreeLegs(): File {
  let it = createEmptyItinerary('2026-09-22T00:00:00.000Z');
  const pO = makePlace('示例起点', 116.397, 39.908);
  const pA = makePlace('示例景点A', 116.4, 39.91);
  const pC = makePlace('示例景点C', 116.402, 39.912);
  const pE = makePlace('示例景点E', 116.404, 39.913);
  for (const p of [pO, pA, pC, pE]) it = upsertPlace(it, p);
  it = setEndpoint(it, 'origin', pO.id);
  it = addVisitNode(it, pA.id, { visitSeconds: 30 * 60, insideWalkSeconds: 0 });
  it = addVisitNode(it, pC.id, { visitSeconds: 20 * 60, insideWalkSeconds: 0 });
  it = addVisitNode(it, pE.id, { visitSeconds: 15 * 60, insideWalkSeconds: 0 });
  const oId = it.origin!.id;
  const [aId, cId, eId] = it.nodeOrder;
  const legBetween = (from: string, to: string) =>
    Object.values(it.legs).find((l) => l.fromNodeId === from && l.toNodeId === to)!;
  // A→C 手动填写
  it = setManualLeg(it, legBetween(aId, cId).id, { walkingSeconds: 8 * 60 });
  // C→E 地图值并采纳（旧采纳时间后续不得被改写）
  it = applyMatrixEdges(it, [matrixEdge(cId, eId, 300)]);
  it = adoptAllMapLegs(it, '2026-09-01T02:00:00.000Z').itinerary;
  // O→A 地图值（未采纳，仅当前会话）
  it = applyMatrixEdges(it, [matrixEdge(oId, aId, 600)]);
  return fileOf(JSON.stringify(it));
}

describe('应用组件流程', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('空行程显示引导与添加入口（UI-01）', () => {
    render(<App />);
    expect(screen.getByText('省脚力路线卡')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加景点' })).toBeInTheDocument();
  });

  it('添加景点：填写名称后出现在列表（A01）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点甲');
    await user.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByText('示例景点甲')).toBeInTheDocument();
    // 自动保存反馈
    expect(screen.getByText('已保存在本机')).toBeInTheDocument();
  });

  it('局部面板取消不修改原行程（A07/T13）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点乙');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await user.click(screen.getByRole('button', { name: '编辑' }));
    const nameInput = screen.getByLabelText('名称');
    await user.clear(nameInput);
    await user.type(nameInput, '被丢弃的名字');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('示例景点乙')).toBeInTheDocument();
    expect(screen.queryByText('被丢弃的名字')).not.toBeInTheDocument();
  });

  it('园内步行大于停留时阻止确认并指出字段（A07）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点丙');
    await user.type(screen.getByLabelText('预计停留（分钟）'), '30');
    await user.type(screen.getByLabelText('园内预计步行（分钟）'), '40');
    await user.click(screen.getByRole('button', { name: '添加' }));
    expect(screen.getByRole('alert').textContent).toContain('园内步行不能大于停留时长');
    expect(screen.queryByText('示例景点丙')).not.toBeInTheDocument();
  });

  it('跳过可选景点：进入已跳过区并可恢复（R07）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '可选景点丁');
    await user.click(screen.getByLabelText('可选'));
    await user.click(screen.getByRole('button', { name: '添加' }));

    const card = screen.getByRole('article', { name: '可选景点丁' });
    await user.click(within(card).getByRole('button', { name: '跳过此站' }));
    expect(screen.getByText('已跳过（资料保留）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复' }));
    expect(screen.getByRole('article', { name: '可选景点丁' })).toBeInTheDocument();
  });

  it('清空行程内容需二次确认；取消不损失内容（A10）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '示例景点戊');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await user.click(screen.getByRole('button', { name: '清空行程内容' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('示例景点戊')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '清空行程内容' }));
    await user.click(screen.getByRole('button', { name: '确认清空' }));
    expect(screen.queryByText('示例景点戊')).not.toBeInTheDocument();
  });

  it('无有效景点时预览提示无法导出并解释原因（14.8）', async () => {
    const user = userEvent.setup();
    render(<App />);
    // 只有起点终点、无景点 → blocked
    await user.type(screen.getByLabelText('起点'), '示例酒店');
    await user.type(screen.getByLabelText('终点'), '示例车站');
    await user.click(screen.getByRole('button', { name: '大字预览' }));
    // 窄屏（jsdom 下为非宽屏）由吸底操作栏承担导出入口，状态为不可用并解释原因
    expect(screen.getByRole('button', { name: /无法导出/ })).toBeDisabled();
    // 纸面状态行与导出面板提示都解释原因
    expect(screen.getAllByText(/请先完善行程/).length).toBeGreaterThanOrEqual(1);
  });

  it('导入非法备份文件：当前行程不变且错误持续可见（Task 5）', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '现存景点');
    await user.click(screen.getByRole('button', { name: '添加' }));

    await user.click(screen.getByRole('button', { name: '导入备份' }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, fileOf('{这不是 JSON'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('文件不是合法 JSON');
    expect(alert.textContent).toContain('当前行程保持不变');
    expect(screen.getByText('现存景点')).toBeInTheDocument();
  });

  it('导入合法备份：取消不变，确认后覆盖（Task 5）', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '现存景点');
    await user.click(screen.getByRole('button', { name: '添加' }));

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const backup = backupWithPlace('备份里的景点');

    // 取消：当前行程不变
    await user.upload(input, backup);
    await screen.findByText('导入备份？');
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('现存景点')).toBeInTheDocument();
    expect(screen.queryByText('备份里的景点')).not.toBeInTheDocument();

    // 确认：整体覆盖
    await user.upload(input, backup);
    await screen.findByText('导入备份？');
    await user.click(screen.getByRole('button', { name: '确认导入' }));
    expect(await screen.findByText('备份里的景点')).toBeInTheDocument();
    expect(screen.queryByText('现存景点')).not.toBeInTheDocument();
  });

  it('采纳全部地图估算：仅 amap 路段被采纳，manual 与已采纳路段不受影响（Task 6）', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    // 出现条件：没有地图估算路段时不出现
    expect(screen.queryByRole('button', { name: /采纳全部地图估算/ })).toBeNull();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, backupWithThreeLegs());
    await screen.findByText('导入备份？');
    await user.click(screen.getByRole('button', { name: '确认导入' }));

    // 出现条件：只统计 amap 路段（manual/adopted 不计）
    expect(await screen.findByText(/有 1 段步行时间来自地图查询/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采纳全部地图估算（1 段）' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '采纳全部地图估算（1 段）' }));
    expect(screen.getByText('采纳全部地图估算？')).toBeInTheDocument();
    expect(screen.getByText(/采纳≠实地核实/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认采纳' }));

    // 采纳后 amap 路段清零，提示与按钮消失
    expect(screen.queryByText(/来自地图查询/)).not.toBeInTheDocument();

    // 原 amap 路段：新写入采纳
    await user.click(screen.getByRole('button', { name: '编辑路段 示例起点 到 示例景点A' }));
    expect(screen.getByText(/来源：已采纳地图估算（非实时）/)).toBeInTheDocument();
    expect(screen.queryByText(/2026-09-01/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));

    // manual 路段不受影响
    await user.click(screen.getByRole('button', { name: '编辑路段 示例景点A 到 示例景点C' }));
    expect(screen.getByText(/来源：用户填写/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));

    // 原已采纳路段：adoptedAt 不被改写
    await user.click(screen.getByRole('button', { name: '编辑路段 示例景点C 到 示例景点E' }));
    expect(screen.getByText(/采纳于 2026-09-01 02:00/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
  });
});

// ---------------------------------------------------------------------------
// Task 3（R-A1、M-R03）：附近厕所/歇脚点候选面板
// ---------------------------------------------------------------------------

describe('附近设施候选流程', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('无坐标的站点：提示先确认地图位置，不发起附近检索，手动录入不受影响', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    await user.type(screen.getByLabelText('名称'), '无坐标景点');
    await user.click(screen.getByRole('button', { name: '添加' }));

    const card = screen.getByRole('article', { name: '无坐标景点' });
    await user.click(within(card).getByRole('button', { name: '设施备注' }));
    expect(screen.getByText('该站点还没有地图坐标，请先在搜索地点中确认地图位置')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(fetchSpy).not.toHaveBeenCalled();
    // 手动设施录入不受影响
    expect(screen.getByLabelText('厕所开放情况')).toBeInTheDocument();
  });

  it('检索→逐属性确认写入→节点卡显示设施摘要（Task 3）', async () => {
    const user = userEvent.setup();
    // 附近检索按类别回不同候选；其余请求不参与本用例
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/api/places/nearby')) {
          const rest = u.includes('REST_CANDIDATE');
          return {
            ok: true,
            json: async () => ({
              requestId: 'r',
              data: {
                items: [
                  rest
                    ? { id: 'poi-rest', name: '长椅休息区', district: '示例区', address: '湖边长廊', location: null, entranceStatus: 'pending', straightLineMeters: 80 }
                    : { id: 'poi-toilet', name: '公园东门厕所', district: '示例区', address: '示例路 1 号', location: null, entranceStatus: 'pending', straightLineMeters: 120 },
                ],
                nextPage: null,
                source: '高德地图搜索',
                fetchedAt: '2026-09-22T05:00:00.000Z',
              },
              warnings: [],
            }),
          };
        }
        return { ok: true, json: async () => ({ requestId: 'r', data: { items: [], nextPage: null }, warnings: [] }) };
      }),
    );

    const { container } = render(<App />);
    // 用带坐标的备份建立站点，保证可以发起附近检索
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, backupWithPlace('示例景点甲'));
    await screen.findByText('导入备份？');
    await user.click(screen.getByRole('button', { name: '确认导入' }));

    const card = await screen.findByRole('article', { name: '示例景点甲' });
    await user.click(within(card).getByRole('button', { name: '设施备注' }));

    // 厕所候选：检索 → 逐属性确认 → 确认写入
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('公园东门厕所')).toBeInTheDocument();
    expect(screen.getByText('直线约 120 米')).toBeInTheDocument();
    expect(screen.getByText('直线距离，非步行路程')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '记录到此站' }));
    const toiletGroup = screen.getByRole('group', { name: '逐属性确认' });
    await user.selectOptions(within(toiletGroup).getByLabelText('开放情况'), 'checked');
    await user.type(within(toiletGroup).getByLabelText('开放时段说明'), '8:00-18:00');
    await user.click(within(toiletGroup).getByRole('button', { name: '确认写入' }));
    expect(screen.getByText('已记录')).toBeInTheDocument();

    // 歇脚处候选：三态默认“待确认”，核对为可坐后写入
    await user.selectOptions(screen.getByLabelText('类别'), 'REST_CANDIDATE');
    await user.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('长椅休息区')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '记录到此站' }));
    const restGroup = screen.getByRole('group', { name: '逐属性确认' });
    expect(within(restGroup).getByLabelText('是否可坐')).toHaveValue('unknown');
    await user.selectOptions(within(restGroup).getByLabelText('是否可坐'), 'yes');
    await user.click(within(restGroup).getByRole('button', { name: '确认写入' }));

    // 确认修改关闭对话框：不覆盖候选已写入的事实
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 节点卡设施摘要（名称＋属性状态），入口仍在
    expect(await screen.findByText('厕所候选：公园东门厕所（你已核对：8:00-18:00）')).toBeInTheDocument();
    expect(screen.getByText('歇脚点候选：长椅休息区（你已核对：可坐）')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '设施备注' })).toBeInTheDocument();

    // 候选无坐标（location:null）：转为休息点后新地点仍无坐标，明确提示“位置待确认”（Task 8）
    await user.click(screen.getByRole('button', { name: '转为休息点：长椅休息区' }));
    expect(screen.getByText('已加入路线，请补充新路段步行时间')).toBeInTheDocument();
    expect(screen.getByText('位置待确认，暂不能自动获取步行数据')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task 6（R-A / M-R01）：多行程管理——行程切换器与列表面板
// ---------------------------------------------------------------------------

/** 通过“添加景点”对话框添加一个景点 */
async function addPlace(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('button', { name: '添加景点' }));
  await user.type(screen.getByLabelText('名称'), name);
  await user.click(screen.getByRole('button', { name: '添加' }));
}

/** 设置当前行程名称（编辑器“行程名称”回车提交） */
async function setTitle(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.type(screen.getByLabelText('行程名称'), `${title}{enter}`);
}

/** 打开行程列表面板 */
async function openTripsPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '行程列表' }));
  return screen.getByRole('dialog', { name: '行程列表' });
}

describe('多行程管理（Task 6）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('行程切换器打开列表面板：列出全部行程并含新建入口（M-R01）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '面板景点');
    const panel = await openTripsPanel(user);
    expect(within(panel).getByRole('button', { name: '新建行程' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '修复行程列表' })).toBeInTheDocument();
    // 列出行程（标题/出游日期/更新时间）
    expect(within(panel).getByText('未命名行程')).toBeInTheDocument();
    expect(within(panel).getByText(/出游日期：/)).toBeInTheDocument();
    expect(within(panel).getByText(/更新于/)).toBeInTheDocument();
    expect(within(panel).getByText('（当前行程）')).toBeInTheDocument();
  });

  it('新建行程：进入空行程编辑', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '旧行程景点');
    await setTitle(user, '旧行程');
    const panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '新建行程' }));
    // 面板收起，进入空行程
    expect(screen.queryByRole('dialog', { name: '行程列表' })).toBeNull();
    expect(screen.queryByText('旧行程景点')).not.toBeInTheDocument();
    expect((screen.getByLabelText('行程名称') as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: '添加景点' })).toBeInTheDocument();
  });

  it('切换行程：编辑与自动保存作用于切换后行程（M-R01）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '景点一号');
    await setTitle(user, '行程甲');

    // 新建第二份
    let panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '新建行程' }));
    await setTitle(user, '行程乙');
    await addPlace(user, '景点二号');

    // 切回行程甲：编辑只作用于切换后的行程
    panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '切换到 行程甲' }));
    expect(screen.queryByRole('dialog', { name: '行程列表' })).toBeNull();
    expect((screen.getByLabelText('行程名称') as HTMLInputElement).value).toBe('行程甲');
    expect(screen.getByText('景点一号')).toBeInTheDocument();
    expect(screen.queryByText('景点二号')).not.toBeInTheDocument();

    // 在行程甲上编辑（自动保存）
    await addPlace(user, '景点三号');

    panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '切换到 行程乙' }));
    expect(screen.getByText('景点二号')).toBeInTheDocument();
    expect(screen.queryByText('景点三号')).not.toBeInTheDocument();

    // 再切回行程甲：编辑内容随自动保存保留
    panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '切换到 行程甲' }));
    expect(screen.getByText('景点一号')).toBeInTheDocument();
    expect(screen.getByText('景点三号')).toBeInTheDocument();
  });

  it('复制行程：内容一致且为新 id', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '复制景点');
    const panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '复制 未命名行程' }));

    // 两条记录并存：同名同内容、id 不同
    expect(within(panel).getAllByText('未命名行程')).toHaveLength(2);
    const rows = within(panel).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.getAttribute('data-trip-id'));
    expect(new Set(ids).size).toBe(2);

    // 复制不改变当前行程；副本内容一致
    const copyRow = rows.find((r) => !r.textContent!.includes('（当前行程）'))!;
    const currentRow = rows.find((r) => r.textContent!.includes('（当前行程）'))!;
    expect(currentRow.getAttribute('data-trip-id')).not.toBe(copyRow.getAttribute('data-trip-id'));
    await user.click(within(copyRow).getByRole('button', { name: '切换到 未命名行程' }));
    expect(screen.getByText('复制景点')).toBeInTheDocument();
  });

  it('重命名行程：保存后即时生效', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '重命名景点');
    const panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '重命名 未命名行程' }));
    await user.clear(screen.getByLabelText('新行程名称'));
    await user.type(screen.getByLabelText('新行程名称'), '两日游计划');
    await user.click(within(panel).getByRole('button', { name: '保存名称' }));
    // 列表即时更新
    expect(within(panel).getByText('两日游计划')).toBeInTheDocument();
    expect(within(panel).queryByText('未命名行程')).toBeNull();
    // 当前行程即时生效（编辑器“行程名称”同步）
    await user.click(within(panel).getByRole('button', { name: '关闭' }));
    expect((screen.getByLabelText('行程名称') as HTMLInputElement).value).toBe('两日游计划');
  });

  it('删除行程记录：二次确认且对象明确，取消不删、确认才删（M-R01）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '甲景点');
    await setTitle(user, '行程甲');
    let panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '新建行程' }));
    await setTitle(user, '行程乙');
    await addPlace(user, '乙景点');
    // 切回行程甲，删除对象是非当前行程
    panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '切换到 行程甲' }));

    panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '删除 行程乙' }));
    // 二次确认：对象明确
    expect(screen.getByText('删除整份行程记录？')).toBeInTheDocument();
    expect(screen.getByText('将删除整份行程记录《行程乙》，此操作不可恢复。')).toBeInTheDocument();

    // 取消：不删
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(within(panel).getByRole('button', { name: '删除 行程乙' })).toBeInTheDocument();

    // 确认：删除整份行程记录
    await user.click(within(panel).getByRole('button', { name: '删除 行程乙' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(within(panel).queryByRole('button', { name: '删除 行程乙' })).toBeNull();
    expect(within(panel).getByRole('button', { name: '删除 行程甲' })).toBeInTheDocument();
    // 当前行程不受影响
    await user.click(within(panel).getByRole('button', { name: '关闭' }));
    expect(screen.getByText('甲景点')).toBeInTheDocument();
    expect(screen.queryByText('乙景点')).not.toBeInTheDocument();
  });

  it('删除当前行程后自动切换到另一条；删完进入空行程编辑并保留新建入口（6.3）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '甲景点');
    await setTitle(user, '行程甲');
    let panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '新建行程' }));
    await setTitle(user, '行程乙');

    // 删除当前的行程乙：自动切到行程甲
    panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '删除 行程乙' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(within(panel).getByText('行程甲')).toBeInTheDocument();
    expect(within(panel).getByText('（当前行程）')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: '关闭' }));
    expect(screen.getByText('甲景点')).toBeInTheDocument();

    // 删除最后一份：进入空行程编辑，新建入口仍在
    panel = await openTripsPanel(user);
    await user.click(within(panel).getByRole('button', { name: '删除 行程甲' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(within(panel).getByText('还没有保存的行程，点击“新建行程”开始。')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: '新建行程' })).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: '关闭' }));
    expect(screen.queryByText('甲景点')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加景点' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Task 3（R-B）：歇脚点候选一键转休息点
// ---------------------------------------------------------------------------

describe('歇脚点候选一键转休息点（Task 3 / R-B）', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('一键转换：插入该站之后、持久提示补充路段、候选提醒消失，并可跳过/恢复', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '示例景点甲');
    await addPlace(user, '示例景点乙');

    // 在示例景点甲上手动记录歇脚点候选（无需网络）
    const cardA = screen.getByRole('article', { name: '示例景点甲' });
    await user.click(within(cardA).getByRole('button', { name: '设施备注' }));
    await user.type(screen.getByLabelText('名称'), '长椅休息区');
    await user.selectOptions(screen.getByLabelText('是否可坐'), 'yes');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 设施摘要条目＋一键转换入口
    expect(await screen.findByText('歇脚点候选：长椅休息区（你已核对：可坐）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '转为休息点：长椅休息区' }));

    // 持久提示（不是一闪而过的 Toast）
    expect(screen.getByText('已加入路线，请补充新路段步行时间')).toBeInTheDocument();
    // 转换出的地点没有坐标：显式提示，不用估算冒充
    expect(screen.getByText('位置待确认，暂不能自动获取步行数据')).toBeInTheDocument();
    // 原设施记录随迁移移除：候选提醒消失
    expect(screen.queryByText(/歇脚点候选/)).not.toBeInTheDocument();

    // 新休息点插入在指定站点之后、下一站之前
    const restCard = screen.getByRole('article', { name: '长椅休息区' });
    const cardB = screen.getByRole('article', { name: '示例景点乙' });
    expect(cardA.compareDocumentPosition(restCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(restCard.compareDocumentPosition(cardB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 新节点遵循既有跳过/恢复规则（资料保留）
    await user.click(within(restCard).getByRole('button', { name: '跳过此站' }));
    expect(screen.getByText('已跳过（资料保留）')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复' }));
    expect(screen.getByRole('article', { name: '长椅休息区' })).toBeInTheDocument();
    // 提示持续可见（持久提示）
    expect(screen.getByText('已加入路线，请补充新路段步行时间')).toBeInTheDocument();
  });

  it('候选缺名称：转换入口标“未命名歇脚点”，转换后提示位置待确认', async () => {
    const user = userEvent.setup();
    render(<App />);
    await addPlace(user, '示例景点甲');

    // 只核对座位、不填名称：候选仍可转换
    const cardA = screen.getByRole('article', { name: '示例景点甲' });
    await user.click(within(cardA).getByRole('button', { name: '设施备注' }));
    await user.selectOptions(screen.getByLabelText('是否可坐'), 'yes');
    await user.click(screen.getByRole('button', { name: '确认修改' }));
    expect(await screen.findByText('歇脚点候选（你已核对：可坐）')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '转为休息点：未命名歇脚点' }));
    expect(screen.getByRole('article', { name: '未命名歇脚点' })).toBeInTheDocument();
    expect(screen.getByText('已加入路线，请补充新路段步行时间')).toBeInTheDocument();
    expect(screen.getByText('位置待确认，暂不能自动获取步行数据')).toBeInTheDocument();
  });
});
