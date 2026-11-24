import type {
  Account,
  ApiKey,
  AuthConfig,
  FileItem,
  FolderItem,
  ItemRefs,
  ItemsResult,
  Listing,
  LoginStart,
  LoginStatus,
  User,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CSRF_HEADER = { 'X-Requested-With': 'telegram-storage' };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...CSRF_HEADER };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', "Can't reach the server. Check that it's running and try again.");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('tgs:signed-out'));
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `The request failed (${res.status})`);
  }
  return data as T;
}

const folderKey = (id: string | null) => encodeURIComponent(id ?? 'root');

export const contentUrl = (id: string, download = false) =>
  `/api/v1/files/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`;

export const api = {
  config: () => request<AuthConfig>('GET', '/api/auth/config'),
  me: () => request<{ user: User }>('GET', '/api/auth/me'),
  startLogin: () => request<LoginStart>('POST', '/api/auth/login'),
  loginStatus: () => request<LoginStatus>('GET', '/api/auth/login/status'),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  account: () => request<Account>('GET', '/api/v1/me'),
  list: (folderId: string | null) => request<Listing>('GET', `/api/v1/folders/${folderKey(folderId)}/children`),
  folderInfo: (folderId: string | null) =>
    request<{ folder: FolderItem | null; breadcrumbs: { id: string; name: string }[] }>('GET', `/api/v1/folders/${folderKey(folderId)}`),
  recent: () => request<ItemsResult>('GET', '/api/v1/recent'),
  search: (q: string) => request<ItemsResult>('GET', `/api/v1/search?q=${encodeURIComponent(q)}`),
  trash: () => request<ItemsResult>('GET', '/api/v1/trash'),

  createFolder: (parentId: string | null, name: string) =>
    request<{ folder: FolderItem }>('POST', '/api/v1/folders', { parentId, name }),
  createFolderPath: (parentId: string | null, path: string) =>
    request<{ folder: FolderItem }>('POST', '/api/v1/folders', { parentId, path }),
  renameFolder: (id: string, name: string) =>
    request<{ folder: FolderItem }>('PATCH', `/api/v1/folders/${encodeURIComponent(id)}`, { name }),
  renameFile: (id: string, name: string) => request<{ file: FileItem }>('PATCH', `/api/v1/files/${encodeURIComponent(id)}`, { name }),
  move: (items: ItemRefs, folderId: string | null) =>
    request<{ moved: unknown[]; errors: { id: string; message: string }[] }>('POST', '/api/v1/items/move', { ...items, folderId }),
  trashItems: (items: ItemRefs) => request<{ count: number }>('POST', '/api/v1/items/trash', items),
  restore: (items: ItemRefs) => request<{ count: number }>('POST', '/api/v1/trash/restore', items),
  deleteForever: (items: ItemRefs) => request<{ count: number }>('POST', '/api/v1/trash/delete', items),
  emptyTrash: () => request<{ count: number }>('DELETE', '/api/v1/trash'),

  keys: () => request<{ keys: ApiKey[] }>('GET', '/api/keys'),
  createKey: (name: string, scopes: string[]) => request<{ key: ApiKey; secret: string }>('POST', '/api/keys', { name, scopes }),
  revokeKey: (id: string) => request<{ ok: true }>('DELETE', `/api/keys/${encodeURIComponent(id)}`),
};

export interface UploadHandle {
  promise: Promise<FileItem>;
  abort: () => void;
}

/** Uploads one file with progress. onSent fires when the browser has sent every byte. */
export function uploadFile(
  file: File,
  opts: {
    folderId: string | null;
    relativePath?: string;
    onProgress: (loaded: number, total: number) => void;
    onSent: () => void;
  },
): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<FileItem>((resolve, reject) => {
    const form = new FormData();
    if (opts.folderId) form.append('folderId', opts.folderId);
    if (opts.relativePath) form.append('relativePath', opts.relativePath);
    form.append('onConflict', 'rename');
    form.append('file', file, file.name);

    xhr.open('POST', '/api/v1/files');
    xhr.setRequestHeader('X-Requested-With', 'telegram-storage');
    xhr.upload.onprogress = (e) => opts.onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.upload.onload = () => opts.onSent();
    xhr.onload = () => {
      let data: { file?: FileItem; error?: { code: string; message: string } } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.file) return resolve(data.file);
      if (xhr.status === 401) window.dispatchEvent(new Event('tgs:signed-out'));
      reject(new ApiError(xhr.status, data?.error?.code ?? 'upload_failed', data?.error?.message ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The connection to the server was lost'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'Upload canceled'));
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
