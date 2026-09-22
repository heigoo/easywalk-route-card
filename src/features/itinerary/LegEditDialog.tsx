/**
 * 路段耗时编辑（需求 R02、第 4.5 节）：
 * 步行/接驳两种模式；空白=未知；总耗时不得小于步行部分；手动值不乘步速因子。
 */
import { useEffect, useState } from 'react';
import type { Leg } from '../../../shared/contracts/domain';
import { Dialog } from '../../components/Dialog';
import { parseMinutesInput } from '../../components/fields';
import editor from './Editor.module.css';
import dialogStyles from '../../components/Dialog.module.css';

export interface LegSavePatch {
  mode: Leg['mode'];
  walkingSeconds: number | null;
  totalSeconds: number | null;
}

export interface LegEditDialogProps {
  open: boolean;
  leg: Leg | null;
  fromName: string;
  toName: string;
  onClose: () => void;
  onSave: (patch: LegSavePatch) => void;
  onRestoreMapValue: (legId: string) => void;
}

const SOURCE_TEXT: Record<Leg['durationSource'], string> = {
  manual: '用户填写',
  amap: '地图估算（仅当前会话有效）',
  adopted: '已采纳地图估算（非实时）',
  'same-entrance': '同一入口零衔接（无需填写）',
};

export function LegEditDialog({ open, leg, fromName, toName, onClose, onSave, onRestoreMapValue }: LegEditDialogProps) {
  const [mode, setMode] = useState<'walking' | 'manual-transfer'>('walking');
  const [walkText, setWalkText] = useState('');
  const [totalText, setTotalText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !leg) return;
    setMode(leg.mode);
    setWalkText(leg.effectiveWalkingSeconds === null ? '' : String(Math.round(leg.effectiveWalkingSeconds / 60)));
    setTotalText(
      leg.mode === 'manual-transfer' && leg.totalTravelSeconds !== null
        ? String(Math.round(leg.totalTravelSeconds / 60))
        : '',
    );
    setError(null);
  }, [open, leg]);

  if (!leg) return null;

  const confirm = () => {
    const walk = parseMinutesInput(walkText);
    if (!walk.ok) return setError('步行时间：' + walk.error);
    let total: number | null;
    if (mode === 'walking') {
      total = walk.seconds;
    } else {
      const t = parseMinutesInput(totalText);
      if (!t.ok) return setError('全程耗时：' + t.error);
      total = t.seconds;
      if (total !== null && walk.seconds !== null && total < walk.seconds) {
        return setError('全程耗时不能小于其中步行时间');
      }
    }
    onSave({ mode, walkingSeconds: walk.seconds, totalSeconds: total });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())} title={`路段：${fromName} → ${toName}`}>
      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--font-small)' }}>
        来源：{SOURCE_TEXT[leg.durationSource]}
        {leg.durationSource === 'adopted' && leg.adoptedAt ? ` · 采纳于 ${leg.adoptedAt.slice(0, 16).replace('T', ' ')}` : ''}
      </p>

      {leg.durationSource === 'same-entrance' ? (
        <p style={{ margin: 0 }}>两个节点已确认为同一入口，无需步行时间。</p>
      ) : (
        <>
          <div className={editor.field}>
            <span id="leg-mode-label">交通方式</span>
            <div role="radiogroup" aria-labelledby="leg-mode-label" style={{ display: 'flex', gap: 'var(--sp-3)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', minHeight: 44 }}>
                <input type="radio" name="leg-mode" checked={mode === 'walking'} onChange={() => setMode('walking')} />
                步行
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', minHeight: 44 }}>
                <input
                  type="radio"
                  name="leg-mode"
                  checked={mode === 'manual-transfer'}
                  onChange={() => setMode('manual-transfer')}
                />
                乘车接驳（含步行段）
              </label>
            </div>
          </div>
          <div className={editor.field}>
            <label htmlFor="leg-walk">其中步行（分钟）</label>
            <input id="leg-walk" inputMode="numeric" value={walkText} onChange={(e) => setWalkText(e.target.value)} placeholder="未知" />
          </div>
          {mode === 'manual-transfer' ? (
            <div className={editor.field}>
              <label htmlFor="leg-total">接驳全程（分钟）</label>
              <input id="leg-total" inputMode="numeric" value={totalText} onChange={(e) => setTotalText(e.target.value)} placeholder="未知" />
            </div>
          ) : null}
        </>
      )}

      {error ? (
        <p className={editor.fieldError} role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}

      <div className={dialogStyles.actions}>
        {leg.durationSource === 'adopted' ? (
          <button
            type="button"
            className={editor.btn}
            onClick={() => {
              onRestoreMapValue(leg.id);
              onClose();
            }}
          >
            恢复为地图值
          </button>
        ) : null}
        <button type="button" className={editor.btn} onClick={onClose}>
          取消
        </button>
        {leg.durationSource !== 'same-entrance' ? (
          <button type="button" className={`${editor.btn} ${editor.primary}`} onClick={confirm}>
            确认修改
          </button>
        ) : (
          <button type="button" className={`${editor.btn} ${editor.primary}`} onClick={onClose}>
            知道了
          </button>
        )}
      </div>
    </Dialog>
  );
}
