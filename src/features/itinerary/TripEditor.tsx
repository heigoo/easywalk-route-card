/**
 * 行程编辑视图（UI-02；需求 R01/R02/R03/R07）。
 * 主编辑区有效修改自动保存；节点/路段用局部草稿弹层，确认才提交。
 */
import { useMemo, useRef, useState } from 'react';
import type { Itinerary, Leg } from '../../../shared/contracts/domain';
import { activeSequence } from '../../../shared/contracts/domain';
import type { TripStats } from '../../domain/compute';
import type { CardStatus } from '../../domain/status';
import {
  addRestNode,
  addVisitNode,
  adoptAllMapLegs,
  confirmEntrance,
  convertRestCandidateToRestNode,
  createPlace,
  moveNode,
  removeNode,
  restoreLegToMapValue,
  restoreNode,
  setEndpoint,
  setManualLegTime,
  skipNode,
  updateBasics,
  updateNode,
  upsertFacilityFactForTarget,
  upsertPlace,
} from '../../domain/itinerary';
import { ceilMinutes } from '../../domain/format';
import { detourNoticeFor, useDetourCompare } from '../planning/useDetourCompare';
import { parseItineraryBackup, serializeItineraryBackup } from '../../storage/local';
import { TextField } from '../../components/fields';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { NodeEditDialog, type NodeSavePatch } from './NodeEditDialog';
import { LegEditDialog, type LegSavePatch } from './LegEditDialog';
import { AddNodeDialog } from './AddNodeDialog';
import { FacilityDialog } from '../facilities/FacilityDialog';
import { RouteNodeCard } from './RouteNodeCard';
import styles from './Editor.module.css';

export interface TripEditorProps {
  itinerary: Itinerary;
  apply: (fn: (it: Itinerary) => Itinerary) => void;
  stats: TripStats;
  cardStatus: CardStatus;
  onDeleteAll: () => void;
  /** 导入备份确认后：整体替换当前行程并按既有机制持久化 */
  onReplaceItinerary: (next: Itinerary) => void;
}

interface LegTarget {
  leg: Leg;
  fromName: string;
  toName: string;
}

/** 导入失败的持久错误文案（不用一闪而过的提示；当前行程保持不变） */
const IMPORT_ERROR_TEXT: Record<string, string> = {
  invalidJson: '文件不是合法 JSON',
  unsupported: '备份版本无法识别',
  invalidShape: '备份内容不完整',
};

/** 读取备份文件文本（FileReader：浏览器与测试环境均可用） */
function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsText(file);
  });
}

