/**
 * 自动规划算法核心（详细设计说明书第 6 章）：纯函数、无网络请求、无 DOM 依赖。
 *
 * 口径约定：
 * - 休息事件分类复用 src/domain/compute.ts 的 classifyRest（第 5.3 节）；
 * - 连续步行按“已确认坐休确定分界、未核实休息按可能分界切分下界”，
 *   下界只取单个区间的已知部分，不把可能分界前后相加以断言超限（第 5.3、6.4.4 节）；
 * - 开放时间等待仅在结构化时段适用（travelDate 匹配、reviewState 非 unknown、value 非 null）
 *   且到达早于开窗时累计（第 5.1、6.4.4 节）；
 * - 明确不可达（null）的边不参与组合；未知（缺失）边不按零成本剪枝或排名（第 6.6 节）。
 *
 * 实现备注：到达时刻的“本地秒”按东八区偏移换算后再取日秒（第 6.4.4 节“到达早于开窗则累等待”的语义）。
 * compute.ts 的 computeStats 同样经 epochToLocalDaySeconds 取东八区本地日秒再与开窗秒比较，
 * 两个文件的时间口径已统一为本地日秒（Asia/Shanghai），不存在按 UTC 日秒比较的偏差。
 */
import type { Itinerary, OpeningWindow, VisitNode } from '../../shared/contracts/domain';
import { activeSequence, MAX_ACTIVITY_NODES, MAX_VISIT_NODES } from '../../shared/contracts/domain';
import { classifyRest } from '../domain/compute';
import { computeInputFingerprint, stableStringify } from '../domain/fingerprint';
import {
  listInsertableRestCandidates,
  type InsertableRestCandidate,
} from '../domain/insertRest';
import type { PlannerCandidate, PlannerInput, PlannerResult } from './planner-types';

/** 与 domain/compute.ts 一致的时间解析口径：行程当前固定东八区（Asia/Shanghai） */

export interface PlanOptions {
  /** 注入生成时间（测试用）；缺省为当前时间 */
  now?: string;
}

// ---------------------------------------------------------------------------
// 第 6.2 节：输入预处理
// ---------------------------------------------------------------------------

/** 区间：固定锚点之间的景点归属段（第 6.1、6.2.2 节） */
interface Segment {
  startAnchor: string | null;
  endAnchor: string | null;
  /** 按当前顺序归属本区间的景点 */
  visits: string[];
}

/** 由当前顺序划分休息锚点与各景点所属区间（第 6.2.2 节） */
function buildSegments(it: Itinerary, seq: string[]): Segment[] {
  const originId = it.origin?.id ?? null;
  const destId = it.destination?.id ?? null;
  const segments: Segment[] = [];
  let current: Segment = { startAnchor: originId, endAnchor: null, visits: [] };
  for (const id of seq) {
    if (id === originId) continue;
    if (id === destId) {
      current.endAnchor = id;
      segments.push(current);
      return segments;
    }
    const node = it.nodes[id];
    if (node?.kind === 'rest') {
      current.endAnchor = id;
      segments.push(current);
      current = { startAnchor: id, endAnchor: null, visits: [] };
    } else {
      current.visits.push(id);
    }
  }
  if (current.startAnchor !== null || current.visits.length > 0) segments.push(current);
  return segments;
}

