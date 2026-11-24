export function formatBytes(bytes: number) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const yearFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

export function formatDate(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  const diff = now.getTime() - ms;
  if (diff < 60_000) return 'Just now';
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (d.toDateString() === now.toDateString()) return `Today, ${timeFmt.format(d)}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${timeFmt.format(d)}`;
  return d.getFullYear() === now.getFullYear() ? dayFmt.format(d) : yearFmt.format(d);
}

export const formatFullDate = (ms: number) => fullFmt.format(new Date(ms));

export type FileCategory = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'code' | 'archive' | 'sheet' | 'slides' | 'doc' | 'other';

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|ps1|bat|sql|css|scss|html|vue|svelte|yml|yaml|toml|ini|env|json|xml|lua|r|dart)$/i;
const TEXT_EXT = /\.(txt|md|markdown|log|csv|tsv|rtf|srt|vtt|conf|cfg)$/i;

export function fileCategory(mime: string, name: string): FileCategory {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/zip|rar|7z|tar|gzip|x-bzip|compressed/.test(m)) return 'archive';
  if (/spreadsheet|excel|csv/.test(m) || /\.(xlsx?|ods|numbers)$/i.test(name)) return 'sheet';
  if (/presentation|powerpoint/.test(m) || /\.(pptx?|odp|key)$/i.test(name)) return 'slides';
  if (/wordprocessing|msword|opendocument\.text/.test(m) || /\.(docx?|odt|pages)$/i.test(name)) return 'doc';
  if (CODE_EXT.test(name) || /json|javascript|typescript|xml|x-sh|x-python/.test(m)) return 'code';
  if (m.startsWith('text/') || TEXT_EXT.test(name)) return 'text';
  return 'other';
}

export const canPreviewInline = (cat: FileCategory) => ['image', 'video', 'audio', 'pdf', 'text', 'code'].includes(cat);

export const extensionOf = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toUpperCase() : '';
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
