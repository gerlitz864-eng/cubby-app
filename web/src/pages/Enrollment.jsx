import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Modal, Field, Banner, Loading, useLoad, useAction, useForm, fmtDate, fmtDateTime, ageText, label } from '../ui.jsx';

// The same allowed moves the database enforces, so the screen only offers valid buttons.
const NEXT = {
  inquiry: ['tour_scheduled', 'applied', 'waitlisted', 'lost_contact', 'family_declined'], tour_scheduled: ['toured', 'inquiry', 'family_declined'], toured: ['applied', 'waitlisted', 'family_declined'],
  applied: ['waitlisted', 'offered', 'center_declined', 'family_declined'], waitlisted: ['offered', 'family_declined', 'center_declined', 'lost_contact'], offered: ['accepted', 'family_declined', 'offer_expired', 'waitlisted'],
  accepted: ['ready_to_start', 'family_declined'], ready_to_start: ['family_declined'], offer_expired: ['waitlisted', 'offered'], lost_contact: ['inquiry'], family_declined: ['inquiry'], center_declined: ['inquiry']
};

function NewInquiry({ onClose, onDone }) {
  const [v, bind, , check] = useForm({ firstName: '', lastName: '', phone: '', email: '', channel: 'phone', childFirst: '', dob: '', due: '', start: '', consentSms: false, consentCalls: false });
  const run = useAction();
  const save = () => run(async () => {
    await api.post('/enrollment/inquiries', { channel: v.channel, guardian: { firstName: v.firstName, lastName: v.lastName, phone: v.phone, email: v.email, consentSms: v.consentSms, consentCalls: v.consentCalls },
      children: [{ firstName: v.childFirst, dateOfBirth: v.dob || null, dueDate: v.due || null, desiredStartDate: v.start || null }] });
    onDone();
  }, 'Inquiry added');
  return (
    <Modal title="New inquiry" onClose={onClose} wide>
      <div className="row2"><Field label="Parent first name"><input {...bind('firstName')} /></Field><Field label="Parent last name"><input {...bind('lastName')} /></Field></div>
      <div className="row3"><Field label="Phone"><input {...bind('phone')} /></Field><Field label="Email"><input {...bind('email')} /></Field><Field label="How they reached us"><select {...bind('channel')}>{['phone', 'web_form', 'walk_in', 'referral', 'email', 'event'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field></div>
      <div className="row3"><Field label="Child's first name"><input {...bind('childFirst')} /></Field><Field label="Date of birth"><input type="date" {...bind('dob')} /></Field><Field label="or due date"><input type="date" {...bind('due')} /></Field></div>
      <Field label="Wanted start date"><input type="date" {...bind('start')} /></Field>
      <label className="chk"><input type="checkbox" {...check('consentSms')} /> They agreed to receive texts</label>
      <label className="chk"><input type="checkbox" {...check('consentCalls')} /> They agreed to receive automated calls</label>
      <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={save}>Add inquiry</Btn></div>
    </Modal>
  );
}

function AppDetail({ id, rooms, onClose, onChange }) {
  const q = useLoad(() => api.get(`/enrollment/applications/${id}`));
  const [offer, setOffer] = useState({ classroomId: '', startDate: '' });
  const [showOffer, setShowOffer] = useState(false);
  const run = useAction();
  const move = (stage, extra = {}) => run(async () => { await api.post(`/enrollment/applications/${id}/stage`, { stage, ...extra }); q.reload(); onChange(); }, `Moved to ${label(stage)}`);
  return (
    <Modal title={q.data ? `${q.data.application.child_first_name} ${q.data.application.child_last_name}` : 'Application'} onClose={onClose} wide>
      <Loading q={q}>{({ application: a, guardians, checklist, events, tours }) => (
        <div className="stack">
          <div className="row"><StatusPill value={a.stage} /><span className="muted small">Born {a.date_of_birth ? `${fmtDate(a.date_of_birth)} (${ageText(a.date_of_birth)})` : `due ${fmtDate(a.expected_due_date)}`}. Wants to start {fmtDate(a.desired_start_date) || 'no date given'}.</span></div>
          {guardians.map((g) => <div key={g.id} className="small"><b>{g.first_name} {g.last_name}</b> {g.phone} {g.email}. {g.consent_sms ? 'Texts OK. ' : 'No text consent. '}{g.consent_calls ? 'Calls OK.' : 'No call consent.'}</div>)}
          {tours.map((t) => <div key={t.id} className="small">Tour: {fmtDateTime(t.scheduled_at)} ({label(t.status)})</div>)}
          {a.offered_classroom_id && <Banner tone="info">Offer: {rooms.find((r) => r.id === a.offered_classroom_id)?.name}, starting {fmtDate(a.offered_start_date)}{a.offer_expires_at ? `. Offer open until ${fmtDate(a.offer_expires_at)}.` : ''}</Banner>}
          <div>
            <h4 style={{ marginBottom: 8 }}>Move to</h4>
            <div className="row">
              {(NEXT[a.stage] || []).map((s) => s === 'offered' ? <Btn key={s} small onClick={() => setShowOffer(true)}>Make an offer</Btn> : <Btn key={s} small kind={['family_declined', 'center_declined', 'lost_contact', 'offer_expired'].includes(s) ? 'danger' : undefined} onClick={() => move(s, ['family_declined', 'center_declined'].includes(s) ? { reason: prompt('Reason (optional)') || undefined } : {})}>{label(s)}</Btn>)}
              {a.stage === 'ready_to_start' && <Btn small onClick={() => run(async () => { const r = await api.post(`/enrollment/applications/${id}/convert`); q.reload(); onChange(); return r; }, 'Enrolled. The child, guardians, room, and start date are set up.')}>Enroll now</Btn>}
              {a.stage === 'inquiry' && <Btn small kind="ghost" onClick={() => run(async () => { await api.post(`/enrollment/applications/${id}/tour`, { scheduledAt: new Date(Date.now() + 3 * 864e5).toISOString() }); q.reload(); onChange(); }, 'Tour scheduled in 3 days')}>Schedule a tour</Btn>}
            </div>
            {showOffer && (
              <div className="panel" style={{ marginTop: 10 }}>
                <div className="row2"><Field label="Classroom"><select value={offer.classroomId} onChange={(e) => setOffer({ ...offer, classroomId: e.target.value })}><option value="">Choose</option>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
                  <Field label="Start date"><input type="date" value={offer.startDate} onChange={(e) => setOffer({ ...offer, startDate: e.target.value })} /></Field></div>
                <Btn onClick={() => move('offered', { offer })}>Send offer</Btn>
              </div>)}
          </div>
          {checklist.length > 0 && (
            <div>
              <h4 style={{ marginBottom: 8 }}>Paperwork before the first day</h4>
              <Table rows={checklist} cols={[{ h: 'Item', render: (c) => <>{c.label}{!c.is_required && <span className="muted small"> (optional)</span>}</> }, { h: 'Due', render: (c) => fmtDate(c.due_date) }, { h: 'Status', render: (c) => <StatusPill value={c.status} /> },
                { h: '', render: (c) => <div className="acell">{c.status !== 'verified' && <Btn small onClick={() => run(async () => { await api.post(`/enrollment/checklist/${c.id}`, { status: 'verified' }); q.reload(); onChange(); })}>Verified</Btn>}{c.status === 'pending' && !c.is_required === false && <Btn small kind="ghost" onClick={() => { const r = prompt('Why is this waived?'); if (r) run(async () => { await api.post(`/enrollment/checklist/${c.id}`, { status: 'waived', waivedReason: r }); q.reload(); onChange(); }); }}>Waive</Btn>}</div> }]} />
            </div>)}
          <div><h4 style={{ marginBottom: 8 }}>History</h4>{events.map((e, i) => <div key={i} className="small muted">{fmtDateTime(e.occurred_at)}: {e.to_stage ? `${label(e.from_stage)} to ${label(e.to_stage)}` : label(e.event)} {e.note || ''}</div>)}</div>
        </div>
      )}</Loading>
    </Modal>
  );
}

function StatusChange({ e, onClose, onDone }) {
  const [v, bind] = useForm({ status: 'on_leave', lastDay: '', returnOn: '', reason: 'moved' });
  const run = useAction();
  return (
    <Modal title={`${e.first_name} ${e.last_name}`} onClose={onClose}>
      <Field label="Change to"><select {...bind('status')}><option value="on_leave">On leave</option><option value="notice_given">Notice given (last day)</option><option value="withdrawn">Withdrawn now</option>{['on_leave', 'notice_given'].includes(e.status) && <option value="active">Back to active</option>}</select></Field>
      {v.status === 'on_leave' && <Field label="Planned return"><input type="date" {...bind('returnOn')} /></Field>}
      {['notice_given', 'withdrawn'].includes(v.status) && <><Field label="Last day"><input type="date" {...bind('lastDay')} /></Field><Field label="Reason"><select {...bind('reason')}>{['moved', 'aged_out', 'cost', 'schedule_change', 'child_care_arrangement', 'starting_school', 'program_ended', 'other'].map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field></>}
      <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post(`/enrollment/enrollments/${e.id}/status`, v); onDone(); }, 'Updated')}>Save</Btn></div>
    </Modal>
  );
}

