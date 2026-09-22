/**
 * 添加节点（渐进填写，第 14.2 节）：先收集名称与关键时长，细节之后可再编辑。
 */
import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog';
import { parseMinutesInput } from '../../components/fields';
import editor from './Editor.module.css';
import dialogStyles from '../../components/Dialog.module.css';

export interface AddNodeInit {
  name: string;
  required: boolean;
  minutes: number | null;
  insideMinutes: number | null;
}

export interface AddNodeDialogProps {
  kind: 'visit' | 'rest' | null;
  onClose: () => void;
  onAdd: (kind: 'visit' | 'rest', init: AddNodeInit) => void;
}

export function AddNodeDialog({ kind, onClose, onAdd }: AddNodeDialogProps) {
  const [name, setName] = useState('');
  const [required, setRequired] = useState(true);
  const [minutesText, setMinutesText] = useState('');
  const [insideText, setInsideText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (kind) {
      setName('');
      setRequired(true);
      setMinutesText('');
      setInsideText('');
      setError(null);
    }
  }, [kind]);

  if (!kind) return null;

  const confirm = () => {
    const trimmed = name.trim();
    if (!trimmed) return setError('请填写名称');
    const minutes = parseMinutesInput(minutesText);
    if (!minutes.ok) return setError(kind === 'visit' ? '停留时长：' + minutes.error : '休息时长：' + minutes.error);
    let insideMinutes: number | null = null;
    if (kind === 'visit') {
      const inside = parseMinutesInput(insideText);
      if (!inside.ok) return setError('园内步行：' + inside.error);
      insideMinutes = inside.seconds;
      if (minutes.seconds !== null && insideMinutes !== null && insideMinutes > minutes.seconds) {
        return setError('园内步行不能大于停留时长');
      }
    }
    onAdd(kind, { name: trimmed, required, minutes: minutes.seconds, insideMinutes });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())} title={kind === 'visit' ? '添加景点' : '添加休息点'}>
      <div className={editor.field}>
        <label htmlFor="add-name">名称</label>
        <input id="add-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="示例：公园东门" />
      </div>
      {kind === 'visit' ? (
        <div className={editor.field}>
          <span id="add-required-label">是否必去</span>
          <div role="radiogroup" aria-labelledby="add-required-label" style={{ display: 'flex', gap: 'var(--sp-3)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', minHeight: 44 }}>
              <input type="radio" name="add-required" checked={required} onChange={() => setRequired(true)} />
              必去
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-1)', minHeight: 44 }}>
              <input type="radio" name="add-required" checked={!required} onChange={() => setRequired(false)} />
              可选
            </label>
          </div>
        </div>
      ) : null}
      <div className={editor.field}>
        <label htmlFor="add-minutes">{kind === 'visit' ? '预计停留（分钟）' : '计划休息（分钟）'}</label>
        <input id="add-minutes" inputMode="numeric" value={minutesText} onChange={(e) => setMinutesText(e.target.value)} placeholder="未知" />
      </div>
      {kind === 'visit' ? (
        <div className={editor.field}>
          <label htmlFor="add-inside">园内预计步行（分钟）</label>
          <input id="add-inside" inputMode="numeric" value={insideText} onChange={(e) => setInsideText(e.target.value)} placeholder="未知" />
        </div>
      ) : null}
      {error ? (
        <p className={editor.fieldError} role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
      <div className={dialogStyles.actions}>
        <button type="button" className={editor.btn} onClick={onClose}>
          取消
        </button>
        <button type="button" className={`${editor.btn} ${editor.primary}`} onClick={confirm}>
          添加
        </button>
      </div>
    </Dialog>
  );
}
