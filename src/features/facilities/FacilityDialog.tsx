/**
 * 设施备注（需求 R03、第 4.4 节；附近厕所/歇脚点候选 R-A1、M-R03）：
 * - 厕所开放、歇脚点座位、台阶有无逐属性记录；默认“待确认”，不提供一键全部核验；
 * - 附近地图候选只是候选：逐属性确认后才写入，来源可追溯到“高德地图搜索”与候选 POI id；
 * - 直线距离只是距查询中心的直线距离，不是步行路程/耗时，不参与任何计算；
 * - 候选坐标随“确认写入”落到 location 事实（Fact 坐标值），供候选一键转休息点带出坐标；候选无坐标记为未知，不猜坐标；
 * - 用户核对时记录核对日期；没查到不能标成“无”（未知不等于没有）。
 * - 覆盖保护（R-E）：“确认修改”只写本次实际改动；把已核对属性退回“待确认”是显式回退，须点名属性二次确认。
 */
import { useEffect, useState } from 'react';
import type {
  FacilityKind,
  FacilityTarget,
  Fact,
  Itinerary,
  RouteNode,
} from '../../../shared/contracts/domain';
import { unknownFact } from '../../../shared/contracts/domain';
import type { PlaceSearchItem } from '../../../shared/contracts/api';
import { ApiRequestError, searchNearby } from '../../services/api';
import { Dialog } from '../../components/Dialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
// 表单控件样式与编辑区共用同一套语义令牌（需求 13.6、13.7）
import editor from '../itinerary/Editor.module.css';
import dialogStyles from '../../components/Dialog.module.css';

type ToiletState = 'unknown' | 'checked';
type SeatState = 'unknown' | 'yes' | 'no';
type NearbyCategory = 'TOILET' | 'REST_CANDIDATE';

/** 候选写入事实的来源口径：经用户从地图候选确认，可追溯到候选 POI */
const CANDIDATE_SOURCE_NAME = '高德地图搜索';
const CANDIDATE_NOTE = '经你从地图候选确认，出发前请再核对';

export interface FacilityDialogProps {
  open: boolean;
  node: RouteNode | null;
  /** 台阶核对归属路段时传入：事实写到 target={type:'leg', legId}（第 4.4 节） */
  legId?: string | null;
  /** 预选/聚焦的核对项（如路段阶梯提示一键带入）；该模式只显示台阶块 */
  preset?: 'stairs';
  itinerary: Itinerary;
  onClose: () => void;
  /** 由调用方应用 upsertFacilityFactForTarget */
  onSave: (target: FacilityTarget, kind: FacilityKind, factKey: string, fact: Fact<unknown>) => void;
}

function matchesTarget(a: FacilityTarget, b: FacilityTarget): boolean {
  return (
    (a.type === 'node' && b.type === 'node' && a.nodeId === b.nodeId) ||
    (a.type === 'leg' && b.type === 'leg' && a.legId === b.legId) ||
    (a.type === 'place' && b.type === 'place' && a.placeId === b.placeId)
  );
}

function getFact(it: Itinerary, target: FacilityTarget, kind: FacilityKind, key: string): Fact<unknown> | null {
  const rec = it.facilities.find((f) => f.kind === kind && matchesTarget(f.target, target));
  return (rec?.facts[key] as Fact<unknown> | undefined) ?? null;
}

/** 用户核对事实（手动录入；来源为用户本人） */
function userCheckedFact(
  value: unknown,
  checkedAt: string,
  applicableDate: string | null,
): Fact<unknown> {
  return {
    value,
    sourceType: 'user',
    sourceName: null,
    sourceReference: null,
    fetchedAt: null,
    reviewState: 'userChecked',
    checkedAt,
    applicableDate,
    note: null,
  };
}

/** 候选确认事实：来源保留“高德地图搜索”与候选 POI id、检索时间 */
function candidateCheckedFact(
  value: unknown,
  item: PlaceSearchItem,
  fetchedAt: string,
  checkedAt: string,
  applicableDate: string | null,
): Fact<unknown> {
  return {
    value,
    sourceType: 'user',
    sourceName: CANDIDATE_SOURCE_NAME,
    sourceReference: item.id,
    fetchedAt,
    reviewState: 'userChecked',
    checkedAt,
    applicableDate,
    note: CANDIDATE_NOTE,
  };
}

