import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Modal, Field, Banner, Loading, useLoad, useAction, useForm, fmtDate, fmtTime, fmtDateTime, hoursText, label } from '../ui.jsx';

const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };

function WeeklyReport() {
  const { has } = useAuth();
  const [week, setWeek] = useState('');
  const q = useLoad(() => api.get('/time/weekly-report' + (week ? `?weekStart=${week}` : '')), [week]);
  const run = useAction();
  const act = (id, what, msg) => run(async () => { await api.post(`/time/timesheets/${id}/${what}`); q.reload(); }, msg);
  return (
    <Loading q={q}>{(d) => (
      <>
        <div className="spread" style={{ marginBottom: 12 }}>
          <div className="row">
            <Btn small kind="ghost" onClick={() => setWeek(addDays(d.weekStart, -7))}>Previous week</Btn>
            <b>{fmtDate(d.weekStart)} to {fmtDate(d.weekEnd)}</b>
            <Btn small kind="ghost" onClick={() => setWeek(addDays(d.weekStart, 7))}>Next week</Btn>
          </div>
          {has('time.approve') && <Btn onClick={() => run(async () => { await api.post('/time/timesheets/build', { weekStart: d.weekStart }); q.reload(); }, 'Timesheets rebuilt from the punches')}>Build timesheets</Btn>}
        </div>
        <Panel flush>
          <Table rows={d.rows} empty="No timesheets yet for this week. Choose Build timesheets." keyOf={(r) => r.staff_id}
            cols={[
              { h: 'Staff member', render: (r) => <><b>{r.first_name} {r.last_name}</b><div className="small muted">{r.job_title}</div></> },
              { h: 'Days', render: (r) => r.days_worked, num: true },
              { h: 'Total hours (exact)', render: (r) => <span title={hoursText(r.total_seconds)}>{r.total_hours}<div className="small muted">{hoursText(r.total_seconds)}</div></span>, num: true },
              { h: 'Regular', render: (r) => r.regular_hours, num: true }, { h: 'Overtime', render: (r) => Number(r.overtime_hours) > 0 ? <b style={{ color: 'var(--warn)' }}>{r.overtime_hours}</b> : r.overtime_hours, num: true },
              { h: 'Status', render: (r) => <><StatusPill value={r.status} />{r.has_open_entry && <div className="small" style={{ color: 'var(--bad)' }}>Shift not clocked out</div>}{r.has_pending_punches && <div className="small" style={{ color: 'var(--warn)' }}>Punch waiting for review</div>}{r.pending_corrections && <div className="small muted">Correction pending</div>}</> },
              ...(has('time.approve') ? [{ h: '', render: (r) => <div className="acell">
                {r.status === 'submitted' && <Btn small onClick={() => act(r.timesheet_id, 'approve', 'Approved')}>Approve</Btn>}
                {r.status === 'approved' && <><Btn small kind="ghost" onClick={() => act(r.timesheet_id, 'lock', 'Locked for payroll')}>Lock</Btn><Btn small kind="ghost" onClick={() => act(r.timesheet_id, 'reopen', 'Reopened')}>Reopen</Btn></>}
                {r.status === 'open' && <span className="small muted">Waiting for staff to confirm</span>}</div> }] : [])
            ]} />
        </Panel>
        <p className="muted small" style={{ marginTop: 10 }}>Team total: <b>{d.totals.total.toFixed(2)}</b> hours, <b>{d.totals.overtime.toFixed(2)}</b> overtime. Hours are exact to the second. A timesheet cannot be approved while a shift is open or a punch is waiting, and never by the person it belongs to.</p>
      </>
    )}</Loading>
  );
}

