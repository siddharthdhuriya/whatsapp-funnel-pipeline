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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setLoading(false);
  };

  return (
    <form onSubmit={handleLogin}>
      <div style={styles.eyebrow}>WhatsApp Funnel Pipeline</div>
      <h1 style={styles.title}>Log in to upload</h1>
      <p style={styles.subtitle}>Use the email and password set up in Supabase Authentication.</p>

      <input
        type="email"
        placeholder="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={styles.input}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        style={styles.input}
      />
      <button type="submit" disabled={loading} style={styles.button}>
        {loading ? 'Logging in…' : 'Log in'}
      </button>

      {error && <div style={{ ...styles.notice, ...styles.noticeError }}>{error}</div>}
    </form>
  );
}

function UploadBox({ onLogout }) {
  const [status, setStatus] = useState('idle'); // idle | uploading | done | error
  const [message, setMessage] = useState('');
  const [dragOver, setDragOver] = useState(false);

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

    const today = new Date().toISOString().slice(0, 10);
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

    setStatus('done');
    setMessage(`Uploaded as ${path}. Processing will run automatically — check back in a minute.`);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleFile(e.dataTransfer.files?.[0]);
  }, [handleFile]);

  return (
    <div>
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
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        {status === 'uploading' ? <span>Uploading…</span> : <span>Drag a file here, or click to browse</span>}
      </label>

      {status === 'done' && <div style={{ ...styles.notice, ...styles.noticeSuccess }}>{message}</div>}
      {status === 'error' && <div style={{ ...styles.notice, ...styles.noticeError }}>{message}</div>}
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
};