/**
 * 是否需要写入事实：
 * - 与已存事实同值同核对状态则不重复写，保留原来源信息（候选来源不被手动确认抹掉）；
 * - 没有已存事实时，“待确认”不落空记录（未知不等于没有）。
 */
function needsWrite(prev: Fact<unknown> | null, next: Fact<unknown>, compareNote: boolean): boolean {
  if (!prev) return next.reviewState !== 'unknown';
  if (prev.value !== next.value || prev.reviewState !== next.reviewState) return true;
  return compareNote && (prev.note ?? '') !== (next.note ?? '');
}

/**
 * 显式回退（需求 R-E）：把“已核对且有值”的事实改回“待确认”。
 * 会丢掉核对结果与来源，必须经二次确认，不得被无意触发。
 */
function isRollback(prev: Fact<unknown> | null, next: Fact<unknown>): boolean {
  return prev !== null && prev.reviewState === 'userChecked' && prev.value !== null && next.reviewState === 'unknown';
}

/** 回退二次确认点名属性（R-E）：“factKey 索引 → 属性名” */
const ROLLBACK_LABELS: Record<string, string> = {
  'toilet:open': '「厕所开放情况」',
  'rest-candidate:name': '「名称」',
  'rest-candidate:address': '「位置说明」',
  'rest-candidate:seat': '「是否可坐」',
  'stairs:exists': '「台阶情况」',
};

/** “确认修改”的待写入项：先收集本次实际改动，回退经确认后一并提交 */
type PendingWrite = {
  kind: FacilityKind;
  factKey: string;
  fact: Fact<unknown>;
  /** 二次确认时点名的属性名 */
  label: string;
  /** 是否属于“已核对→待确认”的显式回退 */
  rollback: boolean;
};

