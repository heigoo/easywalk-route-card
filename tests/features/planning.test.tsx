/**
 * P1 集成：地点搜索的错误可理解性与“矩阵查询 → 规划 → 候选 → 应用”闭环
 * （第 14.4、14.5 节；验证用例 T12 的 P1 侧、B01/B02 的界面表现）。
 * 使用 Worker 桩直接调用纯函数 plan，不访问网络。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../src/app/App';
import { plan } from '../../src/workers/planner';
import type { PlannerInput, PlannerRequestMessage, PlannerResponseMessage } from '../../src/workers/planner-types';

/** Worker 桩：收到请求后同步调用纯函数 plan，并按协议回发 */
class StubPlannerWorker {
  private listeners: Array<(event: MessageEvent<PlannerResponseMessage>) => void> = [];

  postMessage(message: unknown): void {
    const req = message as PlannerRequestMessage;
    queueMicrotask(() => {
      try {
        const result = plan(req.input as PlannerInput);
        this.emit({
          requestId: req.requestId,
          inputFingerprint: req.inputFingerprint,
          result,
        });
      } catch (e) {
        this.emit({
          requestId: req.requestId,
          inputFingerprint: req.inputFingerprint,
          error: { code: 'PLAN_FAILED', message: e instanceof Error ? e.message : '失败' },
        });
      }
    });
  }

  private emit(data: PlannerResponseMessage): void {
    const event = { data } as MessageEvent<PlannerResponseMessage>;
    for (const l of this.listeners) l(event);
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<PlannerResponseMessage>) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(): void {
    this.listeners = [];
  }

  terminate(): void {
    this.listeners = [];
  }
}

function matrixResponse(
  edges: Array<{ from: string; to: string; seconds: number }>,
  partial = false,
  reportedFeatures: Array<{ kind: string; note: string }> = [],
) {
  return {
    requestId: 'mx-1',
    data: {
      edges: edges.map((e) => ({
        fromId: e.from,
        toId: e.to,
        fromCoordinateRevision: 0,
        toCoordinateRevision: 0,
        state: 'ready' as const,
        distanceMeters: e.seconds,
        rawWalkingSeconds: e.seconds,
        provider: 'amap',
        providerApiVersion: 'v5',
        fetchedAt: '2026-09-22T05:00:00.000Z',
        reportedFeatures,
      })),
      failures: [],
      queryCoverage: partial ? ('partial' as const) : ('complete' as const),
      fetchedAt: '2026-09-22T05:00:00.000Z',
    },
    warnings: [],
  };
}

