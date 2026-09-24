/**
 * 时间、步行与可信状态计算（第 5 章）。
 * 关键口径：
 * - 总步行＝有效路段步行＋园内步行（第 5.2 节）；
 * - 连续步行按“满足条件的计划坐休”分界，未知休息按“可能分界”切分下界（第 5.3 节）；
 * - 缺失返回完整值或 null，同时给出已知下界与缺失项，不把部分合计标成完整总量；
 * - 下界超限且另有未知项时仍可判定 FAIL；
 * - 开放时间：多时段空档等待、明确不开放、超闭门均显式产出冲突/等待项。
 */
import type {
  Itinerary,
  Leg,
  OpeningWindow,
  RestNode,
  ReviewState,
  RouteNode,
  VisitNode,
} from '../../shared/contracts/domain';
import { activeSequence } from '../../shared/contracts/domain';

export interface MissingField {
  key: string;
  label: string;
  /** 供界面定位 */
  nodeId?: string;
  legId?: string;
}

/** 等待开门（早到/午休空档）：对称于超闭门冲突（第 5.1、7 章） */
export interface OpenWait extends MissingField {
  /** 等待秒数（正数） */
  waitSeconds: number;
  /** 到达本地时刻 HH:mm */
  arrivalLocalTime: string;
}

export interface TripStats {
  /** 完整值；有任何必需时长未知时为 null */
  totalWalkSeconds: number | null;
  /** 已知步行下界 */
  totalWalkKnownSeconds: number;
  totalDurationSeconds: number | null;
  totalDurationKnownSeconds: number;
  /** 最长连续步行；存在未知步行区间或可能分界时为 null（待确认） */
  longestContinuousWalkSeconds: number | null;
  /** 连续步行可靠下界：可能有效的未核实休息已按“可能分界”切分 */
  longestContinuousWalkKnownSeconds: number;
  /** 座位已确认的独立休息点次数（与连续步行分界资格解耦） */
  plannedRestCount: number;
  missingFields: MissingField[];
  /** 结构化开放时段已适用且确定超过闭门时间的节点 */
  closingConflicts: MissingField[];
  /** 到达时需等待开门/下一开放窗口的节点 */
  openWaits: OpenWait[];
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

/** 园内非步行活动：占时但不计入步行，也不作为休息分界 */
interface OtherEvent {
  other: true;
  seconds: number | null;
  nodeId?: string;
}

/**
 * 休息事件分类（第 4.3、5.2 节）。
 * 仅「用户已核对且明确可坐」才可能成为确定分界；
 * 地图报告（reported）或未知座位一律 possibleRest，不凭空计坐休。
 */
export function classifyRest(
  seatValue: boolean | null,
  seatReviewState: ReviewState | undefined,
  seconds: number | null,
  minRestSeconds: number | null,
): RestEvent {
  const userConfirmedSeat = seatValue === true && seatReviewState === 'userChecked';
  if (userConfirmedSeat) {
    if (seconds === null) return { type: 'possibleRest' };
    if (seconds <= 0) return { type: 'noReset' };
    if (minRestSeconds === null || seconds >= minRestSeconds) return { type: 'hardRest' };
    return { type: 'possibleRest' };
  }
  // 未知、地图报告未核对、或明确不可坐
  if (seatValue === false) return { type: 'noReset' };
  return { type: 'possibleRest' };
}

/** 座位已确认（用户核对为可坐）——用于“已核实坐休”计数，与分界资格解耦 */
function isSeatConfirmedRest(node: RestNode): boolean {
  return node.seatFact.value === true && node.seatFact.reviewState === 'userChecked';
}

function visitWalkEvents(
  node: VisitNode,
  minRestSeconds: number | null,
): Array<WalkEvent | OtherEvent | { rest: RestEvent }> {
  const plan = node.activityPlan;
  if (plan && plan.mode === 'timeline') {
    const events: Array<WalkEvent | OtherEvent | { rest: RestEvent }> = plan.items.map((item) => {
      if (item.kind === 'rest') {
        return {
          rest: classifyRest(item.seatFact.value, item.seatFact.reviewState, item.durationSeconds, minRestSeconds),
        };
      }
      if (item.kind === 'walk') {
        return {
          seconds: item.durationSeconds,
          source: 'activity',
          nodeId: node.id,
        };
      }
      // kind === 'other'：占时但不计入步行统计
      return { other: true as const, seconds: item.durationSeconds, nodeId: node.id };
    });
    if (plan.completeness === 'incomplete') {
      // 缺失项保留，不以旧合计冒充已精确分段：整个园内段落计入未知
      events.push({ seconds: null, source: 'activity-missing', nodeId: node.id });
    }
    return events;
  }
  // aggregate 或简单合计：园内步行作为一段；未知不变成零
  return [{ seconds: node.insideWalkSeconds, source: 'inside-walk', nodeId: node.id }];
}

/** 路段步行秒数：仅 ready 计入精确合计；stale 与编辑区“待补充”口径一致，不计入精确值 */
function legWalkSeconds(leg: Leg | undefined): number | null {
  if (!leg) return null;
  if (leg.state === 'ready') return leg.effectiveWalkingSeconds;
  return null;
}

/** 路段全程秒数：仅 ready 且值非 null；manual-transfer 只填步行未填全程时为 null */
function legTotalSeconds(leg: Leg | undefined): number | null {
  if (!leg) return null;
  if (leg.state === 'ready') return leg.totalTravelSeconds;
  return null;
}

/** 结构化开放时段：null＝未知（不判定）；[]＝该日明确不开放；非空＝开放窗口 */
function applicableWindows(it: Itinerary, placeId: string): OpeningWindow[] | null {
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

function epochOfLocal(date: string, time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  const t = new Date(`${date}T${time}:00+08:00`).getTime();
  return Number.isFinite(t) ? t / 1000 : null;
}

function addSecondsToLocal(date: string, time: string | null, seconds: number): number | null {
  if (!time) return null;
  const base = epochOfLocal(date, time);
  return base === null ? null : base + seconds;
}

function localDaySeconds(time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 3600 + m * 60;
}

function formatLocalTime(epochSeconds: number): string {
  const daySec = epochToLocalDaySeconds(epochSeconds);
  const h = Math.floor(daySec / 3600);
  const m = Math.floor((daySec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function epochToLocalDaySeconds(epochSeconds: number): number {
  const s = Math.floor(epochSeconds + SHANGHAI_OFFSET_SECONDS) % 86400;
  return s < 0 ? s + 86400 : s;
}

/** 开放窗口 → epoch 区间（支持跨零点；按开始时间排序） */
function windowEpochRanges(
  travelDate: string,
  windows: OpeningWindow[],
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const start = epochOfLocal(travelDate, w.startLocalTime);
    let end = epochOfLocal(travelDate, w.endLocalTime);
    if (start === null || end === null) continue;
    if (end <= start) {
      // 跨零点：结束时刻落在次日
      end += 86400;
    }
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
}

interface OpeningImpact {
  /** 需等待开门/下一窗口的秒数；0 表示到达时已开放 */
  waitSeconds: number;
  /** 该日明确不开放 */
  closedDay: boolean;
  /** 确定超过闭门（离开时刻不在任何开放窗口内，或到达时已全部闭门） */
  closingConflict: boolean;
}

/**
 * 开放时间影响（第 5.1 节）：
 * - 多时段：落在空档则等到下一窗口开始（M5）；
 * - windows=[]：该日明确不开放（M6）；
 * - 闭门判定按 epoch 比较，离开时刻须被某个窗口覆盖；visitSeconds 未知时不臆断超闭门（M7）。
 */
function evaluateOpening(
  windows: OpeningWindow[],
  travelDate: string,
  arrivalEpoch: number,
  visitSeconds: number | null,
): OpeningImpact {
  if (windows.length === 0) {
    return { waitSeconds: 0, closedDay: true, closingConflict: true };
  }
  const ranges = windowEpochRanges(travelDate, windows);
  if (ranges.length === 0) {
    return { waitSeconds: 0, closedDay: true, closingConflict: true };
  }

  let waitSeconds = 0;
  let inside = false;
  for (const r of ranges) {
    if (arrivalEpoch >= r.start && arrivalEpoch < r.end) {
      inside = true;
      break;
    }
    if (arrivalEpoch < r.start) {
      waitSeconds = r.start - arrivalEpoch;
      break;
    }
  }

  // 到达时所有窗口均已结束：已过闭门
  if (!inside && waitSeconds === 0) {
    return { waitSeconds: 0, closedDay: false, closingConflict: true };
  }

  const leaveEpoch = arrivalEpoch + waitSeconds + (visitSeconds ?? 0);
  let closingConflict = false;
  if (visitSeconds !== null) {
    const covered = ranges.some((r) => leaveEpoch >= r.start && leaveEpoch <= r.end);
    if (!covered) closingConflict = true;
  }

  return { waitSeconds, closedDay: false, closingConflict };
}

export function computeStats(it: Itinerary): TripStats {
  const missingFields: MissingField[] = [];
  const closingConflicts: MissingField[] = [];
  const openWaits: OpenWait[] = [];
  const seq = activeSequence(it);

  // C1：精确合计用「是否仍精确 + 已知累加」两变量，禁止 null+num 复活
  let totalWalkExact = true;
  let totalWalk: number | null = 0;
  let totalWalkKnown = 0;
  let totalDurationExact = true;
  let totalDuration: number | null = 0;
  let totalDurationKnown = 0;

  // ---- 连续步行区间状态 ----
  let curKnown = 0;
  let curHasUnknown = false;
  let anyUnknownInterval = false;
  /** C2：出现可能分界时，精确最长连续步行不可断言 */
  let anyPossibleSplit = false;
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
      totalWalkExact = false;
      totalWalk = null;
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
      if (totalWalkExact && totalWalk !== null) totalWalk += ev.seconds;
      totalWalkKnown += ev.seconds;
    }
  };

  const addDuration = (seconds: number) => {
    if (totalDurationExact && totalDuration !== null) totalDuration += seconds;
    totalDurationKnown += seconds;
  };

  const markDurationIncomplete = () => {
    totalDurationExact = false;
    totalDuration = null;
  };

  const handleRestEvent = (r: RestEvent, countAsVerifiedRest: boolean) => {
    if (r.type === 'hardRest') {
      if (countAsVerifiedRest) plannedRestCount++;
      closeInterval(true);
    } else if (r.type === 'possibleRest') {
      anyPossibleSplit = true;
      closeInterval(true);
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
      const legTotal = legTotalSeconds(leg);
      if (legTotal !== null) {
        addDuration(legTotal);
      } else {
        markDurationIncomplete();
        // M12：ready 但全程未知（如乘车接驳只填步行）也要登记缺失
        if (leg) {
          const label =
            leg.mode === 'manual-transfer'
              ? '接驳全程待补充'
              : leg.state === 'missing' || leg.state === 'failed' || leg.state === 'unreachable'
                ? '一段路线耗时待获取'
                : '一段路线全程耗时待补充';
          missingFields.push({
            key: `leg-total-${leg.id}`,
            label,
            legId: leg.id,
            nodeId: id,
          });
        } else {
          missingFields.push({
            key: `leg-total-${seq[i - 1]}-${id}`,
            label: '一段路线耗时待获取',
            nodeId: id,
          });
        }
      }
      elapsed += legTotal ?? 0;
      addWalk({ seconds: walk, source: 'leg', legId: leg?.id, nodeId: id });
    }

    if (isEndpoint || !node) continue;

    if (node.kind === 'visit') {
      const windows = applicableWindows(it, node.placeId);
      const placeName = it.places[node.placeId]?.name ?? '景点';

      if (windows !== null && it.departureLocalTime && it.travelDate) {
        const arrival = addSecondsToLocal(it.travelDate, it.departureLocalTime, elapsed);
        if (arrival !== null) {
          const impact = evaluateOpening(windows, it.travelDate, arrival, node.visitSeconds);
          if (impact.closedDay) {
            closingConflicts.push({
              key: `closed-day-${node.id}`,
              label: `${placeName} 该日明确不开放`,
              nodeId: node.id,
            });
          }
          if (impact.waitSeconds > 0) {
            const wait = impact.waitSeconds;
            addDuration(wait);
            elapsed += wait;
            openWaits.push({
              key: `open-wait-${node.id}`,
              label: `${placeName} 需等待开门（到达 ${formatLocalTime(arrival)}，约 ${Math.ceil(wait / 60)} 分钟）`,
              nodeId: node.id,
              waitSeconds: wait,
              arrivalLocalTime: formatLocalTime(arrival),
            });
          }
          if (impact.closingConflict && !impact.closedDay) {
            closingConflicts.push({
              key: `closing-${node.id}`,
              label: `${placeName} 可能超过闭门时间`,
              nodeId: node.id,
            });
          }
        }
      }

      // 停留计入总用时
      if (node.visitSeconds !== null) {
        addDuration(node.visitSeconds);
        elapsed += node.visitSeconds;
      } else {
        markDurationIncomplete();
        missingFields.push({
          key: `visit-${node.id}`,
          label: `${placeName} 停留时长待补充`,
          nodeId: node.id,
        });
      }
      // 园内步行 / 活动序列
      for (const ev of visitWalkEvents(node, it.constraints.minRestSeconds)) {
        if ('rest' in ev) {
          handleRestEvent(ev.rest, false);
        } else if ('other' in ev) {
          // 非步行活动：占时（已含于 visitSeconds），不进步行统计
          if (ev.seconds === null) {
            markDurationIncomplete();
          }
        } else {
          addWalk(ev);
        }
      }
    } else {
      // 独立休息点：时长计入总用时
      if (node.restSeconds !== null) {
        addDuration(node.restSeconds);
        elapsed += node.restSeconds;
      } else {
        markDurationIncomplete();
        missingFields.push({
          key: `rest-${node.id}`,
          label: '休息点时长待补充',
          nodeId: node.id,
        });
      }
      // M8：已核实坐休＝座位已确认的独立休息点，与分界资格解耦
      if (isSeatConfirmedRest(node)) plannedRestCount++;
      const r = classifyRest(
        node.seatFact.value,
        node.seatFact.reviewState,
        node.restSeconds,
        it.constraints.minRestSeconds,
      );
      handleRestEvent(r, false);
    }
  }
  closeInterval(false);

  // C2：未知步行或可能分界切分时，精确最长连续步行不可得
  const longestContinuousWalkSeconds = anyUnknownInterval || anyPossibleSplit ? null : exactMax;
  const longestContinuousWalkKnownSeconds = lowerBoundMax;

  return {
    totalWalkSeconds: totalWalkExact ? totalWalk : null,
    totalWalkKnownSeconds: totalWalkKnown,
    totalDurationSeconds: totalDurationExact ? totalDuration : null,
    totalDurationKnownSeconds: totalDurationKnown,
    longestContinuousWalkSeconds,
    longestContinuousWalkKnownSeconds,
    plannedRestCount,
    missingFields,
    closingConflicts,
    openWaits,
  };
}

/** 解析 HH:mm 为当日秒；非法返回 null（不臆断） */
function parseLocalTimeSeconds(value: string | null): number | null {
  if (!value) return null;
  return localDaySeconds(value);
}

/** 约束判定（第 4.6、5.3 节）：统一 PASS / FAIL / UNKNOWN / NOT_SET；解析失败一律 UNKNOWN */
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
    const endEpoch =
      stats.totalDurationSeconds !== null && it.travelDate && it.departureLocalTime
        ? addSecondsToLocal(it.travelDate, it.departureLocalTime, stats.totalDurationSeconds)
        : null;
    const limitSec = parseLocalTimeSeconds(constraints.latestEndLocal);
    if (endEpoch === null || limitSec === null || !it.travelDate) {
      latestEnd = 'UNKNOWN';
    } else {
      const endDaySec = epochToLocalDaySeconds(endEpoch);
      // 跨零点结束视为次日，必然晚于当日最晚结束
      const endWrapped = endDaySec < epochToLocalDaySeconds(endEpoch - stats.totalDurationSeconds!);
      latestEnd = !endWrapped && endDaySec <= limitSec ? 'PASS' : 'FAIL';
      if (latestEnd === 'FAIL') violations.push('预计结束时间晚于你设置的最晚结束');
    }
  }

  return { totalWalk, continuousWalk, latestEnd, violations };
}
