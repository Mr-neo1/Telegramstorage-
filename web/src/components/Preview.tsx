import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, LoaderCircle, X } from 'lucide-react';
import { contentUrl } from '../api';
import { extensionOf, fileCategory, formatBytes, formatDate } from '../format';
import type { FileItem } from '../types';
import { FileIcon } from './FileIcon';

const TEXT_LIMIT = 256 * 1024;

export function Preview({ files, index, onIndex, onClose }: { files: FileItem[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const file = files[index];
  const hasPrev = index > 0;
  const hasNext = index < files.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft' && hasPrev && !(e.target instanceof HTMLMediaElement)) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && hasNext && !(e.target instanceof HTMLMediaElement)) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [index, hasPrev, hasNext, onIndex, onClose]);

  if (!file) return null;

  return createPortal(
    <div className="preview" role="dialog" aria-modal="true" aria-label={`Preview of ${file.name}`}>
      <div className="preview-bar">
        <FileIcon item={file} size={22} />
        <div className="title">
          <strong title={file.name}>{file.name}</strong>
          <small className="num">
            {formatBytes(file.size)}, changed {formatDate(file.updatedAt).toLowerCase()}
          </small>
        </div>
        <a className="btn" href={contentUrl(file.id, true)} download={file.name}>
          <Download size={17} /> Download
        </a>
        <button className="icon-btn" aria-label="Close preview" onClick={onClose} autoFocus>
          <X size={22} />
        </button>
      </div>
      <div className="preview-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <Stage key={file.id} file={file} />
        {hasPrev && (
          <button className="icon-btn preview-nav prev" aria-label="Previous file" onClick={() => onIndex(index - 1)}>
            <ChevronLeft size={24} />
          </button>
        )}
        {hasNext && (
          <button className="icon-btn preview-nav next" aria-label="Next file" onClick={() => onIndex(index + 1)}>
            <ChevronRight size={24} />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Stage({ file }: { file: FileItem }) {
  const cat = fileCategory(file.mimeType, file.name);
  const src = contentUrl(file.id);
  switch (cat) {
    case 'image':
      return <img src={src} alt={file.name} />;
    case 'video':
      return <video src={src} controls autoPlay playsInline />;
    case 'audio':
      return (
        <div className="audio-card">
          <FileIcon item={file} size={72} />
          <audio src={src} controls autoPlay />
        </div>
      );
    case 'pdf':
      return <iframe src={src} title={file.name} />;
    case 'text':
    case 'code':
      return file.size <= 20 * 1024 * 1024 ? <TextStage file={file} /> : <Fallback file={file} />;
    default:
      return <Fallback file={file} />;
  }
}

function TextStage({ file }: { file: FileItem }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    fetch(contentUrl(file.id), { headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` }, signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.text();
      })
      .then(setText)
      .catch(() => !ac.signal.aborted && setFailed(true));
    return () => ac.abort();
  }, [file.id]);
  if (failed) return <Fallback file={file} message="This file couldn’t be loaded from Telegram." />;
  if (text === null) return <LoaderCircle size={28} className="spin" color="#c7d0de" />;
  return (
    <pre tabIndex={0}>
      {text}
      {file.size > TEXT_LIMIT && `\n\n… Showing the first 256 KB. Download the file to see all of it.`}
    </pre>
  );
}

function Fallback({ file, message }: { file: FileItem; message?: string }) {
  const ext = extensionOf(file.name);
  return (
    <div className="preview-fallback">
      <FileIcon item={file} size={72} />
      <strong>{message ?? 'There’s no preview for this kind of file'}</strong>
      <p className="num">
        {ext ? `${ext} file, ` : ''}
        {formatBytes(file.size)}
      </p>
      <a className="btn" href={contentUrl(file.id, true)} download={file.name}>
        <Download size={17} /> Download
      </a>
    </div>
  );
}