export default function Enrollment() {
  const { has } = useAuth();
  const [tab, setTab] = useState('pipeline');
  const [detail, setDetail] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const [change, setChange] = useState(null);
  const board = useLoad(() => api.get('/enrollment/board'));
  const meta = useLoad(() => api.get('/admin/meta'));
  const enr = useLoad(() => api.get('/enrollment/enrollments'), [tab]);
  const wait = useLoad(() => api.get('/enrollment/waitlist'), [tab]);
  const cap = useLoad(() => api.get('/enrollment/capacity'), [tab]);
  const cand = useLoad(() => api.get('/enrollment/offer-candidates'), [tab]);
  const ages = useLoad(() => api.get('/enrollment/age-ups'), [tab]);
  const run = useAction();
  const rooms = meta.data?.classrooms || [];
  const manage = has('enrollment.manage');

  const months = [...new Set((cap.data || []).map((c) => String(c.month_start).slice(0, 7)))].sort();
  const capRooms = [...new Set((cap.data || []).map((c) => c.classroom))];

  return (
    <Page title="Enrollment" sub="Children who are enrolled now, and families on their way" actions={manage && <Btn onClick={() => setNewOpen(true)}>New inquiry</Btn>}>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'pipeline', label: 'Future: pipeline' }, { id: 'waitlist', label: 'Waitlist and openings' }, { id: 'current', label: 'Current: enrolled children' }, { id: 'ageups', label: 'Room changes', count: (ages.data || []).length }]} />
      {tab === 'pipeline' && (
        <Loading q={board}>{(b) => (
          <div className="cols">
            {['inquiry', 'tour_scheduled', 'toured', 'applied', 'waitlisted', 'offered', 'accepted', 'ready_to_start'].map((s) => {
              const cards = b.applications.filter((a) => a.stage === s);
              return (
                <div key={s} className="col"><h4>{label(s)}<Pill>{cards.length}</Pill></h4>
                  {cards.map((a) => (
                    <button key={a.id} className="card" onClick={() => setDetail(a.id)}>
                      <b>{a.child_first_name} {a.child_last_name}</b>
                      <div className="small muted">{a.date_of_birth ? ageText(a.date_of_birth) : `due ${fmtDate(a.expected_due_date)}`}, wants {fmtDate(a.desired_start_date) || 'any date'}</div>
                      <div className="small muted">{a.contact}</div>
                      {a.checklist_total > 0 && <div className="small">Paperwork {a.checklist_done} of {a.checklist_total}</div>}
                    </button>))}
                </div>);
            })}
          </div>)}</Loading>
      )}
      {tab === 'waitlist' && (
        <div className="stack">
          <Panel title="Openings by room" flush>
            <div className="tw"><table><thead><tr><th>Room</th>{months.map((m) => <th key={m} className="num">{new Date(m + '-01T12:00:00').toLocaleDateString(undefined, { month: 'short', year: '2-digit' })}</th>)}</tr></thead>
              <tbody>{capRooms.map((r) => <tr key={r}><td><b>{r}</b></td>{months.map((m) => { const c = cap.data.find((x) => x.classroom === r && String(x.month_start).slice(0, 7) === m); return <td key={m} className="num" style={{ color: c.open_spots <= 0 ? 'var(--bad)' : c.open_spots <= 2 ? 'var(--warn)' : 'var(--ok)' }}><b>{c.open_spots}</b><div className="small muted">{c.enrolled}/{c.capacity}</div></td>; })}</tr>)}</tbody></table></div>
            <p className="small muted" style={{ padding: '0 20px 14px' }}>Open spots = room capacity minus children who will be there and offers in progress.</p>
          </Panel>
          <div className="split2">
            <Panel title="Waitlist" flush><Table rows={wait.data || []} empty="Nobody is on the waitlist." keyOf={(w) => w.application_id} onRow={(w) => setDetail(w.application_id)} cols={[{ h: '#', render: (w) => w.position }, { h: 'Child', render: (w) => `${w.child_first_name} ${w.child_last_name}` }, { h: 'Fits', render: (w) => w.classroom || 'No room fits' }, { h: 'Joined', render: (w) => fmtDate(w.waitlist_joined_at) }, { h: 'Priority', render: (w) => w.priority_points }]} /></Panel>
            <Panel title="Next in line for an opening" flush><Table rows={cand.data || []} empty="No openings match anyone on the waitlist yet." keyOf={(w) => w.application_id} onRow={(w) => setDetail(w.application_id)} cols={[{ h: 'Child', render: (w) => `${w.child_first_name} ${w.child_last_name}` }, { h: 'Room', k: 'classroom' }, { h: 'Opening', render: (w) => fmtDate(w.month_start) }, { h: 'Spots', render: (w) => w.open_spots }]} /></Panel>
          </div>
        </div>
      )}
      {tab === 'current' && (
        <Panel flush><Table rows={(enr.data || []).filter((e) => e.status !== 'withdrawn')} empty="No enrollments." cols={[{ h: 'Child', render: (e) => `${e.first_name} ${e.last_name}` }, { h: 'Room', render: (e) => e.classroom || '—' }, { h: 'Parent', render: (e) => e.guardian_first_name ? `${e.guardian_first_name} ${e.guardian_last_name}` : '—' }, { h: 'Phone', render: (e) => e.guardian_phone || '—' }, { h: 'Email', render: (e) => e.guardian_email || '—' }, { h: 'Status', render: (e) => <StatusPill value={e.status} /> }, { h: 'Started', render: (e) => fmtDate(e.start_date) }, { h: 'Last day', render: (e) => fmtDate(e.scheduled_end_date || e.end_date) }, ...(manage ? [{ h: '', render: (e) => e.status !== 'scheduled' && <Btn small kind="ghost" onClick={() => setChange(e)}>Leave, notice, or withdraw</Btn> }] : [])]} /></Panel>
      )}
      {tab === 'ageups' && (
        <>
          <Banner tone="info">Children who will outgrow their room by the first of next month. A person confirms each move. Nothing moves on its own.</Banner>
          <div style={{ height: 12 }} />
          <Panel flush><Table rows={ages.data || []} empty="Nobody is due to move rooms." keyOf={(a) => a.child_id} cols={[{ h: 'Child', render: (a) => `${a.first_name} ${a.last_name}` }, { h: 'From', k: 'from_classroom' }, { h: 'To', k: 'to_classroom' }, { h: 'On', render: (a) => fmtDate(a.move_date) },
            ...(manage ? [{ h: '', render: (a) => <Btn small onClick={() => run(async () => { await api.post('/enrollment/age-ups/confirm', { childId: a.child_id, toClassroomId: a.to_classroom_id, moveDate: String(a.move_date).slice(0, 10) }); ages.reload(); }, 'Confirmed. It will happen on that date.')}>Confirm move</Btn> }] : [])]} /></Panel>
        </>
      )}
      {newOpen && <NewInquiry onClose={() => setNewOpen(false)} onDone={() => { setNewOpen(false); board.reload(); }} />}
      {detail && <AppDetail id={detail} rooms={rooms} onClose={() => setDetail(null)} onChange={() => { board.reload(); wait.reload(); cap.reload(); }} />}
      {change && <StatusChange e={change} onClose={() => setChange(null)} onDone={() => { setChange(null); enr.reload(); }} />}
    </Page>
  );
}
