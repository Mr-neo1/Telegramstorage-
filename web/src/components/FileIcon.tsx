import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  Folder,
  Presentation,
  type LucideIcon,
} from 'lucide-react';
import { fileCategory, type FileCategory } from '../format';
type IconItem = { kind: 'folder' } | { kind: 'file'; name: string; mimeType: string };

const ICONS: Record<FileCategory, LucideIcon> = {
  image: FileImage,
  video: FileVideoCamera,
  audio: FileMusic,
  pdf: FileText,
  text: FileText,
  code: FileCode,
  archive: FileArchive,
  sheet: FileSpreadsheet,
  slides: Presentation,
  doc: FileText,
  other: File,
};

export function FileIcon({ item, size = 20 }: { item: IconItem; size?: number }) {
  if (item.kind === 'folder') {
    return <Folder className="ficon folder" size={size} fill="currentColor" fillOpacity={0.16} strokeWidth={1.8} aria-hidden />;
  }
  const cat = fileCategory(item.mimeType, item.name);
  const Icon = ICONS[cat];
  return <Icon className={`ficon ${cat}`} size={size} strokeWidth={1.8} aria-hidden />;
}
