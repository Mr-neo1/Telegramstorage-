import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { Item, Listing } from '../types';
import { FileIcon } from './FileIcon';
import { Modal } from './Modal';

export function MoveDialog({
  items,
  startFolderId,
  onMove,
  onClose,
}: {
  items: Item[];
  startFolderId: string | null;
  onMove: (folderId: string | null, folderName: string) => Promise<void>;
  onClose: () => void;
}) {
  const [folderId, setFolderId] = useState<string | null>(startFolderId);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const moving = new Set(items.filter((i) => i.kind === 'folder').map((i) => i.id));

  useEffect(() => {
    let cancelled = false;
    setListing(null);
    api
      .list(folderId)
      .then((l) => !cancelled && setListing(l))
      .catch((err) => {
        if (cancelled) return;
        // The starting folder may have been removed; fall back to the root.
        if (folderId) setFolderId(null);
        else setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [folderId]);

  const parents = new Set(items.map((i) => (i.kind === 'file' ? i.folderId : i.parentId)));
  const alreadyHere = parents.size === 1 && parents.has(folderId);
  const insideMoving = !!listing && (moving.has(folderId ?? '') || listing.breadcrumbs.some((b) => moving.has(b.id)));
  const here = listing?.folder?.name ?? 'My files';
  const parentId = listing && listing.breadcrumbs.length > 1 ? listing.breadcrumbs[listing.breadcrumbs.length - 2].id : null;
  const title = items.length === 1 ? `Move “${items[0].name}”` : `Move ${items.length} items`;

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="picker">
        <div className="picker-head">
          {folderId ? (
            <button className="icon-btn" aria-label="Go up one folder" onClick={() => setFolderId(parentId)}>
              <ChevronLeft size={18} />
            </button>
          ) : null}
          <span>{here}</span>
        </div>
        <div className="picker-list">
          {!listing && !error && (
            <div className="picker-empty">
              <LoaderCircle size={18} className="spin" />
            </div>
          )}
          {listing && listing.folders.length === 0 && <div className="picker-empty">No folders inside {here}.</div>}
          {listing?.folders.map((f) => (
            <button key={f.id} onClick={() => setFolderId(f.id)} disabled={moving.has(f.id)} title={moving.has(f.id) ? 'You can’t move a folder into itself' : undefined}>
              <FileIcon item={f} size={18} />
              <span>{f.name}</span>
              <ChevronRight size={16} color="var(--ink-3)" />
            </button>
          ))}
        </div>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={!listing || busy || alreadyHere || insideMoving}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await onMove(folderId, here);
              onClose();
            } catch (err) {
              setError(errorMessage(err));
              setBusy(false);
            }
          }}
        >
          {busy && <LoaderCircle size={16} className="spin" />}
          {alreadyHere ? 'Already here' : `Move to ${here.length > 24 ? 'this folder' : here}`}
        </button>
      </div>
    </Modal>
  );
}
