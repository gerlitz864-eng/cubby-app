import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Modal, Field, Banner, Loading, useLoad, useAction, useForm, fmtDateTime, label } from '../ui.jsx';

function Users() {
  const q = useLoad(() => api.get('/admin/users'));
  const [add, setAdd] = useState(false);
  const [v, bind] = useForm({ email: '', role: 'teacher', password: '' });
  const run = useAction();
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Btn onClick={() => setAdd(true)}>Add a user</Btn></div>
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} keyOf={(u) => u.id} cols={[{ h: 'Email', k: 'email' }, { h: 'Person', k: 'staff_name' }, { h: 'Role', render: (u) => label(u.role) }, { h: 'Last sign-in', render: (u) => fmtDateTime(u.last_login_at) }, { h: 'Active', render: (u) => u.is_active ? <Pill tone="ok">Yes</Pill> : <Pill tone="bad">No</Pill> },
        { h: '', render: (u) => <Btn small kind="ghost" onClick={() => run(async () => { await api.patch(`/admin/users/${u.id}`, { isActive: !u.is_active }); q.reload(); })}>{u.is_active ? 'Turn off' : 'Turn on'}</Btn> }]} />}</Loading></Panel>
      {add && <Modal title="Add a user" onClose={() => setAdd(false)}>
        <Field label="Email"><input {...bind('email')} /></Field><Field label="Role"><select {...bind('role')}>{['director', 'front_office', 'billing', 'cook', 'teacher'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
        <Field label="Password" hint="At least 8 characters"><input type="password" {...bind('password')} /></Field>
        <div className="macts"><Btn kind="ghost" onClick={() => setAdd(false)}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post('/admin/users', v); setAdd(false); q.reload(); }, 'User added')}>Add</Btn></div></Modal>}
    </>
  );
}

function Permissions() {
  const q = useLoad(() => api.get('/admin/permissions'));
  const run = useAction();
  const roles = ['director', 'front_office', 'billing', 'cook', 'teacher', 'parent'];
  const defaultScope = (role) => role === 'teacher' ? 'own_classroom' : role === 'parent' ? 'own_children' : 'all';
  return (
    <Loading q={q}>{(d) => {
      const has = (role, code) => d.grants.find((g) => g.role === role && g.permission_code === code);
      const toggle = (role, code) => run(async () => { await api.put('/admin/permissions', { role, code, scope: has(role, code) ? null : defaultScope(role) }); q.reload(); });
      let area = '';
      return (
        <>
          <Banner tone="info">Who can see and do what. The owner always has everything. Teachers see only their own room and parents only their own child, whatever is ticked here. The database enforces those limits.</Banner>
          <div style={{ height: 12 }} />
          <Panel flush><div className="tw"><table className="matrix"><thead><tr><th>Permission</th>{roles.map((r) => <th key={r}>{label(r)}</th>)}</tr></thead>
            <tbody>{d.permissions.map((p) => {
              const head = p.area !== area ? <tr key={'h' + p.area}><td colSpan={roles.length + 1} style={{ background: 'var(--surface-2)', fontWeight: 700 }}>{p.area}</td></tr> : null; area = p.area;
              return [head, <tr key={p.code}><td title={p.code}>{p.description}</td>{roles.map((r) => <td key={r}><input type="checkbox" aria-label={`${r} ${p.code}`} checked={!!has(r, p.code)} onChange={() => toggle(r, p.code)} />{has(r, p.code)?.scope !== 'all' && has(r, p.code) && <div className="small muted">{label(has(r, p.code).scope)}</div>}</td>)}</tr>];
            })}</tbody></table></div></Panel>
        </>);
    }}</Loading>
  );
}

