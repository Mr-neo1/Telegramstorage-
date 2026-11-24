import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import { errorMessage } from '../api';

export function Modal({
  title,
  onClose,
  children,
  wide,
  labelledBy = 'modal-title',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);

  useEffect(() => {
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('[autofocus], input, button, [tabindex]');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && el) {
        const focusables = [...el.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')].filter(
          (x) => !x.hasAttribute('disabled'),
        );
        if (!focusables.length) return;
        const firstEl = focusables[0];
        const lastEl = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === firstEl) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    const prev = opener.current;
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (prev instanceof HTMLElement) prev.focus();
    };
  }, [onClose]);

  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <h2 id={labelledBy}>{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A dialog with one text field, e.g. "New folder" or "Rename". */
export function PromptDialog({
  title,
  label,
  initial = '',
  confirmLabel,
  selectStem,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  /** Select the name without its extension, like a desktop file manager. */
  selectStem?: boolean;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    if (selectStem && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial, selectStem]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return setError('Enter a name');
    if (/[/\\]/.test(v)) return setError('Names can’t contain / or \\');
    setBusy(true);
    setError('');
    try {
      await onSubmit(v);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        <label className="field">
          <span>{label}</span>
          <input
            ref={input}
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={255}
            aria-invalid={!!error}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={title} onClose={onClose}>
      <p>{body}</p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-quiet" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          }}
        >
          {busy && <LoaderCircle size={16} className="spin" />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
