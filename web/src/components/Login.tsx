import { useCallback, useEffect, useRef, useState } from 'react';
import { Braces, CircleExclamationPoint, FolderOpen, LoaderCircle, RefreshCw, Send } from 'lucide-react';
import { api, errorMessage } from '../api';
import type { AuthConfig, LoginStart, User } from '../types';

type Phase =
  | { kind: 'loading' }
  | { kind: 'setup'; config: AuthConfig | null; error?: string }
  | { kind: 'waiting'; start: LoginStart }
  | { kind: 'awaiting'; start: LoginStart; name: string | null }
  | { kind: 'denied'; start: LoginStart }
  | { kind: 'expired'; start: LoginStart | null }
  | { kind: 'failed'; message: string };

export function Brand() {
  return (
    <span className="brand">
      <span className="brand-mark airmail" aria-hidden>
        <span />
      </span>
      Telegram Storage
    </span>
  );
}

export function Login({ onSignedIn }: { onSignedIn: (u: User) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const attempt = useRef(0);

  const begin = useCallback(async () => {
    const my = ++attempt.current;
    setPhase({ kind: 'loading' });
    try {
      const config = await api.config();
      if (config.bot.status !== 'ready') {
        if (my === attempt.current) setPhase({ kind: 'setup', config });
        return;
      }
      const start = await api.startLogin();
      if (my === attempt.current) setPhase({ kind: 'waiting', start });
    } catch (err) {
      if (my === attempt.current) setPhase({ kind: 'failed', message: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    begin();
  }, [begin]);

  // Re-check the bot every few seconds while it's still connecting.
  useEffect(() => {
    if (phase.kind !== 'setup' || phase.config?.bot.status !== 'starting') return;
    const t = window.setTimeout(begin, 3000);
    return () => window.clearTimeout(t);
  }, [phase, begin]);

  // Poll for approval in Telegram.
  const start = phase.kind === 'waiting' || phase.kind === 'awaiting' ? phase.start : null;
  useEffect(() => {
    if (!start) return;
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (Date.now() > start.expiresAt) return !stopped && setPhase({ kind: 'expired', start });
      try {
        const s = await api.loginStatus();
        if (stopped) return;
        if (s.status === 'approved') return onSignedIn(s.user);
        if (s.status === 'denied') return setPhase({ kind: 'denied', start });
        if (s.status === 'expired') return setPhase({ kind: 'expired', start });
        if (s.status === 'awaiting') setPhase((p) => (p.kind === 'awaiting' ? p : { kind: 'awaiting', start, name: s.telegramName }));
      } catch {
        /* keep polling through brief network errors */
      }
      timer = window.setTimeout(tick, document.hidden ? 4000 : 1500);
    };
    timer = window.setTimeout(tick, 1200);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [start, onSignedIn]);

  return (
    <div className="login">
      <div className="login-copy">
        <Brand />
        <h1>Your folders, stored in Telegram.</h1>
        <p>Upload files of any size, sort them into folders and open them from any browser. Telegram holds the files; this app keeps them organised.</p>
        <ul className="login-points">
          <li>
            <Send size={20} aria-hidden />
            <span>
              <strong>No password to remember.</strong> You approve each sign-in in your Telegram app.
            </span>
          </li>
          <li>
            <FolderOpen size={20} aria-hidden />
            <span>
              <strong>Big files welcome.</strong> They’re split into parts behind the scenes and joined again when you download them.
            </span>
          </li>
          <li>
            <Braces size={20} aria-hidden />
            <span>
              <strong>Works with your other apps.</strong> Read and write files from scripts and services with an API key.
            </span>
          </li>
        </ul>
      </div>

      <div className="envelope airmail">
        <div className="envelope-inner">
          <Card phase={phase} onRestart={begin} />
        </div>
      </div>
    </div>
  );
}

function Card({ phase, onRestart }: { phase: Phase; onRestart: () => void }) {
  if (phase.kind === 'loading') {
    return (
      <>
        <h2>Sign in with Telegram</h2>
        <div className="qr" aria-busy="true">
          <div className="qr-overlay">
            <LoaderCircle size={26} className="spin" />
          </div>
        </div>
        <p>Preparing a sign-in code…</p>
      </>
    );
  }

  if (phase.kind === 'failed') {
    return (
      <>
        <h2>Sign-in isn’t available</h2>
        <div className="notice">
          <CircleExclamationPoint size={18} />
          <span>{phase.message}</span>
        </div>
        <button className="btn" onClick={onRestart}>
          <RefreshCw size={16} /> Try again
        </button>
      </>
    );
  }

  if (phase.kind === 'setup') {
    const bot = phase.config?.bot;
    if (bot?.status === 'starting') {
      return (
        <>
          <h2>Connecting to Telegram…</h2>
          <LoaderCircle size={26} className="spin" />
          <p>The server is starting its Telegram bot. This page continues on its own.</p>
        </>
      );
    }
    return (
      <>
        <h2>{bot?.status === 'missing' ? 'Connect a Telegram bot first' : 'The Telegram bot isn’t working'}</h2>
        {bot?.error && (
          <div className="notice">
            <CircleExclamationPoint size={18} />
            <span>{bot.error}</span>
          </div>
        )}
        <ol className="login-steps">
          <li>
            In Telegram, open <strong>@BotFather</strong>, send <code>/newbot</code> and copy the token it gives you.
          </li>
          <li>
            In the project folder, run <code>npm run setup</code> and paste the token.
          </li>
          <li>Restart the server, then reload this page.</li>
        </ol>
        <button className="btn" onClick={onRestart}>
          <RefreshCw size={16} /> Check again
        </button>
      </>
    );
  }

  const start = phase.start;
  const dim = phase.kind !== 'waiting';
  return (
    <>
      <h2>Sign in with Telegram</h2>
      <p>
        {phase.kind === 'waiting' ? (
          <>
            <span className="lead-desktop">Scan the code with your phone’s camera, or open Telegram on this device.</span>
            <span className="lead-mobile">Open Telegram, press Start, then approve the sign-in.</span>
          </>
        ) : phase.kind === 'awaiting' ? (
          'One more step: approve the sign-in in Telegram.'
        ) : phase.kind === 'denied' ? (
          'The sign-in was denied in Telegram, so nobody was signed in.'
        ) : (
          'This sign-in code has expired. Get a new one to try again.'
        )}
      </p>
      <div className={`qr ${dim ? 'dim' : ''}`}>
        {start ? <span dangerouslySetInnerHTML={{ __html: start.qr }} style={{ display: 'contents' }} /> : null}
        {phase.kind === 'awaiting' && (
          <div className="qr-overlay">
            <Send size={28} />
            Tap “Approve sign-in” in Telegram
          </div>
        )}
        {phase.kind === 'denied' && <div className="qr-overlay">Sign-in was denied in Telegram</div>}
        {phase.kind === 'expired' && <div className="qr-overlay">This code has expired</div>}
      </div>
      {phase.kind === 'waiting' || phase.kind === 'awaiting' ? (
        <>
          <div className="login-actions">
            <a className="btn btn-primary btn-lg" href={start!.link} target="_blank" rel="noreferrer">
              <Send size={18} /> Open Telegram
            </a>
          </div>
          <div className="login-status" role="status">
            <span className="dot" aria-hidden />
            {phase.kind === 'awaiting'
              ? `Almost there${phase.name ? `, ${phase.name}` : ''}. Approve the sign-in in your chat with @${start!.botUsername}.`
              : `Waiting for you to press Start in @${start!.botUsername}`}
          </div>
        </>
      ) : (
        <div className="login-actions">
          <button className="btn btn-primary btn-lg" onClick={onRestart}>
            <RefreshCw size={18} /> Get a new code
          </button>
        </div>
      )}
    </>
  );
}
