/**
 * 时间、步行与可信状态计算（第 5 章）。
 * 关键口径：
 * - 总步行＝有效路段步行＋园内步行（第 5.2 节）；
 * - 连续步行按“满足条件的计划坐休”分界，未知休息按“可能分界”切分下界（第 5.3 节）；
 * - 缺失返回完整值或 null，同时给出已知下界与缺失项，不把部分合计标成完整总量；
 * - 下界超限且另有未知项时仍可判定 FAIL。
 */
import type { Itinerary, Leg, RouteNode, VisitNode } from '../../shared/contracts/domain';
import { activeSequence } from '../../shared/contracts/domain';

export interface MissingField {
  key: string;
  label: string;
  /** 供界面定位 */
  nodeId?: string;
  legId?: string;
}

export interface TripStats {
  /** 完整值；有任何必需时长未知时为 null */
  totalWalkSeconds: number | null;
  /** 已知步行下界 */
  totalWalkKnownSeconds: number;
  totalDurationSeconds: number | null;
  totalDurationKnownSeconds: number;
  /** 最长连续步行；存在未知步行区间时为 null（待确认） */
  longestContinuousWalkSeconds: number | null;
  /** 连续步行可靠下界：可能有效的未核实休息已按“可能分界”切分 */
  longestContinuousWalkKnownSeconds: number;
  /** 满足用户条件的计划坐休次数 */
  plannedRestCount: number;
  missingFields: MissingField[];
  /** 结构化开放时段已适用且确定超过闭门时间的节点 */
  closingConflicts: MissingField[];
}

export type Verdict = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_SET';

export interface ConstraintVerdicts {
  totalWalk: Verdict;
  continuousWalk: Verdict;
  latestEnd: Verdict;
  /** FAIL 时的具体说明 */
  violations: string[];
}

type RestEvent =
  | { type: 'hardRest' } // 明确安排、已确认可坐、时长满足条件的坐休：确定分界
  | { type: 'possibleRest' } // 可能有效但未核实：切分下界，不作为确定分界
  | { type: 'noReset' }; // 明确不可坐/站立：不重置

interface WalkEvent {
  seconds: number | null;
  source: string;
  nodeId?: string;
  legId?: string;
}

/** 休息事件分类（第 4.3、5.2 节） */
export function classifyRest(
  seatValue: boolean | null,
  seconds: number | null,
  minRestSeconds: number | null,
): RestEvent {
  if (seatValue === true) {
    if (seconds === null) return { type: 'possibleRest' };
    if (seconds <= 0) return { type: 'noReset' };
    if (minRestSeconds === null || seconds >= minRestSeconds) return { type: 'hardRest' };
    return { type: 'possibleRest' };
  }
  if (seatValue === null) return { type: 'possibleRest' };
  return { type: 'noReset' };
}

function visitWalkEvents(node: VisitNode): Array<WalkEvent | { rest: RestEvent }> {
  const plan = node.activityPlan;
  if (plan && plan.mode === 'timeline') {
    const events: Array<WalkEvent | { rest: RestEvent }> = plan.items.map((item) =>
      item.kind === 'rest'
        ? { rest: classifyRest(item.seatFact.value, item.durationSeconds, null) }
        : {
            seconds: item.durationSeconds,
            source: 'activity',
            nodeId: node.id,
          },
    );
    if (plan.completeness === 'incomplete') {
      // 缺失项保留，不以旧合计冒充已精确分段：整个园内段落计入未知
      events.push({ seconds: null, source: 'activity-missing', nodeId: node.id });
    }
    return events;
  }
  // aggregate 或简单合计：园内步行作为一段；未知不变成零
  return [{ seconds: node.insideWalkSeconds, source: 'inside-walk', nodeId: node.id }];
}

function legWalkSeconds(leg: Leg | undefined): number | null {
  if (!leg) return null;
  if (leg.state === 'ready' || leg.state === 'stale') return leg.effectiveWalkingSeconds;
  return null;
}

/** 结构化开放时段是否适用于出游日期（第 5.1 节：仅明确适用且结构化可解释时使用） */
function applicableWindows(it: Itinerary, placeId: string) {
  const place = it.places[placeId];
  const fact = place?.openingSchedule;
  if (!place || !it.travelDate) return null;
  if (!fact || fact.value === null) return null;
  if (fact.value.applicableDate !== it.travelDate) return null;
  if (fact.reviewState === 'unknown') return null;
  return fact.value.windows;
}

/** 东八区日秒：时间戳按 Asia/Shanghai 折算（首轮时区固定，第 4.1 节） */
const SHANGHAI_OFFSET_SECONDS = 8 * 3600;
function epochToLocalDaySeconds(epochSeconds: number): number {
  const s = Math.floor(epochSeconds + SHANGHAI_OFFSET_SECONDS) % 86400;
  return s < 0 ? s + 86400 : s;
}

