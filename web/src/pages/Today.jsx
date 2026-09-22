import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Pill, Loading, useLoad, fmtTime, label } from '../ui.jsx';

const stateTone = { ok: 'ok', limit: 'warn', over: 'bad', idle: 'mute' };
const stateText = { ok: 'Ratio OK', limit: 'At limit', over: 'Over ratio', idle: 'No children yet' };

function RoomBoard({ r }) {
  const seats = Math.max(r.capacity, r.children_in);
  const cells = [];
  for (let i = 0; i < Math.min(seats, 30); i++) cells.push(i < r.children_in ? (i < r.capacity ? 'on' : 'ov') : '');
  return (
    <article className="panel room" style={{ '--rc': r.color_hex }}>
      <div className="rh"><div><h3>{r.name}</h3><p className="muted small">Up to {r.ratio} children per staff member</p></div><Pill tone={stateTone[r.state]}>{stateText[r.state]}</Pill></div>
      <div className="rnum"><span className="big">{r.staff_in ? (r.children_in / r.staff_in).toFixed(1).replace('.0', '') : r.children_in ? '—' : '0'}</span><span className="muted small">children per staff now, with {r.staff_in} staff and {r.children_in} children</span></div>
      <div className="seats" aria-hidden="true">{cells.map((c, i) => <i key={i} className={`seat ${c}`} />)}</div>
    </article>
  );
}

export default function Today() {
  const { has } = useAuth();
  const ratios = useLoad(() => api.get('/attendance/ratios'));
  const board = useLoad(() => api.get('/attendance/today'));
  const alerts = useLoad(() => (has('attendance.record') ? api.get('/alerts') : []));
  const late = useLoad(() => (has('punctuality.view') ? api.get('/time/punctuality') : { today: [] }));
  const supply = useLoad(() => (has('supplies.review') ? api.get('/supplies/queue') : []));
  const review = useLoad(() => (has('time.view_all') ? api.get('/time/review-queue') : []));
  const compliance = useLoad(() => (has('food_products.manage', 'meals.claims') ? api.get('/compliance/summary') : { expiring: [], missingDocs: [] }));

  const kids = board.data || [];
  const count = { in: 0, out: 0, absent: 0, wait: 0 };
  kids.forEach((k) => { if (k.checked_out_at) count.out++; else if (k.attendance_status === 'present') count.in++; else if (k.attendance_status === 'absent') count.absent++; else count.wait++; });
  const items = [];
  (alerts.data || []).forEach((a) => items.push({ tone: 'bad', to: '/alerts', title: `${a.first_name} has not arrived`, sub: `Step ${a.current_step} of the family contact plan` }));
  (supply.data || []).filter((s) => s.urgency === 'urgent' && s.level === 'out').forEach((s) => items.push({ tone: 'bad', to: '/supplies', title: `${s.first_name} is out of ${s.item.toLowerCase()}`, sub: s.child_here_now ? 'Child is here now' : 'Not in the building' }));
  (review.data || []).forEach((p) => items.push({ tone: 'warn', to: '/hours', title: `${p.first_name}'s punch needs review`, sub: p.flag_reason }));
  (late.data?.today || []).filter((x) => x.subject_type === 'staff').forEach((x) => items.push({ tone: 'warn', to: '/hours', title: `${x.person} ${x.status === 'no_show' ? 'has not clocked in' : `is ${x.minutes_late} minutes late`}`, sub: 'Staff punctuality' }));
  (compliance.data?.expiring || []).forEach((c) => items.push({ tone: c.days_left < 0 ? 'bad' : 'warn', to: '/food', title: `${c.title} ${c.days_left < 0 ? 'has expired' : `expires in ${c.days_left} days`}`, sub: 'Vendor certificate' }));

  return (
    <Page title="Today" sub={new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}>
      <section className="panel daystrip" style={{ marginBottom: 20 }}>
        <div className="dsnum"><b>{count.in}</b>children in the building<span className="muted"> of {kids.length} on the roster</span></div>
        <div className="sbar" role="img" aria-label="Attendance today">
          {[['in', count.in], ['out', count.out], ['absent', count.absent], ['wait', count.wait]].map(([k, n]) => n ? <span key={k} className={`seg ${k}`} style={{ flex: n }} /> : null)}
        </div>
        <ul className="legend">
          <li><i style={{ background: 'var(--ok)' }} />{count.in} in</li><li><i style={{ background: 'var(--info)' }} />{count.out} picked up</li>
          <li><i style={{ background: 'var(--warn)' }} />{count.absent} absent</li><li><i style={{ background: 'var(--line-strong)' }} />{count.wait} not yet arrived</li>
        </ul>
      </section>
      <div className="today">
        <Loading q={ratios}>{(rooms) => <div className="rooms">{rooms.map((r) => <RoomBoard key={r.id} r={r} />)}</div>}</Loading>
        <aside className="side">
          <Panel title="Needs attention">
            {items.length === 0 && <p className="empty">Nothing needs attention right now.</p>}
            {items.slice(0, 12).map((i, n) => (
              <Link key={n} to={i.to} className={`att ${i.tone}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <span className="ai">!</span><span><b>{i.title}</b><span className="d">{i.sub}</span></span>
              </Link>
            ))}
          </Panel>
          <Panel title="Late or missing today">
            {(late.data?.today || []).length === 0 && <p className="empty">Everyone expected has arrived on time so far.</p>}
            {(late.data?.today || []).map((x, i) => (
              <div key={i} className="ctc"><div><b>{x.person}</b><small>{label(x.subject_type)}, expected {String(x.expected_time).slice(0, 5)}{x.actual_time ? `, arrived ${String(x.actual_time).slice(0, 5)}` : ''}</small></div><Pill tone={x.status === 'no_show' ? 'bad' : 'warn'}>{label(x.status)}</Pill></div>
            ))}
          </Panel>
        </aside>
      </div>
    </Page>
  );
}
