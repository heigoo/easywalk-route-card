/**
 * domain → CardViewModel（第 10.2 节）。
 * 文本预格式化：单位、“约”、待确认与缺失说明在生成时一次确定，渲染层不再二次拼接。
 */
import type { Fact, Itinerary, Leg, OpeningWindow, PlaceRef } from '../../../shared/contracts/domain';
import { activeSequence } from '../../../shared/contracts/domain';
import type { ConstraintVerdicts, TripStats } from '../../domain/compute';
import type { CardStatus } from '../../domain/status';
import { approxMinutesText, ceilMinutes, formatShanghaiDateTime, minutesValueText } from '../../domain/format';
import type {
  CardBlock,
  CardStatusVm,
  CardViewModel,
  LegBlock,
  NodeBlock,
  NodeNotice,
  SummaryItem,
  SummaryValueState,
} from './viewModel';

let blockSeq = 0;
function blockId(prefix: string): string {
  blockSeq += 1;
  return `${prefix}-${blockSeq}`;
}

export interface BuildInput {
  itinerary: Itinerary;
  stats: TripStats;
  verdicts: ConstraintVerdicts;
  status: CardStatus;
  now?: string;
}

export function buildCardViewModel(input: BuildInput): CardViewModel {
  const { itinerary: it, stats, verdicts, status } = input;
  const now = input.now ?? new Date().toISOString();
  const generatedAtText = formatShanghaiDateTime(now);

  const titleText = it.title.trim() || '未命名行程';
  const subtitleText = it.city.trim() ? it.city.trim() : null;
  const dateText = it.travelDate;

  const blocks: CardBlock[] = [];

  blocks.push({
    id: blockId('header'),
    kind: 'header',
    breakMode: 'atomic',
    stickWithNext: true,
    sectionTitleText: null,
    titleText,
    subtitleText,
    dateText,
    generatedAtText,
  });

  // ---- 摘要 ----
  const totalWalkState: SummaryValueState =
    verdicts.totalWalk === 'FAIL'
      ? 'violated'
      : stats.totalWalkSeconds === null
        ? stats.totalWalkKnownSeconds > 0
          ? 'partial'
          : 'unknown'
        : 'known';
  const longestState: SummaryValueState =
    verdicts.continuousWalk === 'FAIL'
      ? 'violated'
      : stats.longestContinuousWalkSeconds === null
        ? stats.longestContinuousWalkKnownSeconds > 0
          ? 'partial'
          : 'unknown'
        : 'known';

  const summaryItems: SummaryItem[] = [
    {
      key: 'totalWalk',
      labelText: '预计总步行',
      valueText: minutesValueText(stats.totalWalkSeconds ?? stats.totalWalkKnownSeconds),
      unitText: '分钟',
      state: totalWalkState,
      noteText:
        stats.totalWalkSeconds === null
          ? `已知约 ${minutesValueText(stats.totalWalkKnownSeconds)} 分钟，另有 ${stats.missingFields.length} 项待补充`
          : verdicts.totalWalk === 'FAIL'
            ? '超过你设置的上限'
            : null,
    },
    {
      key: 'totalDuration',
      labelText: '预计全程用时',
      valueText: minutesValueText(stats.totalDurationSeconds ?? stats.totalDurationKnownSeconds),
      unitText: '分钟',
      state: stats.totalDurationSeconds === null ? 'partial' : 'known',
      noteText:
        stats.totalDurationSeconds === null
          ? '部分时长未知，不显示精确结束时间'
          : null,
    },
    {
      key: 'longestWalk',
      labelText: '最长连续步行',
      valueText:
        stats.longestContinuousWalkSeconds !== null
          ? minutesValueText(stats.longestContinuousWalkSeconds)
          : '待确认',
      unitText: stats.longestContinuousWalkSeconds !== null ? '分钟' : '',
      state: longestState,
      noteText:
        verdicts.continuousWalk === 'FAIL'
          ? '超过你设置的上限'
          : stats.longestContinuousWalkSeconds === null
            ? '休息或园内步行信息待确认'
            : null,
    },
    {
      key: 'restCount',
      labelText: '计划休息',
      valueText: String(stats.plannedRestCount),
      unitText: '次',
      state: 'known',
      noteText: null,
    },
  ];

  blocks.push({
    id: blockId('summary'),
    kind: 'summary',
    breakMode: 'atomic',
    stickWithNext: true,
    sectionTitleText: null,
    items: summaryItems,
  });

  // ---- 状态提醒（随图保留） ----
  for (const n of status.notices) {
    blocks.push({
      id: blockId('notice'),
      kind: 'notice',
      breakMode: 'text',
      stickWithNext: false,
      sectionTitleText: null,
      text: n.text,
      severity: n.severity,
      anchorBlockId: n.anchorBlockId ?? null,
    });
  }

  // ---- 逐站节点 ----
  const seq = activeSequence(it);
  const activeVisitIds = seq.filter((id) => {
    const n = it.nodes[id];
    return n?.kind === 'visit';
  });
  const visitIndex = new Map(activeVisitIds.map((id, i) => [id, i + 1]));
  let prevNodeName: string | null = null;

  for (let i = 0; i < seq.length; i++) {
    const id = seq[i];
    const isOrigin = it.origin?.id === id;
    const isDestination = it.destination?.id === id;
    const node = it.nodes[id];

    if (i > 0) {
      const leg = findLegBetween(it, seq[i - 1], id);
      blocks.push(buildLegBlock(leg, prevNodeName));
    }

    if (isOrigin || isDestination) {
      const endpoint = isOrigin ? it.origin : it.destination;
      const place = endpoint ? it.places[endpoint.placeId] : null;
      const title = place?.name || (isOrigin ? '起点' : '终点');
      const nodeBlock: NodeBlock = {
        id: blockId('node'),
        kind: 'node',
        breakMode: 'atomic',
        stickWithNext: true,
        sectionTitleText: i === 0 ? '路线' : null,
        role: isOrigin ? 'origin' : 'destination',
        indexText: null,
        titleText: title,
        metaLines: [],
        badges: [],
        notices: [],
      };
      blocks.push(nodeBlock);
      prevNodeName = title;
      continue;
    }
    if (!node) continue;

    const place = it.places[node.placeId];
    const title = place?.name ?? '未命地点';

    if (node.kind === 'visit') {
      const metaLines: string[] = [];
      if (node.visitSeconds !== null) metaLines.push(`停留 ${ceilMinutes(node.visitSeconds)} 分钟`);
      else metaLines.push('停留时长待确认');
      if (node.insideWalkSeconds !== null) metaLines.push(`园内步行 ${ceilMinutes(node.insideWalkSeconds)} 分钟`);
      else metaLines.push('园内步行待确认');

      const notices: NodeNotice[] = [];
      const placeNotices = collectPlaceNotices(it, node.placeId);
      notices.push(...placeNotices);
      notices.push(...collectNodeFacilityNotices(it, id));

      const nodeBlock: NodeBlock = {
        id: blockId('node'),
        kind: 'node',
        breakMode: 'atomic',
        stickWithNext: true,
        sectionTitleText: null,
        role: 'visit',
        indexText: String(visitIndex.get(id) ?? ''),
        titleText: title,
        metaLines,
        badges: [
          ...(node.required ? [{ text: '必去', tone: 'neutral' as const }] : []),
          ...(!node.required ? [{ text: '可选', tone: 'brand' as const }] : []),
          ...(!node.required ? [{ text: '累了可跳过', tone: 'brand' as const }] : []),
        ],
        notices,
      };
      blocks.push(nodeBlock);
      if (node.notes.trim()) {
        blocks.push({
          id: blockId('note'),
          kind: 'note',
          breakMode: 'text',
          stickWithNext: true,
          sectionTitleText: null,
          ownerNodeId: id,
          text: node.notes.trim(),
        });
      }
    } else {
      const metaLines: string[] = [];
      if (node.restSeconds !== null) metaLines.push(`坐下歇 ${ceilMinutes(node.restSeconds)} 分钟`);
      else metaLines.push('休息时长待确认');
      const notices: NodeNotice[] = [];
      if (node.seatFact.value !== true) {
        notices.push({ text: '是否有座位待确认', severity: 'info' });
      }
      notices.push(...collectNodeFacilityNotices(it, id));
      const nodeBlock: NodeBlock = {
        id: blockId('node'),
        kind: 'node',
        breakMode: 'atomic',
        stickWithNext: true,
        sectionTitleText: null,
        role: 'rest',
        indexText: null,
        titleText: title,
        metaLines,
        badges: [{ text: '休息点', tone: 'neutral' as const }],
        notices,
      };
      blocks.push(nodeBlock);
      if (node.notes.trim()) {
        blocks.push({
          id: blockId('note'),
          kind: 'note',
          breakMode: 'text',
          stickWithNext: true,
          sectionTitleText: null,
          ownerNodeId: id,
          text: node.notes.trim(),
        });
      }
    }
    prevNodeName = title;
  }

  // ---- 已跳过节点（资料保留，不参与路线） ----
  const skipped = it.nodeOrder
    .map((nid) => it.nodes[nid])
    .filter((n): n is NonNullable<typeof n> => Boolean(n && n.skipped));
  if (skipped.length > 0) {
    blocks.push({
      id: blockId('skipped'),
      kind: 'skipped',
      breakMode: 'atomic',
      stickWithNext: false,
      sectionTitleText: null,
      items: skipped.map((n) => ({
        titleText: it.places[n.placeId]?.name ?? '未命地点',
        noteText: '已跳过 · 资料保留，可恢复',
      })),
    });
  }

  // ---- 数据来源（整张卡只出现一次，位于全部节点之后） ----
  const sourceItems = buildSourceItems(it);
  blocks.push({
    id: blockId('source'),
    kind: 'source',
    breakMode: 'atomic',
    stickWithNext: false,
    sectionTitleText: null,
    items: sourceItems,
    checkText: '出发前请核对开放与通行情况；图中时间均为预计。',
  });

  const statusVm: CardStatusVm = {
    kind: status.kind,
    notices: status.notices.map((n) => ({
      text: n.text,
      severity: n.severity,
      anchorBlockId: n.anchorBlockId ?? null,
    })),
  };

  return {
    version: 1,
    meta: { titleText, subtitleText, dateText, generatedAt: now, generatedAtText },
    status: statusVm,
    blocks,
    footText: `省脚力路线卡 · 生成于 ${generatedAtText} · 第 {page}/{total} 张`,
  };
}

