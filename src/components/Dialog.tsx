/**
 * 通用对话框（需求 UI-03、13.7、14.9）：
 * 打开后焦点进入对话框，ESC/关闭返回触发控件；Radix 提供焦点管理。
 */
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import styles from './Dialog.module.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** 存在未确认修改时的关闭询问由调用方通过 onOpenChange(false) 前的逻辑处理 */
}

export function Dialog({ open, onOpenChange, title, description, children }: DialogProps) {
  // M40：DOM id 不用含标点的标题拼接
  const descId = `dialog-desc-${title.replace(/[^\w]+/g, '-').slice(0, 32)}`;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={styles.content}
          aria-describedby={description ? descId : undefined}
        >
          <div className={styles.header}>
            <DialogPrimitive.Title className={styles.title}>{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close className={styles.close} aria-label="关闭">
              ×
            </DialogPrimitive.Close>
          </div>
          {description ? (
            <DialogPrimitive.Description className={styles.description} id={descId}>
              {description}
            </DialogPrimitive.Description>
          ) : null}
          <div className={styles.body}>{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