function MyHours() {
  const q = useLoad(() => api.get('/time/my'));
  const run = useAction();
  return (
    <Loading q={q}>{(d) => !d.sheet ? <p className="empty">No hours yet this week.</p> : (
      <div className="stack">
        <Panel title={`Week of ${fmtDate(d.weekStart)}`} actions={d.sheet.status === 'open' && <Btn onClick={() => run(async () => { await api.post('/time/my/confirm', { weekStart: d.weekStart }); q.reload(); }, 'Hours confirmed')}>Confirm my hours</Btn>}>
          <p style={{ fontSize: 26 }}><b>{hoursText(d.sheet.total_seconds)}</b> <StatusPill value={d.sheet.status} /></p>
          {d.sheet.has_open_entry && <Banner>You are still clocked in, or a shift has no clock-out. Ask the director to correct it before you confirm.</Banner>}
          <Table rows={d.days} keyOf={(x) => x.work_date} cols={[{ h: 'Day', render: (x) => fmtDate(x.work_date) }, { h: 'In', render: (x) => fmtTime(x.first_in) }, { h: 'Out', render: (x) => fmtTime(x.last_out) }, { h: 'Worked', render: (x) => hoursText(x.worked_seconds), num: true }]} />
        </Panel>
      </div>
    )}</Loading>
  );
}

function Correction({ onClose, onDone }) {
  const staff = useLoad(() => api.get('/admin/meta'));
  const [v, bind] = useForm({ staffId: '', requestedClockIn: '', requestedClockOut: '', reason: '' });
  const run = useAction();
  return (
    <Modal title="Request a time correction" onClose={onClose}>
      <p className="muted small" style={{ marginBottom: 10 }}>The original punches stay as they were. Someone other than you approves the change.</p>
      <Field label="Staff member"><select {...bind('staffId')}><option value="">Choose</option>{(staff.data?.staff || []).map((s) => <option key={s.id} value={s.id}>{s.first_name} {s.last_name}</option>)}</select></Field>
      <div className="row2"><Field label="Clock in"><input type="datetime-local" {...bind('requestedClockIn')} /></Field><Field label="Clock out"><input type="datetime-local" {...bind('requestedClockOut')} /></Field></div>
      <Field label="Reason"><input {...bind('reason')} placeholder="Forgot to clock out" /></Field>
      <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post('/time/corrections', { ...v, requestedClockIn: new Date(v.requestedClockIn).toISOString(), requestedClockOut: v.requestedClockOut ? new Date(v.requestedClockOut).toISOString() : null }); onDone(); }, 'Sent for approval')}>Send</Btn></div>
    </Modal>
  );
}