function Pins() {
  const q = useLoad(() => api.get('/admin/pins'));
  const [set, setSet] = useState(null);
  const [pin, setPin] = useState('');
  const [purpose, setPurpose] = useState('kiosk');
  const run = useAction();
  return (
    <>
      <Banner tone="info">Every parent and pick-up person has a 6-digit PIN for the kiosk and the parent portal. Five wrong tries lock it for 15 minutes and the director is told. Without a PIN, nobody can sign a child out.</Banner>
      <div style={{ height: 12 }} />
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} keyOf={(r) => r.guardian_id} cols={[{ h: 'Parent', k: 'person' }, { h: 'Phone', k: 'phone' }, { h: 'PINs', render: (r) => (r.pins || []).map((p) => <span key={p.id} style={{ marginRight: 8 }}><Pill tone={p.locked ? 'bad' : 'ok'}>{label(p.purpose)}{p.locked ? ' (locked)' : ''}</Pill>{p.locked && <Btn small kind="ghost" onClick={() => run(async () => { await api.post(`/admin/pins/${p.id}/unlock`); q.reload(); }, 'Unlocked')}>Unlock</Btn>}</span>) },
        { h: '', render: (r) => <Btn small kind="ghost" onClick={() => setSet(r)}>Set a new PIN</Btn> }]} />}</Loading></Panel>
      {set && <Modal title={`New PIN for ${set.person}`} onClose={() => setSet(null)}>
        <Field label="Used for"><select value={purpose} onChange={(e) => setPurpose(e.target.value)}><option value="kiosk">Kiosk sign-in and sign-out</option><option value="portal">Parent portal</option></select></Field>
        <Field label="6-digit PIN" hint="Not a repeat or a simple sequence. Give it to the parent in person."><input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value)} /></Field>
        <div className="macts"><Btn kind="ghost" onClick={() => setSet(null)}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post('/admin/pins', { guardianId: set.guardian_id, purpose, pin }); setSet(null); setPin(''); q.reload(); }, 'PIN saved')}>Save</Btn></div></Modal>}
    </>
  );
}

function StaffFace() {
  const q = useLoad(() => api.get('/admin/staff'));
  const run = useAction();
  const post = (id, path, body, msg) => run(async () => { await api.post(`/admin/staff/${id}/${path}`, body); q.reload(); }, msg);
  return (
    <>
      <Banner>Face verification is optional. A staff member must give written consent first, and a PIN is always available. Withdrawing consent switches face off at once and deletes the template. In this demo, the face check is a stand-in and identifies nobody.</Banner>
      <div style={{ height: 12 }} />
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} keyOf={(s) => s.id} cols={[{ h: 'Staff member', render: (s) => <><b>{s.first_name} {s.last_name}</b><div className="small muted">{s.job_title}</div></> }, { h: 'Face consent', render: (s) => s.consent === 'granted' ? <Pill tone="ok">Granted</Pill> : s.consent === 'withdrawn' ? <Pill tone="warn">Withdrawn</Pill> : <Pill>None</Pill> },
        { h: 'Face set up', render: (s) => s.has_template ? <Pill tone="ok">Yes</Pill> : <Pill>No</Pill> }, { h: 'PIN', render: (s) => s.has_pin ? <Pill tone="ok">Yes</Pill> : <Pill tone="warn">No</Pill> }, { h: 'Overtime', render: (s) => s.overtime_eligible ? 'Eligible' : 'Exempt' },
        { h: '', render: (s) => <div className="acell" style={{ flexWrap: 'wrap' }}>
          {s.consent !== 'granted' && <Btn small kind="ghost" onClick={() => post(s.id, 'biometric/consent', { status: 'granted', method: 'signed_form' }, 'Consent recorded')}>Record consent</Btn>}
          {s.consent === 'granted' && !s.has_template && <Btn small onClick={() => post(s.id, 'biometric/enroll', { imageBase64: 'demo' }, 'Face set up (demo)')}>Set up face</Btn>}
          {s.consent === 'granted' && <Btn small kind="danger" onClick={() => post(s.id, 'biometric/consent', { status: 'withdrawn' }, 'Consent withdrawn. Template removed.')}>Withdraw</Btn>}
          <Btn small kind="ghost" onClick={() => { const p = prompt('New PIN (4 to 8 digits)'); if (p) post(s.id, 'pin', { pin: p }, 'PIN saved'); }}>Set PIN</Btn></div> }]} />}</Loading></Panel>
    </>
  );
}