function addSecondsToLocal(date: string, time: string | null, seconds: number): number | null {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return new Date(`${date}T${time}:00+08:00`).getTime() / 1000 + seconds;
}

function localDaySeconds(time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 3600 + m * 60;
}

export function computeStats(it: Itinerary): TripStats {
  const missingFields: MissingField[] = [];
  const closingConflicts: MissingField[] = [];
  const seq = activeSequence(it);

  let totalWalk: number | null = 0;
  let totalWalkKnown = 0;
  let totalDuration: number | null = 0;
  let totalDurationKnown = 0;

  // ---- 连续步行区间状态 ----
  let curKnown = 0;
  let curHasUnknown = false;
  let anyUnknownInterval = false;
  let exactMax = 0;
  let lowerBoundMax = 0;
  let plannedRestCount = 0;

  const closeInterval = (reset: boolean) => {
    if (!curHasUnknown && curKnown > exactMax) exactMax = curKnown;
    if (curKnown > lowerBoundMax) lowerBoundMax = curKnown;
    if (curHasUnknown) anyUnknownInterval = true;
    if (reset) {
      curKnown = 0;
      curHasUnknown = false;
    }
  };

  const addWalk = (ev: WalkEvent) => {
    if (ev.seconds === null) {
      curHasUnknown = true;
      totalWalk = null; // 完整总量不可得，只保留下界
      if (ev.source === 'leg') {
        missingFields.push({
          key: `leg-walk-${ev.legId}`,
          label: '一段路线步行时间待补充',
          legId: ev.legId,
          nodeId: ev.nodeId,
        });
      } else {
        missingFields.push({
          key: `inside-walk-${ev.nodeId}`,
          label: '景点园内步行待补充',
          nodeId: ev.nodeId,
        });
      }
    } else {
      curKnown += ev.seconds;
      if (totalWalk !== null) totalWalk += ev.seconds;
      totalWalkKnown += ev.seconds;
    }
  };

  // ---- 沿有效序列推进 ----
  let elapsed = 0;
  for (let i = 0; i < seq.length; i++) {
    const id = seq[i];
    const node: RouteNode | undefined = it.nodes[id];
    const isEndpoint = it.origin?.id === id || it.destination?.id === id;

    if (i > 0) {
      // 路段（相邻逻辑节点之间）
      const leg = Object.values(it.legs).find(
        (l) => l.fromNodeId === seq[i - 1] && l.toNodeId === id,
      );
      const walk = legWalkSeconds(leg);
      const legTotal = leg && (leg.state === 'ready' || leg.state === 'stale') ? leg.totalTravelSeconds : null;
      if (legTotal !== null) {
        totalDuration! += legTotal;
        totalDurationKnown += legTotal;
      } else {
        totalDuration = null;
        if (leg && (leg.state === 'missing' || leg.state === 'failed')) {
          missingFields.push({
            key: `leg-total-${leg.id}`,
            label: '一段路线耗时待获取',
            legId: leg.id,
            nodeId: id,
          });
        }
      }
      elapsed += legTotal ?? 0;
      addWalk({ seconds: walk, source: 'leg', legId: leg?.id, nodeId: id });
    }

    if (isEndpoint || !node) continue;

    if (node.kind === 'visit') {
      // 等待开门：仅结构化且适用于出游日期的开放时段
      const windows = applicableWindows(it, node.placeId);
      if (windows && windows.length > 0 && it.departureLocalTime && it.travelDate) {
        const arrival = addSecondsToLocal(it.travelDate, it.departureLocalTime, elapsed);
        if (arrival !== null) {
          const arrivalSec = epochToLocalDaySeconds(arrival);
          const starts = windows.map((w) => localDaySeconds(w.startLocalTime)).filter((s): s is number => s !== null);
          if (starts.length > 0) {
            const openSec = Math.min(...starts);
            if (arrivalSec < openSec) {
              const wait = openSec - arrivalSec;
              totalDuration! += wait;
              totalDurationKnown += wait;
              elapsed += wait;
            }
          }
        }
      }
      // 超过闭门时间
      if (windows && windows.length > 0 && it.departureLocalTime && it.travelDate) {
        const arrival = addSecondsToLocal(it.travelDate, it.departureLocalTime, elapsed);
        const visit = node.visitSeconds ?? 0;
        if (arrival !== null) {
          const leaveSec = epochToLocalDaySeconds(arrival + visit);
          for (const w of windows) {
            const endSec = localDaySeconds(w.endLocalTime);
            if (endSec !== null && leaveSec > endSec) {
              closingConflicts.push({
                key: `closing-${node.id}`,
                label: `${it.places[node.placeId]?.name ?? '景点'} 可能超过闭门时间`,
                nodeId: node.id,
              });
              break;
            }
          }
        }
      }
      // 停留计入总用时
      if (node.visitSeconds !== null) {
        totalDuration! += node.visitSeconds;
        totalDurationKnown += node.visitSeconds;
        elapsed += node.visitSeconds;
      } else {
        totalDuration = null;
        missingFields.push({
          key: `visit-${node.id}`,
          label: `${it.places[node.placeId]?.name ?? '景点'} 停留时长待补充`,
          nodeId: node.id,
        });
      }
      // 园内步行 / 活动序列
      for (const ev of visitWalkEvents(node)) {
        if ('rest' in ev) {
          const r = ev.rest;
          if (r.type === 'hardRest') {
            plannedRestCount++;
            closeInterval(true);
          } else if (r.type === 'possibleRest') {
            closeInterval(true); // 可能分界：切分下界
          }
          // noReset：不重置
        } else {
          addWalk(ev);
        }
      }
    } else {
      // 独立休息点：时长计入总用时
      if (node.restSeconds !== null) {
        totalDuration! += node.restSeconds;
        totalDurationKnown += node.restSeconds;
        elapsed += node.restSeconds;
      } else {
        totalDuration = null;
        missingFields.push({
          key: `rest-${node.id}`,
          label: '休息点时长待补充',
          nodeId: node.id,
        });
      }
      const r = classifyRest(node.seatFact.value, node.restSeconds, it.constraints.minRestSeconds);
      if (r.type === 'hardRest') {
        plannedRestCount++;
        closeInterval(true);
      } else if (r.type === 'possibleRest') {
        closeInterval(true);
      }
    }
  }
  closeInterval(false);

  const longestContinuousWalkSeconds = anyUnknownInterval ? null : exactMax;
  const longestContinuousWalkKnownSeconds = lowerBoundMax;

  return {
    totalWalkSeconds: totalWalk,
    totalWalkKnownSeconds: totalWalkKnown,
    totalDurationSeconds: totalDuration,
    totalDurationKnownSeconds: totalDurationKnown,
    longestContinuousWalkSeconds,
    longestContinuousWalkKnownSeconds,
    plannedRestCount,
    missingFields,
    closingConflicts,
  };
}

