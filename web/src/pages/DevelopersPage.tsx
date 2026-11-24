import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, Plus } from 'lucide-react';
import { api, errorMessage } from '../api';
import { formatDate } from '../format';
import type { ApiKey } from '../types';
import { ConfirmDialog, Modal } from '../components/Modal';
import { useToast } from '../components/Toasts';

const EXAMPLES: Record<'curl' | 'JavaScript' | 'Python', string> = {
  curl: `# Save a file. Missing folders are created for you.
curl -X PUT "__BASE__/api/v1/fs/Backups/notes.txt" \\
  -H "Authorization: Bearer $TGS_KEY" \\
  --data-binary @notes.txt

# Read it back
curl "__BASE__/api/v1/fs/Backups/notes.txt" \\
  -H "Authorization: Bearer $TGS_KEY" -o notes.txt

# List a folder
curl "__BASE__/api/v1/fs/Backups" -H "Authorization: Bearer $TGS_KEY"

# Upload several files with a form
curl "__BASE__/api/v1/files?path=Photos/2026" \\
  -H "Authorization: Bearer $TGS_KEY" \\
  -F "file=@beach.jpg" -F "file=@sunset.jpg"`,

  JavaScript: `const BASE = '__BASE__/api/v1';
const headers = { Authorization: \`Bearer \${process.env.TGS_KEY}\` };

// Save a file. Missing folders are created for you.
await fetch(\`\${BASE}/fs/Backups/notes.txt\`, {
  method: 'PUT',
  headers,
  body: 'Hello from my app',
});

// Read it back
const res = await fetch(\`\${BASE}/fs/Backups/notes.txt\`, { headers });
const text = await res.text();

// Upload a Blob or a file from <input type="file">
const form = new FormData();
form.append('file', blob, 'photo.jpg');
const upload = await fetch(\`\${BASE}/files?path=Photos\`, { method: 'POST', headers, body: form });
const { file } = await upload.json(); // file.id, file.size, …`,

  Python: `import os
import requests

BASE = "__BASE__/api/v1"
headers = {"Authorization": f"Bearer {os.environ['TGS_KEY']}"}

# Save a file. Missing folders are created for you.
with open("notes.txt", "rb") as f:
    requests.put(f"{BASE}/fs/Backups/notes.txt", data=f, headers=headers).raise_for_status()

# Read it back
data = requests.get(f"{BASE}/fs/Backups/notes.txt", headers=headers).content

# List a folder
listing = requests.get(f"{BASE}/fs/Backups", headers=headers).json()
for item in listing["files"]:
    print(item["name"], item["size"])`,
};

const ENDPOINTS: { group: string; rows: [string, string, string][] }[] = [
  {
    group: 'Read and write by path',
    rows: [
      ['GET', '/api/v1/fs/{path}', 'Download a file, or list a folder as JSON. Add ?meta=1 to get a file’s details instead of its content.'],
      ['PUT', '/api/v1/fs/{path}', 'Write the request body to a file. Creates missing folders and replaces an existing file; add ?overwrite=false to refuse instead.'],
      ['PATCH', '/api/v1/fs/{path}', 'Rename or move. Body: {"name": "new.txt", "moveTo": "Folder/Sub"}'],
      ['DELETE', '/api/v1/fs/{path}', 'Move to the trash. Add ?permanent=true to delete forever.'],
    ],
  },
  {
    group: 'Files by id',
    rows: [
      ['POST', '/api/v1/files', 'Upload with multipart/form-data in a field named "file". Options: folderId or path, and onConflict = rename, overwrite or fail.'],
      ['GET', '/api/v1/files/{id}', 'A file’s details.'],
      ['GET', '/api/v1/files/{id}/content', 'Download. Supports Range requests for streaming; add ?download=1 to force a download.'],
      ['PUT', '/api/v1/files/{id}/content', 'Replace the content and keep the same id.'],
      ['PATCH', '/api/v1/files/{id}', 'Rename or move. Body: {"name", "folderId"}'],
      ['DELETE', '/api/v1/files/{id}', 'Move to the trash (?permanent=true deletes forever).'],
    ],
  },
  {
    group: 'Folders by id',
    rows: [
      ['GET', '/api/v1/folders/{id}/children', 'List a folder. Use root for the top level.'],
      ['POST', '/api/v1/folders', 'Create a folder: {"name", "parentId"}, or {"path": "A/B/C"} to create nested folders.'],
      ['PATCH', '/api/v1/folders/{id}', 'Rename or move. Body: {"name", "parentId"}'],
      ['DELETE', '/api/v1/folders/{id}', 'Move to the trash with everything inside (?permanent=true deletes forever).'],
    ],
  },
  {
    group: 'Search, recent and trash',
    rows: [
      ['GET', '/api/v1/search?q={text}', 'Find files and folders by name.'],
      ['GET', '/api/v1/recent', 'Recently added or changed files.'],
      ['GET', '/api/v1/trash', 'Items in the trash.'],
      ['POST', '/api/v1/trash/restore', 'Restore items. Body: {"files": [ids], "folders": [ids]}'],
      ['DELETE', '/api/v1/trash', 'Empty the trash.'],
      ['GET', '/api/v1/me', 'Your account and how much you have stored.'],
    ],
  },
];