/** 第 6.3 节：按区间生成可能用到的有向路段（含空区间起点直达终点，不跨固定锚点） */
export function listCandidatePairs(itinerary: Itinerary): Array<{ from: string; to: string }> {
  const segments = buildSegments(itinerary, activeSequence(itinerary));
  const seen = new Set<string>();
  const pairs: Array<{ from: string; to: string }> = [];
  const push = (from: string, to: string): void => {
    if (from === to) return;
    const key = `${from}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ from, to });
  };
  for (const seg of segments) {
    // 区间含 k 个景点时，本段候选有向边上界为 k²＋k＋1（起点/终点齐备时）
    if (seg.startAnchor !== null && seg.endAnchor !== null) push(seg.startAnchor, seg.endAnchor);
    for (const v of seg.visits) {
      if (seg.startAnchor !== null) push(seg.startAnchor, v);
      if (seg.endAnchor !== null) push(v, seg.endAnchor);
    }
    for (const a of seg.visits) {
      for (const b of seg.visits) {
        if (a !== b) push(a, b);
      }
    }
  }
  // 可插入歇脚候选：有效序列相邻边上枚举插入边（a→R→b）。
  // 优先挂靠站相邻边，其次其它相邻边（长连续段也可插入）；总量有上限，避免矩阵爆炸。
  const seq = activeSequence(itinerary);
  const inserts = listInsertableRestCandidates(itinerary);
  type InsertSlot = { a: string; b: string; r: (typeof inserts)[number]; hostFirst: boolean };
  const slots: InsertSlot[] = [];
  for (const r of inserts) {
    for (let i = 0; i < seq.length - 1; i++) {
      const a = seq[i];
      const b = seq[i + 1];
      slots.push({ a, b, r, hostFirst: a === r.hostNodeId || b === r.hostNodeId });
    }
  }
  slots.sort((x, y) => Number(y.hostFirst) - Number(x.hostFirst));
  let insertPairBudget = MAX_INSERT_MATRIX_PAIRS;
  for (const slot of slots) {
    if (insertPairBudget <= 0) break;
    const before = pairs.length;
    push(slot.a, slot.r.virtualId);
    push(slot.r.virtualId, slot.b);
    insertPairBudget -= pairs.length - before;
  }
  return pairs;
}

/** 插入歇脚相关的矩阵边上限（成对计：a→R 与 R→b）；超出部分不取数，规划侧自动跳过 */
export const MAX_INSERT_MATRIX_PAIRS = 32;

// ---------------------------------------------------------------------------
// 边解析与显示名
// ---------------------------------------------------------------------------

type EdgeResolution =
  | { kind: 'known'; seconds: number }
  | { kind: 'unreachable' }
  | { kind: 'unknown' };

function placeIdOf(it: Itinerary, id: string): string | null {
  if (it.origin?.id === id) return it.origin.placeId;
  if (it.destination?.id === id) return it.destination.placeId;
  return it.nodes[id]?.placeId ?? null;
}

function virtualRestOf(id: string, inserts: Map<string, InsertableRestCandidate>): InsertableRestCandidate | null {
  return inserts.get(id) ?? null;
}

/** 同一已确认入口的相邻节点为零衔接边（第 7.2 节，与 rebuildLegs 口径一致） */
function isSameEntrance(it: Itinerary, a: string, b: string): boolean {
  const pa = placeIdOf(it, a);
  const pb = placeIdOf(it, b);
  if (!pa || !pb || pa !== pb) return false;
  return it.places[pa]?.entranceConfirmed === true;
}

/** 解析一条有向边：调用方数据优先；其次同一入口零衔接；否则未知（第 6.6 节） */
function resolveEdge(
  it: Itinerary,
  edges: Record<string, number | null>,
  from: string,
  to: string,
): EdgeResolution {
  const raw = edges[`${from}|${to}`];
  if (raw !== undefined) return raw === null ? { kind: 'unreachable' } : { kind: 'known', seconds: raw };
  if (isSameEntrance(it, from, to)) return { kind: 'known', seconds: 0 };
  return { kind: 'unknown' };
}

function displayName(
  it: Itinerary,
  id: string,
  inserts: Map<string, InsertableRestCandidate> = new Map(),
): string {
  if (it.origin?.id === id) return '起点';
  if (it.destination?.id === id) return '终点';
  const virtual = virtualRestOf(id, inserts);
  if (virtual) return virtual.name;
  const node = it.nodes[id];
  if (!node) return id;
  return it.places[node.placeId]?.name ?? id;
}

// ---------------------------------------------------------------------------
// 时间工具（与 domain/compute.ts 同口径：东八区、HH:mm）
// ---------------------------------------------------------------------------

/** 本地日期时间转 epoch 秒；非法输入返回 null（同 compute.ts 的 addSecondsToLocal） */
function epochOfLocal(date: string, time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const t = new Date(`${date}T${time}:00+08:00`).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

/** 完整本地时间（"YYYY-MM-DDTHH:mm"）转 epoch 秒；非法输入返回 null */
function epochOfDateTime(localDateTime: string): number | null {
  const t = new Date(`${localDateTime}:00+08:00`).getTime();
  return Number.isNaN(t) ? null : t / 1000;
}

/** 本地 "HH:mm" 转当日秒；非法输入返回 null（同 compute.ts 的 localDaySeconds） */
function localDaySeconds(time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 3600 + m * 60;
}

/** 结构化开放时段是否适用于出游日期（第 5.1 节：travelDate 匹配、reviewState 非 unknown、value 非 null） */
function applicableWindows(it: Itinerary, placeId: string): OpeningWindow[] | null {
  const place = it.places[placeId];
  const fact = place?.openingSchedule;
  if (!place || !it.travelDate) return null;
  if (!fact || fact.value === null) return null;
  if (fact.value.applicableDate !== it.travelDate) return null;
  if (fact.reviewState === 'unknown') return null;
  return fact.value.windows;
}

// ---------------------------------------------------------------------------
// 第 6.4.3～6.4.5 节：沿有向边推进时间、硬限检查与剪枝
// ---------------------------------------------------------------------------

type VisitEvent =
  | { walkSeconds: number | null }
  | { restSeat: boolean | null; restReviewState?: string; restSeconds: number | null }
  | { otherSeconds: number | null };

/** 景点园内步行/活动序列（口径同 compute.ts 的 visitWalkEvents，第 5.2 节；M17 仅 walk 计步行） */
function visitWalkEvents(node: VisitNode): VisitEvent[] {
  const plan = node.activityPlan;
  if (plan && plan.mode === 'timeline') {
    const events: VisitEvent[] = plan.items.map((item) => {
      if (item.kind === 'rest') {
        return {
          restSeat: item.seatFact.value,
          restReviewState: item.seatFact.reviewState,
          restSeconds: item.durationSeconds,
        };
      }
      if (item.kind === 'walk') {
        return { walkSeconds: item.durationSeconds };
      }
      return { otherSeconds: item.durationSeconds };
    });
    if (plan.completeness === 'incomplete') events.push({ walkSeconds: null });
    return events;
  }
  return [{ walkSeconds: node.insideWalkSeconds }];
}

interface SimulateOutcome {
  pruned: boolean;
  totalWalkSeconds: number | null;
  totalWalkKnownSeconds: number;
  totalDurationSeconds: number | null;
  longestContinuousWalkSeconds: number | null;
  longestContinuousWalkKnownSeconds: number;
  unknownFields: string[];
  violations: string[];
}

/** 剪枝分支的占位结果（第 6.4.5 节：已知违反硬限，立即丢弃并计数） */
const PRUNNED_OUTCOME: SimulateOutcome = {
  pruned: true,
  totalWalkSeconds: null,
  totalWalkKnownSeconds: 0,
  totalDurationSeconds: null,
  longestContinuousWalkSeconds: null,
  longestContinuousWalkKnownSeconds: 0,
  unknownFields: [],
  violations: [],
};

/**
 * 沿候选节点序列推进时间（第 6.4.3 节）。
 * 只使用已知时长推进“已知用时”（下界）；未知时长标记 unknownFields，不按零计入。
 */
function simulate(
  it: Itinerary,
  edges: Record<string, number | null>,
  path: string[],
  inserts: Map<string, InsertableRestCandidate> = new Map(),
): SimulateOutcome {
  const cons = it.constraints;
  const unknownFields: string[] = [];
  const addUnknown = (field: string): void => {
    if (!unknownFields.includes(field)) unknownFields.push(field);
  };

  let walkTotal: number | null = 0;
  let walkKnown = 0;
  let durationIncomplete = false;
  const violations: string[] = [];
  let elapsed = 0; // 已知用时合计（随推进单调递增的下界）

  // 连续步行区间状态（第 5.3 节口径）
  let curKnown = 0;
  let curHasUnknown = false;
  let anyUnknownInterval = false;
  let exactMax = 0;
  let lowerBoundMax = 0;

  const departureEpoch =
    it.travelDate && it.departureLocalTime ? epochOfLocal(it.travelDate, it.departureLocalTime) : null;
  const latestEndEpoch = cons.latestEndLocal !== null ? epochOfDateTime(cons.latestEndLocal) : null;

  const closeInterval = (reset: boolean): void => {
    if (!curHasUnknown && curKnown > exactMax) exactMax = curKnown;
    if (curKnown > lowerBoundMax) lowerBoundMax = curKnown;
    if (curHasUnknown) anyUnknownInterval = true;
    if (reset) {
      curKnown = 0;
      curHasUnknown = false;
    }
  };

  const addWalk = (seconds: number | null, unknownLabel?: string): void => {
    if (seconds === null) {
      curHasUnknown = true;
      walkTotal = null; // 完整总量不可得，只保留下界
      if (unknownLabel) addUnknown(unknownLabel);
    } else {
      curKnown += seconds;
      if (walkTotal !== null) walkTotal += seconds;
      walkKnown += seconds;
    }
  };

  /**
   * 第 6.4.5 节剪枝判定：仅当“已知下界”已确定违反硬限才剪枝。
   * 未知数据不按零成本断言超限——下界超限则实际值必然超限（单向成立）。
   * 说明：总步行/连续步行在沿边推进中即可确定下界，立即剪枝；
   * 最晚结束在完整推进后统一判定（第 5.3 节 evaluateConstraints 口径），
   * 违反的候选保留在列表中并标记 violations，但不进入可核验推荐（第 6.5 节）。
   */
  const definiteViolation = (): boolean => {
    if (cons.maxTotalWalkSeconds !== null && walkKnown > cons.maxTotalWalkSeconds) return true;
    if (cons.maxContinuousWalkSeconds !== null && curKnown > cons.maxContinuousWalkSeconds) return true;
    return false;
  };

  for (let i = 0; i < path.length; i++) {
    const id = path[i];

    if (i > 0) {
      const from = path[i - 1];
      const res = resolveEdge(it, edges, from, id);
      if (res.kind !== 'known') {
        durationIncomplete = true;
        addWalk(null, `路段 ${displayName(it, from, inserts)}→${displayName(it, id, inserts)} 步行时间待补充`);
      } else {
        elapsed += res.seconds;
        addWalk(res.seconds);
      }
      if (definiteViolation()) return PRUNNED_OUTCOME;
    }

    const virtual = virtualRestOf(id, inserts);
    if (virtual) {
      // 已确认可坐的歇脚候选插入点：时长不编造；可坐→切分连续步行（possibleRest）
      durationIncomplete = true;
      addUnknown(`${virtual.name} 休息时长待补充`);
      closeInterval(true);
      if (definiteViolation()) return PRUNNED_OUTCOME;
      continue;
    }

    const node = it.nodes[id];
    const isEndpoint = it.origin?.id === id || it.destination?.id === id;
    if (isEndpoint || !node) continue;

    if (node.kind === 'visit') {
      // 第 6.4.4 节：开放时间等待——多时段空档等到下一窗口；明确不开放记违规（M5/M6/M18）
      const windows = applicableWindows(it, node.placeId);
      if (windows && departureEpoch !== null && it.travelDate) {
        const arrivalEpoch = departureEpoch + elapsed;
        const pushViolation = (text: string) => {
          if (!violations.includes(text)) violations.push(text);
        };
        if (windows.length === 0) {
          pushViolation(`${displayName(it, id, inserts)} 该日明确不开放`);
        } else {
          // 到达是否落在某窗口内；否则等到下一窗口
          let wait = 0;
          let inside = false;
          for (const w of windows) {
            const startSec = localDaySeconds(w.startLocalTime);
            let endSec = localDaySeconds(w.endLocalTime);
            if (startSec === null || endSec === null) continue;
            const startEpoch = epochOfLocal(it.travelDate, w.startLocalTime)!;
            let endEpoch = epochOfLocal(it.travelDate, w.endLocalTime)!;
            if (endEpoch <= startEpoch) endEpoch += 86400;
            if (arrivalEpoch >= startEpoch && arrivalEpoch < endEpoch) {
              inside = true;
              break;
            }
            if (arrivalEpoch < startEpoch) {
              wait = startEpoch - arrivalEpoch;
              break;
            }
          }
          if (!inside && wait === 0) {
            pushViolation(`${displayName(it, id, inserts)} 可能超过闭门时间`);
          }
          if (wait > 0) elapsed += wait;
          // 离开时刻覆盖检查
          if (node.visitSeconds !== null && (inside || wait > 0)) {
            const leave = arrivalEpoch + wait + node.visitSeconds;
            const covered = windows.some((w) => {
              const s = epochOfLocal(it.travelDate!, w.startLocalTime);
              let e = epochOfLocal(it.travelDate!, w.endLocalTime);
              if (s === null || e === null) return false;
              if (e <= s) e += 86400;
              return leave >= s && leave <= e;
            });
            if (!covered) {
              pushViolation(`${displayName(it, id, inserts)} 可能超过闭门时间`);
            }
          }
        }
      }
      if (node.visitSeconds === null) {
        durationIncomplete = true;
        addUnknown(`${displayName(it, id, inserts)} 停留时长待补充`);
      } else {
        elapsed += node.visitSeconds;
      }
      for (const ev of visitWalkEvents(node)) {
        if ('restSeat' in ev) {
          const r = classifyRest(
            ev.restSeat,
            ev.restReviewState as never,
            ev.restSeconds,
            cons.minRestSeconds,
          );
          if (r.type !== 'noReset') closeInterval(true); // 确定分界与可能分界都切分（第 5.3 节）
        } else if ('otherSeconds' in ev) {
          // 非步行活动：不进步行统计
          if (ev.otherSeconds === null) durationIncomplete = true;
        } else {
          addWalk(
            ev.walkSeconds,
            ev.walkSeconds === null ? `${displayName(it, id, inserts)} 园内步行待补充` : undefined,
          );
        }
      }
      if (definiteViolation()) return PRUNNED_OUTCOME;
    } else {
      if (node.restSeconds === null) {
        durationIncomplete = true;
        addUnknown(`${displayName(it, id)} 休息时长待补充`);
      } else {
        elapsed += node.restSeconds;
      }
      const r = classifyRest(
        node.seatFact.value,
        node.seatFact.reviewState,
        node.restSeconds,
        cons.minRestSeconds,
      );
      if (r.type !== 'noReset') closeInterval(true);
      if (definiteViolation()) return PRUNNED_OUTCOME;
    }
  }

  closeInterval(false);

  const longest = anyUnknownInterval ? null : exactMax;
  const duration = durationIncomplete ? null : elapsed;

  // 硬限最终判定（文案与 evaluateConstraints 一致，第 5.3 节）；开放时间违规已写入 violations
  if (cons.maxTotalWalkSeconds !== null) {
    if (
      (walkTotal !== null && walkTotal > cons.maxTotalWalkSeconds) ||
      (walkTotal === null && walkKnown > cons.maxTotalWalkSeconds)
    ) {
      if (!violations.includes('预计总步行超过你设置的上限')) {
        violations.push('预计总步行超过你设置的上限');
      }
    }
  }
  if (cons.maxContinuousWalkSeconds !== null) {
    if (
      (longest !== null && longest > cons.maxContinuousWalkSeconds) ||
      (longest === null && lowerBoundMax > cons.maxContinuousWalkSeconds)
    ) {
      if (!violations.includes('最长连续步行超过你设置的上限')) {
        violations.push('最长连续步行超过你设置的上限');
      }
    }
  }
  if (cons.latestEndLocal !== null && duration !== null && departureEpoch !== null && latestEndEpoch !== null) {
    if (departureEpoch + elapsed > latestEndEpoch) {
      if (!violations.includes('预计结束时间晚于你设置的最晚结束')) {
        violations.push('预计结束时间晚于你设置的最晚结束');
      }
    }
  }

  return {
    pruned: false,
    totalWalkSeconds: walkTotal,
    totalWalkKnownSeconds: walkKnown,
    totalDurationSeconds: duration,
    longestContinuousWalkSeconds: longest,
    longestContinuousWalkKnownSeconds: lowerBoundMax,
    unknownFields,
    violations,
  };
}

// ---------------------------------------------------------------------------
// 第 6.4.1～6.4.2 节：候选枚举
// ---------------------------------------------------------------------------

function consContinuousSet(it: Itinerary): boolean {
  return it.constraints.maxContinuousWalkSeconds !== null;
}

/** 确定性全排列生成：按输入顺序递归选取 */
function* permutations(items: string[]): Generator<string[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      yield [items[i], ...tail];
    }
  }
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 候选分组（第 6.4.6、6.5 节）：0=可核验且通过硬限；1=可核验但违反硬限；2=待核验 */
function rankOf(candidate: PlannerCandidate): number {
  if (!candidate.verifiable) return 2;
  return candidate.violations.length > 0 ? 1 : 0;
}

/**
 * 自动规划主入口（第 6.1～6.6 节）。
 * 纯函数：同一输入快照必然产生同一 resultId 与候选顺序。
 */
export function plan(input: PlannerInput, options: PlanOptions = {}): PlannerResult {
  const it = input.itinerary;
  const edges = input.edges;
  const seq = activeSequence(it);
  const visitIds = seq.filter((id) => it.nodes[id]?.kind === 'visit');

  // 第 6.1 节：超出搜索上限不丢弃节点，直接报错提示改用手动整理或拆分行程
  if (visitIds.length > MAX_VISIT_NODES) {
    throw new Error(
      `景点数量 ${visitIds.length} 超出自动规划上限 ${MAX_VISIT_NODES}，请改用手动整理或拆分行程`,
    );
  }
  if (seq.length > MAX_ACTIVITY_NODES) {
    throw new Error(
      `活动节点数量 ${seq.length} 超出自动规划上限 ${MAX_ACTIVITY_NODES}（含起终点与独立休息点），请拆分行程`,
    );
  }

  const segments = buildSegments(it, seq);
  const optionalIds = new Set(
    visitIds.filter((id) => !(it.nodes[id] as VisitNode).required),
  );
  const hasRequired = visitIds.some((id) => (it.nodes[id] as VisitNode).required);
  const allOptional = visitIds.filter((id) => optionalIds.has(id));
  const originalPos = new Map(seq.map((id, index) => [id, index] as const));

  const conflicts: string[] = [];
  if (visitIds.length === 0) conflicts.push('没有可参与规划的景点节点');

  const collected: Array<{ candidate: PlannerCandidate; ordinal: number }> = [];
  let enumerated = 0;
  let pruned = 0;
  let ordinal = 0;
  const unreachablePairs: string[] = [];
  let unknownEdgeSeen = false;
  const insertables = listInsertableRestCandidates(it);
  const insertMap = new Map(insertables.map((r) => [r.virtualId, r] as const));

  const collectPath = (path: string[], sim: SimulateOutcome, insertedRests?: PlannerCandidate['insertedRests']): void => {
    const keptVisits = path.filter((id) => it.nodes[id]?.kind === 'visit');
    const adoptedLegKeys: string[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      const res = resolveEdge(it, edges, from, to);
      if (res.kind === 'unreachable') {
        const key = `${from}|${to}`;
        if (!unreachablePairs.includes(key)) unreachablePairs.push(key);
        return;
      }
      if (res.kind === 'known') {
        adoptedLegKeys.push(`${from}|${to}`);
      } else {
        unknownEdgeSeen = true;
      }
    }
    const candidate: PlannerCandidate = {
      nodeOrder: path,
      adoptedLegKeys,
      totalWalkSeconds: sim.totalWalkSeconds,
      longestContinuousWalkSeconds: sim.longestContinuousWalkSeconds,
      totalDurationSeconds: sim.totalDurationSeconds,
      keptOptional: allOptional.filter((id) => keptVisits.includes(id)),
      droppedOptional: allOptional.filter((id) => !keptVisits.includes(id)),
      violations: sim.violations,
      unknownFields: sim.unknownFields,
      verifiable: sim.unknownFields.length === 0,
      ...(insertedRests && insertedRests.length > 0 ? { insertedRests } : {}),
    };
    collected.push({ candidate, ordinal: ordinal++ });
  };

  /** 连续步行超限（或已知硬限剪枝）时，有限枚举在路径相邻边上插入已确认坐位的歇脚候选 */
  const tryInsertRests = (path: string[]): void => {
    if (insertables.length === 0) return;
    let overLimitNoted = false;
    for (const r of insertables) {
      // 挂靠站相邻边优先，其次路径其它边（长连续段也可插入）
      const edgeSlots = path.slice(0, -1).map((_, i) => ({
        at: i + 1,
        a: path[i],
        b: path[i + 1],
        hostFirst: path[i] === r.hostNodeId || path[i + 1] === r.hostNodeId,
      }));
      edgeSlots.sort((x, y) => Number(y.hostFirst) - Number(x.hostFirst));
      for (const { at, a, b } of edgeSlots) {
        const pathVariant = [...path.slice(0, at), r.virtualId, ...path.slice(at)];
        const keptVisits = pathVariant.filter((id) => it.nodes[id]?.kind === 'visit');
        if (!hasRequired && keptVisits.length === 0) continue;
        if (pathVariant.length > MAX_ACTIVITY_NODES) {
          if (!overLimitNoted) {
            overLimitNoted = true;
            conflicts.push(
              `插入休息点后活动节点将超过自动规划上限 ${MAX_ACTIVITY_NODES}（含起终点与休息点），请拆分行程后再规划`,
            );
          }
          continue;
        }
        // 仅在插入边已有路段时间时枚举（未知边不按零成本断言可省力）
        const resIn = resolveEdge(it, edges, a, r.virtualId);
        const resOut = resolveEdge(it, edges, r.virtualId, b);
        if (resIn.kind !== 'known' || resOut.kind !== 'known') continue;
        const sim2 = simulate(it, edges, pathVariant, insertMap);
        if (sim2.pruned) continue;
        enumerated += 1;
        collectPath(pathVariant, sim2, [
          { virtualId: r.virtualId, facilityId: r.facilityId, afterNodeId: a },
        ]);
      }
    }
  };

  const finalize = (path: string[]): void => {
    const keptVisits = path.filter((id) => it.nodes[id]?.kind === 'visit');
    // 第 6.2.3 节：无必去且全部可选时，最终至少保留一个景点
    if (!hasRequired && keptVisits.length === 0) return;
    enumerated += 1;

    const sim = simulate(it, edges, path, insertMap);
    if (sim.pruned) {
      pruned += 1; // 第 6.4.5 节：已知违反硬限的分支立即剪枝并计数
      // 连续步行导致的剪枝仍可尝试插入休息点（产品缺口补救，不宣称全局最优）
      if (consContinuousSet(it)) tryInsertRests(path);
      return;
    }

    collectPath(path, sim);
    if (
      sim.violations.some((v) => v.includes('连续步行')) ||
      (it.constraints.maxContinuousWalkSeconds !== null &&
        (sim.longestContinuousWalkSeconds !== null
          ? sim.longestContinuousWalkSeconds > it.constraints.maxContinuousWalkSeconds
          : sim.longestContinuousWalkKnownSeconds > it.constraints.maxContinuousWalkSeconds))
    ) {
      tryInsertRests(path);
    }
  };

  /** 第 6.4.1～6.4.2 节：枚举区间内可选景点子集 → 枚举顺序并连接固定锚点 */
  const dfs = (segIndex: number, prefix: string[]): void => {
    if (segIndex >= segments.length) {
      finalize(prefix);
      return;
    }
    const seg = segments[segIndex];
    const optional = seg.visits.filter((id) => optionalIds.has(id));
    const fixed = seg.visits.filter((id) => !optionalIds.has(id));
    for (let mask = 0; mask < 1 << optional.length; mask++) {
      const chosen = new Set(fixed);
      for (let i = 0; i < optional.length; i++) {
        if ((mask & (1 << i)) !== 0) chosen.add(optional[i]);
      }
      const orderedChosen = seg.visits.filter((id) => chosen.has(id));
      for (const perm of permutations(orderedChosen)) {
        const next = [...prefix, ...perm];
        if (seg.endAnchor !== null) next.push(seg.endAnchor);
        dfs(segIndex + 1, next);
      }
    }
  };
  dfs(0, it.origin ? [it.origin.id] : []);

  // 第 6.5 节排序：组内按确定性元组比较；null 值排到已知之后（未知不当零、不当最短）
  const compareNullable = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  };
  const compareOrderKey = (a: number[], b: number[]): number => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  };
  const orderKeyOf = (c: PlannerCandidate): number[] =>
    c.nodeOrder.map((id) => originalPos.get(id) ?? Number.MAX_SAFE_INTEGER);
  const compareCollected = (
    x: { candidate: PlannerCandidate; ordinal: number },
    y: { candidate: PlannerCandidate; ordinal: number },
  ): number => {
    const a = x.candidate;
    const b = y.candidate;
    const rankA = rankOf(a);
    const rankB = rankOf(b);
    if (rankA !== rankB) return rankA - rankB;
    if (a.keptOptional.length !== b.keptOptional.length) {
      return b.keptOptional.length - a.keptOptional.length; // 保留可选景点数降序
    }
    let diff = compareNullable(a.totalWalkSeconds, b.totalWalkSeconds); // 总步行升序
    if (diff !== 0) return diff;
    diff = compareNullable(a.longestContinuousWalkSeconds, b.longestContinuousWalkSeconds); // 最长连续升序
    if (diff !== 0) return diff;
    diff = compareNullable(a.totalDurationSeconds, b.totalDurationSeconds); // 总用时升序
    if (diff !== 0) return diff;
    diff = compareOrderKey(orderKeyOf(a), orderKeyOf(b)); // 原始节点顺序作稳定平局
    if (diff !== 0) return diff;
    return x.ordinal - y.ordinal;
  };

  collected.sort(compareCollected);
  const candidates = collected.map((x) => x.candidate);

  // 第 6.5 节输出：一个主要建议 + 至多两个 nodeOrder 非重复的备选；不够不凑数
  const passing = collected.filter((x) => rankOf(x.candidate) === 0);
  const primary = passing.length > 0 ? passing[0].candidate : null;
  const alternatives: PlannerCandidate[] = [];
  const seenOrders = new Set<string>(primary ? [primary.nodeOrder.join('|')] : []);
  for (const x of passing.slice(1)) {
    const key = x.candidate.nodeOrder.join('|');
    if (seenOrders.has(key)) continue;
    seenOrders.add(key);
    alternatives.push(x.candidate);
    if (alternatives.length >= 2) break;
  }

  // 第 6.6 节：部分查询失败与终止提示
  if (unreachablePairs.length > 0) {
    const listed = unreachablePairs
      .map((key) => {
        const [from, to] = key.split('|');
        return `${displayName(it, from, insertMap)}→${displayName(it, to, insertMap)}`;
      })
      .join('、');
    conflicts.push(`以下路段明确不可达，相关组合已排除：${listed}`);
  }
  if (unknownEdgeSeen) {
    conflicts.push('部分路段步行时间未获取，搜索数据不完整，候选比较范围受限');
  }
  if (!primary) {
    if (unknownEdgeSeen) {
      // 数据缺失无法排除潜在方案：不给“所有方案均不可行”的确定结论
      conflicts.push('搜索数据不完整，无法确定是否存在满足硬性限制的方案');
    } else if (candidates.length === 0) {
      if (insertables.length > 0) {
        conflicts.push(
          '在已知数据下没有找到可行路线组合；已枚举可插入的已确认歇脚点仍不可行，请调整休息安排或手动插入休息点，而不是只减少景点',
        );
      } else {
        conflicts.push(
          '在已知数据下没有找到可行路线组合；连续步行可能超限，可调整休息安排或手动插入休息点（当前没有已确认可坐且有坐标的歇脚候选）',
        );
      }
    } else {
      conflicts.push('已知数据下的完整候选均违反硬性限制');
      if (insertables.length === 0) {
        conflicts.push('若因连续步行超限，可手动插入休息点或补充已确认可坐的歇脚候选，而不是只少去一个可选景点');
      }
    }
  }

  // 输入快照指纹（行程部分复用 domain 口径）+ edges 稳定序列化；确定性 resultId
  const inputFingerprint = `fp-${fnv1a(`${computeInputFingerprint(it)}|${stableStringify(edges)}`)}`;
  const resultId = `plan-${fnv1a(stableStringify({ inputFingerprint, candidates }))}`;

  return {
    resultId,
    inputFingerprint,
    candidates,
    primary,
    alternatives,
    searchSpace: { enumerated, pruned, budgetExceeded: false },
    conflicts,
    generatedAt: options.now ?? new Date().toISOString(),
  };
}
