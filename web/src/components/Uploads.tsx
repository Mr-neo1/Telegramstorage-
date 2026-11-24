import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronUp, RotateCcw, X } from 'lucide-react';
import { errorMessage, uploadFile, type UploadHandle } from '../api';
import { formatBytes } from '../format';
import { FileIcon } from './FileIcon';

type Status = 'queued' | 'uploading' | 'posting' | 'done' | 'error' | 'canceled';

interface Job {
  id: number;
  file: File;
  relativePath: string;
  folderId: string | null;
  status: Status;
  loaded: number;
  total: number;
  error?: string;
}

export interface UploadEntry {
  file: File;
  relativePath: string;
}

interface UploadsApi {
  enqueue: (entries: UploadEntry[], folderId: string | null) => void;
  /** Increments whenever an upload finishes, so views can refresh. */
  version: number;
}

const Ctx = createContext<UploadsApi | null>(null);
const PARALLEL = 2;

export function useUploads() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUploads outside provider');
  return v;
}

export function UploadsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [version, setVersion] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const handles = useRef(new Map<number, UploadHandle>());
  const started = useRef(new Set<number>());
  const seq = useRef(0);

  const patch = useCallback((id: number, p: Partial<Job>) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }, []);

  const enqueue = useCallback<UploadsApi['enqueue']>((entries, folderId) => {
    if (!entries.length) return;
    setCollapsed(false);
    setJobs((js) => [
      ...js,
      ...entries.map((e) => ({
        id: ++seq.current,
        file: e.file,
        relativePath: e.relativePath,
        folderId,
        status: 'queued' as const,
        loaded: 0,
        total: e.file.size,
      })),
    ]);
  }, []);

  // Start queued uploads while fewer than PARALLEL are running.
  useEffect(() => {
    const running = jobs.filter((j) => j.status === 'uploading' || j.status === 'posting').length;
    const next = jobs
      .filter((j) => j.status === 'queued' && !started.current.has(j.id))
      .slice(0, Math.max(0, PARALLEL - running));
    for (const job of next) {
      started.current.add(job.id);
      patch(job.id, { status: 'uploading' });
      const handle = uploadFile(job.file, {
        folderId: job.folderId,
        relativePath: job.relativePath,
        onProgress: (loaded, total) => patch(job.id, { loaded, total }),
        onSent: () => patch(job.id, { status: 'posting', loaded: job.file.size }),
      });
      handles.current.set(job.id, handle);
      handle.promise
        .then(() => {
          patch(job.id, { status: 'done' });
          setVersion((v) => v + 1);
        })
        .catch((err) => {
          if ((err as { code?: string }).code === 'aborted') patch(job.id, { status: 'canceled' });
          else patch(job.id, { status: 'error', error: errorMessage(err) });
        })
        .finally(() => {
          handles.current.delete(job.id);
          started.current.delete(job.id);
        });
    }
  }, [jobs, patch]);

  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'uploading' || j.status === 'posting');

  useEffect(() => {
    if (!active.length) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active.length]);

  const cancel = (job: Job) => {
    const h = handles.current.get(job.id);
    if (h) h.abort();
    else patch(job.id, { status: 'canceled' });
  };

  const retry = (job: Job) => patch(job.id, { status: 'queued', loaded: 0, error: undefined });

  const close = () => {
    if (active.length && !window.confirm(`Cancel ${active.length === 1 ? 'the upload' : `${active.length} uploads`} in progress?`)) return;
    active.forEach(cancel);
    setJobs([]);
  };

  const api = useMemo(() => ({ enqueue, version }), [enqueue, version]);

  const done = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'error').length;
  const title = active.length
    ? `Uploading ${jobs.length - active.length + 1} of ${jobs.length}`
    : failed
      ? `${done} uploaded, ${failed} failed`
      : `${done} ${done === 1 ? 'upload' : 'uploads'} complete`;

  return (
    <Ctx.Provider value={api}>
      {children}
      {jobs.length > 0 && (
        <section className={`uploads ${collapsed ? 'collapsed' : ''}`} aria-label="Uploads">
          <div className="uploads-head">
            <strong aria-live="polite">{title}</strong>
            <button
              className="icon-btn"
              aria-label={collapsed ? 'Expand uploads' : 'Collapse uploads'}
              onClick={() => setCollapsed((c) => !c)}
            >
              {collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            </button>
            <button className="icon-btn" aria-label="Close uploads" onClick={close}>
              <X size={18} />
            </button>
          </div>
          {!collapsed && (
            <div className="uploads-list">
              {jobs.map((job) => (
                <UploadRow key={job.id} job={job} onCancel={() => cancel(job)} onRetry={() => retry(job)} />
              ))}
            </div>
          )}
        </section>
      )}
    </Ctx.Provider>
  );
}

function UploadRow({ job, onCancel, onRetry }: { job: Job; onCancel: () => void; onRetry: () => void }) {
  const pct = job.total ? Math.min(100, (job.loaded / job.total) * 100) : 0;
  const name = job.relativePath ? `${job.relativePath}/${job.file.name}` : job.file.name;
  let status: ReactNode;
  let statusClass = '';
  switch (job.status) {
    case 'queued':
      status = 'Waiting to upload';
      break;
    case 'uploading':
      status = `${formatBytes(job.loaded)} of ${formatBytes(job.total)}`;
      break;
    case 'posting':
      status = 'Sending to Telegram…';
      break;
    case 'done':
      status = `Saved to Telegram, ${formatBytes(job.file.size)}`;
      statusClass = 'done';
      break;
    case 'error':
      status = job.error;
      statusClass = 'error';
      break;
    case 'canceled':
      status = 'Canceled';
      break;
  }
  return (
    <div className="upload">
      <span className="uicon">
        <FileIcon item={{ kind: 'file', name: job.file.name, mimeType: job.file.type || '' }} />
      </span>
      <span className="uname" title={name}>
        {name}
      </span>
      {(job.status === 'uploading' || job.status === 'posting') && (
        <div className={`bar ${job.status === 'posting' ? 'posting' : ''}`} aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <span className={`ustatus ${statusClass}`}>{status}</span>
      <span className="uact">
        {job.status === 'done' ? (
          <Check size={18} color="var(--green)" aria-label="Done" />
        ) : job.status === 'error' || job.status === 'canceled' ? (
          <button className="icon-btn" aria-label={`Retry ${job.file.name}`} onClick={onRetry}>
            <RotateCcw size={16} />
          </button>
        ) : (
          <button className="icon-btn" aria-label={`Cancel ${job.file.name}`} onClick={onCancel}>
            <X size={16} />
          </button>
        )}
      </span>
    </div>
  );
}
