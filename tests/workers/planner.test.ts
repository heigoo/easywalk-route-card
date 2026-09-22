// @vitest-environment node
/**
 * 自动规划算法核心与 Worker 协议测试（验证用例 T08、T09 及第 6.3～6.6 节口径）。
 * 地点与数字均为虚构示例。
 */
import { describe, expect, it } from 'vitest';
import type {
  Constraints,
  Itinerary,
  OpeningWindow,
  PlaceRef,
  RestNode,
  RouteNode,
  VisitNode,
} from '../../shared/contracts/domain';
import { SCHEMA_VERSION, unknownFact, userFact } from '../../shared/contracts/domain';
import { listCandidatePairs, plan } from '../../src/workers/planner';
import type { PlannerInput, PlannerResult } from '../../src/workers/planner-types';
import { PLANNER_PROTOCOL_VERSION } from '../../src/workers/planner-types';
import { handlePlannerMessage } from '../../src/workers/planner.worker';
import {
  createPlannerClient,
  PlannerClientError,
  type PlannerRequestMessage,
  type PlannerResponseMessage,
  type PlannerWorkerLike,
} from '../../src/workers';

// ---------------------------------------------------------------------------
// 用例构造辅助
// ---------------------------------------------------------------------------

interface VisitSpec {
  key: string;
  required?: boolean;
  visitSeconds?: number | null;
  insideWalkSeconds?: number | null;
  openingWindows?: OpeningWindow[] | null;
}

interface RestSpec {
  key: string;
  restSeconds?: number | null;
  seat?: boolean | null;
}

interface CaseOptions {
  visits: VisitSpec[];
  rests?: RestSpec[];
  /** 节点当前顺序（键名）；缺省为声明顺序 */
  order?: string[];
  constraints?: Partial<Constraints>;
  travelDate?: string | null;
  departureLocalTime?: string | null;
  destination?: boolean;
  /** 明确给定的边（number=已知秒数；null=明确不可达）；未列出的边保持未知 */
  edges?: Record<string, number | null>;
  /** 未列出的候选边默认填充的秒数（缺省保持未知） */
  defaultEdgeSeconds?: number;
}

function makePlace(name: string, index: number, openingWindows?: OpeningWindow[] | null, travelDate?: string | null): PlaceRef {
  return {
    id: `place-${name}`,
    name,
    providerPoiId: null,
    location: { longitude: 116.4 + index / 1000, latitude: 39.9 + index / 1000 },
    coordinateRevision: 0,
    entranceConfirmed: true,
    openingDescription: unknownFact<string>(),
    openingSchedule: openingWindows
      ? {
          value: {
            applicableDate: travelDate ?? '2026-10-01',
            timezone: 'Asia/Shanghai',
            windows: openingWindows,
          },
          sourceType: 'user',
          sourceName: null,
          sourceReference: null,
          fetchedAt: null,
          reviewState: 'userChecked',
          checkedAt: null,
          applicableDate: null,
          note: null,
        }
      : unknownFact(),
  };
}

