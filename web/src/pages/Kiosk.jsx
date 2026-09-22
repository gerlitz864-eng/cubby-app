import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { kioskApi, publicApi } from '../api.js';
import { Btn, Field, Pill, hoursText, fmtTime, label } from '../ui.jsx';

// A shared tablet at the entrance or in a classroom. It signs in with a device token, not a person's login.
// Staff clock in and out (face or PIN). Parents and pick-up people sign children in and out with a PIN.

export function PinPad({ value, onChange, onEnter, length = 6 }) {
  const press = (d) => { if (value.length < length) onChange(value + d); };
  return (
    <div>
      <div className="dots" aria-label={`${value.length} of ${length} digits entered`}>{Array.from({ length }).map((_, i) => <i key={i} className={i < value.length ? 'on' : ''} />)}</div>
      <div className="pad">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <button key={n} type="button" onClick={() => press(String(n))}>{n}</button>)}
        <button type="button" onClick={() => onChange(value.slice(0, -1))} aria-label="Delete">⌫</button>
        <button type="button" onClick={() => press('0')}>0</button>
        <button type="button" onClick={() => onEnter?.()} aria-label="Enter" style={{ background: 'var(--primary)', color: 'var(--primary-ink)' }}>OK</button>
      </div>
    </div>
  );
}

