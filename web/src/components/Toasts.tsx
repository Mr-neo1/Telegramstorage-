import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error';
  action?: { label: string; run: () => void };
}

interface ToastApi {
  show: (text: string, opts?: { tone?: 'info' | 'error'; action?: Toast['action']; duration?: number }) => void;
  error: (text: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast outside provider');
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback<ToastApi['show']>(
    (text, opts = {}) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-2), { id, text, tone: opts.tone ?? 'info', action: opts.action }]);
      window.setTimeout(() => dismiss(id), opts.duration ?? (opts.action ? 7000 : 4500));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show, error: (text) => show(text, { tone: 'error', duration: 7000 }) }), [show]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'error' ? 'error' : ''}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <X size={16} />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
