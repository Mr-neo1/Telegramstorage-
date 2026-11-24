import { useSyncExternalStore, type MouseEvent } from 'react';

export type Route =
  | { name: 'folder'; id: string | null }
  | { name: 'recent' }
  | { name: 'trash' }
  | { name: 'search'; q: string }
  | { name: 'developers' };

export function parseRoute(pathname: string, search: string): Route {
  const m = /^\/folder\/([^/]+)\/?$/.exec(pathname);
  if (m) return { name: 'folder', id: decodeURIComponent(m[1]) };
  if (pathname === '/recent') return { name: 'recent' };
  if (pathname === '/trash') return { name: 'trash' };
  if (pathname === '/developers') return { name: 'developers' };
  if (pathname === '/search') return { name: 'search', q: new URLSearchParams(search).get('q') ?? '' };
  return { name: 'folder', id: null };
}

const EVENT = 'tgs:navigate';

export function navigate(to: string, { replace = false } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void) {
  window.addEventListener('popstate', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(EVENT, cb);
  };
}

const snapshot = () => window.location.pathname + window.location.search;

export function useRoute(): Route {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const q = loc.indexOf('?');
  return parseRoute(q < 0 ? loc : loc.slice(0, q), q < 0 ? '' : loc.slice(q));
}

export const folderHref = (id: string | null) => (id ? `/folder/${encodeURIComponent(id)}` : '/');

/** onClick for <a> elements that should navigate inside the app. */
export function linkClick(e: MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(e.currentTarget.getAttribute('href') || '/');
}
