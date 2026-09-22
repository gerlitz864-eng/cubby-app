import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Modal, Field, Loading, RoomDot, useLoad, useAction, useForm, fmtTime, label } from '../ui.jsx';

function CheckOut({ child, onClose, onDone }) {
  const people = useLoad(() => api.get(`/attendance/pickup-people/${child.child_id}`));
  const [who, setWho] = useState('');
  const [idOk, setIdOk] = useState(false);
  const run = useAction();
  const submit = () => run(async () => {
    const [kind, id] = who.split(':');
    await api.post('/attendance/check-out', { childId: child.child_id, personKind: kind, personId: id, photoIdChecked: idOk });
    onDone();
  }, `${child.first_name} signed out`);
  return (
    <Modal title={`Sign out ${child.first_name}`} onClose={onClose}>
      <p className="muted" style={{ marginBottom: 12 }}>Only people on the authorized pick-up list can take {child.first_name} home.</p>
      <Loading q={people}>{(list) => (
        <>
          <Field label="Picked up by">
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose a person</option>
              {list.map((p) => <option key={p.kind + p.id} value={`${p.kind}:${p.id}`}>{p.name} ({p.relationship})</option>)}
            </select>
          </Field>
          <label className="chk"><input type="checkbox" checked={idOk} onChange={(e) => setIdOk(e.target.checked)} /> I checked this person's photo ID</label>
          <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={submit} disabled={!who || !idOk}>Sign out</Btn></div>
        </>
      )}</Loading>
    </Modal>
  );
}

function Absent({ child, onClose, onDone }) {
  const [v, bind] = useForm({ reason: 'Sick', note: '' });
  const run = useAction();
  return (
    <Modal title={`Mark ${child.first_name} absent`} onClose={onClose}>
      <Field label="Reason"><select {...bind('reason')}><option>Sick</option><option>Family trip</option><option>Appointment</option><option>Other</option></select></Field>
      <Field label="Note (optional)"><input {...bind('note')} /></Field>
      <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post('/attendance/absent', { childId: child.child_id, ...v }); onDone(); }, 'Marked absent')}>Mark absent</Btn></div>
    </Modal>
  );
}

export default function Attendance() {
  const { has, scope } = useAuth();
  const q = useLoad(() => api.get('/attendance/today'));
  const [room, setRoom] = useState('all');
  const [modal, setModal] = useState(null);
  const run = useAction();
  const canRecord = has('attendance.record');
  const rows = (q.data || []).filter((k) => room === 'all' || k.classroom === room);
  const rooms = [...new Set((q.data || []).map((k) => k.classroom))].filter(Boolean).sort();
  const order = { none: 0, present: 1, absent: 3 };
  rows.sort((a, b) => (a.checked_out_at ? 2 : order[a.attendance_status || 'none'] ?? 0) - (b.checked_out_at ? 2 : order[b.attendance_status || 'none'] ?? 0) || a.first_name.localeCompare(b.first_name));

  const status = (k) => k.checked_out_at ? <Pill tone="info">Picked up</Pill> : k.attendance_status === 'present' ? <Pill tone="ok">In</Pill> : k.attendance_status === 'absent' ? <Pill tone="warn">Absent</Pill> : <Pill>Not arrived</Pill>;
  const cols = [
    { h: 'Child', render: (k) => <><RoomDot color={k.color_hex} /><b>{k.first_name} {k.last_name}</b>{(k.alerts > 0 || k.has_alert) && <> <span className="tag bad">Alert{k.alert_names ? `: ${k.alert_names}` : ''}</span></>}{!q.data?.every((x) => !x.classroom) && room === 'all' && <div className="small muted" style={{ marginLeft: 18 }}>{k.classroom}</div>}</> },
    { h: 'Status', render: status },
    ...(scope('attendance.view') === 'all' ? [{ h: 'Expected', render: (k) => String(k.expected_arrival || '').slice(0, 5) }] : []),
    { h: 'In', render: (k) => fmtTime(k.checked_in_at) },
    { h: 'Out', render: (k) => fmtTime(k.checked_out_at) },
    ...(scope('attendance.view') === 'all' ? [{ h: 'On time?', render: (k) => k.arrival_status && k.arrival_status !== 'not_yet_due' ? <StatusPill value={k.arrival_status} /> : '' }] : []),
    ...(canRecord ? [{ h: '', render: (k) => (
      <div className="acell" onClick={(e) => e.stopPropagation()}>
        {!k.attendance_status && <><Btn small onClick={() => run(async () => { const r = await api.post('/attendance/check-in', { childId: k.child_id }); q.reload(); if (r.overRatio) throw new Error('Signed in, but this room is now over ratio.'); }, `${k.first_name} signed in`)}>Check in</Btn><Btn small kind="ghost" onClick={() => setModal({ t: 'absent', k })}>Absent</Btn></>}
        {k.attendance_status === 'present' && !k.checked_out_at && has('attendance.checkout') && <Btn small kind="ghost" onClick={() => setModal({ t: 'out', k })}>Check out</Btn>}
      </div>) }] : [])
  ];

  return (
    <Page title="Attendance" sub={scope('attendance.view') === 'own_classroom' ? 'When the children in your room come in and go out' : 'Who is here today, and who is not'}>
      <Tabs value={room} onChange={setRoom} tabs={[{ id: 'all', label: 'All rooms' }, ...rooms.map((r) => ({ id: r, label: r }))]} />
      <Panel flush><Loading q={q}>{() => <Table cols={cols} rows={rows} keyOf={(k) => k.child_id} empty="No children on the roster for this room." />}</Loading></Panel>
      {modal?.t === 'out' && <CheckOut child={modal.k} onClose={() => setModal(null)} onDone={() => { setModal(null); q.reload(); }} />}
      {modal?.t === 'absent' && <Absent child={modal.k} onClose={() => setModal(null)} onDone={() => { setModal(null); q.reload(); }} />}
    </Page>
  );
}