export function DevelopersPage() {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [tab, setTab] = useState<keyof typeof EXAMPLES>('curl');
  const base = window.location.origin;

  const load = () =>
    api
      .keys()
      .then((r) => setKeys(r.keys))
      .catch((err) => setError(errorMessage(err)));

  useEffect(() => {
    load();
  }, []);

  const code = EXAMPLES[tab].replaceAll('__BASE__', base);

  return (
    <div className="content-wrap">
      <div className="content">
        <div className="dev">
          <div className="page-head">
            <h1 className="page-title">Developers</h1>
          </div>
          <p className="page-sub">
            Other apps and scripts can store and read files here through the API. They sign requests with an API key instead of signing in with Telegram.
          </p>

          <section aria-labelledby="keys-title">
            <div className="section-head">
              <div>
                <h2 id="keys-title">API keys</h2>
                <p>Give each app its own key, so you can revoke one without breaking the others.</p>
              </div>
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                <Plus size={17} /> Create API key
              </button>
            </div>
            <div className="keys">
              {!keys && !error && (
                <div className="keys-empty">
                  <LoaderCircle size={16} className="spin" />
                </div>
              )}
              {error && <div className="keys-empty">{error}</div>}
              {keys?.length === 0 && <div className="keys-empty">No API keys yet. Create one to connect your first app.</div>}
              {keys?.map((k) => (
                <div className="key-row" key={k.id}>
                  <div>
                    <strong>{k.name}</strong>
                    <small>
                      <span className="inline-code">{k.prefix}…</span> created {formatDate(k.createdAt).toLowerCase()},{' '}
                      {k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt).toLowerCase()}` : 'never used'}
                    </small>
                  </div>
                  <div className="scopes">
                    {k.scopes.map((s) => (
                      <span key={s} className={`scope ${s}`}>
                        {s === 'read' ? 'Read' : 'Write'}
                      </span>
                    ))}
                  </div>
                  <button className="btn btn-quiet" onClick={() => setRevoking(k)}>
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="start-title">
            <h2 id="start-title">Quick start</h2>
            <p>
              Send your key in the <span className="inline-code">Authorization: Bearer</span> header (or <span className="inline-code">X-API-Key</span>). These examples
              expect it in a <span className="inline-code">TGS_KEY</span> environment variable.
            </p>
            <div className="code-block">
              <div className="code-tabs" role="tablist" aria-label="Language">
                {(Object.keys(EXAMPLES) as (keyof typeof EXAMPLES)[]).map((t) => (
                  <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                    {t}
                  </button>
                ))}
              </div>
              <CopyButton text={code} />
              <pre>
                <code>{code}</code>
              </pre>
            </div>
          </section>

          <section aria-labelledby="ref-title">
            <h2 id="ref-title">Endpoints</h2>
            <p>
              Base URL <span className="inline-code">{base}</span>. Errors come back as <span className="inline-code">{'{"error": {"code", "message"}}'}</span> with a
              matching HTTP status. Folder paths are case-insensitive.
            </p>
            <div className="endpoints">
              {ENDPOINTS.map((g) => (
                <div key={g.group}>
                  <div className="endpoint-group">{g.group}</div>
                  {g.rows.map(([method, path, text]) => (
                    <div className="endpoint" key={method + path}>
                      <span className={`method ${method}`}>{method}</span>
                      <code>{path}</code>
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <h3>Good to know</h3>
            <p>
              Files of any size are accepted. Large files are split into parts below Telegram’s 20 MB bot limit and joined again on download, so a 1 GB
              file takes a few minutes to store. Telegram limits how fast a bot can post, so bulk uploads are throttled automatically rather than failing.
            </p>
          </section>
        </div>
      </div>

      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            load();
          }}
        />
      )}
      {revoking && (
        <ConfirmDialog
          title={`Revoke “${revoking.name}”?`}
          body="Apps using this key will stop working right away. This can’t be undone."
          confirmLabel="Revoke key"
          danger
          onClose={() => setRevoking(null)}
          onConfirm={async () => {
            await api.revokeKey(revoking.id);
            toast.show(`Revoked “${revoking.name}”`);
            load();
          }}
        />
      )}
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn copy"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        })
      }
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}

function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [write, setWrite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the key a name, like the app that will use it');
    setBusy(true);
    setError('');
    try {
      const r = await api.createKey(name.trim(), write ? ['read', 'write'] : ['read']);
      setSecret(r.secret);
      onCreated();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (secret) {
    return (
      <Modal title="Copy your new API key" onClose={onClose} wide>
        <p>This is the only time the key is shown. Store it somewhere safe, like your app’s environment variables.</p>
        <div className="secret-box">
          <code>{secret}</code>
          <button
            className="btn"
            onClick={() =>
              navigator.clipboard.writeText(secret).then(() => {
                setCopied(true);
              })
            }
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Create API key" onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Backup script" maxLength={80} autoFocus />
        </label>
        <div className="field">
          <span>Permissions</span>
          <label className="check">
            <input type="checkbox" checked disabled />
            <div>
              Read
              <small>List folders and download files.</small>
            </div>
          </label>
          <label className="check">
            <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
            <div>
              Write
              <small>Upload, rename, move and delete files and folders.</small>
            </div>
          </label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}
            Create key
          </button>
        </div>
      </form>
    </Modal>
  );
}
