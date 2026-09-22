import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, Link } from 'react-router-dom';
import { publicApi } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Btn, Field, useForm, useAction } from '../ui.jsx';

const DEMO = [
  ['Owner', 'owner@willowcreek.test', 'demo1234'], ['Director', 'director@willowcreek.test', 'demo1234'], ['Office', 'office@willowcreek.test', 'demo1234'],
  ['Teacher (Ladybugs)', 'teacher@willowcreek.test', 'demo1234'], ['Teacher (Bumblebees)', 'teacher2@willowcreek.test', 'demo1234'], ['Cook', 'cook@willowcreek.test', 'demo1234']
];

export default function Login() {
  const { user, signIn } = useAuth();
  const loc = useLocation();
  const [parent, setParent] = useState(false);
  const [health, setHealth] = useState(null);
  const [v, bind, set] = useForm({ email: '', password: '', pin: '' });
  const run = useAction();
  useEffect(() => { publicApi.get('/health').then(setHealth).catch(() => {}); }, []);
  if (user) return <Navigate to={loc.state?.from || '/'} replace />;

  const submit = () => run(async () => {
    const r = parent ? await publicApi.post('/auth/parent-login', { email: v.email, pin: v.pin }) : await publicApi.post('/auth/login', { email: v.email, password: v.password });
    await signIn(r.token);
  });

  return (
    <div className="kiosk">
      <div className="panel" style={{ maxWidth: 460 }}>
        <div className="brand" style={{ color: 'var(--ink)', padding: 0, marginBottom: 6 }}><span className="logo" aria-hidden="true"><i /><i /><i /><i /></span><b style={{ fontSize: 28 }}>Cubby</b></div>
        <p className="muted" style={{ marginBottom: 18 }}>Willow Creek Early Learning</p>
        <div className="tabs">
          <button className={`tab ${!parent ? 'on' : ''}`} onClick={() => setParent(false)}>Staff</button>
          <button className={`tab ${parent ? 'on' : ''}`} onClick={() => setParent(true)}>Parent</button>
        </div>
        <Field label="Email"><input type="email" autoFocus {...bind('email')} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
        {parent
          ? <Field label="PIN" hint="The 6-digit PIN from the front desk"><input type="password" inputMode="numeric" maxLength={6} {...bind('pin')} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>
          : <Field label="Password"><input type="password" {...bind('password')} onKeyDown={(e) => e.key === 'Enter' && submit()} /></Field>}
        <Btn onClick={submit} style={{ width: '100%' }}>Sign in</Btn>
        <p className="small muted" style={{ marginTop: 14 }}>Staff time clock and parent sign-in kiosks: <Link to="/kiosk">open the kiosk</Link></p>
        {health?.demo && (
          <div className="banner info" style={{ marginTop: 16 }}>
            <b>Demo data is loaded.</b> Click to fill in:
            <div className="row" style={{ marginTop: 8 }}>
              {DEMO.map(([n, e, p]) => <button key={e} className="chip" onClick={() => { setParent(false); set({ email: e, password: p, pin: '' }); }}>{n}</button>)}
              <button className="chip" onClick={() => { setParent(true); set({ email: 'parent@willowcreek.test', password: '', pin: '123456' }); }}>Parent (PIN 123456)</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