function Camera({ onCapture, disabled }) {
  const ref = useRef(null);
  const [state, setState] = useState('starting');
  useEffect(() => {
    let stream;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        if (ref.current) { ref.current.srcObject = stream; await ref.current.play().catch(() => {}); }
        setState('ready');
      } catch { setState('unavailable'); }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  const snap = () => {
    const v = ref.current; const c = document.createElement('canvas');
    c.width = 320; c.height = 240; c.getContext('2d').drawImage(v, 0, 0, 320, 240);
    onCapture(c.toDataURL('image/jpeg', 0.7));
  };
  return (
    <div className="center">
      <video ref={ref} className="cam" muted playsInline aria-label="Camera preview" />
      {state === 'unavailable' && <p className="muted small" style={{ marginTop: 8 }}>The camera is not available on this device. Use your PIN instead.</p>}
      <div style={{ marginTop: 12 }}><Btn onClick={snap} disabled={disabled || state !== 'ready'}>Verify with camera</Btn></div>
    </div>
  );
}

const ACTIONS = [['clock_in', 'Clock in'], ['clock_out', 'Clock out'], ['break_start', 'Start break'], ['break_end', 'End break'], ['room_change', 'Change room']];

function StaffClock({ k, info }) {
  const [staff, setStaff] = useState([]);
  const [who, setWho] = useState(null);
  const [action, setAction] = useState(null);
  const [room, setRoom] = useState('');
  const [method, setMethod] = useState('face');
  const [pin, setPin] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [msg, setMsg] = useState('');
  const [result, setResult] = useState(null);
  const demo = /mock/i.test(info.faceProvider);

  const load = () => k.get('/kiosk/staff').then(setStaff).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, []);
  const reset = () => { setWho(null); setAction(null); setPin(''); setAttempts(0); setMsg(''); setResult(null); load(); };

  const send = async (extra) => {
    setMsg('');
    try {
      const r = await k.post('/kiosk/punch', { staffId: who.id, punchType: action, classroomId: room || undefined, method, attempts: attempts + 1, ...extra });
      if (method === 'face' && r.status === 'pending_review') { setAttempts((a) => a + 1); setMsg('We could not confirm it is you. If this keeps happening, use your PIN.'); if (attempts + 1 >= 3) setMethod('pin'); return; }
      setResult(r);
    } catch (e) { setMsg(e.message); setPin(''); }
  };

  if (result) {
    return (
      <div className="center stack">
        <h2>{result.status === 'accepted' ? `Thank you, ${result.name}` : 'Recorded for review'}</h2>
        <p style={{ fontSize: 22 }}>{label(result.punchType)} at {fmtTime(result.at)}</p>
        {result.status !== 'accepted' && <div className="banner">Your punch was saved with this time and a supervisor will review it. You do not lose any pay.</div>}
        <p className="muted">Today so far: <b>{hoursText(result.today_seconds)}</b><br />Last 7 days: <b>{hoursText(result.week_seconds)}</b></p>
        <Btn onClick={reset}>Done</Btn>
      </div>
    );
  }
  if (!who) {
    return (
      <>
        <h2 style={{ marginBottom: 12 }}>Who are you?</h2>
        <div className="tilegrid">{staff.map((s) => <button key={s.id} className={`tile ${s.clocked_in_at ? 'ok' : ''}`} onClick={() => { setWho(s); setRoom(s.default_classroom_id || ''); }}><b>{s.first_name} {s.last_name[0]}.</b><div className="small">{s.clocked_in_at ? `In since ${fmtTime(s.clocked_in_at)}` : 'Not clocked in'}</div></button>)}</div>
      </>
    );
  }
  if (!action) {
    return (
      <div className="stack">
        <div className="spread"><h2>Hi, {who.first_name}</h2><Btn kind="ghost" small onClick={reset}>Not me</Btn></div>
        <div className="tilegrid">{ACTIONS.map(([id, text]) => <button key={id} className="tile" onClick={() => { setAction(id); setMethod(who.face_enabled ? 'face' : 'pin'); }}><b>{text}</b></button>)}</div>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="spread"><h2>{who.first_name}: {label(action)}</h2><Btn kind="ghost" small onClick={() => setAction(null)}>Back</Btn></div>
      {(action === 'clock_in' || action === 'room_change') && <Field label="Room"><select value={room} onChange={(e) => setRoom(e.target.value)}><option value="">No room (office or floating)</option>{info.classrooms.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>}
      {who.face_enabled && <div className="row"><Btn small kind={method === 'face' ? undefined : 'ghost'} onClick={() => setMethod('face')}>Face</Btn><Btn small kind={method === 'pin' ? undefined : 'ghost'} onClick={() => setMethod('pin')}>PIN</Btn></div>}
      {method === 'face'
        ? <>
            <Camera disabled={false} onCapture={(img) => send({ imageBase64: img })} />
            {demo && <div className="banner info small">Demo mode: the face check accepts any image and identifies nobody. Try the outcomes: <div className="row" style={{ marginTop: 6 }}><Btn small kind="ghost" onClick={() => send({ imageBase64: 'demo', demoResult: 'pass' })}>Pretend it matched</Btn><Btn small kind="ghost" onClick={() => send({ imageBase64: 'demo', demoResult: 'fail' })}>Pretend no match</Btn><Btn small kind="ghost" onClick={() => send({ imageBase64: 'demo', demoResult: 'spoof' })}>Pretend it was a photo</Btn></div></div>}
          </>
        : <><p className="muted center">Enter your PIN</p><PinPad value={pin} onChange={setPin} length={4} onEnter={() => send({ pin })} /><p className="center small muted">Demo PIN for everyone: 2468</p></>}
      {msg && <div className="banner bad">{msg}</div>}
    </div>
  );
}

function FamilySign({ k }) {
  const [phone, setPhone] = useState('');
  const [person, setPerson] = useState(null);
  const [pin, setPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(null);

  const reset = () => { setPhone(''); setPerson(null); setPin(''); setUnlocked(false); setMsg(''); setDone(null); };
  const lookup = async () => { setMsg(''); try { setPerson(await k.post('/kiosk/family/lookup', { phone })); } catch (e) { setMsg(e.message); } };
  const sign = async (child, action) => {
    setMsg('');
    try { await k.post('/kiosk/family/sign', { credentialId: person.credentialId, pin, childId: child.id, action }); setDone({ child, action }); setTimeout(reset, 4000); }
    catch (e) { setMsg(e.message); setUnlocked(false); setPin(''); }
  };

  if (done) return <div className="center stack"><h2>{done.action === 'check_in' ? `${done.child.first_name} is signed in` : `${done.child.first_name} is signed out`}</h2><p className="muted">Thank you.</p></div>;
  if (!person) {
    return (
      <div className="stack">
        <h2>Sign your child in or out</h2>
        <Field label="Your phone number"><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && lookup()} placeholder="(555) 010-2311" autoFocus /></Field>
        <Btn onClick={lookup}>Continue</Btn>
        {msg && <div className="banner bad">{msg}</div>}
        <p className="small muted">Demo: use (555) 010-2311 (Rachel Bennett) with PIN 123456.</p>
      </div>
    );
  }
  if (!unlocked) {
    return (
      <div className="stack">
        <div className="spread"><h2>Hello, {person.firstName}</h2><Btn kind="ghost" small onClick={reset}>Not me</Btn></div>
        <p className="muted center">Enter your PIN</p>
        <PinPad value={pin} onChange={setPin} onEnter={() => pin.length === 6 && setUnlocked(true)} />
        {msg && <div className="banner bad">{msg}</div>}
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="spread"><h2>Choose your child</h2><Btn kind="ghost" small onClick={reset}>Cancel</Btn></div>
      <div className="tilegrid">
        {person.children.map((c) => (
          <div key={c.id} className="tile"><b>{c.first_name}</b><div className="small muted" style={{ marginBottom: 8 }}>{c.state === 'in' ? 'Signed in' : c.state === 'out' ? 'Signed out today' : 'Not in yet'}</div>
            {c.state === 'in' ? <Btn small onClick={() => sign(c, 'check_out')}>Sign out</Btn> : c.state === 'out' ? null : <Btn small onClick={() => sign(c, 'check_in')}>Sign in</Btn>}</div>
        ))}
      </div>
      {msg && <div className="banner bad">{msg}</div>}
    </div>
  );
}

export default function Kiosk() {
  const [token, setToken] = useState(localStorage.getItem('cubby_device') || '');
  const [draft, setDraft] = useState('');
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('staff');
  const [health, setHealth] = useState(null);
  const k = useMemo(() => kioskApi(token), [token]);
  useEffect(() => { publicApi.get('/health').then(setHealth).catch(() => {}); }, []);
  useEffect(() => { if (token) k.get('/kiosk/info').then((i) => { setInfo(i); setErr(''); }).catch((e) => { setErr(e.message); setInfo(null); }); }, [token]);

  if (!info) {
    return (
      <div className="kiosk"><div className="panel stack" style={{ maxWidth: 480 }}>
        <h2>Set up this kiosk</h2>
        <p className="muted">An administrator creates a device token under Admin, then Devices. Paste it here.</p>
        <Field label="Device token"><input value={draft} onChange={(e) => setDraft(e.target.value)} /></Field>
        <Btn onClick={() => { localStorage.setItem('cubby_device', draft.trim()); setToken(draft.trim()); }}>Connect</Btn>
        {err && <div className="banner bad">{err}</div>}
        {health?.demo && <div className="banner info">Demo token: <button className="chip" onClick={() => setDraft('demo-kiosk-token')}>demo-kiosk-token</button></div>}
        <Link to="/login" className="small">Back to sign in</Link>
      </div></div>
    );
  }
  return (
    <div className="kiosk">
      <div className="panel">
        <div className="spread" style={{ marginBottom: 14 }}>
          <div><b style={{ fontSize: 20 }}>{info.center}</b><div className="small muted">{info.device}</div></div>
          <div className="row"><Pill tone="info">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</Pill><Btn small kind="ghost" onClick={() => { localStorage.removeItem('cubby_device'); setToken(''); setInfo(null); }}>Unpair</Btn></div>
        </div>
        <div className="tabs"><button className={`tab ${mode === 'staff' ? 'on' : ''}`} onClick={() => setMode('staff')}>Staff time clock</button><button className={`tab ${mode === 'family' ? 'on' : ''}`} onClick={() => setMode('family')}>Parents and pick-up</button></div>
        {mode === 'staff' ? <StaffClock k={k} info={info} /> : <FamilySign k={k} />}
      </div>
    </div>
  );
}
