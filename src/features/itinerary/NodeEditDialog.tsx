/**
 * 节点编辑面板（UI-03）：局部草稿，确认才提交；取消不修改原数据（第 14.3 节）。
 * 校验：园内步行不得大于停留（A07）；非法值就地提示且不入领域模型。
 * 开放时间（R-A2）：地图参考文本可“写入并标记核对”（写 user/userChecked 事实）；
 * 结构化开放时段手动录入，无效输入就地报错、不静默修正；适用日期必须是出游日期。
 */
import { useEffect, useState } from 'react';
import type {
  Fact,
  OpeningSchedule,
  OpeningWindow,
  PlaceRef,
  RouteNode,
} from '../../../shared/contracts/domain';
import { unknownFact } from '../../../shared/contracts/domain';
import { Dialog } from '../../components/Dialog';
import { parseMinutesInput } from '../../components/fields';
import { formatShanghaiDateTime } from '../../domain/format';
import { openingScheduleFromText } from '../../domain/opening';
import editor from './Editor.module.css';
import dialogStyles from '../../components/Dialog.module.css';

/** 地点级开放事实补丁（写在 PlaceRef 上）；缺省＝本次不修改 */
export interface PlaceOpeningPatch {
  openingDescription?: Fact<string>;
  openingSchedule?: Fact<OpeningSchedule>;
}

export type NodeSavePatch = {
  name: string;
  entranceConfirmed?: boolean;
  /** 地点级开放事实；缺省＝本次不修改 */
  placePatch?: PlaceOpeningPatch;
} & Partial<RouteNode>;

export interface NodeEditDialogProps {
  open: boolean;
  node: RouteNode | null;
  place: PlaceRef | null;
  /** 出游日期：开放时段的适用日期；未填写时不允许保存开放时段 */
  travelDate: string | null;
  /** 行程时区 */
  timezone: string;
  onClose: () => void;
  onSave: (patch: NodeSavePatch) => void;
}

/** 当天开放三态：开放（一段窗口）/ 不开放（空窗口）/ 待确认（value=null） */
type OpeningMode = 'open' | 'closed' | 'unknown';

/** 手动时间输入只接受严格 HH:mm；不合法不保存、不静默修正 */
const HH_MM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 窗口数组 → 展示文本 */
function windowsText(windows: OpeningWindow[]): string {
  if (windows.length === 0) return '当天不开放';
  return windows.map((w) => `${w.startLocalTime}-${w.endLocalTime}`).join('、');
}

