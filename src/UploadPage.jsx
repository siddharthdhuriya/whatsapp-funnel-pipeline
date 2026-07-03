// src/UploadPage.jsx
//
// A one-page uploader: log in, drag today's export in, it lands in
// the `daily-exports` Supabase Storage bucket, and the Database
// Webhook takes over from there. This page never talks to the
// processing function directly — Storage is the handoff point.

import { useState, useCallback, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY // safe to expose — restricted by RLS policies + login below
);

const BUCKET = 'daily-exports';

// Fixed account behind the shared password gate — not a real mailbox,
// just an identity for Supabase Auth/RLS to attach the session to.
const SHARED_EMAIL = 'access@whatsapp-funnel.internal';

export default function UploadPage() {
  const [session, setSession] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  if (checkingSession) {
    return <div style={styles.page}><div style={styles.card}>Loading…</div></div>;
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        {session ? <UploadBox onLogout={() => supabase.auth.signOut()} /> : <LoginBox />}
      </div>
    </div>
  );
}

function LoginBox() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email: SHARED_EMAIL, password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <form onSubmit={handleLogin}>
      <a href="/" style={styles.backLink}>← Back to report</a>
      <div style={styles.eyebrow}>WhatsApp Funnel Pipeline</div>
      <h1 style={styles.title}>Enter password to upload</h1>
      <p style={styles.subtitle}>This page is password-protected.</p>

      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        autoFocus
        style={styles.input}
      />
      <button type="submit" disabled={loading} style={styles.button}>
        {loading ? 'Unlocking…' : 'Unlock'}
      </button>

      {error && <div style={{ ...styles.notice, ...styles.noticeError }}>{error}</div>}
    </form>
  );
}

// How long to keep polling daily_upload_log for the matching entry
// before giving up and telling the user to check back later.
const PROCESSING_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;

