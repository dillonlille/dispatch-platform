import type { ReactNode } from 'react';
import { Modal } from './Modal.js';

export function ConfirmDialog({
  title,
  children,
  confirm,
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirm: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p>{children}</p>
      <div className="form-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className={tone} disabled={busy} onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </Modal>
  );
}