export function FacilityDialog({ open, node, legId = null, preset, itinerary, onClose, onSave }: FacilityDialogProps) {
  const [toiletState, setToiletState] = useState<ToiletState>('unknown');
  const [toiletText, setToiletText] = useState('');
  const [restName, setRestName] = useState('');
  const [restAddress, setRestAddress] = useState('');
  const [restSeat, setRestSeat] = useState<SeatState>('unknown');
  const [stairsState, setStairsState] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [stairsNote, setStairsNote] = useState('');
  // 显式回退二次确认（R-E）：非空＝等待用户确认回退，writes 为本次“确认修改”的全部实际改动
  const [pendingSubmit, setPendingSubmit] = useState<{ labels: string[]; writes: PendingWrite[] } | null>(null);

  // 搜索附近（Task 3 子任务 3.1）
  const [category, setCategory] = useState<NearbyCategory>('TOILET');
  const [radius, setRadius] = useState(500);
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<PlaceSearchItem[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [searchPhase, setSearchPhase] = useState<'idle' | 'done' | 'empty' | 'error'>('idle');
  const [searchError, setSearchError] = useState<{ code: string } | null>(null);
  // 逐属性确认区：同时只展开一个候选
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [recordedIds, setRecordedIds] = useState<string[]>([]);
  const [candOpenState, setCandOpenState] = useState<ToiletState>('unknown');
  const [candOpenText, setCandOpenText] = useState('');
  const [candSeat, setCandSeat] = useState<SeatState>('unknown');

  // 台阶可归属路段（阶梯提示入口）；其余入口归属节点
  const target: FacilityTarget | null = legId
    ? { type: 'leg', legId }
    : node
      ? { type: 'node', nodeId: node.id }
      : null;
  // 预选台阶项：路段阶梯核对只记录台阶事实（厕所等仍走节点设施备注）
  const stairsOnly = preset === 'stairs';

  // 检索以节点所属地点坐标为中心；无坐标不发起请求（地图未返回≠没有）
  const location = !stairsOnly && node ? (itinerary.places[node.placeId]?.location ?? null) : null;

  useEffect(() => {
    if (!open) return;
    const current: FacilityTarget | null = legId
      ? { type: 'leg', legId }
      : node
        ? { type: 'node', nodeId: node.id }
        : null;
    if (!current) return;
    // 手动录入按已存事实逐属性回读
    const toilet = stairsOnly ? null : getFact(itinerary, current, 'toilet', 'open');
    setToiletState(toilet && toilet.reviewState === 'userChecked' && toilet.value !== null ? 'checked' : 'unknown');
    setToiletText(toilet?.value ? String(toilet.value) : '');
    const restNameFact = stairsOnly ? null : getFact(itinerary, current, 'rest-candidate', 'name');
    const restAddressFact = stairsOnly ? null : getFact(itinerary, current, 'rest-candidate', 'address');
    const restSeatFact = stairsOnly ? null : getFact(itinerary, current, 'rest-candidate', 'seat');
    setRestName(restNameFact?.value ? String(restNameFact.value) : '');
    setRestAddress(restAddressFact?.value ? String(restAddressFact.value) : '');
    setRestSeat(restSeatFact?.value === true ? 'yes' : restSeatFact?.value === false ? 'no' : 'unknown');
    const stairs = getFact(itinerary, current, 'stairs', 'exists');
    setStairsState(
      stairs?.value === true ? 'yes' : stairs?.value === false ? 'no' : 'unknown',
    );
    setStairsNote(stairs?.note ?? '');
    // 搜索状态每次打开重置（不随 itinerary 变化重置，避免写入候选后清掉结果）
    setCategory('TOILET');
    setRadius(500);
    setSearching(false);
    setCandidates([]);
    setFetchedAt(null);
    setSearchPhase('idle');
    setSearchError(null);
    setExpandedId(null);
    setRecordedIds([]);
    setPendingSubmit(null);
    // 刻意不依赖 itinerary：写入候选后不重置未确认的手动输入与检索结果
  }, [open, node, legId, stairsOnly]);

  if (!target) return null;

  /** 提交“确认修改”的待写入项（只含本次实际改动），随后关闭弹层 */
  const submit = (writes: PendingWrite[]) => {
    for (const w of writes) onSave(target, w.kind, w.factKey, w.fact);
    onClose();
  };

  const doSearch = async () => {
    // 无坐标不发起请求，手动设施录入不受影响
    if (!location) return;
    setSearching(true);
    setSearchPhase('idle');
    setSearchError(null);
    setExpandedId(null);
    try {
      const data = await searchNearby(location.longitude, location.latitude, category, radius, 1);
      setCandidates(data.items);
      setFetchedAt(data.fetchedAt);
      setSearchPhase(data.items.length > 0 ? 'done' : 'empty');
    } catch (e) {
      const code = e instanceof ApiRequestError ? e.code : 'UPSTREAM_DATA_INVALID';
      setCandidates([]);
      setFetchedAt(null);
      setSearchError({ code });
      setSearchPhase('error');
    } finally {
      setSearching(false);
    }
  };

  const expandCandidate = (item: PlaceSearchItem) => {
    setExpandedId(item.id);
    // 逐属性确认区每次展开都回到“待确认”，绝不默认“可坐/不可坐/已核对”
    setCandOpenState('unknown');
    setCandOpenText('');
    setCandSeat('unknown');
  };

  /** 确认写入候选：逐属性确认后落 facilityRecord（kind=toilet/rest-candidate，target=该节点） */
  const confirmCandidate = (item: PlaceSearchItem) => {
    if (!target || !fetchedAt) return;
    const now = new Date().toISOString();
    const kind: FacilityKind = category === 'TOILET' ? 'toilet' : 'rest-candidate';
    // 名称、地址按候选原文写入；地址缺失写“未知”，避免残留旧候选地址
    onSave(target, kind, 'name', candidateCheckedFact(item.name, item, fetchedAt, now, itinerary.travelDate));
    onSave(
      target,
      kind,
      'address',
      item.address.trim()
        ? candidateCheckedFact(item.address.trim(), item, fetchedAt, now, itinerary.travelDate)
        : unknownFact(),
    );
    // 候选坐标写入 location 事实（GCJ-02 坐标对象）：转休息点时带出坐标，可自动获取步行数据与绕行对比；
    // 候选无坐标记为未知（不猜坐标），转换后明确提示“位置待确认”
    onSave(
      target,
      kind,
      'location',
      item.location
        ? candidateCheckedFact(item.location, item, fetchedAt, now, itinerary.travelDate)
        : unknownFact(),
    );
    if (kind === 'toilet') {
      // 待确认＝未知，不写成“不开放”
      onSave(
        target,
        kind,
        'open',
        candOpenState === 'checked'
          ? candidateCheckedFact(candOpenText.trim() || null, item, fetchedAt, now, itinerary.travelDate)
          : unknownFact(),
      );
    } else {
      onSave(
        target,
        kind,
        'seat',
        candSeat === 'unknown'
          ? unknownFact()
          : candidateCheckedFact(candSeat === 'yes', item, fetchedAt, now, itinerary.travelDate),
      );
    }
    // 同步手动录入区显示为刚写入的内容，避免“确认修改”用旧值覆盖候选事实
    if (kind === 'toilet') {
      setToiletState(candOpenState);
      setToiletText(candOpenText);
    } else {
      setRestName(item.name);
      setRestAddress(item.address.trim());
      setRestSeat(candSeat);
    }
    setRecordedIds((ids) => (ids.includes(item.id) ? ids : [...ids, item.id]));
    setExpandedId(null);
  };

  const confirm = () => {
    const now = new Date().toISOString();
    const writes: PendingWrite[] = [];
    /** 只收集本次实际改动：未变化不重复写（保留来源）；无已存事实时“待确认”不落空记录 */
    const push = (kind: FacilityKind, factKey: string, fact: Fact<unknown>, compareNote = false) => {
      const prev = getFact(itinerary, target, kind, factKey);
      if (!needsWrite(prev, fact, compareNote)) return;
      writes.push({
        kind,
        factKey,
        fact,
        label: ROLLBACK_LABELS[`${kind}:${factKey}`] ?? `「${factKey}」`,
        rollback: isRollback(prev, fact),
      });
    };

    if (!stairsOnly) {
      const toiletFact: Fact<unknown> =
        toiletState === 'checked'
          ? userCheckedFact(toiletText.trim() || null, now, itinerary.travelDate)
          : unknownFact();
      push('toilet', 'open', toiletFact);

      // 歇脚点候选手动块（3.3）：有输入或已有记录才写，避免产生空记录
      const hasRestInput = restName.trim() !== '' || restAddress.trim() !== '' || restSeat !== 'unknown';
      const hasRestRecord = itinerary.facilities.some(
        (f) => f.kind === 'rest-candidate' && matchesTarget(f.target, target),
      );
      if (hasRestInput || hasRestRecord) {
        push('rest-candidate', 'name', restName.trim() ? userCheckedFact(restName.trim(), now, itinerary.travelDate) : unknownFact());
        push('rest-candidate', 'address', restAddress.trim() ? userCheckedFact(restAddress.trim(), now, itinerary.travelDate) : unknownFact());
        push(
          'rest-candidate',
          'seat',
          restSeat === 'unknown' ? unknownFact() : userCheckedFact(restSeat === 'yes', now, itinerary.travelDate),
        );
      }
    }

    // 台阶的“替代通行说明”存在 note 里，是可编辑内容，比较时按 note 一起比
    const stairsFact: Fact<unknown> =
      stairsState === 'unknown'
        ? unknownFact()
        : { ...userCheckedFact(stairsState === 'yes', now, itinerary.travelDate), note: stairsNote.trim() || null };
    push('stairs', 'exists', stairsFact, true);

    // 显式回退（已核对→待确认）先点名属性二次确认；确认前不写入、不关闭（R-E）
    const labels = writes.filter((w) => w.rollback).map((w) => w.label);
    if (labels.length > 0) {
      setPendingSubmit({ labels, writes });
      return;
    }
    submit(writes);
  };

  /** 确认回退：本次“确认修改”的全部实际改动一并提交（回退＋其他改动，不部分生效） */
  const confirmPending = () => {
    if (!pendingSubmit) return;
    const { writes } = pendingSubmit;
    setPendingSubmit(null);
    submit(writes);
  };

  /** 放弃回退＝放弃本次“确认修改”整体提交：不写入、保留草稿、弹层不关闭 */
  const cancelPending = () => setPendingSubmit(null);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())} title="设施备注（逐属性核对）">
      {stairsOnly ? null : (
        <>
          <div className={editor.field}>
            <label htmlFor="toilet-state">厕所开放情况</label>
            <select id="toilet-state" value={toiletState} onChange={(e) => setToiletState(e.target.value as ToiletState)}>
              <option value="unknown">待确认</option>
              <option value="checked">已核对</option>
            </select>
          </div>
          {toiletState === 'checked' ? (
            <div className={editor.field}>
              <label htmlFor="toilet-text">开放时段说明</label>
              <input id="toilet-text" type="text" value={toiletText} onChange={(e) => setToiletText(e.target.value)} placeholder="例如：8:00-18:00" />
            </div>
          ) : null}

          <div className={editor.candidateBox}>
            <span className={editor.boxTitle}>歇脚点候选（手动记录）</span>
            <div className={editor.field}>
              <label htmlFor="rest-name">名称</label>
              <input id="rest-name" type="text" value={restName} onChange={(e) => setRestName(e.target.value)} placeholder="例如：长椅休息区" />
            </div>
            <div className={editor.field}>
              <label htmlFor="rest-address">位置说明</label>
              <input id="rest-address" type="text" value={restAddress} onChange={(e) => setRestAddress(e.target.value)} placeholder="例如：湖边长廊西侧" />
            </div>
            <div className={editor.field}>
              <label htmlFor="rest-seat">是否可坐</label>
              <select id="rest-seat" value={restSeat} onChange={(e) => setRestSeat(e.target.value as SeatState)}>
                <option value="unknown">待确认</option>
                <option value="yes">可坐</option>
                <option value="no">不可坐</option>
              </select>
            </div>
            <p className={editor.boxHint}>没查到不等于不可坐；核对不到就留“待确认”。</p>
          </div>
        </>
      )}

      <div className={editor.field}>
        <label htmlFor="stairs-state">台阶情况</label>
        <select
          id="stairs-state"
          value={stairsState}
          onChange={(e) => setStairsState(e.target.value as typeof stairsState)}
          autoFocus={stairsOnly}
        >
          <option value="unknown">待确认</option>
          <option value="yes">有台阶</option>
          <option value="no">无台阶（已核对）</option>
        </select>
      </div>
      {stairsState === 'yes' ? (
        <div className={editor.field}>
          <label htmlFor="stairs-note">替代通行说明</label>
          <input id="stairs-note" type="text" value={stairsNote} onChange={(e) => setStairsNote(e.target.value)} placeholder="例如：西侧有无障碍坡道" />
        </div>
      ) : null}

      {stairsOnly ? null : (
        <section className={editor.candidateBox} aria-label="搜索附近">
          <span className={editor.boxTitle}>搜索附近（地图候选，需你逐属性确认）</span>
          <div className={editor.searchRow}>
            <div className={editor.field}>
              <label htmlFor="nearby-category">类别</label>
              <select id="nearby-category" value={category} onChange={(e) => setCategory(e.target.value as NearbyCategory)}>
                <option value="TOILET">厕所</option>
                <option value="REST_CANDIDATE">歇脚处</option>
              </select>
            </div>
            <div className={editor.field}>
              <label htmlFor="nearby-radius">搜索半径</label>
              <select id="nearby-radius" value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
                <option value={300}>300 米</option>
                <option value={500}>500 米</option>
                <option value={1000}>1000 米</option>
                <option value={2000}>2000 米</option>
              </select>
            </div>
            <button type="button" className={`${editor.btn} ${editor.primary}`} disabled={searching} onClick={() => void doSearch()}>
              {searching ? '检索中…' : '搜索'}
            </button>
          </div>

          {location === null ? (
            <p className={editor.boxHint} role="status">
              该站点还没有地图坐标，请先在搜索地点中确认地图位置
            </p>
          ) : null}
          {searching ? (
            <p className={editor.boxHint} role="status" aria-live="polite">
              正在检索附近候选…
            </p>
          ) : null}
          {searchError ? (
            <p className={editor.boxError} role="alert">
              <span>
                {searchError.code === 'AMAP_NOT_CONFIGURED'
                  ? '地图服务未配置（服务端缺少 Web 服务 Key），手动填写不受影响；需要自动检索附近设施时请联系管理员配置。'
                  : '附近检索失败，可重试'}
              </span>
              <button type="button" className={`${editor.btn} ${editor.small}`} onClick={() => void doSearch()}>
                重试
              </button>
            </p>
          ) : null}
          {searchPhase === 'empty' ? (
            <p className={editor.boxHint} role="status">
              附近没有找到候选，可换类别/半径或手动记录
            </p>
          ) : null}

          {candidates.length > 0 ? (
            <ul className={editor.candidateList}>
              {candidates.map((item) => {
                const recorded = recordedIds.includes(item.id);
                const expanded = expandedId === item.id;
                const kind: FacilityKind = category === 'TOILET' ? 'toilet' : 'rest-candidate';
                return (
                  <li key={item.id} className={editor.candidateItem}>
                    <div className={editor.candidateHead}>
                      <span className={editor.candidateName}>{item.name}</span>
                      <span className={editor.badge}>{recorded ? '已记录' : '待核对'}</span>
                    </div>
                    {[item.district, item.address].filter(Boolean).join(' · ') ? (
                      <span className={editor.candidateMeta}>{[item.district, item.address].filter(Boolean).join(' · ')}</span>
                    ) : null}
                    <span className={editor.candidateDistance}>
                      <span>{item.straightLineMeters != null ? `直线约 ${item.straightLineMeters} 米` : '直线距离未知'}</span>
                      <span className={editor.candidateWarn}>直线距离，非步行路程</span>
                    </span>
                    <div className={editor.candidateActions}>
                      <button
                        type="button"
                        className={`${editor.btn} ${editor.small}`}
                        aria-expanded={expanded}
                        onClick={() => (expanded ? setExpandedId(null) : expandCandidate(item))}
                      >
                        记录到此站
                      </button>
                    </div>
                    {expanded ? (
                      <div role="group" aria-label="逐属性确认" className={editor.candidateBox}>
                        {kind === 'toilet' ? (
                          <>
                            <div className={editor.field}>
                              <label htmlFor={`cand-open-${item.id}`}>开放情况</label>
                              <select
                                id={`cand-open-${item.id}`}
                                value={candOpenState}
                                onChange={(e) => setCandOpenState(e.target.value as ToiletState)}
                              >
                                <option value="unknown">待确认</option>
                                <option value="checked">已核对</option>
                              </select>
                            </div>
                            {candOpenState === 'checked' ? (
                              <div className={editor.field}>
                                <label htmlFor={`cand-open-text-${item.id}`}>开放时段说明</label>
                                <input
                                  id={`cand-open-text-${item.id}`}
                                  type="text"
                                  value={candOpenText}
                                  onChange={(e) => setCandOpenText(e.target.value)}
                                  placeholder="例如：8:00-18:00"
                                />
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className={editor.field}>
                            <label htmlFor={`cand-seat-${item.id}`}>是否可坐</label>
                            <select
                              id={`cand-seat-${item.id}`}
                              value={candSeat}
                              onChange={(e) => setCandSeat(e.target.value as SeatState)}
                            >
                              <option value="unknown">待确认</option>
                              <option value="yes">可坐</option>
                              <option value="no">不可坐</option>
                            </select>
                          </div>
                        )}
                        {itinerary.facilities.some((f) => f.kind === kind && matchesTarget(f.target, target)) ? (
                          <p className={editor.boxHint}>
                            该站已有{kind === 'toilet' ? '厕所' : '歇脚点候选'}记录，确认写入会更新（覆盖）原有同名属性。
                          </p>
                        ) : null}
                        <p className={editor.boxHint}>
                          逐属性确认后才会写入；“待确认”记为未知，不会记成“没有/不可用”。
                        </p>
                        <div className={dialogStyles.actions}>
                          <button type="button" className={editor.btn} onClick={() => setExpandedId(null)}>
                            收起
                          </button>
                          <button type="button" className={`${editor.btn} ${editor.primary}`} onClick={() => confirmCandidate(item)}>
                            确认写入
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <p className={editor.boxHint}>候选只是候选：确认写入前不会记入行程；直线距离不能当步行路程或耗时用。</p>
        </section>
      )}

      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--font-small)' }}>
        核对仅表示你本次确认的实际情况，不代表永久有效；地图返回的信息会标注来源与获取时间。
      </p>

      <div className={dialogStyles.actions}>
        <button type="button" className={editor.btn} onClick={onClose}>
          取消
        </button>
        <button type="button" className={`${editor.btn} ${editor.primary}`} onClick={confirm}>
          确认修改
        </button>
      </div>

      {/* 显式回退二次确认（R-E）：ConfirmDialog 经 Portal 独立渲染，点名属性后才执行回退 */}
      <ConfirmDialog
        open={pendingSubmit !== null}
        title="退回待确认？"
        description={`将把已核对的${(pendingSubmit?.labels ?? []).join('')}退回待确认。退回后该属性记为“待确认”（未知），原核对结果与来源不再保留。`}
        confirmText="确认退回"
        danger
        onConfirm={confirmPending}
        onCancel={cancelPending}
      />
    </Dialog>
  );
}