/** 约束判定（第 4.6、5.3 节）：统一 PASS / FAIL / UNKNOWN / NOT_SET */
export function evaluateConstraints(it: Itinerary, stats: TripStats): ConstraintVerdicts {
  const violations: string[] = [];
  const { constraints } = it;

  let totalWalk: Verdict = 'NOT_SET';
  if (constraints.maxTotalWalkSeconds !== null) {
    if (stats.totalWalkSeconds !== null) {
      totalWalk = stats.totalWalkSeconds <= constraints.maxTotalWalkSeconds ? 'PASS' : 'FAIL';
    } else if (stats.totalWalkKnownSeconds > constraints.maxTotalWalkSeconds) {
      totalWalk = 'FAIL';
    } else {
      totalWalk = 'UNKNOWN';
    }
    if (totalWalk === 'FAIL') {
      violations.push('预计总步行超过你设置的上限');
    }
  }

  let continuousWalk: Verdict = 'NOT_SET';
  if (constraints.maxContinuousWalkSeconds !== null) {
    if (stats.longestContinuousWalkSeconds !== null) {
      continuousWalk =
        stats.longestContinuousWalkSeconds <= constraints.maxContinuousWalkSeconds ? 'PASS' : 'FAIL';
    } else if (stats.longestContinuousWalkKnownSeconds > constraints.maxContinuousWalkSeconds) {
      continuousWalk = 'FAIL';
    } else {
      continuousWalk = 'UNKNOWN';
    }
    if (continuousWalk === 'FAIL') {
      violations.push('最长连续步行超过你设置的上限');
    }
  }

  let latestEnd: Verdict = 'NOT_SET';
  if (constraints.latestEndLocal !== null) {
    if (stats.totalDurationSeconds !== null && it.travelDate && it.departureLocalTime) {
      const endSec =
        addSecondsToLocal(it.travelDate, it.departureLocalTime, stats.totalDurationSeconds) ?? 0;
      const limit = new Date(`${constraints.latestEndLocal}:00+08:00`).getTime() / 1000;
      latestEnd = endSec <= limit ? 'PASS' : 'FAIL';
      if (latestEnd === 'FAIL') violations.push('预计结束时间晚于你设置的最晚结束');
    } else {
      latestEnd = 'UNKNOWN';
    }
  }

  return { totalWalk, continuousWalk, latestEnd, violations };
}