function Devices() {
  const q = useLoad(() => api.get('/admin/devices'));
  const [name, setName] = useState('');
  const [token, setToken] = useState(null);
  const run = useAction();
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><input placeholder="Device name, for example Front door tablet" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 360 }} /><Btn onClick={() => run(async () => { const r = await api.post('/admin/devices', { name }); setToken(r.token); setName(''); q.reload(); })}>Register a kiosk</Btn></div>
      {token && <Banner tone="info">Copy this token now. It is shown only once: <code>{token}</code>. Open <b>/kiosk</b> on the tablet and paste it.</Banner>}
      <div style={{ height: 12 }} />
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} keyOf={(d) => d.id} cols={[{ h: 'Device', k: 'name' }, { h: 'Room', k: 'classroom' }, { h: 'Last seen', render: (d) => fmtDateTime(d.last_seen_at) }, { h: 'Active', render: (d) => d.is_active ? 'Yes' : 'No' }]} />}</Loading></Panel>
    </>
  );
}

const SETTING_LABELS = {
  punctuality_policies: ['On-time rules', { child_grace_minutes: 'Minutes a child may be late and still be on time', staff_grace_minutes: 'Minutes staff may be late and still be on time', staff_late_alert_after_minutes: 'Tell the director when staff are this late (minutes)' }],
  alert_policies: ['Missing-child alerts', { grace_minutes: 'Start contacting families after this many minutes' }],
  access_policies: ['PIN rules', { max_failed_attempts: 'Wrong tries before a PIN locks', lockout_minutes: 'Minutes locked' }],
  time_policies: ['Time clock', { overtime_after_seconds: 'Overtime starts after (seconds per week)', max_face_attempts: 'Face attempts before offering the PIN' }],
  centers: ['Center', { program_start_time: 'Program starts at', offer_hold_days: 'Days an enrollment offer stays open' }]
};
function Settings() {
  const q = useLoad(() => api.get('/admin/settings'));
  const [edits, setEdits] = useState({});
  const run = useAction();
  return (
    <Loading q={q}>{(d) => (
      <div className="split2">{Object.entries(SETTING_LABELS).map(([table, [title, fields]]) => (
        <Panel key={table} title={title}>
          {Object.entries(fields).map(([k, text]) => <Field key={k} label={text}><input value={edits[table + k] ?? d[table]?.[k] ?? ''} onChange={(e) => setEdits({ ...edits, [table + k]: e.target.value })} /></Field>)}
          <Btn small onClick={() => run(async () => { const values = {}; Object.keys(fields).forEach((k) => { if (edits[table + k] !== undefined) values[k] = edits[table + k]; }); if (!Object.keys(values).length) return; await api.put('/admin/settings', { table, values }); setEdits({}); q.reload(); }, 'Saved')}>Save</Btn>
        </Panel>))}</div>)}</Loading>
  );
}

function Audit() {
  const q = useLoad(() => api.get('/admin/audit'));
  return <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="Nothing recorded yet." keyOf={(r) => r.occurred_at + r.action} cols={[{ h: 'When', render: (r) => fmtDateTime(r.occurred_at) }, { h: 'Who', k: 'by' }, { h: 'What', render: (r) => `${label(r.action)} ${r.table_name}` }, { h: 'Reason', k: 'reason' }]} />}</Loading></Panel>;
}

export default function Admin() {
  const { has } = useAuth();
  const [tab, setTab] = useState(has('users.manage') ? 'users' : 'settings');
  const tabs = [...(has('users.manage') ? [{ id: 'users', label: 'Users' }, { id: 'perms', label: 'Who can do what' }, { id: 'pins', label: 'Parent PINs' }, { id: 'staff', label: 'Staff and face check' }, { id: 'devices', label: 'Kiosks' }] : []), ...(has('settings.manage') ? [{ id: 'settings', label: 'Settings' }] : []), ...(has('audit.view') ? [{ id: 'audit', label: 'Audit log' }] : [])];
  return (
    <Page title="Admin" sub="Accounts, permissions, PINs, kiosks, and settings">
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'users' && <Users />}{tab === 'perms' && <Permissions />}{tab === 'pins' && <Pins />}{tab === 'staff' && <StaffFace />}{tab === 'devices' && <Devices />}{tab === 'settings' && <Settings />}{tab === 'audit' && <Audit />}
    </Page>
  );
}
