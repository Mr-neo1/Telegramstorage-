import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Braces, Clock, HardDrive, LoaderCircle, LogOut, Menu, Search, Trash } from 'lucide-react';
import { api, errorMessage } from './api';
import { ITEMS_MIME, hasItems } from './dnd';
import { formatBytes, plural } from './format';
import { linkClick, navigate, useRoute } from './router';
import type { Account, ItemRefs, User } from './types';
import { Brand, Login } from './components/Login';
import { NewMenu, notifyChanged } from './components/NewMenu';
import { ToastProvider, useToast } from './components/Toasts';
import { UploadsProvider, useUploads } from './components/Uploads';
import { DevelopersPage } from './pages/DevelopersPage';
import { DrivePage } from './pages/DrivePage';

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null));
    const onSignedOut = () => setUser(null);
    window.addEventListener('tgs:signed-out', onSignedOut);
    return () => window.removeEventListener('tgs:signed-out', onSignedOut);
  }, []);

  if (user === undefined) {
    return (
      <div className="splash" aria-busy="true">
        <LoaderCircle size={28} className="spin" />
      </div>
    );
  }

  return (
    <ToastProvider>
      {user ? (
        <UploadsProvider>
          <Shell user={user} onSignedOut={() => setUser(null)} />
        </UploadsProvider>
      ) : (
        <Login onSignedIn={setUser} />
      )}
    </ToastProvider>
  );
}

function Avatar({ user }: { user: User }) {
  const [broken, setBroken] = useState(false);
  const initials = (user.firstName[0] ?? '') + (user.lastName?.[0] ?? '');
  return (
    <span className="avatar" aria-hidden>
      {user.hasPhoto && !broken ? <img src="/api/auth/avatar" alt="" onError={() => setBroken(true)} /> : initials.toUpperCase() || '?'}
    </span>
  );
}

function Shell({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const route = useRoute();
  const routeKey = JSON.stringify(route);
  const toast = useToast();
  const { version } = useUploads();
  const [navOpen, setNavOpen] = useState(false);
  const [account, setAccount] = useState<Account | null>(null);
  const [changed, setChanged] = useState(0);
  const [query, setQuery] = useState(route.name === 'search' ? route.q : '');
  const [dropOn, setDropOn] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onChanged = () => setChanged((c) => c + 1);
    window.addEventListener('tgs:changed', onChanged);
    return () => window.removeEventListener('tgs:changed', onChanged);
  }, []);

  useEffect(() => {
    api.account().then(setAccount).catch(() => {});
  }, [version, changed]);

  useEffect(() => {
    setNavOpen(false);
    if (route.name !== 'search') setQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey]);

  // Search as you type.
  useEffect(() => {
    const q = query.trim();
    const t = window.setTimeout(() => {
      if (q) navigate(`/search?q=${encodeURIComponent(q)}`, { replace: route.name === 'search' });
      else if (route.name === 'search') navigate('/', { replace: true });
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // "/" focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey) return;
      if ((e.target as HTMLElement).closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut();
  };

  // Dragging items from the list onto "My files" or "Trash" in the sidebar.
  const sidebarDrop = (target: 'root' | 'trash') => ({
    onDragOver: (e: DragEvent) => {
      if (!hasItems(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropOn(target);
    },
    onDragLeave: () => setDropOn(null),
    onDrop: async (e: DragEvent) => {
      setDropOn(null);
      if (!hasItems(e.dataTransfer)) return;
      e.preventDefault();
      let refs: ItemRefs;
      try {
        refs = JSON.parse(e.dataTransfer.getData(ITEMS_MIME));
      } catch {
        return;
      }
      const count = refs.files.length + refs.folders.length;
      const what = count === 1 ? 'the item' : plural(count, 'item');
      try {
        if (target === 'trash') {
          await api.trashItems(refs);
          toast.show(`Moved ${what} to the trash`, {
            action: { label: 'Undo', run: () => api.restore(refs).then(notifyChanged).catch((err) => toast.error(errorMessage(err))) },
          });
        } else {
          const r = await api.move(refs, null);
          if (r.errors.length) toast.error(r.errors[0].message);
          else toast.show(`Moved ${what} to My files`);
        }
        notifyChanged();
      } catch (err) {
        toast.error(errorMessage(err));
      }
    },
  });

  const usage = account?.usage;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Telegram user';

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidebar" aria-label="Main">
        <a href="/" onClick={linkClick} style={{ textDecoration: 'none' }} aria-label="Telegram Storage, My files">
          <Brand />
        </a>
        <NewMenu folderId={route.name === 'folder' ? route.id : null} inFolderView={route.name === 'folder'} />
        <nav className="nav" aria-label="Sections">
          <a
            href="/"
            onClick={linkClick}
            aria-current={route.name === 'folder' ? 'page' : undefined}
            className={dropOn === 'root' ? 'drop-target' : ''}
            {...sidebarDrop('root')}
          >
            <HardDrive size={19} /> My files
          </a>
          <a href="/recent" onClick={linkClick} aria-current={route.name === 'recent' ? 'page' : undefined}>
            <Clock size={19} /> Recent
          </a>
          <a
            href="/trash"
            onClick={linkClick}
            aria-current={route.name === 'trash' ? 'page' : undefined}
            className={dropOn === 'trash' ? 'drop-target' : ''}
            {...sidebarDrop('trash')}
          >
            <Trash size={19} /> Trash
          </a>
          <div className="nav-divider" />
          <a href="/developers" onClick={linkClick} aria-current={route.name === 'developers' ? 'page' : undefined}>
            <Braces size={19} /> Developers
          </a>
        </nav>

        <div className="usage" aria-live="polite">
          {usage ? (
            <>
              <strong className="num">{formatBytes(usage.bytes)}</strong>
              <span className="num">
                in {plural(usage.files, 'file')} and {plural(usage.folders, 'folder')}
              </span>
              {usage.trashFiles > 0 && <span className="num">{formatBytes(usage.trashBytes)} more in the trash</span>}
            </>
          ) : (
            <span>&nbsp;</span>
          )}
        </div>

        <div className="user-chip">
          <Avatar user={user} />
          <div className="who">
            <strong title={name}>{name}</strong>
            <span>{user.username ? `@${user.username}` : `ID ${user.id}`}</span>
          </div>
          <button className="icon-btn" aria-label="Sign out" title="Sign out" onClick={signOut}>
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-toggle" aria-label="Open menu" onClick={() => setNavOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="search" role="search">
            <Search size={18} />
            <input
              ref={searchInput}
              type="search"
              placeholder="Search files and folders"
              aria-label="Search files and folders"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setQuery('');
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        </header>
        {route.name === 'developers' ? <DevelopersPage /> : <DrivePage route={route} />}
      </main>
    </div>
  );
}