function findLegBetween(it: Itinerary, fromId: string, toId: string): Leg | undefined {
  return Object.values(it.legs).find((l) => l.fromNodeId === fromId && l.toNodeId === toId);
}

function buildLegBlock(leg: Leg | undefined, fromName: string | null): LegBlock {
  if (!leg || leg.state === 'missing') {
    return {
      id: blockId('leg'),
      kind: 'leg',
      breakMode: 'atomic',
      stickWithNext: false,
      sectionTitleText: null,
      mainText: '步行时间待补充',
      secondaryText: fromName ? `从「${fromName}」出发的一段` : '联网获取或手动填写',
      state: 'missing',
    };
  }
  if (leg.state === 'unreachable' || leg.state === 'failed') {
    return {
      id: blockId('leg'),
      kind: 'leg',
      breakMode: 'atomic',
      stickWithNext: false,
      sectionTitleText: null,
      mainText: '步行时间待补充',
      secondaryText: '上次获取失败，需重新获取或手动填写',
      state: 'missing',
    };
  }
  const walkText = approxMinutesText(leg.effectiveWalkingSeconds);
  const secondary: string[] = [];
  if (leg.mode === 'manual-transfer') {
    secondary.push(`含接驳 · 全程${approxMinutesText(leg.totalTravelSeconds)}`);
  }
  if (leg.durationSource === 'adopted' && leg.adoptedAt) {
    secondary.push(`已采纳地图估算（非实时）· 采纳于 ${formatShanghaiDateTime(leg.adoptedAt)}`);
  } else if (leg.durationSource === 'amap') {
    secondary.push('地图估算 · 仅当前会话有效');
  } else if (leg.durationSource === 'manual') {
    secondary.push('用户填写');
  }
  return {
    id: blockId('leg'),
    kind: 'leg',
    breakMode: 'atomic',
    stickWithNext: false,
    sectionTitleText: null,
    mainText: `步行${walkText}`,
    secondaryText: secondary.length > 0 ? secondary.join(' · ') : null,
    state: leg.state === 'stale' ? 'stale' : 'ready',
  };
}

