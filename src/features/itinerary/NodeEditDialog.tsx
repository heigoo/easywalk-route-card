/**
 * 节点编辑面板（UI-03）：局部草稿，确认才提交；取消不修改原数据（第 14.3 节）。
 * 校验：园内步行不得大于停留（A07）；非法值就地提示且不入领域模型。
 */
import { useEffect, useState } from 'react';
import type { PlaceRef, RouteNode } from '../../../shared/contracts/domain';
import { Dialog } from '../../components/Dialog';
import { parseMinutesInput } from '../../components/fields';
import editor from './Editor.module.css';
import dialogStyles from '../../components/Dialog.module.css';

export interface NodeEditDialogProps {
  open: boolean;
  node: RouteNode | null;
  place: PlaceRef | null;
  onClose: () => void;
  onSave: (patch: { name: string; entranceConfirmed?: boolean } & Partial<RouteNode>) => void;
}

export function NodeEditDialog({ open, node, place, onSave, onClose }: NodeEditDialogProps) {
  const [name, setName] = useState('');
  const [stayText, setStayText] = useState('');
  const [insideText, setInsideText] = useState('');
  const [required, setRequired] = useState(true);
  const [restText, setRestText] = useState('');
  const [seat, setSeat] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [notes, setNotes] = useState('');
  const [entranceConfirmed, setEntranceConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !node) return;
    setName(place?.name ?? '');
    setNotes(node.notes);
    setEntranceConfirmed(place?.entranceConfirmed ?? false);
    setError(null);
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

  const confirm = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请填写名称');
      return;
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