export default function Hours() {
  const { has } = useAuth();
  const all = has('time.view_all');
  const [tab, setTab] = useState(all ? 'week' : 'mine');
  const [modal, setModal] = useState(false);
  const review = useLoad(() => (all ? api.get('/time/review-queue') : []));
  const who = useLoad(() => (all ? api.get('/time/who-is-in') : []), [tab]);
  const corr = useLoad(() => (all ? api.get('/time/corrections') : []), [tab]);
  const punct = useLoad(() => (has('punctuality.view') ? api.get('/time/punctuality') : { today: [], summary: [] }), [tab]);
  const run = useAction();

  return (
    <Page title="Staff hours" sub="Exact hours from face or PIN punches, day by day and week by week">
      <Tabs value={tab} onChange={setTab} tabs={[
        ...(all ? [{ id: 'week', label: 'Weekly report' }, { id: 'in', label: "Who's in" }, { id: 'review', label: 'Punches to review', count: (review.data || []).length }, { id: 'corr', label: 'Corrections' }, { id: 'late', label: 'On time or late' }] : []),
        { id: 'mine', label: 'My hours' }]} />
      {tab === 'week' && <WeeklyReport />}
      {tab === 'mine' && <MyHours />}
      {tab === 'in' && <Panel flush><Table rows={who.data || []} empty="Nobody is clocked in." keyOf={(r) => r.staff_id} cols={[{ h: 'Staff member', render: (r) => `${r.first_name} ${r.last_name}` }, { h: 'Since', render: (r) => fmtTime(r.clock_in_at) }, { h: 'Time on shift', render: (r) => `${Math.floor(r.minutes_on_shift / 60)}h ${r.minutes_on_shift % 60}m` }, { h: '', render: (r) => r.on_break ? <Pill tone="warn">On break</Pill> : <Pill tone="ok">Working</Pill> }]} /></Panel>}
      {tab === 'review' && (
        <Panel flush>
          <Table rows={review.data || []} empty="No punches are waiting. A punch is held when a face check is not confirmed, comes out of order, or the device clock is off." keyOf={(r) => r.punch_id}
            cols={[{ h: 'Staff member', render: (r) => `${r.first_name} ${r.last_name}` }, { h: 'Punch', render: (r) => label(r.punch_type) }, { h: 'Time', render: (r) => fmtDateTime(r.occurred_at) }, { h: 'Method', render: (r) => label(r.method) }, { h: 'Why held', render: (r) => r.flag_reason },
              ...(has('time.approve') ? [{ h: '', render: (r) => <div className="acell"><Btn small onClick={() => run(async () => { await api.post(`/time/punches/${r.punch_id}/review`, { decision: 'accept', note: 'Reviewed' }); review.reload(); }, 'Accepted. It counts from the original time.')}>Accept</Btn><Btn small kind="danger" onClick={() => run(async () => { await api.post(`/time/punches/${r.punch_id}/review`, { decision: 'reject', note: 'Rejected' }); review.reload(); }, 'Rejected')}>Reject</Btn></div> }] : [])]} />
        </Panel>
      )}
      {tab === 'corr' && (
        <>
          <div className="row" style={{ marginBottom: 12 }}><Btn onClick={() => setModal(true)}>Request a correction</Btn></div>
          <Panel flush><Table rows={corr.data || []} empty="No corrections." cols={[{ h: 'Staff member', render: (r) => `${r.first_name} ${r.last_name}` }, { h: 'Requested', render: (r) => `${fmtDateTime(r.requested_clock_in)} to ${fmtTime(r.requested_clock_out)}` }, { h: 'Reason', k: 'reason' }, { h: 'Status', render: (r) => <StatusPill value={r.status} /> },
            ...(has('time.approve') ? [{ h: '', render: (r) => r.status === 'pending' && <div className="acell"><Btn small onClick={() => run(async () => { await api.post(`/time/corrections/${r.id}/approve`); corr.reload(); }, 'Applied')}>Approve</Btn><Btn small kind="danger" onClick={() => run(async () => { await api.post(`/time/corrections/${r.id}/deny`, { note: 'Not approved' }); corr.reload(); }, 'Denied')}>Deny</Btn></div> }] : [])]} /></Panel>
          {modal && <Correction onClose={() => setModal(false)} onDone={() => { setModal(false); corr.reload(); }} />}
        </>
      )}
      {tab === 'late' && (
        <div className="split2">
          <Panel title="Today" flush><Table rows={punct.data?.today || []} empty="Everyone expected has arrived on time." cols={[{ h: 'Who', render: (r) => <><b>{r.person}</b><div className="small muted">{label(r.subject_type)}</div></> }, { h: 'Expected', render: (r) => String(r.expected_time).slice(0, 5) }, { h: 'Arrived', render: (r) => String(r.actual_time || '').slice(0, 5) }, { h: '', render: (r) => <StatusPill value={r.status} /> }]} /></Panel>
          <Panel title="Last 4 weeks" flush><Table rows={punct.data?.summary || []} empty="No late arrivals recorded." keyOf={(r) => (r.child_id || r.staff_id)} cols={[{ h: 'Who', render: (r) => r.person }, { h: 'Days late', render: (r) => r.late_days, num: true }, { h: 'No-shows', render: (r) => r.no_show_days, num: true }, { h: 'Average minutes late', render: (r) => r.avg_minutes_late ?? '', num: true }]} /></Panel>
        </div>
      )}
    </Page>
  );
}
