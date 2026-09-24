/**
 * 二次确认对话框（需求 A10、UI-06）：删除行程、跳过必去等丢失/影响内容的操作。
 */
import { Dialog } from './Dialog';
import editor from '../features/itinerary/Editor.module.css';
import styles from './Dialog.module.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmText: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmText,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onCancel())} title={title}>
      <p style={{ margin: 0, color: 'var(--text-secondary)' }}>{description}</p>
      <div className={styles.actions}>
        <button
          type="button"
          className={editor.btn}
          onClick={onCancel}
          // 危险操作默认聚焦「取消」，避免误按回车即删除
          autoFocus
        >
          取消
        </button>
        <button
          type="button"
          className={`${editor.btn} ${danger ? editor.danger : editor.primary}`}
          onClick={onConfirm}
        >
          {confirmText}
        </button>
      </div>
    </Dialog>
  );
}
