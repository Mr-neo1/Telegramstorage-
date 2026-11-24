import type { UploadEntry } from './components/Uploads';

/** Reads files and folders dropped from the desktop, keeping their folder structure. */
export async function entriesFromDrop(dt: DataTransfer): Promise<{ files: UploadEntry[]; emptyDirs: string[] }> {
  // Entries must be read synchronously, before the drop event finishes.
  const roots = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  const plainFiles = [...dt.files];

  if (!roots.length) return { files: plainFiles.map((file) => ({ file, relativePath: '' })), emptyDirs: [] };

  const files: UploadEntry[] = [];
  const emptyDirs: string[] = [];

  const walk = async (entry: FileSystemEntry, parent: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      files.push({ file, relativePath: parent });
      return;
    }
    if (entry.isDirectory) {
      const dir = parent ? `${parent}/${entry.name}` : entry.name;
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const children: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        children.push(...batch);
      }
      if (!children.length) emptyDirs.push(dir);
      for (const child of children) await walk(child, dir);
    }
  };

  for (const root of roots) await walk(root, '');
  return { files, emptyDirs };
}

/** Files picked with <input type="file">, including webkitdirectory folder picks. */
export function entriesFromInput(list: FileList | null): UploadEntry[] {
  return [...(list ?? [])].map((file) => {
    const rel = file.webkitRelativePath || '';
    const slash = rel.lastIndexOf('/');
    return { file, relativePath: slash > 0 ? rel.slice(0, slash) : '' };
  });
}

export const hasFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes('Files');
export const ITEMS_MIME = 'application/x-telegram-storage-items';
export const hasItems = (dt: DataTransfer | null) => !!dt && [...dt.types].includes(ITEMS_MIME);
