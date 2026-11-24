import { useEffect, useRef, useState } from 'react';
import { FolderPlus, FolderUp, Plus, Upload } from 'lucide-react';
import { api } from '../api';
import { entriesFromInput } from '../dnd';
import { folderHref, navigate } from '../router';
import { MenuButtons, menuKeys } from './Menu';
import { PromptDialog } from './Modal';
import { useToast } from './Toasts';
import { useUploads } from './Uploads';

export const notifyChanged = () => window.dispatchEvent(new Event('tgs:changed'));

/** "New" button: create a folder or upload files/folders into `folderId` (null = My files). */
export function NewMenu({ folderId, inFolderView, compact }: { folderId: string | null; inFolderView: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const { enqueue } = useUploads();
  const toast = useToast();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    wrap.current?.querySelector<HTMLButtonElement>('.menu button')?.focus();
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);

  const startUpload = (list: FileList | null) => {
    const entries = entriesFromInput(list);
    if (!entries.length) return;
    enqueue(entries, folderId);
    if (!inFolderView) {
      navigate(folderHref(folderId));
      toast.show('Uploading to My files');
    }
  };

  return (
    <div className="new-menu-wrap" ref={wrap}>
      {compact ? (
        <button className="icon-btn" aria-label="New" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Plus size={20} />
        </button>
      ) : (
        <button className="btn btn-primary new-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Plus size={19} /> New
        </button>
      )}
      {open && (
        <div className="menu anchored" role="menu" onKeyDown={menuKeys} style={compact ? { left: 'auto', right: 0 } : undefined}>
          <MenuButtons
            onDone={() => setOpen(false)}
            actions={[
              { label: 'New folder', icon: FolderPlus, onSelect: () => setNaming(true) },
              { label: 'Upload files', icon: Upload, onSelect: () => filesInput.current?.click(), separated: true },
              { label: 'Upload a folder', icon: FolderUp, onSelect: () => folderInput.current?.click() },
            ]}
          />
        </div>
      )}
      <input
        ref={filesInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          startUpload(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        // @ts-expect-error non-standard but supported by every current browser
        webkitdirectory=""
        onChange={(e) => {
          startUpload(e.target.files);
          e.target.value = '';
        }}
      />
      {naming && (
        <PromptDialog
          title="New folder"
          label="Folder name"
          initial="Untitled folder"
          confirmLabel="Create folder"
          onClose={() => setNaming(false)}
          onSubmit={async (name) => {
            const { folder } = await api.createFolder(folderId, name);
            notifyChanged();
            if (!inFolderView) navigate(folderHref(folderId));
            toast.show(`Created “${folder.name}”`);
          }}
        />
      )}
    </div>
  );
}