/** 地点与节点相关的待确认提醒（第 5.4 节：厕所、台阶等） */
function collectPlaceNotices(it: Itinerary, placeId: string): NodeNotice[] {
  const notices: NodeNotice[] = [];
  const place = it.places[placeId];
  if (!place) return notices;
  notices.push(openingNotice(place));
  for (const f of it.facilities) {
    if (f.target.type === 'place' && f.target.placeId === placeId) {
      for (const [key, raw] of Object.entries(f.facts)) {
        const fact = raw as { value?: unknown; reviewState?: string };
        if (fact.reviewState !== 'reported') continue;
        if (f.kind === 'toilet' && key === 'open') {
          notices.push({ text: '厕所开放时间待确认', severity: 'info' });
        } else if (f.kind === 'stairs' && fact.value === true) {
          notices.push({ text: '附近可能有台阶，待确认', severity: 'warning' });
        }
      }
    }
  }
  return notices;
}

/**
 * 节点上记录的设施候选提醒（Task 3 / M-R03）：
 * 歇脚点措辞必须含“候选”，不暗示有空座位或可免费休息；
 * 座位/开放未知时保持“待确认”口径（未知不等于没有）。
 */
function collectNodeFacilityNotices(it: Itinerary, nodeId: string): NodeNotice[] {
  const notices: NodeNotice[] = [];
  for (const f of it.facilities) {
    if (f.target.type !== 'node' || f.target.nodeId !== nodeId) continue;
    const facts = f.facts as Record<string, Fact<unknown> | undefined>;
    const rawName = facts.name?.value;
    const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
    if (f.kind === 'rest-candidate') {
      const seat = facts.seat;
      const checked = seat?.reviewState === 'userChecked';
      if (!name && !checked) continue;
      const status = !checked
        ? '座位待确认'
        : seat?.value === true
          ? '你已核对：可坐'
          : seat?.value === false
            ? '你已核对：不可坐'
            : '你已核对';
      notices.push({
        text: name ? `歇脚点候选：${name}（${status}）` : `歇脚点候选（${status}）`,
        severity: 'info',
      });
    } else if (f.kind === 'toilet') {
      const open = facts.open;
      const checked = open?.reviewState === 'userChecked';
      if (!name && !checked) continue;
      const status = !checked ? '待确认' : open?.value ? `你已核对：${String(open.value)}` : '你已核对';
      notices.push({
        text: name ? `厕所：${name}（${status}）` : `厕所（${status}）`,
        severity: 'info',
      });
    }
  }
  return notices;
}