function UploadBox({ onLogout }) {
  // idle | uploading | processing | done | error | timeout
  const [status, setStatus] = useState('idle');
  const [message, setMessage] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((text) => {
    setToast(text);
    setTimeout(() => setToast(null), 4000);
  }, []);

  const pollForProcessing = useCallback((path, uploadStartedIso) => {
    const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

    const poll = async () => {
      const { data, error } = await supabase
        .from('daily_upload_log')
        .select('*')
        .eq('file_name', path)
        .gte('processed_at', uploadStartedIso)
        .order('processed_at', { ascending: false })
        .limit(1);

      if (!error && data && data.length > 0) {
        const log = data[0];
        if (log.status === 'success') {
          setStatus('done');
          setMessage(`Processed ${log.rows_parsed} rows into ${log.segments_upserted} segments.`);
          showToast('Data processing completed');
          // Take the user to the live report now that it's updated.
          setTimeout(() => { window.location.href = '/'; }, 1500);
          return;
        }
        setStatus('error');
        setMessage(log.error_message || 'Processing failed.');
        return;
      }

      if (Date.now() > deadline) {
        setStatus('timeout');
        setMessage('Still processing — this is taking longer than usual. Check back in a few minutes.');
        return;
      }

      setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();
  }, [showToast]);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    const okType = /\.(xlsx|xls|csv)$/i.test(file.name);
    if (!okType) {
      setStatus('error');
      setMessage('Please upload an .xlsx, .xls, or .csv file.');
      return;
    }

    setStatus('uploading');
    setMessage('');

    const uploadStartedIso = new Date().toISOString();
    const today = uploadStartedIso.slice(0, 10);
    const ext = file.name.split('.').pop();
    const path = `report-${today}.${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { upsert: true, contentType: file.type });

    if (error) {
      setStatus('error');
      setMessage(error.message);
      return;
    }

    setStatus('processing');
    setMessage(`Uploaded as ${path}. Processing…`);
    pollForProcessing(path, uploadStartedIso);
  }, [pollForProcessing]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }, [handleFile]);

  const busy = status === 'uploading' || status === 'processing';

  return (
    <div>
      {toast && <div style={styles.toast}>{toast}</div>}

      <a href="/" style={styles.backLink}>← Back to report</a>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={styles.eyebrow}>WhatsApp Funnel Pipeline</div>
          <h1 style={styles.title}>Upload today's export</h1>
        </div>
        <button onClick={onLogout} style={styles.logoutButton}>Log out</button>
      </div>
      <p style={styles.subtitle}>
        Drop the daily Excel/CSV export here. Everything after this — parsing,
        aggregating, updating the dashboard — happens automatically.
      </p>

      <label
        style={{ ...styles.dropzone, ...(dragOver ? styles.dropzoneActive : {}) }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
          style={{ display: 'none' }}
          disabled={busy}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {status === 'uploading' ? <span>Uploading…</span>
          : status === 'processing' ? <span>Processing…</span>
          : <span>Drag a file here, or click to browse</span>}
      </label>

      {(status === 'uploading' || status === 'processing') && (
        <div style={styles.statusBar}>
          <div style={styles.statusRow}>
            <StatusStep label="Uploaded" active={true} />
            <StatusStep label="Processing" active={status === 'processing'} spinning={status === 'processing'} />
            <StatusStep label="Complete" active={false} />
          </div>
          <div style={styles.statusTrack}>
            <div style={{ ...styles.statusFill, width: status === 'uploading' ? '33%' : '66%' }} />
          </div>
          <div style={styles.statusMessage}>{message}</div>
        </div>
      )}

      {status === 'done' && <div style={{ ...styles.notice, ...styles.noticeSuccess }}>{message}</div>}
      {(status === 'error' || status === 'timeout') && (
        <div style={{ ...styles.notice, ...styles.noticeError }}>{message}</div>
      )}
    </div>
  );
}

function StatusStep({ label, active, spinning }) {
  return (
    <div style={{ ...styles.statusStep, ...(active ? styles.statusStepActive : {}) }}>
      {spinning ? <span style={styles.spinner} /> : null}
      {label}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#ffffff',
    fontFamily: "'Space Grotesk', sans-serif",
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    border: '1px solid #e1e6ef',
    borderRadius: 12,
    padding: 32,
    boxShadow: '0 1px 2px rgba(20,25,40,0.04)',
  },
  backLink: {
    display: 'inline-block',
    marginBottom: 16,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    color: '#5c6479',
    textDecoration: 'none',
  },
  eyebrow: {
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: '#0d9488',
    marginBottom: 8,
  },
  title: { fontSize: 22, fontWeight: 600, margin: '0 0 8px', color: '#151b2c' },
  subtitle: { fontSize: 13, color: '#5c6479', marginBottom: 24, lineHeight: 1.5 },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    marginBottom: 12,
    border: '1px solid #e1e6ef',
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  button: {
    width: '100%',
    padding: '10px 12px',
    border: 'none',
    borderRadius: 8,
    background: '#0d9488',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: "'Space Grotesk', sans-serif",
  },
  logoutButton: {
    padding: '6px 12px',
    border: '1px solid #e1e6ef',
    borderRadius: 8,
    background: '#fff',
    color: '#5c6479',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: "'IBM Plex Mono', monospace",
  },
  dropzone: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: 160,
    border: '1.5px dashed #e1e6ef',
    borderRadius: 10,
    cursor: 'pointer',
    color: '#9399ac',
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    textAlign: 'center',
    transition: 'all .15s ease',
  },
  dropzoneActive: { borderColor: '#0d9488', color: '#0d9488', background: '#f4f6fa' },
  notice: {
    marginTop: 16,
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 12.5,
    fontFamily: "'IBM Plex Mono', monospace",
  },
  noticeSuccess: { background: 'rgba(13,148,136,0.10)', color: '#0d9488' },
  noticeError: { background: 'rgba(214,41,62,0.10)', color: '#d6293e' },
  statusBar: {
    marginTop: 16,
    padding: '14px 16px',
    border: '1px solid #e1e6ef',
    borderRadius: 10,
    background: '#f4f6fa',
  },
  statusRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  statusStep: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 11,
    color: '#9399ac',
  },
  statusStepActive: { color: '#0d9488', fontWeight: 600 },
  statusTrack: {
    height: 5,
    borderRadius: 3,
    background: '#eef1f7',
    overflow: 'hidden',
    marginBottom: 8,
  },
  statusFill: {
    height: '100%',
    borderRadius: 3,
    background: '#0d9488',
    transition: 'width .4s ease',
  },
  statusMessage: {
    fontSize: 12,
    color: '#5c6479',
    fontFamily: "'IBM Plex Mono', monospace",
  },
  spinner: {
    display: 'inline-block',
    width: 9,
    height: 9,
    borderRadius: '50%',
    border: '1.5px solid rgba(13,148,136,0.3)',
    borderTopColor: '#0d9488',
    animation: 'spin .7s linear infinite',
  },
  toast: {
    position: 'fixed',
    top: 20,
    right: 20,
    padding: '12px 18px',
    borderRadius: 8,
    background: '#151b2c',
    color: '#fff',
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12.5,
    boxShadow: '0 4px 16px rgba(20,25,40,0.18)',
    zIndex: 1000,
  },
};