function buildCase(options: CaseOptions): { input: PlannerInput } {
  const travelDate = options.travelDate === undefined ? '2026-10-01' : options.travelDate;
  const places: Record<string, PlaceRef> = {};
  const nodes: Record<string, RouteNode> = {};
  let index = 0;

  const originPlace = makePlace('起点', index++);
  const destPlace = makePlace('终点', index++);
  places[originPlace.id] = originPlace;
  places[destPlace.id] = destPlace;

  for (const v of options.visits) {
    const place = makePlace(v.key, index++, v.openingWindows ?? null, travelDate);
    places[place.id] = place;
    const node: VisitNode = {
      kind: 'visit',
      id: v.key,
      placeId: place.id,
      required: v.required ?? true,
      skipped: false,
      visitSeconds: v.visitSeconds === undefined ? 1800 : v.visitSeconds,
      insideWalkSeconds: v.insideWalkSeconds === undefined ? 0 : v.insideWalkSeconds,
      activityPlan: null,
      notes: '',
    };
    nodes[node.id] = node;
  }
  for (const r of options.rests ?? []) {
    const place = makePlace(r.key, index++);
    places[place.id] = place;
    const node: RestNode = {
      kind: 'rest',
      id: r.key,
      placeId: place.id,
      restSeconds: r.restSeconds === undefined ? 600 : r.restSeconds,
      seatFact: r.seat === null || r.seat === undefined ? userFact(true) : userFact(r.seat),
      skipped: false,
      notes: '',
    };
    nodes[node.id] = node;
  }

  const order = options.order ?? [...options.visits.map((v) => v.key), ...(options.rests ?? []).map((r) => r.key)];
  const itinerary: Itinerary = {
    id: 'it-test',
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    title: '测试行程（示例数据）',
    city: '示例市',
    travelDate,
    departureLocalTime:
      options.departureLocalTime === undefined ? '09:00' : options.departureLocalTime,
    timezone: 'Asia/Shanghai',
    places,
    origin: { id: 'O', placeId: originPlace.id, role: 'origin' },
    destination:
      options.destination === false ? null : { id: 'D', placeId: destPlace.id, role: 'destination' },
    nodes,
    nodeOrder: order,
    facilities: [],
    legs: {},
    constraints: {
      maxTotalWalkSeconds: null,
      maxContinuousWalkSeconds: null,
      minRestSeconds: null,
      latestEndLocal: null,
      walkingFactor: 1,
      passageRequirements: [],
      ...options.constraints,
    },
    updatedAt: '2026-09-22T00:00:00.000Z',
  };

  // 只填入第 6.3 节候选边清单内的边；清单外一律不请求
  const edges: Record<string, number | null> = {};
  for (const pair of listCandidatePairs(itinerary)) {
    const key = `${pair.from}|${pair.to}`;
    if (options.edges && key in options.edges) {
      edges[key] = options.edges[key];
    } else if (options.defaultEdgeSeconds !== undefined) {
      edges[key] = options.defaultEdgeSeconds;
    }
  }
  return { input: { itinerary, edges } };
}

function candidateOrders(result: PlannerResult): string[][] {
  return result.candidates.map((c) => c.nodeOrder);
}

// ---------------------------------------------------------------------------
// T08：必去全保留、休息锚点不动、可选至少留一个（第 6.1、6.2 节）
// ---------------------------------------------------------------------------

describe('T08 搜索边界与区间归属（第 6.1、6.2 节）', () => {
  it('必去景点全保留、休息锚点固定、区间不跨锚点搬移', () => {
    const { input } = buildCase({
      visits: [
        { key: 'A', required: true },
        { key: 'B', required: false },
        { key: 'C', required: false },
      ],
      rests: [{ key: 'R' }],
      order: ['A', 'B', 'R', 'C'],
      defaultEdgeSeconds: 600,
    });
    const result = plan(input);

    expect(result.candidates).toHaveLength(6);
    for (const c of result.candidates) {
      expect(c.nodeOrder[0]).toBe('O');
      expect(c.nodeOrder[c.nodeOrder.length - 1]).toBe('D');
      expect(c.nodeOrder).toContain('A'); // 必去全保留
      expect(c.nodeOrder).toContain('R'); // 休息锚点不动
      const restIndex = c.nodeOrder.indexOf('R');
      // A、B 归属锚点前的区间，C 归属锚点后的区间（第 6.2.2 节）
      for (const id of ['A', 'B']) {
        if (c.nodeOrder.includes(id)) expect(c.nodeOrder.indexOf(id)).toBeLessThan(restIndex);
      }
      if (c.nodeOrder.includes('C')) expect(c.nodeOrder.indexOf('C')).toBeGreaterThan(restIndex);
    }
    // 可选景点可省略：存在去掉 B 的候选，也存在保留 B 的候选
    expect(result.candidates.some((c) => !c.keptOptional.includes('B'))).toBe(true);
    expect(result.candidates.some((c) => c.keptOptional.includes('B'))).toBe(true);
  });

  it('无必去且全部可选时，最终至少保留一个景点（第 6.2.3 节）', () => {
    const { input } = buildCase({
      visits: [
        { key: 'X', required: false },
        { key: 'Y', required: false },
      ],
      defaultEdgeSeconds: 600,
    });
    const result = plan(input);

    expect(result.candidates).toHaveLength(4);
    for (const c of result.candidates) {
      expect(c.keptOptional.length).toBeGreaterThanOrEqual(1);
    }
    expect(candidateOrders(result)).not.toContainEqual(['O', 'D']); // 空行程被排除
  });

  it('超出搜索上限抛错提示，不丢弃节点（第 6.1 节）', () => {
    const sevenVisits = buildCase({
      visits: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((key) => ({ key })),
      defaultEdgeSeconds: 600,
    });
    expect(() => plan(sevenVisits.input)).toThrowError(/超出自动规划上限 6/);

    const tooManyNodes = buildCase({
      visits: ['A', 'B', 'C', 'E', 'F', 'G'].map((key) => ({ key })),
      rests: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map((key) => ({ key })),
      order: ['A', 'R1', 'B', 'R2', 'C', 'R3', 'E', 'R4', 'F', 'R5', 'G', 'R6'],
      defaultEdgeSeconds: 600,
    });
    expect(() => plan(tooManyNodes.input)).toThrowError(/超出自动规划上限 12/);
  });
});

