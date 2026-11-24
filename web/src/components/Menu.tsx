import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export interface MenuAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  /** Draw a divider above this item. */
  separated?: boolean;
}

/** Keyboard navigation shared by menus: arrows move between buttons. */
export function menuKeys(e: KeyboardEvent<HTMLElement>) {
  const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
  const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    buttons[0]?.focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    buttons[buttons.length - 1]?.focus();
  }
}

export function MenuButtons({ actions, onDone }: { actions: MenuAction[]; onDone: () => void }) {
  return (
    <>
      {actions.map((a) => (
        <Fragment key={a.label}>
          {a.separated && <hr />}
          <button
            role="menuitem"
            className={a.danger ? 'danger' : ''}
            onClick={() => {
              onDone();
              a.onSelect();
            }}
          >
            <a.icon size={17} aria-hidden />
            {a.label}
          </button>
        </Fragment>
      ))}
    </>
  );
}

/** A context menu at a screen position. */
export function ContextMenu({ x, y, actions, onClose }: { x: number; y: number; actions: MenuAction[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
      top: Math.max(8, y + height > window.innerHeight - 8 ? y - height : y),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={pos}
      onKeyDown={menuKeys}
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuButtons actions={actions} onDone={onClose} />
    </div>,
    document.body,
  );
}