export function NodeEditDialog({
  open,
  node,
  place,
  travelDate,
  timezone,
  onSave,
  onClose,
}: NodeEditDialogProps) {
  const [name, setName] = useState('');
  const [stayText, setStayText] = useState('');
  const [insideText, setInsideText] = useState('');
  const [required, setRequired] = useState(true);
  const [restText, setRestText] = useState('');
  const [seat, setSeat] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [notes, setNotes] = useState('');
  const [entranceConfirmed, setEntranceConfirmed] = useState(false);
  const [openingMode, setOpeningMode] = useState<OpeningMode>('unknown');
  const [openStart, setOpenStart] = useState('');
  const [openEnd, setOpenEnd] = useState('');
  const [openNote, setOpenNote] = useState('');
  /** 结构化开放时段是否被本次编辑改动；未改动不重写事实 */
  const [openingDirty, setOpeningDirty] = useState(false);
  /** “写入并标记核对”暂存（局部草稿）：确认修改时才提交 */
  const [mapConfirmed, setMapConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !node) return;
    setName(place?.name ?? '');
    setNotes(node.notes);
    setEntranceConfirmed(place?.entranceConfirmed ?? false);
    setError(null);
    setMapConfirmed(false);
    setOpeningDirty(false);
    setOpenNote('');
    const sched = place?.openingSchedule ?? null;
    if (sched?.value) {
      const w = sched.value.windows;
      if (w.length > 0) {
        setOpeningMode('open');
        setOpenStart(w[0].startLocalTime);
        setOpenEnd(w[0].endLocalTime);
      } else {
        setOpeningMode('closed');
        setOpenStart('');
        setOpenEnd('');
      }
    } else {
      setOpeningMode('unknown');
      setOpenStart('');
      setOpenEnd('');
    }
    if (node.kind === 'visit') {
      setStayText(node.visitSeconds === null ? '' : String(node.visitSeconds / 60));
      setInsideText(node.insideWalkSeconds === null ? '' : String(node.insideWalkSeconds / 60));
      setRequired(node.required);
    } else {
      setRestText(node.restSeconds === null ? '' : String(node.restSeconds / 60));
      setSeat(node.seatFact.value === true ? 'yes' : node.seatFact.value === false ? 'no' : 'unknown');
    }
  }, [open, node, place]);

  if (!node) return null;

  /** 事实展示三态：你已核对 / 自动解析（请核对）/ 地图参考（待核对）/ 待确认 */
  const descFact = place?.openingDescription ?? unknownFact<string>();
  const schedFact = place?.openingSchedule ?? unknownFact<OpeningSchedule>();
  const mapRefText =
    descFact.value !== null && (descFact.sourceType === 'amap' || descFact.reviewState === 'reported')
      ? descFact.value
      : null;
  const schedValue = schedFact.value;
  const schedAuto = schedFact.note !== null && schedFact.note.includes('自动解析');
  const schedLine =
    schedValue !== null
      ? schedFact.reviewState === 'userChecked'
        ? schedAuto
          ? `自动解析自地图文本（请核对）：${windowsText(schedValue.windows)}`
          : `你已核对：${windowsText(schedValue.windows)}`
        : schedFact.sourceType === 'amap' || schedFact.reviewState === 'reported'
          ? `地图参考（待核对）：${windowsText(schedValue.windows)}`
          : null
      : null;
  const descCheckedLine =
    mapRefText === null && descFact.value !== null && descFact.reviewState === 'userChecked'
      ? `你已核对：${descFact.value}`
      : null;
  const hasOpeningLine = mapConfirmed || mapRefText !== null || schedLine !== null || descCheckedLine !== null;

  const confirm = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写名称');
      return;
    }
    const now = new Date().toISOString();
    const placePatch: PlaceOpeningPatch = {};

    // 2.3a “写入并标记核对”：转成 user/userChecked 事实（来源名/POI id/获取时间保留在事实上）
    if (mapConfirmed && descFact.value !== null) {
      const sourceName = descFact.sourceName ?? '高德地图搜索';
      placePatch.openingDescription = {
        value: descFact.value,
        sourceType: 'user',
        sourceName,
        sourceReference: place?.providerPoiId ?? descFact.sourceReference ?? null,
        fetchedAt: descFact.fetchedAt,
        reviewState: 'userChecked',
        checkedAt: now,
        applicableDate: travelDate,
        note: `经你确认；参考来源：${sourceName}`,
      };
      // 文本可被保守解析且已有出游日期时，同时写结构化时段（自动解析，仍请核对）
      const parsed =
        travelDate !== null ? openingScheduleFromText(descFact.value, travelDate, timezone) : null;
      if (parsed) {
        placePatch.openingSchedule = {
          value: parsed,
          sourceType: 'user',
          sourceName,
          sourceReference: place?.providerPoiId ?? descFact.sourceReference ?? null,
          fetchedAt: descFact.fetchedAt,
          reviewState: 'userChecked',
          checkedAt: now,
          applicableDate: travelDate,
          note: '自动解析自地图文本，请核对',
        };
      }
    }

    // 2.3b 结构化开放时段（手动）：无效输入就地报错，不静默修正
    if (openingDirty) {
      if (!travelDate) {
        setError('请先填写出游日期');
        return;
      }
      let windows: OpeningWindow[] = [];
      if (openingMode === 'open') {
        const start = openStart.trim();
        const end = openEnd.trim();
        if (!HH_MM_RE.test(start) || !HH_MM_RE.test(end)) {
          setError('开放时段：请按 HH:mm 填写开始与结束时间');
          return;
        }
        if (start >= end) {
          setError('开放时段：开始时间须早于结束时间（不支持跨零点时段）');
          return;
        }
        windows = [{ startLocalTime: start, endLocalTime: end }];
      }
      placePatch.openingSchedule = {
        value: openingMode === 'unknown' ? null : { applicableDate: travelDate, timezone, windows },
        sourceType: 'user',
        sourceName: null,
        sourceReference: null,
        fetchedAt: null,
        reviewState: 'userChecked',
        checkedAt: now,
        applicableDate: travelDate,
        note: openingMode === 'unknown' ? '你标记为待确认' : '手动填写',
      };
      const noteText = openNote.trim();
      if (noteText) {
        placePatch.openingDescription = {
          value: noteText,
          sourceType: 'user',
          sourceName: null,
          sourceReference: null,
          fetchedAt: null,
          reviewState: 'userChecked',
          checkedAt: now,
          applicableDate: travelDate,
          note: '手动填写',
        };
      }
    }

    if (node.kind === 'visit') {
      const stay = parseMinutesInput(stayText);
      if (!stay.ok) return setError('停留时长：' + stay.error);
      const inside = parseMinutesInput(insideText);
      if (!inside.ok) return setError('园内步行：' + inside.error);
      if (stay.seconds !== null && inside.seconds !== null && inside.seconds > stay.seconds) {
        return setError('园内步行不能大于停留时长');
      }
      onSave({
        name: trimmed,
        entranceConfirmed,
        visitSeconds: stay.seconds,
        insideWalkSeconds: inside.seconds,
        required,
        notes: notes.trim(),
        ...(Object.keys(placePatch).length > 0 ? { placePatch } : {}),
      });
    } else {
      const rest = parseMinutesInput(restText);
      if (!rest.ok) return setError('休息时长：' + rest.error);
      onSave({
        name: trimmed,
        entranceConfirmed,
        restSeconds: rest.seconds,
        seatFact: {
          value: seat === 'yes' ? true : seat === 'no' ? false : null,
          sourceType: 'user',
          sourceName: null,
          sourceReference: null,
          fetchedAt: null,
          reviewState: 'userChecked',
          checkedAt: seat === 'unknown' ? null : new Date().toISOString(),
          applicableDate: null,
          note: null,
        },
        notes: notes.trim(),
        ...(Object.keys(placePatch).length > 0 ? { placePatch } : {}),
      });
    }
    onClose();
  };

  const title = node.kind === 'visit' ? '编辑景点' : '编辑休息点';

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())} title={title}>
      <div className={editor.field}>
        <label htmlFor="node-name">名称</label>
        <input id="node-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      {node.kind === 'visit' ? (
        <>
          <div className={editor.field}>
            <span id="required-label">是否必去</span>
            <div role="radiogroup" aria-labelledby="required-label" style={{ display: 'flex', gap: 'var(--sp-3)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', minHeight: 44 }}>
                <input type="radio" name="required" checked={required} onChange={() => setRequired(true)} />
                必去
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', minHeight: 44 }}>
                <input type="radio" name="required" checked={!required} onChange={() => setRequired(false)} />
                可选（累了可跳过）
              </label>
            </div>
          </div>
          <div className={editor.field}>
            <label htmlFor="node-stay">预计停留（分钟，留空=未知）</label>
            <input id="node-stay" inputMode="numeric" value={stayText} onChange={(e) => setStayText(e.target.value)} placeholder="未知" />
          </div>
          <div className={editor.field}>
            <label htmlFor="node-inside">园内预计步行（分钟）</label>
            <input id="node-inside" inputMode="numeric" value={insideText} onChange={(e) => setInsideText(e.target.value)} placeholder="未知" />
          </div>
        </>
      ) : (
        <>
          <div className={editor.field}>
            <label htmlFor="node-rest">计划休息（分钟）</label>
            <input id="node-rest" inputMode="numeric" value={restText} onChange={(e) => setRestText(e.target.value)} placeholder="未知" />
          </div>
          <div className={editor.field}>
            <label htmlFor="node-seat">是否有座位</label>
            <select id="node-seat" value={seat} onChange={(e) => setSeat(e.target.value as typeof seat)}>
              <option value="unknown">待确认</option>
              <option value="yes">可坐</option>
              <option value="no">不可坐/仅站立</option>
            </select>
          </div>
        </>
      )}

      <div className={editor.field}>
        <label htmlFor="node-entrance" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-2)', minHeight: 44 }}>
          <input
            id="node-entrance"
            type="checkbox"
            checked={entranceConfirmed}
            onChange={(e) => setEntranceConfirmed(e.target.checked)}
          />
          入口已确认（可通行的步行入口）
        </label>
        <span className={editor.fieldError} style={{ color: 'var(--text-muted)' }}>
          地点名不等于入口已确认；同一入口的相邻节点之间不会重复计算步行。
        </span>
      </div>

      {/* 开放时间（R-A2）：来源状态显式区分；无值显示待确认，不编造结论 */}
      <div className={editor.field}>
        <span id="opening-label">开放时间</span>
        <div className={editor.openingBox} role="group" aria-labelledby="opening-label">
          {mapConfirmed ? (
            <p className={editor.openingValue} data-testid="opening-checked">
              你已核对：{descFact.value}（确认修改后保存）
            </p>
          ) : (
            <>
              {mapRefText !== null ? (
                <div className={editor.openingValue}>
                  <span>{mapRefText}</span>
                  <span className={editor.openingTag}>地图参考（待核对）</span>
                  <button
                    type="button"
                    className={`${editor.btn} ${editor.small}`}
                    onClick={() => setMapConfirmed(true)}
                  >
                    写入并标记核对
                  </button>
                </div>
              ) : null}
              {schedLine !== null ? (
                <p className={editor.openingValue}>
                  {schedLine}
                  {schedFact.checkedAt ? `（核对于 ${formatShanghaiDateTime(schedFact.checkedAt)}）` : ''}
                </p>
              ) : null}
              {descCheckedLine !== null ? (
                <p className={editor.openingValue}>
                  {descCheckedLine}
                  {descFact.checkedAt ? `（核对于 ${formatShanghaiDateTime(descFact.checkedAt)}）` : ''}
                </p>
              ) : null}
              {!hasOpeningLine ? <p className={editor.openingValue}>待确认</p> : null}
            </>
          )}

          <div className={editor.field}>
            <label htmlFor="opening-mode">当天开放</label>
            <select
              id="opening-mode"
              value={openingMode}
              onChange={(e) => {
                setOpeningMode(e.target.value as OpeningMode);
                setOpeningDirty(true);
              }}
            >
              <option value="unknown">待确认</option>
              <option value="open">开放</option>
              <option value="closed">不开放</option>
            </select>
          </div>
          {openingMode === 'open' ? (
            <div className={editor.field}>
              <span id="opening-hours-label">开放时段</span>
              <div className={editor.openingRow} role="group" aria-labelledby="opening-hours-label">
                <input
                  aria-label="开始时间"
                  placeholder="HH:mm"
                  value={openStart}
                  onChange={(e) => {
                    setOpenStart(e.target.value);
                    setOpeningDirty(true);
                  }}
                />
                <span aria-hidden="true">至</span>
                <input
                  aria-label="结束时间"
                  placeholder="HH:mm"
                  value={openEnd}
                  onChange={(e) => {
                    setOpenEnd(e.target.value);
                    setOpeningDirty(true);
                  }}
                />
              </div>
              <span className={editor.fieldError} style={{ color: 'var(--text-muted)' }}>
                按 HH:mm 填写；开始时间须早于结束时间，跨零点时段请另行说明。
              </span>
            </div>
          ) : null}
          <div className={editor.field}>
            <label htmlFor="opening-note">开放说明（可选）</label>
            <input
              id="opening-note"
              type="text"
              value={openNote}
              onChange={(e) => {
                setOpenNote(e.target.value);
                setOpeningDirty(true);
              }}
              placeholder="例如：周一闭馆，节假日另行安排"
            />
          </div>
        </div>
      </div>

      <div className={editor.field}>
        <label htmlFor="node-notes">备注</label>
        <textarea
          id="node-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--control-border)',
            borderRadius: 'var(--radius-input)',
            color: 'var(--text-primary)',
            padding: 'var(--sp-3)',
            font: 'inherit',
            resize: 'vertical',
          }}
        />
      </div>

      {error ? (
        <p className={editor.fieldError} role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}

      <div className={dialogStyles.actions}>
        <button type="button" className={editor.btn} onClick={onClose}>
          取消
        </button>
        <button type="button" className={`${editor.btn} ${editor.primary}`} onClick={confirm} data-testid="node-confirm">
          确认修改
        </button>
      </div>
    </Dialog>
  );
}
