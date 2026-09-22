/**
 * 行程编辑视图（UI-02；需求 R01/R02/R03/R07）。
 * 主编辑区有效修改自动保存；节点/路段用局部草稿弹层，确认才提交。
 */
import { useMemo, useState } from 'react';
import type { Itinerary, Leg, RouteNode } from '../../../shared/contracts/domain';
import { activeSequence } from '../../../shared/contracts/domain';
import type { TripStats } from '../../domain/compute';
import type { CardStatus } from '../../domain/status';
import {
  addRestNode,
  addVisitNode,
  adoptAllMapLegs,
  confirmEntrance,
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
  upsertNodeFacilityFact,
  upsertPlace,
} from '../../domain/itinerary';
import { ceilMinutes } from '../../domain/format';
import { TextField } from '../../components/fields';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { NodeEditDialog } from './NodeEditDialog';
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
  onShowPreview: () => void;
  onDeleteAll: () => void;
}

interface LegTarget {
  leg: Leg;
  fromName: string;
  toName: string;
}

export function TripEditor({
  itinerary: it,
  apply,
  stats,
  cardStatus,
  onShowPreview,
  onDeleteAll,
}: TripEditorProps) {
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editingLeg, setEditingLeg] = useState<LegTarget | null>(null);
  const [adding, setAdding] = useState<'visit' | 'rest' | null>(null);
  const [facilityNodeId, setFacilityNodeId] = useState<string | null>(null);
  const [confirmSkipId, setConfirmSkipId] = useState<string | null>(null);
  const [confirmDeleteNodeId, setConfirmDeleteNodeId] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const seq = useMemo(() => activeSequence(it), [it]);
  const activeVisits = seq.filter((id) => it.nodes[id]?.kind === 'visit');
  const visitIndex = new Map(activeVisits.map((id, i) => [id, i + 1]));
  const skippedNodes = it.nodeOrder.map((id) => it.nodes[id]).filter((n) => n?.skipped);

  const amapReadyLegs = Object.values(it.legs).filter(
    (l) => l.durationSource === 'amap' && l.state === 'ready',
  );

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

  const saveNodePatch = (nodeId: string) => (patch: { name: string; entranceConfirmed?: boolean } & Partial<RouteNode>) => {
    apply((prev) => {
      const node = prev.nodes[nodeId];
      if (!node) return prev;
      let next = upsertPlace(prev, { ...prev.places[node.placeId], name: patch.name });
      if (patch.entranceConfirmed !== undefined) {
        next = confirmEntrance(next, node.placeId, patch.entranceConfirmed);
      }
      const { name: _name, entranceConfirmed: _entrance, ...nodePatch } = patch;
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
        <SummaryItem label="预计总步行" value={stats.totalWalkSeconds ?? stats.totalWalkKnownSeconds} unit="分钟" warn={stats.totalWalkSeconds === null} note={stats.totalWalkSeconds === null ? `已知约 ${ceilMinutes(stats.totalWalkKnownSeconds)} 分钟` : undefined} />
        <SummaryItem label="预计全程用时" value={stats.totalDurationSeconds ?? stats.totalDurationKnownSeconds} unit="分钟" warn={stats.totalDurationSeconds === null} />
        <SummaryItem label="最长连续步行" value={stats.longestContinuousWalkSeconds} unit="分钟" warn={stats.longestContinuousWalkSeconds === null} note={stats.longestContinuousWalkSeconds === null ? '待确认' : undefined} />
        <SummaryItem label="计划休息" value={stats.plannedRestCount} unit="次" warn={false} />
      </div>

      {amapReadyLegs.length > 0 ? (
        <div className={`${styles.reminder} info`} role="note">
          <span>
            有 {amapReadyLegs.length} 段步行时间来自地图查询，仅当前会话有效；采纳后可离线查看与导出。
          </span>
          <button
            type="button"
            className={`${styles.btn} ${styles.primary} ${styles.small}`}
            onClick={() =>
              apply((prev) => {
                const { itinerary } = adoptAllMapLegs(prev);
                return itinerary;
              })
            }
          >
            采纳全部路段时间
          </button>
        </div>
      ) : null}

      {cardStatus.kind === 'violated' || cardStatus.kind === 'draft' || cardStatus.kind === 'blocked'
        ? cardStatus.notices.map((n, i) => (
            <div key={i} className={`${styles.reminder} ${n.severity === 'error' ? 'error' : n.severity === 'warning' ? 'warning' : 'info'}`} role="note">
              <span>{n.text}</span>
            </div>
          ))
        : null}

      <div className={styles.nodes}>
        {seq.map((id, idx) => {
          if (it.origin?.id === id || it.destination?.id === id) {
            const isOrigin = it.origin?.id === id;
            const placeName = nameOf(id);
            return (
              <div key={id} className={styles.nodeCard} style={{ opacity: 0.9 }}>
                <div className={styles.nodeHead}>
                  <span className={styles.nodeTitle}>{isOrigin ? '起点' : '终点'} · {placeName || '未设置'}</span>
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
                />
              ) : null}
              <RouteNodeCard
                node={node}
                place={it.places[node.placeId]}
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
        <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={onShowPreview} style={{ marginLeft: 'auto' }}>
          预览路线卡
        </button>
      </div>

      <div className={styles.dangerZone}>
        <button type="button" className={`${styles.btn} ${styles.danger} ${styles.small}`} onClick={() => setConfirmDeleteAll(true)}>
          删除整份行程
        </button>
      </div>

      <NodeEditDialog
        open={editingNodeId !== null}
        node={editingNodeId ? (it.nodes[editingNodeId] ?? null) : null}
        place={editingNodeId ? (it.places[it.nodes[editingNodeId]?.placeId ?? ''] ?? null) : null}
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
        open={facilityNodeId !== null}
        node={facilityNodeId ? (it.nodes[facilityNodeId] ?? null) : null}
        itinerary={it}
        onClose={() => setFacilityNodeId(null)}
        onSave={(nodeId, kind, key, fact) => apply((p) => upsertNodeFacilityFact(p, nodeId, kind, key, fact))}
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
        open={confirmDeleteAll}
        title="删除整份行程？"
        description="将清除本机保存的这份行程，且无法恢复。建议先导出图片留存。"
        confirmText="确认删除"
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

function SummaryItem({ label, value, unit, warn, note }: { label: string; value: number | null; unit: string; warn: boolean; note?: string }) {
  return (
    <div className={styles.summaryItem}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${warn ? 'warn' : ''}`}>
        {value === null ? '待确认' : `${ceilMinutes(value)} ${unit}`}
      </span>
      {note ? <span className={styles.note}>{note}</span> : null}
    </div>
  );
}

function LegRow({ leg, fromName, toName, onEdit }: { leg: Leg; fromName: string; toName: string; onEdit: () => void }) {
  const ready = leg.state === 'ready' || leg.state === 'stale';
  const text = ready
    ? `步行约 ${Math.ceil((leg.effectiveWalkingSeconds ?? 0) / 60)} 分钟${leg.mode === 'manual-transfer' ? '（含接驳）' : ''}`
    : leg.state === 'loading'
      ? '正在获取…'
      : '步行时间待补充';
  return (
    <div className={`${styles.legRow} ${ready ? '' : 'missing'}`}>
      <span aria-live="polite">
        ↓ {text}
        {leg.durationSource === 'adopted' ? ' · 已采纳地图估算' : ''}
      </span>
      <button type="button" className={`${styles.btn} ${styles.small}`} onClick={onEdit} aria-label={`编辑路段 ${fromName} 到 ${toName}`}>
        编辑
      </button>
    </div>
  );
}