// ---------------------------------------------------------------------------
// T09：未知数据的候选不以零成本排第一（第 6.5、6.6 节）
// ---------------------------------------------------------------------------

describe('T09 完整数据优先，未知不当零成本（第 6.5 节）', () => {
  it('含未知路段的候选排到完整候选之后', () => {
    const { input } = buildCase({
      visits: [
        { key: 'A', required: false },
        { key: 'X', required: false },
      ],
      edges: { 'O|A': 100, 'A|D': 100, 'X|D': 50 }, // O→X、A↔X 未知
    });
    const result = plan(input);

    const orders = candidateOrders(result);
    // 唯一可核验候选 [O,A,D]（总步行 200）排第一，尽管未知候选可能“看起来更短”
    expect(orders[0]).toEqual(['O', 'A', 'D']);
    expect(result.primary?.nodeOrder).toEqual(['O', 'A', 'D']);
    expect(result.candidates[0].verifiable).toBe(true);
    expect(result.candidates[0].totalWalkSeconds).toBe(200);

    const unknownCandidate = result.candidates.find((c) => c.nodeOrder.join('|') === 'O|X|D')!;
    expect(unknownCandidate.verifiable).toBe(false);
    expect(unknownCandidate.unknownFields.length).toBeGreaterThan(0);
    // 含未知路段，比较范围受限需说明
    expect(result.conflicts.some((m) => m.includes('搜索数据不完整'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 第 6.5 节排序元组：保留可选降序 → 总步行升序 → 连续升序 → 总用时升序 → 原始顺序平局
// ---------------------------------------------------------------------------

describe('排序元组（第 6.5 节）', () => {
  it('保留可选多者优先；总步行少者优先；同分用原始节点顺序稳定平局', () => {
    const { input } = buildCase({
      visits: [
        { key: 'A', required: false },
        { key: 'B', required: false },
      ],
      edges: {
        'O|A': 50,
        'A|D': 50,
        'O|B': 100,
        'A|B': 100,
        'B|A': 100,
        'B|D': 100,
      },
    });
    const result = plan(input);

    // keep2 组（步行 250）整体先于 keep1 组；组内步行升序；步行相同按原始顺序
    expect(candidateOrders(result)).toEqual([
      ['O', 'A', 'B', 'D'], // keep2，步行 250（与下一个同分，原始顺序优先）
      ['O', 'B', 'A', 'D'], // keep2，步行 250
      ['O', 'A', 'D'], // keep1，步行 100
      ['O', 'B', 'D'], // keep1，步行 200
    ]);
    expect(result.primary?.nodeOrder).toEqual(['O', 'A', 'B', 'D']);
    // 至多两个 nodeOrder 非重复的备选，不凑数
    expect(result.alternatives.map((c) => c.nodeOrder)).toEqual([
      ['O', 'B', 'A', 'D'],
      ['O', 'A', 'D'],
    ]);
  });

  it('同一输入两次 plan 输出相同 resultId 与候选顺序（确定性）', () => {
    const { input } = buildCase({
      visits: [
        { key: 'A', required: false },
        { key: 'B', required: false },
      ],
      edges: { 'O|A': 50, 'A|D': 50, 'O|B': 100, 'A|B': 100, 'B|A': 100, 'B|D': 100 },
    });
    const first = plan(input, { now: '2026-09-22T00:00:00.000Z' });
    const second = plan(input, { now: '2026-09-22T00:00:00.000Z' });

    expect(second.resultId).toBe(first.resultId);
    expect(second.inputFingerprint).toBe(first.inputFingerprint);
    expect(candidateOrders(second)).toEqual(candidateOrders(first));

    // 另建一份等价输入快照，指纹一致
    const rebuilt = buildCase({
      visits: [
        { key: 'A', required: false },
        { key: 'B', required: false },
      ],
      edges: { 'O|A': 50, 'A|D': 50, 'O|B': 100, 'A|B': 100, 'B|A': 100, 'B|D': 100 },
    });
    expect(plan(rebuilt.input).inputFingerprint).toBe(first.inputFingerprint);
  });
});

// ---------------------------------------------------------------------------
// 第 6.4.5 节：硬限剪枝与“未知不按零成本剪枝”
// ---------------------------------------------------------------------------

describe('硬限剪枝（第 6.4.5 节）', () => {
  it('总步行超限的分支不出现且 pruned 计数增加', () => {
    const { input } = buildCase({
      visits: [
        { key: 'A', required: false },
        { key: 'B', required: false },
      ],
      constraints: { maxTotalWalkSeconds: 150 },
      edges: {
        'O|A': 100,
        'A|D': 100,
        'O|B': 60,
        'B|D': 60,
        'A|B': 20,
        'B|A': 20,
      },
    });
    const result = plan(input);

    expect(result.searchSpace.pruned).toBe(3); // [O,A,D] 200、[O,A,B,D] 180、[O,B,A,D] 180
    expect(result.searchSpace.enumerated).toBe(4); // [O,D] 空行程不计
    expect(candidateOrders(result)).toEqual([['O', 'B', 'D']]);
    expect(result.primary?.nodeOrder).toEqual(['O', 'B', 'D']);
  });

  it('未知数据不按零成本剪枝：已知下界未超限则保留为待核验候选', () => {
    const { input } = buildCase({
      visits: [{ key: 'A', required: true }],
      constraints: { maxTotalWalkSeconds: 150 },
      edges: { 'A|D': 140 }, // O→A 未知
    });
    const result = plan(input);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].verifiable).toBe(false);
    expect(result.candidates[0].totalWalkSeconds).toBe(null);
    expect(result.searchSpace.pruned).toBe(0);
  });

  it('已知下界已超限则确定剪枝（与未知部分无关）', () => {
    const { input } = buildCase({
      visits: [{ key: 'A', required: true }],
      constraints: { maxTotalWalkSeconds: 150 },
      edges: { 'A|D': 200 }, // O→A 未知，但已知下界 200 已超限
    });
    const result = plan(input);

    expect(result.candidates).toHaveLength(0);
    expect(result.searchSpace.pruned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 第 6.4.4 节：开放时间等待计入总用时；最晚结束 FAIL 不进可核验推荐
// ---------------------------------------------------------------------------

describe('时间推进与硬限判定（第 6.4.4 节）', () => {
  it('到达早于开窗时累计等待，等待计入总行程用时', () => {
    const { input } = buildCase({
      visits: [
        { key: 'A', required: true, visitSeconds: 1800, insideWalkSeconds: 0, openingWindows: [{ startLocalTime: '10:00', endLocalTime: '18:00' }] },
      ],
      edges: { 'O|A': 1800, 'A|D': 600 },
    });
    const result = plan(input);

    const candidate = result.candidates[0];
    expect(candidate.verifiable).toBe(true);
    // 步行 1800+600；用时 = 步行 1800 + 等待 1800（09:30 到，10:00 开门）+ 停留 1800 + 步行 600
    expect(candidate.totalWalkSeconds).toBe(2400);
    expect(candidate.totalDurationSeconds).toBe(6000);
  });

  it('开放时间不适用（未核对）时不累计等待', () => {
    const { input } = buildCase({
      visits: [
        {
          key: 'A',
          required: true,
          visitSeconds: 1800,
          insideWalkSeconds: 0,
          // 结构化时段存在但由测试改为 unknown 核对状态：直接不提供 openingWindows
        },
      ],
      edges: { 'O|A': 1800, 'A|D': 600 },
    });
    const result = plan(input);
    expect(result.candidates[0].totalDurationSeconds).toBe(4200); // 无等待
  });

  it('最晚结束 FAIL 的候选保留在列表但不进入可核验推荐', () => {
    const base = {
      visits: [{ key: 'A', required: true, visitSeconds: 1800, insideWalkSeconds: 0 }],
      edges: { 'O|A': 1800, 'A|D': 600 },
    };
    const failCase = buildCase({
      ...base,
      constraints: { latestEndLocal: '2026-10-01T10:00' }, // 结束 10:12
    });
    const failResult = plan(failCase.input);
    expect(failResult.candidates).toHaveLength(1);
    expect(failResult.candidates[0].violations).toContain('预计结束时间晚于你设置的最晚结束');
    expect(failResult.primary).toBeNull();
    expect(failResult.conflicts.some((m) => m.includes('完整候选均违反硬性限制'))).toBe(true);

    const passCase = buildCase({
      ...base,
      constraints: { latestEndLocal: '2026-10-01T10:30' },
    });
    const passResult = plan(passCase.input);
    expect(passResult.candidates[0].violations).toEqual([]);
    expect(passResult.primary?.nodeOrder).toEqual(['O', 'A', 'D']);
  });
});

// ---------------------------------------------------------------------------
// 第 6.6 节：明确不可达的边不参与组合
// ---------------------------------------------------------------------------

describe('部分查询失败与不可达（第 6.6 节）', () => {
  it('含明确 null 边的组合被排除，并给出冲突说明', () => {
    const { input } = buildCase({
      visits: [{ key: 'A', required: true }],
      edges: { 'O|A': null }, // 明确不可达；A|D 未查询不等于不可达
    });
    const result = plan(input);

    expect(result.candidates).toHaveLength(0);
    expect(result.primary).toBeNull();
    expect(result.conflicts.some((m) => m.includes('明确不可达'))).toBe(true);
    // 数据完整（无未知边参与歧义）时允许给出确定结论
    expect(result.conflicts.some((m) => m.includes('没有找到可行路线组合'))).toBe(true);
    expect(result.conflicts.some((m) => m.includes('无法确定'))).toBe(false);
  });

  it('数据缺失导致无可用结论时，不给“所有方案均不可行”的确定结论', () => {
    const { input } = buildCase({
      visits: [
        { key: 'A', required: true },
        { key: 'B', required: true },
      ],
      edges: { 'O|A': 100, 'A|D': 100, 'O|B': null }, // B 侧含未知与不可达混合
    });
    const result = plan(input);

    // [O,B,A,D] 被不可达边排除；[O,A,B,D] 含未知路段，作为待核验候选保留（B 为必去不能省略）
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].verifiable).toBe(false);
    expect(result.primary).toBeNull();
    expect(result.conflicts.some((m) => m.includes('明确不可达'))).toBe(true);
    expect(result.conflicts.some((m) => m.includes('搜索数据不完整'))).toBe(true);
    expect(result.conflicts.some((m) => m.includes('无法确定是否存在满足硬性限制的方案'))).toBe(true);
    expect(result.conflicts.some((m) => m.includes('没有找到可行路线组合'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 第 6.3 节：候选有向边数量上界
// ---------------------------------------------------------------------------

describe('路段查询数量上界（第 6.3 节）', () => {
  it('每区间含 k 景点时上界 k²＋k＋1，且不生成跨锚点/进出起终点的无效边', () => {
    const { input } = buildCase({
      visits: ['A', 'B', 'C', 'E', 'F', 'G'].map((key) => ({ key, required: false })),
      rests: [{ key: 'R1' }, { key: 'R2' }],
      order: ['A', 'B', 'R1', 'C', 'E', 'R2', 'F', 'G'],
      defaultEdgeSeconds: 600,
    });
    const pairs = listCandidatePairs(input.itinerary);
    const keys = pairs.map((p) => `${p.from}|${p.to}`);

    // 三个区间各 k=2 → 每段上界 2²＋2＋1 = 7，总计 21（对照 6.3 节算例口径）
    expect(pairs).toHaveLength(21);
    expect(new Set(keys).size).toBe(keys.length); // 去重
    expect(keys.some((k) => k.endsWith('|O'))).toBe(false); // 不请求进入起点
    expect(keys.some((k) => k.startsWith('D|'))).toBe(false); // 不请求从终点出发
    expect(keys.some((k) => k === 'A|C')).toBe(false); // 不跨固定锚点
    expect(keys.some((k) => k === 'B|E')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker 消息协议与客户端（第 6 章）
// ---------------------------------------------------------------------------

function simpleInput(): PlannerInput {
  return buildCase({
    visits: [{ key: 'A', required: true }],
    edges: { 'O|A': 600, 'A|D': 600 },
  }).input;
}

function fakePlannerResult(): PlannerResult {
  return {
    resultId: 'plan-fake',
    inputFingerprint: 'fp-fake',
    candidates: [],
    primary: null,
    alternatives: [],
    searchSpace: { enumerated: 0, pruned: 0, budgetExceeded: false },
    conflicts: [],
    generatedAt: '2026-09-22T00:00:00.000Z',
  };
}

describe('Worker 消息协议（第 6 章）', () => {
  it('版本不匹配回传 VERSION_MISMATCH 错误', () => {
    const message = handlePlannerMessage({
      type: 'plan',
      version: 999,
      requestId: 'req-x',
      inputFingerprint: 'fp-x',
      input: simpleInput(),
    });
    expect('error' in message && message.error.code).toBe('VERSION_MISMATCH');
    expect(message.requestId).toBe('req-x');
  });

  it('plan 抛错时回传 PLAN_FAILED 与中文原因（含 requestId/inputFingerprint）', () => {
    const overLimit = buildCase({
      visits: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((key) => ({ key })),
      defaultEdgeSeconds: 600,
    }).input;
    const message = handlePlannerMessage({
      type: 'plan',
      version: PLANNER_PROTOCOL_VERSION,
      requestId: 'req-fail',
      inputFingerprint: 'fp-fail',
      input: overLimit,
    });
    expect('error' in message && message.error.code).toBe('PLAN_FAILED');
    expect('error' in message && message.error.message).toContain('超出自动规划上限');
    expect(message.inputFingerprint).toBe('fp-fail');
  });

  it('正常请求回传 result', () => {
    const message = handlePlannerMessage({
      type: 'plan',
      version: PLANNER_PROTOCOL_VERSION,
      requestId: 'req-ok',
      inputFingerprint: 'fp-ok',
      input: simpleInput(),
    });
    expect('result' in message && message.result.primary?.nodeOrder).toEqual(['O', 'A', 'D']);
  });
});

/** 桩 Worker：记录外发消息，支持手动回发响应 */
class StubWorker implements PlannerWorkerLike {
  readonly posted: PlannerRequestMessage[] = [];
  terminated = false;
  private listeners: Array<(event: MessageEvent<PlannerResponseMessage>) => void> = [];

  postMessage(message: unknown): void {
    this.posted.push(message as PlannerRequestMessage);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(_type: 'message', listener: (event: MessageEvent<PlannerResponseMessage>) => void): void {
    this.listeners.push(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<PlannerResponseMessage>) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }

  emit(message: PlannerResponseMessage): void {
    for (const listener of this.listeners) {
      listener({ data: message } as MessageEvent<PlannerResponseMessage>);
    }
  }

  get lastMessage(): PlannerRequestMessage {
    return this.posted[this.posted.length - 1];
  }
}

describe('PlannerClient（第 6 章）', () => {
  it('run 发送协议消息并按 requestId 关联响应', async () => {
    const stub = new StubWorker();
    const client = createPlannerClient({ createWorker: () => stub });

    const promise = client.run(simpleInput(), 'fp-1');
    expect(stub.lastMessage.type).toBe('plan');
    expect(stub.lastMessage.version).toBe(PLANNER_PROTOCOL_VERSION);
    expect(stub.lastMessage.inputFingerprint).toBe('fp-1');
    expect(stub.lastMessage.requestId).toBeTruthy();

    const fake = fakePlannerResult();
    // 未知 requestId 的响应被忽略
    stub.emit({ requestId: 'req-unknown', inputFingerprint: 'fp-1', result: fake });
    stub.emit({ requestId: stub.lastMessage.requestId, inputFingerprint: 'fp-1', result: fake });
    await expect(promise).resolves.toBe(fake);
  });

  it('服务端错误按 code 拒绝', async () => {
    const stub = new StubWorker();
    const client = createPlannerClient({ createWorker: () => stub });

    const promise = client.run(simpleInput(), 'fp-2');
    stub.emit({
      requestId: stub.lastMessage.requestId,
      inputFingerprint: 'fp-2',
      error: { code: 'PLAN_FAILED', message: '计算失败' },
    });
    await expect(promise).rejects.toMatchObject({ code: 'PLAN_FAILED', message: '计算失败' });
  });

  it('cancel 终止 Worker 并以 REQUEST_CANCELLED 拒绝未完成请求', async () => {
    const stub = new StubWorker();
    const client = createPlannerClient({ createWorker: () => stub });

    const pending = client.run(simpleInput(), 'fp-3');
    client.cancel();

    await expect(pending).rejects.toBeInstanceOf(PlannerClientError);
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(stub.terminated).toBe(true);

    // 取消后再请求直接拒绝
    await expect(client.run(simpleInput(), 'fp-4')).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
    });
  });
});
