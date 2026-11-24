export interface User {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  hasPhoto: boolean;
  createdAt: number;
}

export interface FolderItem {
  kind: 'folder';
  id: string;
  name: string;
  parentId: string | null;
  itemCount?: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  location?: string;
}

export interface FileItem {
  kind: 'file';
  id: string;
  name: string;
  folderId: string | null;
  size: number;
  mimeType: string;
  sha256: string | null;
  source: 'web' | 'api' | 'bot';
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  location?: string;
}

export type Item = FolderItem | FileItem;

export interface Crumb {
  id: string;
  name: string;
}

export interface Listing {
  folder: FolderItem | null;
  breadcrumbs: Crumb[];
  folders: FolderItem[];
  files: FileItem[];
}

export interface ItemsResult {
  folders: FolderItem[];
  files: FileItem[];
}

export interface Usage {
  files: number;
  bytes: number;
  folders: number;
  trashFiles: number;
  trashBytes: number;
}

export interface Account {
  user: User;
  usage: Usage;
  limits: { chunkSize: number; maxUploadBytes: number | null };
}

export interface AuthConfig {
  bot: { configured: boolean; status: 'missing' | 'starting' | 'ready' | 'error'; username: string | null; error: string | null };
  restricted: boolean;
  storage: 'channel' | 'bot-chat';
}

export interface LoginStart {
  link: string;
  appLink: string;
  qr: string;
  expiresAt: number;
  botUsername: string;
}

export type LoginStatus =
  | { status: 'pending' | 'expired' | 'denied' }
  | { status: 'awaiting'; telegramName: string | null }
  | { status: 'approved'; user: User };

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: ('read' | 'write')[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ItemRefs {
  files: string[];
  folders: string[];
}
