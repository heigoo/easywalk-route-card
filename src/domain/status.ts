/**
 * 卡片状态合成（第 5.4 节）：
 * 优先检查结构性无效输入 → 已知超限 → 缺失与未核验项；不同问题同时保留，不互相覆盖。
 */
import type { Itinerary } from '../../shared/contracts/domain';
import { activeVisitCount } from '../../shared/contracts/domain';
import type { ConstraintVerdicts, TripStats } from './compute';

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
  for (const c of stats.closingConflicts) {
    notices.push({ text: c.label, severity: 'warning' });
  }

  if (knownViolation) return { kind: 'violated', notices };
  if (missingCount > 0 || unverifiedCount > 0 || stats.closingConflicts.length > 0) {
    return { kind: 'draft', notices };
  }
  return { kind: 'complete', notices };
}

/** 待确认事实数：reported（地图返回未核实）或 unknown 且非用户填写的设施/开放信息 */
function countUnverifiedFacts(it: Itinerary): number {
  let count = 0;
  for (const f of it.facilities) {
    for (const fact of Object.values(f.facts)) {
      const v = fact as { value?: unknown; reviewState?: string; sourceType?: string };
      if (v.reviewState === 'reported') count++;
      else if (v.reviewState === 'unknown' && v.sourceType !== 'user' && v.value !== null) count++;
    }
  }
  for (const place of Object.values(it.places)) {
    if (place.openingDescription.reviewState === 'reported') count++;
    if (place.openingSchedule.reviewState === 'reported') count++;
  }
  return count;
}
