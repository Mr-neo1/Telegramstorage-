import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Download,
  Ellipsis,
  Eye,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  LayoutGrid,
  Link,
  List,
  Pencil,
  RotateCcw,
  Trash,
  Upload,
  X,
} from 'lucide-react';
import { ApiError, api, contentUrl, errorMessage } from '../api';
import { ITEMS_MIME, entriesFromDrop, entriesFromInput, hasFiles, hasItems } from '../dnd';
import { extensionOf, fileCategory, formatBytes, formatDate, formatFullDate, plural } from '../format';
import { folderHref, linkClick, navigate, type Route } from '../router';
import type { FileItem, Item, ItemRefs, ItemsResult, Listing } from '../types';
import { FileIcon } from '../components/FileIcon';
import { ContextMenu, type MenuAction } from '../components/Menu';
import { ConfirmDialog, PromptDialog } from '../components/Modal';
import { MoveDialog } from '../components/MoveDialog';
import { NewMenu, notifyChanged } from '../components/NewMenu';
import { Preview } from '../components/Preview';
import { useToast } from '../components/Toasts';
import { useUploads } from '../components/Uploads';

export type DriveRoute = Extract<Route, { name: 'folder' | 'recent' | 'search' | 'trash' }>;
type SortKey = 'name' | 'size' | 'date';
interface Sort {
  key: SortKey;
  dir: 1 | -1;
}
type ViewData = ItemsResult & Partial<Pick<Listing, 'folder' | 'breadcrumbs'>>;

const keyOf = (i: Item) => `${i.kind}:${i.id}`;
const refsOf = (items: Item[]): ItemRefs => ({
  files: items.filter((i) => i.kind === 'file').map((i) => i.id),
  folders: items.filter((i) => i.kind === 'folder').map((i) => i.id),
});
const describe = (items: Item[]) => (items.length === 1 ? `“${items[0].name}”` : plural(items.length, 'item'));
const parentOf = (i: Item) => (i.kind === 'file' ? i.folderId : i.parentId);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

const DEFAULT_SORT: Record<DriveRoute['name'], Sort> = {
  folder: { key: 'name', dir: 1 },
  search: { key: 'name', dir: 1 },
  recent: { key: 'date', dir: -1 },
  trash: { key: 'date', dir: -1 },
};

function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* private mode */
      }
    },
    [key],
  );
  return [value, set] as const;
}

