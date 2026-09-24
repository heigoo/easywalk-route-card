/**
 * 卡片状态合成（第 5.4 节）：
 * 优先检查结构性无效输入 → 已知超限 → 缺失与未核验项；不同问题同时保留，不互相覆盖。
 */
import type { Itinerary } from '../../shared/contracts/domain';
import { activeSequence, activeVisitCount } from '../../shared/contracts/domain';
import type { ConstraintVerdicts, TripStats } from './compute';

/**
 * 有效序列上「有坐标但入口未确认」的地点名（去重、按序列顺序）。
 * 入口未确认不阻断矩阵，但可能把坐标中心当入口，须在计算/规划处提示。
 */
export function unconfirmedEntrancePlaceNames(it: Itinerary): string[] {
  const seq = activeSequence(it);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const id of seq) {
    let placeId: string | undefined;
    if (it.origin?.id === id) placeId = it.origin.placeId;
    else if (it.destination?.id === id) placeId = it.destination.placeId;
    else placeId = it.nodes[id]?.placeId;
    const place = placeId ? it.places[placeId] : undefined;
    if (!place?.location || place.entranceConfirmed) continue;
    const name = place.name.trim() || '有地点';
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export type CardKind = 'complete' | 'draft' | 'violated' | 'blocked';
export type NoticeSeverity = 'info' | 'warning' | 'error';

export interface StatusNotice {
  text: string;
  severity: NoticeSeverity;
  anchorBlockId?: string;
}

export interface CardStatus {
  kind: CardKind;
  notices: StatusNotice[];
}

/** 结构性无效：阻止正常导出（第 5.4 节） */
export function findStructuralProblems(it: Itinerary): string[] {
  const problems: string[] = [];
  if (activeVisitCount(it) === 0) {
    problems.push('还没有有效景点，请先添加至少一个景点');
  }
  for (const id of it.nodeOrder) {
    const n = it.nodes[id];
    if (!n || n.kind !== 'visit' || n.skipped) continue;
    if (
      n.visitSeconds !== null &&
      n.insideWalkSeconds !== null &&
      n.insideWalkSeconds > n.visitSeconds
    ) {
      problems.push(`「${it.places[n.placeId]?.name ?? '景点'}」园内步行大于停留时长，请检查`);
    }
  }
  return problems;
}

export function synthesizeCardStatus(
  it: Itinerary,
  stats: TripStats,
  verdicts: ConstraintVerdicts,
): CardStatus {
  const notices: StatusNotice[] = [];
  const structural = findStructuralProblems(it);
  if (structural.length > 0) {
    return {
      kind: 'blocked',
      notices: structural.map((text) => ({ text, severity: 'error' as const })),
    };
  }

  const knownViolation = verdicts.totalWalk === 'FAIL' || verdicts.continuousWalk === 'FAIL' || verdicts.latestEnd === 'FAIL';
  for (const v of verdicts.violations) {
    notices.push({ text: v, severity: 'warning' });
  }

  const missingCount = stats.missingFields.length;
  const unverifiedCount = countUnverifiedFacts(it);
  const unconfirmedEntrances = unconfirmedEntrancePlaceNames(it);
  if (unconfirmedEntrances.length > 0) {
    notices.push({
      text: `${unconfirmedEntrances.join('、')}入口未确认，步行时间可能按坐标中心估算，请核对可通行入口`,
      severity: 'warning',
    });
  }
  if (missingCount > 0) {
    notices.push({
      text:
        stats.totalWalkKnownSeconds > 0
          ? `已知步行约 ${Math.ceil(stats.totalWalkKnownSeconds / 60)} 分钟，另有 ${missingCount} 项待补充`
          : `步行数据待补充（共 ${missingCount} 项）`,
      severity: 'info',
    });
  }
  if (unverifiedCount > 0) {
    notices.push({ text: `有 ${unverifiedCount} 项设施或开放信息待确认`, severity: 'info' });
  }
  for (const w of stats.openWaits) {
    notices.push({ text: w.label, severity: 'warning', anchorBlockId: w.nodeId });
  }
  for (const c of stats.closingConflicts) {
    notices.push({ text: c.label, severity: 'warning', anchorBlockId: c.nodeId });
  }

  if (knownViolation) return { kind: 'violated', notices };
  if (
    missingCount > 0 ||
    unverifiedCount > 0 ||
    stats.closingConflicts.length > 0 ||
    stats.openWaits.length > 0 ||
    unconfirmedEntrances.length > 0
  ) {
    return { kind: 'draft', notices };
  }
  return { kind: 'complete', notices };
}

/** 待确认事实数：reported（地图返回未核实）或 unknown 且非用户填写的设施/开放/座位信息 */
function countUnverifiedFacts(it: Itinerary): number {
  let count = 0;
  const bump = (v: { value?: unknown; reviewState?: string; sourceType?: string }) => {
    if (v.reviewState === 'reported') count++;
    else if (v.reviewState === 'unknown' && v.sourceType !== 'user' && v.value !== null) count++;
  };
  for (const f of it.facilities) {
    for (const fact of Object.values(f.facts)) {
      bump(fact as { value?: unknown; reviewState?: string; sourceType?: string });
    }
  }
  for (const place of Object.values(it.places)) {
    if (place.openingDescription.reviewState === 'reported') count++;
    if (place.openingSchedule.reviewState === 'reported') count++;
  }
  // M13：座位事实也是待确认项，未核对座位阻止“完整”
  for (const node of Object.values(it.nodes)) {
    if (node.skipped) continue;
    if (node.kind === 'rest') {
      bump(node.seatFact);
    } else if (node.activityPlan) {
      for (const item of node.activityPlan.items) {
        if (item.kind === 'rest') bump(item.seatFact);
      }
    }
  }
  return count;
}