/** 窗口数组 → 展示文本（HH:mm-HH:mm；空数组＝当天不开放） */
function windowsText(windows: OpeningWindow[]): string {
  if (windows.length === 0) return '当天不开放';
  return windows.map((w) => `${w.startLocalTime}-${w.endLocalTime}`).join('、');
}

/**
 * 开放时间提醒（R-A2）三态文案：
 * 地图参考（待核对）/ 自动解析自地图文本（请核对）/ 你已核对；
 * 无值只显示“待确认”，不显示看似完整的开放结论。
 */
function openingNotice(place: PlaceRef): NodeNotice {
  const schedule = place.openingSchedule;
  const desc = place.openingDescription;
  if (schedule.value !== null) {
    const valueText = windowsText(schedule.value.windows);
    if (schedule.note !== null && schedule.note.includes('自动解析')) {
      return { text: `开放时间（自动解析自地图文本，请核对）：${valueText}`, severity: 'info' };
    }
    if (schedule.reviewState === 'userChecked') {
      return { text: `开放时间（你已核对）：${valueText}`, severity: 'info' };
    }
    if (schedule.sourceType === 'amap' || schedule.reviewState === 'reported') {
      return { text: `开放时间（地图参考，待核对）：${valueText}`, severity: 'info' };
    }
  }
  if (desc.value !== null) {
    if (desc.reviewState === 'userChecked') {
      return { text: `开放时间（你已核对）：${desc.value}`, severity: 'info' };
    }
    if (desc.sourceType === 'amap' || desc.reviewState === 'reported') {
      return { text: `开放时间（地图参考，待核对）：${desc.value}`, severity: 'info' };
    }
  }
  return { text: '开放时间待确认', severity: 'info' };
}

function buildSourceItems(it: Itinerary): Array<{ labelText: string; valueText: string }> {
  const legs = Object.values(it.legs);
  const adopted = legs.filter((l) => l.durationSource === 'adopted');
  const amapSession = legs.filter((l) => l.durationSource === 'amap' && l.state === 'ready');
  const manualLegs = legs.filter((l) => l.durationSource === 'manual' && l.state === 'ready');
  const manualFacilities = it.facilities.filter((f) =>
    Object.values(f.facts).some((v) => (v as { sourceType?: string }).sourceType === 'user'),
  ).length;

  const items: Array<{ labelText: string; valueText: string }> = [];
  if (manualLegs.length > 0 || manualFacilities > 0) {
    items.push({ labelText: '用户填写', valueText: `${manualLegs.length} 段路线、${manualFacilities} 项设施` });
  }
  if (adopted.length > 0) {
    items.push({
      labelText: '已采纳地图估算',
      valueText: `${adopted.length} 段（按本行程估计保存，非实时）`,
    });
  }
  if (amapSession.length > 0) {
    items.push({
      labelText: '地图来源',
      valueText: `${amapSession.length} 段（未采纳，仅当前会话有效）`,
    });
  }
  items.push({ labelText: '待确认', valueText: '开放时间、台阶与座位等信息以现场为准' });
  return items;
}