function download(files: FileItem[]) {
  files.forEach((f, i) =>
    window.setTimeout(() => {
      const a = document.createElement('a');
      a.href = contentUrl(f.id, true);
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 400),
  );
}

export function DrivePage({ route }: { route: DriveRoute }) {
  const toast = useToast();
  const { enqueue, version } = useUploads();

  const routeKey = route.name === 'folder' ? `folder:${route.id ?? ''}` : route.name === 'search' ? `search:${route.q}` : route.name;
  const folderId = route.name === 'folder' ? route.id : null;
  const inTrash = route.name === 'trash';
  const canUpload = route.name === 'folder';
  const showLocation = route.name !== 'folder';

  const [data, setData] = useState<ViewData | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [prefs, setPrefs] = useStored('tgs:prefs', { view: 'list' as 'list' | 'grid', sort: DEFAULT_SORT });
  const [menu, setMenu] = useState<{ x: number; y: number; actions: MenuAction[] } | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const dragging = useRef<Item[] | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const sort = prefs.sort[route.name] ?? DEFAULT_SORT[route.name];
  const view = prefs.view;
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);

  // ------------------------------------------------------------ loading

  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
    setData(null);
    setLoadError(null);
    setPreview(null);
  }, [routeKey]);

  useEffect(() => {
    let cancelled = false;
    const request: Promise<ViewData> =
      route.name === 'folder'
        ? api.list(route.id)
        : route.name === 'recent'
          ? api.recent()
          : route.name === 'trash'
            ? api.trash()
            : api.search(route.q);
    request
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoadError(null);
        // Drop selections of items that no longer exist.
        const keys = new Set([...d.folders, ...d.files].map(keyOf));
        setSelected((s) => (([...s].every((k) => keys.has(k)) ? s : new Set([...s].filter((k) => keys.has(k))))));
      })
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err : new ApiError(0, 'error', errorMessage(err))));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, reload, version]);

  useEffect(() => {
    const onChanged = () => setReload((r) => r + 1);
    window.addEventListener('tgs:changed', onChanged);
    return () => window.removeEventListener('tgs:changed', onChanged);
  }, []);

  // ------------------------------------------------------------ derived

  const items = useMemo<Item[]>(() => {
    if (!data) return [];
    const dateOf = (i: Item) => (inTrash ? (i.deletedAt ?? i.updatedAt) : i.updatedAt);
    const sizeOf = (i: Item) => (i.kind === 'file' ? i.size : (i.itemCount ?? 0));
    const cmp = (a: Item, b: Item) => {
      let r = 0;
      if (sort.key === 'size') r = sizeOf(a) - sizeOf(b);
      else if (sort.key === 'date') r = dateOf(a) - dateOf(b);
      if (r === 0) r = collator.compare(a.name, b.name);
      return r * sort.dir;
    };
    return [...[...data.folders].sort(cmp), ...[...data.files].sort(cmp)];
  }, [data, sort, inTrash]);

  const files = useMemo(() => items.filter((i): i is FileItem => i.kind === 'file'), [items]);
  const selectedItems = useMemo(() => items.filter((i) => selected.has(keyOf(i))), [items, selected]);
  const currentName = data?.folder?.name ?? 'My files';

  // ------------------------------------------------------------ actions

  const open = (item: Item) => {
    if (item.kind === 'folder') {
      if (inTrash) return toast.show('Restore this folder to see what’s inside');
      return navigate(folderHref(item.id));
    }
    setPreview(files.indexOf(item));
  };

  const rename = (item: Item) =>
    setDialog(
      <PromptDialog
        title={item.kind === 'folder' ? 'Rename folder' : 'Rename file'}
        label={item.kind === 'folder' ? 'Folder name' : 'File name'}
        initial={item.name}
        selectStem={item.kind === 'file'}
        confirmLabel="Rename"
        onClose={closeDialog}
        onSubmit={async (name) => {
          if (name === item.name) return;
          if (item.kind === 'folder') await api.renameFolder(item.id, name);
          else await api.renameFile(item.id, name);
          notifyChanged();
          toast.show(`Renamed to “${name}”`);
        }}
      />,
    );

  const newFolder = () =>
    setDialog(
      <PromptDialog
        title="New folder"
        label="Folder name"
        initial="Untitled folder"
        confirmLabel="Create folder"
        onClose={closeDialog}
        onSubmit={async (name) => {
          const { folder } = await api.createFolder(folderId, name);
          notifyChanged();
          toast.show(`Created “${folder.name}”`);
        }}
      />,
    );

  const moveTo = async (targets: Item[], to: string | null, toName: string) => {
    const movable = targets.filter((t) => parentOf(t) !== to && !(t.kind === 'folder' && t.id === to));
    if (!movable.length) return;
    try {
      const r = await api.move(refsOf(movable), to);
      notifyChanged();
      if (r.errors.length) toast.error(r.errors[0].message);
      else toast.show(`Moved ${describe(movable)} to ${toName}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const move = (targets: Item[]) =>
    setDialog(
      <MoveDialog
        items={targets}
        startFolderId={route.name === 'folder' ? folderId : (parentOf(targets[0]) ?? null)}
        onClose={closeDialog}
        onMove={async (to, toName) => {
          const r = await api.move(refsOf(targets), to);
          if (!r.moved.length && r.errors.length) throw new Error(r.errors[0].message);
          notifyChanged();
          if (r.errors.length) toast.error(`${r.errors.length} couldn’t be moved: ${r.errors[0].message}`);
          else toast.show(`Moved ${describe(targets)} to ${toName}`);
        }}
      />,
    );

  const moveToTrash = async (targets: Item[]) => {
    const refs = refsOf(targets);
    try {
      await api.trashItems(refs);
      setSelected(new Set());
      notifyChanged();
      toast.show(`Moved ${describe(targets)} to the trash`, {
        action: {
          label: 'Undo',
          run: () =>
            api
              .restore(refs)
              .then(notifyChanged)
              .catch((err) => toast.error(errorMessage(err))),
        },
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const restore = async (targets: Item[]) => {
    try {
      await api.restore(refsOf(targets));
      setSelected(new Set());
      notifyChanged();
      toast.show(`Restored ${describe(targets)}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const deleteForever = (targets: Item[]) =>
    setDialog(
      <ConfirmDialog
        title={`Delete ${describe(targets)} forever?`}
        body={
          targets.some((t) => t.kind === 'folder')
            ? 'Everything inside will be deleted too, and the files will be removed from Telegram. This can’t be undone.'
            : 'The files will be removed from Telegram. This can’t be undone.'
        }
        confirmLabel="Delete forever"
        danger
        onClose={closeDialog}
        onConfirm={async () => {
          await api.deleteForever(refsOf(targets));
          setSelected(new Set());
          notifyChanged();
          toast.show(`Deleted ${describe(targets)} forever`);
        }}
      />,
    );

  const emptyTrash = () =>
    setDialog(
      <ConfirmDialog
        title="Empty the trash?"
        body={`${plural(items.length, 'item')} will be deleted forever and removed from Telegram. This can’t be undone.`}
        confirmLabel="Empty trash"
        danger
        onClose={closeDialog}
        onConfirm={async () => {
          await api.emptyTrash();
          notifyChanged();
          toast.show('Trash emptied');
        }}
      />,
    );

  const copyApiLink = (file: FileItem) => {
    const url = `${window.location.origin}/api/v1/files/${file.id}/content`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.show('Copied the API link. Send it with an API key to read this file from another app.'))
      .catch(() => toast.error(`Couldn’t copy. The link is ${url}`));
  };

  const uploadDropped = async (dt: DataTransfer, target: string | null) => {
    try {
      const { files: entries, emptyDirs } = await entriesFromDrop(dt);
      for (const dir of emptyDirs) await api.createFolderPath(target, dir);
      if (emptyDirs.length) notifyChanged();
      enqueue(entries, target);
    } catch (err) {
      toast.error(`Couldn’t read the dropped items: ${errorMessage(err)}`);
    }
  };

  const actionsFor = (targets: Item[]): MenuAction[] => {
    if (inTrash) {
      return [
        { label: 'Restore', icon: RotateCcw, onSelect: () => restore(targets) },
        { label: 'Delete forever', icon: Trash, onSelect: () => deleteForever(targets), danger: true, separated: true },
      ];
    }
    const single = targets.length === 1 ? targets[0] : null;
    const targetFiles = targets.filter((t): t is FileItem => t.kind === 'file');
    const list: (MenuAction | false | null)[] = [
      single?.kind === 'folder' && { label: 'Open', icon: FolderOpen, onSelect: () => open(single) },
      single?.kind === 'file' && { label: 'Preview', icon: Eye, onSelect: () => open(single) },
      targetFiles.length > 0 && { label: targetFiles.length > 1 ? `Download ${targetFiles.length} files` : 'Download', icon: Download, onSelect: () => download(targetFiles) },
      single && { label: 'Rename', icon: Pencil, onSelect: () => rename(single), separated: true },
      { label: 'Move to…', icon: FolderInput, onSelect: () => move(targets), separated: !single },
      single?.kind === 'file' && { label: 'Copy API link', icon: Link, onSelect: () => copyApiLink(single) },
      showLocation && single && { label: 'Show in folder', icon: Folder, onSelect: () => navigate(folderHref(parentOf(single))) },
      { label: 'Move to trash', icon: Trash, onSelect: () => moveToTrash(targets), danger: true, separated: true },
    ];
    return list.filter((a): a is MenuAction => !!a);
  };

  // ------------------------------------------------------------ selection

  const selectOnly = (item: Item) => {
    setSelected(new Set([keyOf(item)]));
    setAnchor(keyOf(item));
  };

  const toggle = (item: Item) => {
    const k = keyOf(item);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
    setAnchor(k);
  };

  const onItemClick = (e: MouseEvent, item: Item) => {
    const k = keyOf(item);
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => keyOf(i) === anchor);
      const b = items.findIndex((i) => keyOf(i) === k);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        setSelected(new Set(items.slice(from, to + 1).map(keyOf)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) return toggle(item);
    if (isCoarse()) return selected.size ? toggle(item) : open(item);
    selectOnly(item);
  };

  const showMenu = (e: MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    const k = keyOf(item);
    let targets = selectedItems;
    if (!selected.has(k)) {
      selectOnly(item);
      targets = [item];
    }
    let { clientX: x, clientY: y } = e;
    if (e.type === 'click') {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      x = r.right - 208;
      y = r.bottom + 4;
    }
    setMenu({ x, y, actions: actionsFor(targets) });
  };

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || menu || preview !== null) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], .menu, .modal, .uploads')) return;
      const sel = selectedItems;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setSelected(new Set(items.map(keyOf)));
      } else if (e.key === 'Escape' && sel.length) {
        setSelected(new Set());
      } else if ((e.key === 'Delete' || (e.key === 'Backspace' && mod)) && sel.length) {
        e.preventDefault();
        if (inTrash) deleteForever(sel);
        else moveToTrash(sel);
      } else if (e.key === 'F2' && sel.length === 1 && !inTrash) {
        e.preventDefault();
        rename(sel[0]);
      } else if (e.key === 'Enter' && sel.length === 1 && !t.closest('button, a')) {
        e.preventDefault();
        open(sel[0]);
      } else if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key) && items.length) {
        if (view === 'list' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
        e.preventDefault();
        const cur = items.findIndex((i) => keyOf(i) === anchor);
        const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        const next = items[Math.max(0, Math.min(items.length - 1, cur < 0 ? 0 : cur + step))];
        const k = keyOf(next);
        if (e.shiftKey) setSelected((s) => new Set([...s, k]));
        else setSelected(new Set([k]));
        setAnchor(k);
        document.querySelector(`[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------ drag and drop

  const onItemDragStart = (e: DragEvent, item: Item) => {
    const k = keyOf(item);
    const targets = selected.has(k) ? selectedItems : [item];
    if (!selected.has(k)) selectOnly(item);
    dragging.current = targets;
    e.dataTransfer.setData(ITEMS_MIME, JSON.stringify(refsOf(targets)));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onItemDragEnd = () => {
    dragging.current = null;
    setDropTarget(null);
  };

  /** Lets a folder (row, tile or breadcrumb) accept dragged items or files from the desktop. */
  const dropZone = (target: string | null, targetName: string, key: string) => ({
    onDragOver: (e: DragEvent) => {
      if (hasItems(e.dataTransfer)) {
        const d = dragging.current;
        if (!d || d.some((i) => i.kind === 'folder' && i.id === target)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      } else if (hasFiles(e.dataTransfer) && !inTrash) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      } else return;
      if (dropTarget !== key) setDropTarget(key);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropTarget((t) => (t === key ? null : t));
    },
    onDrop: (e: DragEvent) => {
      setDropTarget(null);
      if (hasItems(e.dataTransfer) && dragging.current) {
        e.preventDefault();
        e.stopPropagation();
        moveTo(dragging.current, target, targetName);
        dragging.current = null;
      } else if (hasFiles(e.dataTransfer) && !inTrash) {
        e.preventDefault();
        e.stopPropagation();
        dragDepth.current = 0;
        setDragOver(false);
        uploadDropped(e.dataTransfer, target);
      }
    },
  });

  const contentDropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!canUpload || !hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth.current++;
      setDragOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (canUpload && hasFiles(e.dataTransfer)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragOver(false);
      if (canUpload) uploadDropped(e.dataTransfer, folderId);
    },
  };

  // ------------------------------------------------------------ rendering

  const setSort = (key: SortKey) => {
    const dir: 1 | -1 = sort.key === key ? (sort.dir === 1 ? -1 : 1) : key === 'name' ? 1 : -1;
    setPrefs({ ...prefs, sort: { ...prefs.sort, [route.name]: { key, dir } } });
  };

  const crumbs: { id: string | null; name: string }[] = [{ id: null, name: 'My files' }, ...(data?.breadcrumbs ?? [])];

  let head: ReactNode;
  if (route.name === 'folder') {
    head = (
      <nav aria-label="Folder path" style={{ minWidth: 0 }}>
        <h1 className="crumbs">
          {crumbs.map((c, i) =>
            i === crumbs.length - 1 ? (
              <span key={c.id ?? 'root'} className="current" aria-current="page" title={c.name}>
                {c.name}
              </span>
            ) : (
              <span key={c.id ?? 'root'} style={{ display: 'contents' }}>
                <a
                  href={folderHref(c.id)}
                  onClick={linkClick}
                  className={dropTarget === `crumb:${c.id}` ? 'drop-target' : ''}
                  title={c.name}
                  {...dropZone(c.id, c.name, `crumb:${c.id}`)}
                >
                  {c.name}
                </a>
                <ChevronRight className="sep" size={18} aria-hidden />
              </span>
            ),
          )}
        </h1>
      </nav>
    );
  } else {
    const titles = { recent: 'Recent', trash: 'Trash', search: `Results for “${route.name === 'search' ? route.q : ''}”` };
    head = <h1 className="page-title">{titles[route.name]}</h1>;
  }

  const viewToggle = (
    <div className="seg" role="group" aria-label="Layout">
      <button className="icon-btn" aria-pressed={view === 'list'} aria-label="List" onClick={() => setPrefs({ ...prefs, view: 'list' })}>
        <List size={17} />
      </button>
      <button className="icon-btn" aria-pressed={view === 'grid'} aria-label="Grid" onClick={() => setPrefs({ ...prefs, view: 'grid' })}>
        <LayoutGrid size={17} />
      </button>
    </div>
  );

  const selectionBar = selectedItems.length > 0 && (
    <div className="selbar" role="toolbar" aria-label="Selected items">
      <button className="icon-btn" aria-label="Clear selection" onClick={() => setSelected(new Set())}>
        <X size={18} />
      </button>
      <span className="count num">{selectedItems.length} selected</span>
      {inTrash ? (
        <>
          <button className="btn btn-quiet" onClick={() => restore(selectedItems)}>
            <RotateCcw size={16} /> Restore
          </button>
          <button className="btn btn-quiet" onClick={() => deleteForever(selectedItems)}>
            <Trash size={16} /> Delete forever
          </button>
        </>
      ) : (
        <>
          {selectedItems.some((i) => i.kind === 'file') && (
            <button className="btn btn-quiet" onClick={() => download(selectedItems.filter((i): i is FileItem => i.kind === 'file'))}>
              <Download size={16} /> Download
            </button>
          )}
          <button className="btn btn-quiet" onClick={() => move(selectedItems)}>
            <FolderInput size={16} /> Move
          </button>
          {selectedItems.length === 1 && (
            <button className="btn btn-quiet" onClick={() => rename(selectedItems[0])}>
              <Pencil size={16} /> Rename
            </button>
          )}
          <button className="btn btn-quiet" onClick={() => moveToTrash(selectedItems)}>
            <Trash size={16} /> Move to trash
          </button>
        </>
      )}
    </div>
  );

  let body: ReactNode;
  if (loadError) {
    body =
      loadError.status === 404 ? (
        <div className="empty">
          <h2>This folder isn’t available</h2>
          <p>It may have been moved to the trash or deleted.</p>
          <a className="btn" href="/" onClick={linkClick}>
            Go to My files
          </a>
        </div>
      ) : (
        <div className="empty">
          <h2>Couldn’t load your files</h2>
          <p>{loadError.message}</p>
          <button className="btn" onClick={() => setReload((r) => r + 1)}>
            Try again
          </button>
        </div>
      );
  } else if (!data) {
    body = (
      <div aria-busy="true" aria-label="Loading">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton" style={{ opacity: 1 - i * 0.14 }} />
        ))}
      </div>
    );
  } else if (!items.length) {
    body = <EmptyState route={route} isRoot={!folderId} onUpload={() => uploadInput.current?.click()} onNewFolder={newFolder} />;
  } else if (view === 'grid') {
    const folderItems = items.filter((i) => i.kind === 'folder');
    const fileItems = items.filter((i) => i.kind === 'file');
    const tile = (item: Item) => {
      const k = keyOf(item);
      const cat = item.kind === 'file' ? fileCategory(item.mimeType, item.name) : null;
      const thumb = item.kind === 'file' && cat === 'image' && item.size < 15 * 1024 * 1024;
      return (
        <div
          key={k}
          data-key={k}
          className={`tile ${item.kind === 'folder' ? 'folder-tile' : ''} ${selected.has(k) ? 'selected' : ''} ${dropTarget === k ? 'drop-target' : ''}`}
          aria-selected={selected.has(k)}
          role="option"
          onClick={(e) => onItemClick(e, item)}
          onDoubleClick={() => open(item)}
          onContextMenu={(e) => showMenu(e, item)}
          draggable={!inTrash}
          onDragStart={(e) => onItemDragStart(e, item)}
          onDragEnd={onItemDragEnd}
          {...(item.kind === 'folder' && !inTrash ? dropZone(item.id, item.name, k) : {})}
        >
          {item.kind === 'file' && (
            <div className="thumb">
              <FileIcon item={item} size={40} />
              {thumb && (
                <img
                  src={contentUrl(item.id)}
                  alt=""
                  loading="lazy"
                  style={{ position: 'absolute', inset: 0 }}
                  onError={(e) => (e.currentTarget.style.display = 'none')}
                />
              )}
              {!thumb && extensionOf(item.name) && <span className="ext">{extensionOf(item.name)}</span>}
            </div>
          )}
          <div className="meta">
            {item.kind === 'folder' && <FileIcon item={item} size={22} />}
            <div className="name" title={item.name}>
              {item.name}
              <small className="num">
                {item.kind === 'file' ? formatBytes(item.size) : plural(item.itemCount ?? 0, 'item')}
              </small>
            </div>
            <button className="icon-btn" aria-label={`Actions for ${item.name}`} onClick={(e) => showMenu(e, item)}>
              <Ellipsis size={18} />
            </button>
          </div>
        </div>
      );
    };
    body = (
      <div className="grid" role="listbox" aria-multiselectable="true" aria-label="Files and folders">
        {folderItems.length > 0 && <div className="grid-label">Folders</div>}
        {folderItems.map(tile)}
        {fileItems.length > 0 && <div className="grid-label">Files</div>}
        {fileItems.map(tile)}
      </div>
    );
  } else {
    const allSelected = selected.size > 0 && selected.size === items.length;
    const sortHead = (key: SortKey, label: string) => (
      <button aria-pressed={sort.key === key} onClick={() => setSort(key)}>
        {label}
        {sort.key === key && (sort.dir === 1 ? <ArrowUp size={13} /> : <ArrowDown size={13} />)}
      </button>
    );
    body = (
      <div className={`list ${showLocation ? 'with-location' : ''}`} role="grid" aria-multiselectable="true" aria-label="Files and folders">
        <div className="list-head" role="row">
          <div className="checkbox-cell" role="columnheader">
            <Checkbox
              checked={allSelected}
              label="Select all"
              onToggle={() => setSelected(allSelected ? new Set() : new Set(items.map(keyOf)))}
            />
          </div>
          <div role="columnheader">{sortHead('name', 'Name')}</div>
          {showLocation && (
            <div className="col-loc" role="columnheader">
              Location
            </div>
          )}
          <div role="columnheader">{sortHead('size', 'Size')}</div>
          <div className="col-date" role="columnheader">
            {sortHead('date', inTrash ? 'Deleted' : 'Modified')}
          </div>
          <div role="columnheader">
            <span className="visually-hidden">Actions</span>
          </div>
        </div>
        {items.map((item) => {
          const k = keyOf(item);
          const isSel = selected.has(k);
          const date = inTrash ? (item.deletedAt ?? item.updatedAt) : item.updatedAt;
          const pid = parentOf(item);
          return (
            <div
              key={k}
              data-key={k}
              role="row"
              aria-selected={isSel}
              className={`row ${isSel ? 'selected' : ''} ${dropTarget === k ? 'drop-target' : ''} ${anchor === k ? 'focused' : ''}`}
              onClick={(e) => onItemClick(e, item)}
              onDoubleClick={() => open(item)}
              onContextMenu={(e) => showMenu(e, item)}
              draggable={!inTrash}
              onDragStart={(e) => onItemDragStart(e, item)}
              onDragEnd={onItemDragEnd}
              {...(item.kind === 'folder' && !inTrash ? dropZone(item.id, item.name, k) : {})}
            >
              <div className="checkbox-cell" role="gridcell">
                <Checkbox checked={isSel} label={`Select ${item.name}`} onToggle={() => toggle(item)} />
              </div>
              <div className="name-cell" role="gridcell">
                <FileIcon item={item} />
                <button
                  className="name"
                  title={item.name}
                  tabIndex={-1}
                  onClick={(e) => {
                    if (e.shiftKey || e.ctrlKey || e.metaKey || isCoarse()) return;
                    e.stopPropagation();
                    selectOnly(item);
                    open(item);
                  }}
                >
                  {item.name}
                </button>
              </div>
              {showLocation && (
                <div className="loc col-loc" role="gridcell">
                  <a href={folderHref(pid)} onClick={(e) => (e.stopPropagation(), linkClick(e))} title={item.location}>
                    {!item.location || item.location === '/' ? 'My files' : item.location.slice(1).split('/').join(' › ')}
                  </a>
                </div>
              )}
              <div className="num" role="gridcell">
                {item.kind === 'file' ? formatBytes(item.size) : item.itemCount !== undefined ? plural(item.itemCount, 'item') : ''}
              </div>
              <div className="col-date num" role="gridcell" title={formatFullDate(date)}>
                {formatDate(date)}
              </div>
              <div className="actions" role="gridcell">
                <button className="icon-btn" aria-label={`Actions for ${item.name}`} onClick={(e) => showMenu(e, item)}>
                  <Ellipsis size={18} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <>
      <div className="content-wrap" {...contentDropHandlers}>
      <div
        className="content"
        onMouseDown={(e) => {
          const t = e.target as HTMLElement;
          if (t === e.currentTarget || t.classList.contains('grid') || t.classList.contains('list') || t.classList.contains('empty')) {
            setSelected(new Set());
          }
        }}
      >
        <div className="page-head">
          {head}
          <div className="spacer" />
          {inTrash && items.length > 0 && (
            <button className="btn" onClick={emptyTrash}>
              <Trash size={16} /> Empty trash
            </button>
          )}
          {route.name === 'folder' && (
            <div className="mobile-only">
              <NewMenu folderId={folderId} inFolderView compact />
            </div>
          )}
          {items.length > 0 && viewToggle}
        </div>
        {route.name === 'trash' && items.length > 0 && (
          <p className="page-sub">Restore items to put them back where they were. Deleting forever also removes them from Telegram.</p>
        )}
        {route.name === 'search' && data && items.length > 0 && <p className="page-sub num">{plural(items.length, 'match', 'matches')}</p>}
        {selectionBar}
        {body}
      </div>
        {dragOver && (
          <div className="drop-overlay">
            <div className="drop-label">
              <Upload size={26} />
              <div>
                <strong>Drop to upload to {currentName}</strong>
                <small>Or drop onto a folder to upload into it. Folders keep their structure.</small>
              </div>
            </div>
          </div>
        )}
      </div>

      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          enqueue(entriesFromInput(e.target.files), folderId);
          e.target.value = '';
        }}
      />
      {menu && <ContextMenu x={menu.x} y={menu.y} actions={menu.actions} onClose={closeMenu} />}
      {dialog}
      {preview !== null && files[preview] && <Preview files={files} index={preview} onIndex={setPreview} onClose={() => setPreview(null)} />}
    </>
  );
}

function Checkbox({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className="cb"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {checked && <Check size={13} strokeWidth={3} />}
    </button>
  );
}

function EmptyState({ route, isRoot, onUpload, onNewFolder }: { route: DriveRoute; isRoot: boolean; onUpload: () => void; onNewFolder: () => void }) {
  if (route.name === 'folder') {
    return (
      <div className="empty">
        <h2>{isRoot ? 'Store your first file' : 'This folder is empty'}</h2>
        <p>
          {isRoot
            ? 'Drop files or whole folders anywhere on this page, or upload them. Everything is saved to Telegram and listed here.'
            : 'Drop files here, or upload them to add them to this folder.'}
        </p>
        <div className="row-of-buttons">
          <button className="btn btn-primary" onClick={onUpload}>
            <Upload size={17} /> Upload files
          </button>
          <button className="btn" onClick={onNewFolder}>
            <FolderPlus size={17} /> New folder
          </button>
        </div>
      </div>
    );
  }
  if (route.name === 'recent') {
    return (
      <div className="empty">
        <h2>Nothing here yet</h2>
        <p>Files you upload or change show up here, newest first.</p>
      </div>
    );
  }
  if (route.name === 'trash') {
    return (
      <div className="empty">
        <h2>Trash is empty</h2>
        <p>Deleted files and folders wait here until you delete them forever, so you can always restore them.</p>
      </div>
    );
  }
  return (
    <div className="empty">
      <h2>No matches for “{route.q}”</h2>
      <p>Check the spelling, or search for part of the name.</p>
    </div>
  );
}