describe('P1 自动规划界面', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('Worker', StubPlannerWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('地图未配置时给出原因，并说明手动整理继续可用（T12）', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          code: 'AMAP_NOT_CONFIGURED',
          message: '服务端未配置 AMAP_WEB_SERVICE_KEY',
          retryable: false,
          fieldErrors: [],
          requestId: 'req-1',
        }),
      }),
    );
    render(<App />);
    await user.click(screen.getByRole('button', { name: '展开' }));
    await user.type(screen.getByLabelText('地点关键词'), '示例公园');
    await user.type(screen.getByLabelText('搜索城市'), '示例市');
    await user.click(screen.getByRole('button', { name: '搜索地点' }));
    expect(await screen.findByText(/地图服务未配置/)).toBeInTheDocument();
    // 手动功能仍可用
    await user.click(screen.getByRole('button', { name: '添加景点' }));
    expect(screen.getByLabelText('名称', { exact: true })).toBeInTheDocument();
  });

  it('计算路线后展示候选，应用后行程顺序按候选更新（第 14.5 节）', async () => {
    const user = userEvent.setup();
    render(<App />);
    // 展开 P1 分区后用地点搜索建立带坐标的行程
    const p1Toggle = screen.getByRole('button', { name: '展开' });
    await user.click(p1Toggle);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          requestId: 'r',
          data: {
            items: [
              { id: 'p1', name: '示例起点', district: '示例区', address: '示例路1号', location: { longitude: 116.4, latitude: 39.9 }, entranceStatus: 'pending' },
              { id: 'p2', name: '示例终点', district: '示例区', address: '示例路2号', location: { longitude: 116.42, latitude: 39.93 }, entranceStatus: 'pending' },
              { id: 'p3', name: '示例景点甲', district: '示例区', address: '示例路3号', location: { longitude: 116.41, latitude: 39.91 }, entranceStatus: 'pending' },
            ],
            nextPage: null,
          },
          warnings: [],
        }),
      })),
    );
    await user.type(screen.getByLabelText('地点关键词'), '示例');
    await user.type(screen.getByLabelText('搜索城市'), '示例市');
    await user.click(screen.getByRole('button', { name: '搜索地点' }));
    const items = await screen.findAllByRole('listitem');
    await within(items[0]).getByRole('button', { name: '设为起点' }).click();
    await within(items[1]).getByRole('button', { name: '设为终点' }).click();
    await within(items[2]).getByRole('button', { name: '设为景点' }).click();

    // 补全停留时长，使候选可核验（第 6.4.6 节）
    const nodeCard = screen.getByRole('article', { name: '示例景点甲' });
    await user.click(within(nodeCard).getByRole('button', { name: '编辑' }));
    await user.type(screen.getByLabelText('预计停留（分钟，留空=未知）'), '30');
    await user.type(screen.getByLabelText('园内预计步行（分钟）'), '8');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 恢复矩阵响应并计算：按请求中的 pairs 动态回边，保证边键与当前节点身份匹配
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { pairs: Array<{ fromId: string; toId: string }> };
        return {
          ok: true,
          json: async () =>
            matrixResponse(body.pairs.map((p, i) => ({ from: p.fromId, to: p.toId, seconds: 300 + i * 60 }))),
        };
      }),
    );
    await user.click(screen.getByRole('button', { name: '计算路线' }));
    await waitFor(() => expect(screen.queryByText('计算中…')).not.toBeInTheDocument());

    // 候选展示：预计步行与全程，且候选为可核验状态
    expect(await screen.findByText('主要建议')).toBeInTheDocument();
    expect(screen.getByText(/预计步行/)).toBeInTheDocument();
    expect(screen.getByText('数据完整')).toBeInTheDocument();

    // 应用候选：需用户明确触发；应用后结果区清空、行程保留景点并写入会话内地图值
    await user.click(screen.getByRole('button', { name: '应用此方案' }));
    await waitFor(() => expect(screen.queryByText('主要建议')).not.toBeInTheDocument());
    expect(screen.getByRole('article', { name: '示例景点甲' })).toBeInTheDocument();
    expect(screen.getAllByText(/步行约/).length).toBeGreaterThan(0);
    // 地图未返回阶梯信息：不显示任何“有阶梯/无台阶”结论（未知不等于没有）
    expect(screen.queryByText(/可能有阶梯/)).not.toBeInTheDocument();
    expect(screen.queryByText('无台阶')).not.toBeInTheDocument();
  });

  it('地图报告阶梯时路段行提示并可一键记录台阶核对（R-A3）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '展开' }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          requestId: 'r',
          data: {
            items: [
              { id: 'p1', name: '示例起点', district: '示例区', address: '示例路1号', location: { longitude: 116.4, latitude: 39.9 }, entranceStatus: 'pending' },
              { id: 'p2', name: '示例终点', district: '示例区', address: '示例路2号', location: { longitude: 116.42, latitude: 39.93 }, entranceStatus: 'pending' },
              { id: 'p3', name: '示例景点甲', district: '示例区', address: '示例路3号', location: { longitude: 116.41, latitude: 39.91 }, entranceStatus: 'pending' },
            ],
            nextPage: null,
          },
          warnings: [],
        }),
      })),
    );
    await user.type(screen.getByLabelText('地点关键词'), '示例');
    await user.type(screen.getByLabelText('搜索城市'), '示例市');
    await user.click(screen.getByRole('button', { name: '搜索地点' }));
    const items = await screen.findAllByRole('listitem');
    await within(items[0]).getByRole('button', { name: '设为起点' }).click();
    await within(items[1]).getByRole('button', { name: '设为终点' }).click();
    await within(items[2]).getByRole('button', { name: '设为景点' }).click();

    // 补全停留时长，使候选可核验（第 6.4.6 节）
    const nodeCard = screen.getByRole('article', { name: '示例景点甲' });
    await user.click(within(nodeCard).getByRole('button', { name: '编辑' }));
    await user.type(screen.getByLabelText('预计停留（分钟，留空=未知）'), '30');
    await user.type(screen.getByLabelText('园内预计步行（分钟）'), '8');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 矩阵边带阶梯报告
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { pairs: Array<{ fromId: string; toId: string }> };
        return {
          ok: true,
          json: async () =>
            matrixResponse(
              body.pairs.map((p, i) => ({ from: p.fromId, to: p.toId, seconds: 300 + i * 60 })),
              false,
              [{ kind: 'stairs', note: '高德标注阶梯' }],
            ),
        };
      }),
    );
    await user.click(screen.getByRole('button', { name: '计算路线' }));
    await waitFor(() => expect(screen.queryByText('计算中…')).not.toBeInTheDocument());
    await screen.findByText('主要建议');
    await user.click(screen.getByRole('button', { name: '应用此方案' }));
    await waitFor(() => expect(screen.queryByText('主要建议')).not.toBeInTheDocument());

    // 路段行出现阶梯提示；未核对前不下“无台阶”结论
    expect(screen.getAllByText('高德标注本段可能有阶梯（待核对）').length).toBeGreaterThan(0);
    expect(screen.queryByText(/无台阶/)).not.toBeInTheDocument();

    // 一键记录台阶核对：打开对话框并预选台阶项
    await user.click(screen.getAllByRole('button', { name: '记录台阶核对' })[0]);
    expect(screen.getByLabelText('台阶情况')).toBeInTheDocument();
    expect(screen.queryByLabelText('厕所开放情况')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('台阶情况'), 'yes');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 核对结果已写入 stairs 事实：重新打开按路段回读
    await user.click(screen.getAllByRole('button', { name: '记录台阶核对' })[0]);
    expect(screen.getByLabelText('台阶情况')).toHaveValue('yes');
  });

  it('终点前路段行可编辑并显示阶梯提示（Task 11，R02/R-A3）', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '展开' }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          requestId: 'r',
          data: {
            items: [
              { id: 'p1', name: '示例起点', district: '示例区', address: '示例路1号', location: { longitude: 116.4, latitude: 39.9 }, entranceStatus: 'pending' },
              { id: 'p2', name: '示例终点', district: '示例区', address: '示例路2号', location: { longitude: 116.42, latitude: 39.93 }, entranceStatus: 'pending' },
              { id: 'p3', name: '示例景点甲', district: '示例区', address: '示例路3号', location: { longitude: 116.41, latitude: 39.91 }, entranceStatus: 'pending' },
            ],
            nextPage: null,
          },
          warnings: [],
        }),
      })),
    );
    await user.type(screen.getByLabelText('地点关键词'), '示例');
    await user.type(screen.getByLabelText('搜索城市'), '示例市');
    await user.click(screen.getByRole('button', { name: '搜索地点' }));
    const items = await screen.findAllByRole('listitem');
    await within(items[0]).getByRole('button', { name: '设为起点' }).click();
    await within(items[1]).getByRole('button', { name: '设为终点' }).click();
    await within(items[2]).getByRole('button', { name: '设为景点' }).click();

    // 补全停留时长，使候选可核验（第 6.4.6 节）
    const nodeCard = screen.getByRole('article', { name: '示例景点甲' });
    await user.click(within(nodeCard).getByRole('button', { name: '编辑' }));
    await user.type(screen.getByLabelText('预计停留（分钟，留空=未知）'), '30');
    await user.type(screen.getByLabelText('园内预计步行（分钟）'), '8');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 矩阵边带阶梯报告：构造“起点＋1 景点＋终点”行程（含“最后一站→终点”段）
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { pairs: Array<{ fromId: string; toId: string }> };
        return {
          ok: true,
          json: async () =>
            matrixResponse(
              body.pairs.map((p, i) => ({ from: p.fromId, to: p.toId, seconds: 300 + i * 60 })),
              false,
              [{ kind: 'stairs', note: '高德标注阶梯' }],
            ),
        };
      }),
    );
    await user.click(screen.getByRole('button', { name: '计算路线' }));
    await waitFor(() => expect(screen.queryByText('计算中…')).not.toBeInTheDocument());
    await screen.findByText('主要建议');
    await user.click(screen.getByRole('button', { name: '应用此方案' }));
    await waitFor(() => expect(screen.queryByText('主要建议')).not.toBeInTheDocument());

    // “最后一站→终点”路段行存在（修复前终点分支漏渲染该行，按钮根本不存在）
    const legEditBtn = screen.getByRole('button', { name: '编辑路段 示例景点甲 到 示例终点' });
    // 该段的阶梯提示可见（按路段行定界，不误认其他路段的提示）
    const legRow = legEditBtn.closest('div')!;
    expect(within(legRow).getByText('高德标注本段可能有阶梯（待核对）')).toBeInTheDocument();

    // 可点开编辑弹层并填“其中步行”，确认生效
    await user.click(legEditBtn);
    expect(screen.getByText('路段：示例景点甲 → 示例终点')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('其中步行（分钟）'));
    await user.type(screen.getByLabelText('其中步行（分钟）'), '13');
    await user.click(screen.getByRole('button', { name: '确认修改' }));

    // 生效验证：路段行更新为手动值；重新打开弹层回读同一数值
    const updatedBtn = screen.getByRole('button', { name: '编辑路段 示例景点甲 到 示例终点' });
    expect(within(updatedBtn.closest('div')!).getByText(/步行约 13 分钟/)).toBeInTheDocument();
    await user.click(updatedBtn);
    expect(screen.getByLabelText('其中步行（分钟）')).toHaveValue('13');
    await user.click(screen.getByRole('button', { name: '取消' }));
  });
});