export function TripEditor({
  itinerary: it,
  apply,
  stats,
  cardStatus,
  onDeleteAll,
  onReplaceItinerary,
}: TripEditorProps) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingLeg, setEditingLeg] = useState<LegTarget | null>(null);
  const [adding, setAdding] = useState<'visit' | 'rest' | null>(null);
  const [facilityNodeId, setFacilityNodeId] = useState<string | null>(null);
  const [facilityLegId, setFacilityLegId] = useState<string | null>(null);
  const [confirmSkipId, setConfirmSkipId] = useState<string | null>(null);
  const [confirmDeleteNodeId, setConfirmDeleteNodeId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmAdoptAll, setConfirmAdoptAll] = useState(false);
  const [pendingImport, setPendingImport] = useState<Itinerary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  /** 候选转休息点后的持久提示（Task 3 / R-B）：不是一闪而过的 Toast */
  const [convertHint, setConvertHint] = useState<{ locationMissing: boolean } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // 歇脚绕行对照（Task 4 / R-D）：结果仅会话内，不写行程、不落盘
  const detour = useDetourCompare(it);

  const seq = useMemo(() => activeSequence(it), [it]);
  const activeVisits = seq.filter((id) => it.nodes[id]?.kind === 'visit');
  const visitIndex = new Map(activeVisits.map((id, i) => [id, i + 1]));
  const skippedNodes = it.nodeOrder.map((id) => it.nodes[id]).filter((n) => n?.skipped);

  const amapLegs = Object.values(it.legs).filter((l) => l.durationSource === 'amap');

  // 汇总口径展示（UX 评审修复）：空行程不显示“0 分钟/0 次”，未核实休息点显式说明
  const isEmptyTrip = seq.length === 0;
  const restNodeCount = seq.filter((id) => it.nodes[id]?.kind === 'rest').length;

  const nameOf = (id: string): string => {
    if (it.origin?.id === id) return it.places[it.origin.placeId]?.name ?? '起点';
    if (it.destination?.id === id) return it.places[it.destination.placeId]?.name ?? '终点';
    const n = it.nodes[id];
    return n ? (it.places[n.placeId]?.name ?? '未命地点') : '';
  };

  const legBefore = (nodeId: string, seqIndex: number): Leg | undefined => {
    if (seqIndex <= 0) return undefined;
    return Object.values(it.legs).find((l) => l.fromNodeId === seq[seqIndex - 1] && l.toNodeId === nodeId);
  };

  const setEndpointName = (role: 'origin' | 'destination') => (name: string) => {
    apply((prev) => {
      const endpoint = prev[role];
      const existing = endpoint ? prev.places[endpoint.placeId] : null;
      if (existing && existing.name === name.trim()) return prev;
      const place = createPlace(name.trim() || (role === 'origin' ? '起点' : '终点'));
      return setEndpoint(upsertPlace(prev, place), role, place.id);
    });
  };

  const saveNodePatch = (nodeId: string) => (patch: NodeSavePatch) => {
    apply((prev) => {
      const node = prev.nodes[nodeId];
      if (!node) return prev;
      const { name: _name, entranceConfirmed: _entrance, placePatch, ...nodePatch } = patch;
      // 地点级开放事实写在 PlaceRef 上；placePatch 缺省＝本次不修改
      let next = upsertPlace(prev, {
        ...prev.places[node.placeId],
        name: patch.name,
        ...(placePatch?.openingDescription ? { openingDescription: placePatch.openingDescription } : {}),
        ...(placePatch?.openingSchedule ? { openingSchedule: placePatch.openingSchedule } : {}),
      });
      if (patch.entranceConfirmed !== undefined) {
        next = confirmEntrance(next, node.placeId, patch.entranceConfirmed);
      }
      next = updateNode(next, nodeId, nodePatch);
      return next;
    });
  };

  const saveLeg = (patch: LegSavePatch) => {
    if (!editingLeg) return;
    apply((prev) =>
      setManualLegTime(prev, editingLeg.leg.id, {
        walkingSeconds: patch.walkingSeconds,
        totalSeconds: patch.totalSeconds,
        mode: patch.mode,
      }),
    );
  };

  const confirmSkip = () => {
    if (!confirmSkipId) return;
    apply((prev) => skipNode(prev, confirmSkipId));
    setConfirmSkipId(null);
  };

  /**
   * 歇脚点候选一键转休息点（Task 3 / R-B）：
   * 提示只依赖转换前可知的信息（新节点是否带坐标），不从状态更新器里捕获新 id。
   */
  const convertRestCandidate = (facilityId: string, afterNodeId: string) => {
    const preview = convertRestCandidateToRestNode(it, facilityId, afterNodeId);
    const created = preview.nodeId ? preview.itinerary.nodes[preview.nodeId] : null;
    const place = created ? preview.itinerary.places[created.placeId] : null;
    setConvertHint({ locationMissing: place ? place.location === null : true });
    apply((prev) => convertRestCandidateToRestNode(prev, facilityId, afterNodeId).itinerary);
  };

  /** 休息点行的歇脚绕行对比（Task 4 / R-D）；对照不可得一律“绕行对比待补充” */
  const detourLineFor = (nodeId: string) => {
    const notice = detourNoticeFor(it, nodeId, detour.compares);
    if (!notice) return null;
    return (
      <div className={styles.detourLine}>
        <span aria-live="polite">{notice.text}</span>
        {notice.retryable ? (
          <button type="button" className={`${styles.btn} ${styles.small}`} onClick={() => detour.retry(nodeId)}>
            重试对比
          </button>
        ) : null}
      </div>
    );
  };

  /** 导出备份文件：文件名=省脚力路线卡-{行程名称或“未命名”}-{出游日期或“无日期”}.json */
  const exportBackup = () => {
    const blob = new Blob([serializeItineraryBackup(it)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `省脚力路线卡-${it.title.trim() || '未命名'}-${it.travelDate ?? '无日期'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  /** 导入备份：解析失败保持当前行程不变并持续显示原因；成功先进二次确认 */
  const importBackupFile = async (file: File) => {
    let text: string;
    try {
      text = await readFileText(file);
    } catch {
      setPendingImport(null);
      setImportError(`${IMPORT_ERROR_TEXT.invalidJson}，当前行程保持不变`);
      return;
    }
    const result = parseItineraryBackup(text);
    if (!result.ok) {
      setPendingImport(null);
      setImportError(`${IMPORT_ERROR_TEXT[result.error] ?? IMPORT_ERROR_TEXT.invalidShape}，当前行程保持不变`);
      return;
    }
    setImportError(null);
    setPendingImport(result.itinerary);
  };

  return (
    <div className={styles.editor}>
      <div className={styles.basics}>
        <div className={styles.full}>
          <TextField id="title" label="行程名称" value={it.title} onCommit={(v) => apply((p) => updateBasics(p, { title: v }))} placeholder="未命名行程" />
        </div>
        <TextField id="city" label="城市" value={it.city} onCommit={(v) => apply((p) => updateBasics(p, { city: v }))} />
        <div className={styles.field}>
          <label htmlFor="travel-date">出游日期</label>
          <input
            id="travel-date"
            type="date"
            value={it.travelDate ?? ''}
            onChange={(e) => apply((p) => updateBasics(p, { travelDate: e.target.value || null }))}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="departure">出发时间</label>
          <input
            id="departure"
            type="time"
            value={it.departureLocalTime ?? ''}
            onChange={(e) => apply((p) => updateBasics(p, { departureLocalTime: e.target.value || null }))}
          />
        </div>
        <TextField
          id="origin"
          label="起点"
          value={it.origin ? (it.places[it.origin.placeId]?.name ?? '') : ''}
          onCommit={setEndpointName('origin')}
          placeholder="例如：酒店门口"
        />
        <TextField
          id="destination"
          label="终点"
          value={it.destination ? (it.places[it.destination.placeId]?.name ?? '') : ''}
          onCommit={setEndpointName('destination')}
          placeholder="例如：地铁站"
        />
      </div>

      <div className={styles.summary} role="status" aria-label="步行与用时汇总">
        <SummaryItem
          label="预计总步行"
          value={stats.totalWalkSeconds ?? (stats.totalWalkKnownSeconds > 0 ? stats.totalWalkKnownSeconds : null)}
          unit="分钟"
          warn={stats.totalWalkSeconds === null}
          empty={isEmptyTrip}
          note={
            isEmptyTrip
              ? '添加景点后计算'
              : stats.totalWalkSeconds === null
                ? stats.totalWalkKnownSeconds > 0
                  ? `已知约 ${ceilMinutes(stats.totalWalkKnownSeconds)} 分钟`
                  : '步行数据待补充'
                : undefined
          }
        />
        <SummaryItem
          label="预计全程用时"
          value={stats.totalDurationSeconds ?? (stats.totalDurationKnownSeconds > 0 ? stats.totalDurationKnownSeconds : null)}
          unit="分钟"
          warn={stats.totalDurationSeconds === null}
          empty={isEmptyTrip}
        />
        <SummaryItem
          label="最长连续步行"
          value={stats.longestContinuousWalkSeconds}
          unit="分钟"
          warn={stats.longestContinuousWalkSeconds === null}
          empty={isEmptyTrip}
          note={!isEmptyTrip && stats.longestContinuousWalkSeconds === null ? '休息或园内步行信息待确认' : undefined}
        />
        <SummaryItem
          label="已核实坐休"
          value={stats.plannedRestCount}
          unit="次"
          warn={false}
          empty={isEmptyTrip}
          note={!isEmptyTrip && restNodeCount > stats.plannedRestCount ? '有休息点未计入（座位或时长待核实）' : undefined}
        />
      </div>

      {amapLegs.length > 0 ? (
        <div className={`${styles.reminder} ${styles.info}`} role="note">
          <span>
            有 {amapLegs.length} 段步行时间来自地图查询，仅当前会话有效；采纳后可离线查看与导出。
          </span>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary} ${styles.small}`}
            onClick={() => setConfirmAdoptAll(true)}
          >
            采纳全部地图估算（{amapLegs.length} 段）
          </button>
        </div>
      ) : null}

      {convertHint ? (
        <div className={`${styles.reminder} ${styles.info}`} role="note">
          <span>已加入路线，请补充新路段步行时间</span>
          {convertHint.locationMissing ? <span>位置待确认，暂不能自动获取步行数据</span> : null}
          <button type="button" className={`${styles.btn} ${styles.small}`} onClick={() => setConvertHint(null)}>
            知道了
          </button>
        </div>
      ) : null}

      {cardStatus.kind === 'violated' || cardStatus.kind === 'draft' || cardStatus.kind === 'blocked'
        ? cardStatus.notices.map((n, i) => (
            <div key={i} className={`${styles.reminder} ${n.severity === 'error' ? styles.error : n.severity === 'warning' ? styles.warning : styles.info}`} role="note">
              <span>{n.text}</span>
            </div>
          ))
        : null}

      <div className={styles.nodes}>
        {seq.map((id, idx) => {
          if (it.origin?.id === id || it.destination?.id === id) {
            const isOrigin = it.origin?.id === id;
            const placeName = nameOf(id);
            // 终点前也有路段：与景点分支同样渲染 LegRow（起点是 seq[0]，其前无路段，legBefore 返回 undefined）
            const leg = legBefore(id, idx);
            return (
              <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
                {leg ? (
                  <LegRow
                    leg={leg}
                    fromName={nameOf(seq[idx - 1])}
                    toName={nameOf(id)}
                    onEdit={() => setEditingLeg({ leg, fromName: nameOf(seq[idx - 1]), toName: nameOf(id) })}
                    onRecordStairs={() => setFacilityLegId(leg.id)}
                  />
                ) : null}
                <div className={styles.nodeCard} style={{ opacity: 0.9 }}>
                  <div className={styles.nodeHead}>
                    <span className={styles.nodeTitle}>{isOrigin ? '起点' : '终点'} · {placeName || '未设置'}</span>
                  </div>
                </div>
              </div>
            );
          }
          const node = it.nodes[id];
          if (!node) return null;
          const leg = legBefore(id, idx);
          return (
            <div key={id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
              {leg ? (
                <LegRow
                  leg={leg}
                  fromName={nameOf(seq[idx - 1])}
                  toName={nameOf(id)}
                  onEdit={() => setEditingLeg({ leg, fromName: nameOf(seq[idx - 1]), toName: nameOf(id) })}
                  onRecordStairs={() => setFacilityLegId(leg.id)}
                />
              ) : null}
              <RouteNodeCard
                node={node}
                place={it.places[node.placeId]}
                facilities={it.facilities.filter((f) => f.target.type === 'node' && f.target.nodeId === id)}
                onConvertRestCandidate={(facilityId) => convertRestCandidate(facilityId, id)}
                index={node.kind === 'visit' ? (visitIndex.get(id) ?? null) : null}
                isFirst={idx === (it.origin ? 1 : 0)}
                isLast={idx === seq.length - (it.destination ? 2 : 1)}
                onEdit={() => setEditingNodeId(id)}
                onFacility={() => setFacilityNodeId(id)}
                onMoveUp={() => apply((p) => moveNode(p, id, -1))}
                onMoveDown={() => apply((p) => moveNode(p, id, 1))}
                onSkip={() => {
                  if (node.kind === 'visit' && node.required) setConfirmSkipId(id);
                  else apply((p) => skipNode(p, id));
                }}
                onDelete={() => setConfirmDeleteNodeId(id)}
              />
              {node.kind === 'rest' ? detourLineFor(id) : null}
            </div>
          );
        })}
      </div>

      {skippedNodes.length > 0 ? (
        <div className={styles.skippedSection}>
          <h3>已跳过（资料保留）</h3>
          {skippedNodes.map((n) => (
            <div key={n!.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
              <span style={{ overflowWrap: 'anywhere' }}>{it.places[n!.placeId]?.name ?? '未命地点'}</span>
              <button type="button" className={`${styles.btn} ${styles.small}`} onClick={() => apply((p) => restoreNode(p, n!.id))}>
                恢复
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.small}`}
                onClick={() => setConfirmDeleteNodeId(n!.id)}
              >
                永久删除
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className={styles.addRow}>
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={() => setAdding('visit')}>
          添加景点
        </button>
        <button type="button" className={styles.btn} onClick={() => setAdding('rest')}>
          添加休息点
        </button>
      </div>

      <div className={styles.backupRow}>
        <span className={styles.backupHint}>
          备份与恢复：导出 JSON 备份文件，清缓存或换设备后可从备份恢复（未采纳的地图估算不随备份导出）。
        </span>
        <button type="button" className={styles.btn} onClick={exportBackup}>
          导出备份
        </button>
        <button type="button" className={styles.btn} onClick={() => importInputRef.current?.click()}>
          导入备份
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = '';
            if (file) void importBackupFile(file);
          }}
        />
      </div>

      {importError ? (
        <div className={`${styles.reminder} ${styles.error}`} role="alert">
          <span>{importError}</span>
        </div>
      ) : null}

      <div className={styles.dangerZone}>
        <button type="button" className={`${styles.btn} ${styles.danger} ${styles.small}`} onClick={() => setConfirmDeleteAll(true)}>
          清空行程内容
        </button>
      </div>

      <NodeEditDialog
        open={editingNodeId !== null}
        node={editingNodeId ? (it.nodes[editingNodeId] ?? null) : null}
        place={editingNodeId ? (it.places[it.nodes[editingNodeId]?.placeId ?? ''] ?? null) : null}
        travelDate={it.travelDate}
        timezone={it.timezone}
        onClose={() => setEditingNodeId(null)}
        onSave={editingNodeId ? saveNodePatch(editingNodeId) : () => undefined}
      />

      <LegEditDialog
        open={editingLeg !== null}
        leg={editingLeg?.leg ?? null}
        fromName={editingLeg?.fromName ?? ''}
        toName={editingLeg?.toName ?? ''}
        onClose={() => setEditingLeg(null)}
        onSave={saveLeg}
        onRestoreMapValue={(legId) => apply((p) => restoreLegToMapValue(p, legId))}
      />

      <AddNodeDialog
        kind={adding}
        onClose={() => setAdding(null)}
        onAdd={(kind, init) =>
          apply((prev) => {
            const place = createPlace(init.name);
            const withPlace = upsertPlace(prev, place);
            return kind === 'visit'
              ? addVisitNode(withPlace, place.id, {
                  required: init.required,
                  visitSeconds: init.minutes,
                  insideWalkSeconds: init.insideMinutes,
                })
              : addRestNode(withPlace, place.id, { restSeconds: init.minutes });
          })
        }
      />

      <FacilityDialog
        open={facilityNodeId !== null || facilityLegId !== null}
        node={facilityNodeId ? (it.nodes[facilityNodeId] ?? null) : null}
        legId={facilityLegId}
        preset={facilityLegId !== null ? 'stairs' : undefined}
        itinerary={it}
        onClose={() => {
          setFacilityNodeId(null);
          setFacilityLegId(null);
        }}
        onSave={(target, kind, key, fact) => apply((p) => upsertFacilityFactForTarget(p, target, kind, key, fact))}
      />

      <ConfirmDialog
        open={confirmSkipId !== null}
        title="跳过必去景点？"
        description={`「${confirmSkipId ? nameOf(confirmSkipId) : ''}」标记为必去。跳过后相关路段需要重新获取或填写。`}
        confirmText="确认跳过"
        onConfirm={confirmSkip}
        onCancel={() => setConfirmSkipId(null)}
      />

      <ConfirmDialog
        open={confirmDeleteNodeId !== null}
        title="永久删除节点？"
        description="删除后不可恢复（区别于“跳过”）。该节点的设施备注将一并移除。"
        confirmText="永久删除"
        danger
        onConfirm={() => {
          if (confirmDeleteNodeId) apply((p) => removeNode(p, confirmDeleteNodeId));
          setConfirmDeleteNodeId(null);
        }}
        onCancel={() => setConfirmDeleteNodeId(null)}
      />

      <ConfirmDialog
        open={confirmAdoptAll}
        title="采纳全部地图估算？"
        description={`确认后将对 ${amapLegs.length} 段地图估算路段写入采纳。采纳后按你的估计保存、可在本机离线查看；采纳≠实地核实，来源与获取时间保留。`}
        confirmText="确认采纳"
        onConfirm={() => {
          setConfirmAdoptAll(false);
          apply((prev) => adoptAllMapLegs(prev).itinerary);
        }}
        onCancel={() => setConfirmAdoptAll(false)}
      />

      <ConfirmDialog
        open={pendingImport !== null}
        title="导入备份？"
        description="导入将覆盖当前行程，是否继续？"
        confirmText="确认导入"
        danger
        onConfirm={() => {
          if (pendingImport) onReplaceItinerary(pendingImport);
          setPendingImport(null);
        }}
        onCancel={() => setPendingImport(null)}
      />

      <ConfirmDialog
        open={confirmDeleteAll}
        title="清空行程内容？"
        description="将清空当前行程的全部内容（行程记录保留、其他行程不受影响），且无法恢复。建议先导出图片留存。"
        confirmText="确认清空"
        danger
        onConfirm={() => {
          setConfirmDeleteAll(false);
          onDeleteAll();
        }}
        onCancel={() => setConfirmDeleteAll(false)}
      />
    </div>
  );
}

function SummaryItem({ label, value, unit, warn, note, empty }: { label: string; value: number | null; unit: string; warn: boolean; note?: string; empty?: boolean }) {
  return (
    <div className={styles.summaryItem}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${empty ? styles.empty : warn ? styles.warn : ''}`}>
        {empty ? '—' : value === null ? '待确认' : `${ceilMinutes(value)} ${unit}`}
      </span>
      {note ? <span className={styles.note}>{note}</span> : null}
    </div>
  );
}

function LegRow({
  leg,
  fromName,
  toName,
  onEdit,
  onRecordStairs,
}: {
  leg: Leg;
  fromName: string;
  toName: string;
  onEdit: () => void;
  onRecordStairs: () => void;
}) {
  const ready = leg.state === 'ready' || leg.state === 'stale';
  const text = ready
    ? `步行约 ${Math.ceil((leg.effectiveWalkingSeconds ?? 0) / 60)} 分钟${leg.mode === 'manual-transfer' ? '（含接驳）' : ''}`
    : leg.state === 'loading'
      ? '正在获取…'
      : '步行时间待补充';
  // 地图报告了阶梯才提示；未返回不生成“无台阶”结论（未知不等于没有）
  const stairsReported = leg.reportedFeatures.some((f) => f.kind === 'stairs');
  return (
    <div className={`${styles.legRow} ${ready ? '' : styles.missing}`}>
      <span aria-live="polite">
        ↓ {text}
        {leg.durationSource === 'adopted' ? ' · 已采纳地图估算' : ''}
      </span>
      {stairsReported ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sp-2)' }}>
          <span>高德标注本段可能有阶梯（待核对）</span>
          <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onRecordStairs}>
            记录台阶核对
          </button>
        </span>
      ) : null}
      <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onEdit} aria-label={`编辑路段 ${fromName} 到 ${toName}`}>
        编辑
      </button>
    </div>
  );
}
