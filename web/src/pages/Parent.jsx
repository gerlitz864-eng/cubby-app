import React from 'react';
import { api } from '../api.js';
import { Page, Panel, Btn, Pill, Table, Banner, Loading, useLoad, useAction, fmtDate, fmtTime, fmtDateTime, label } from '../ui.jsx';
import { useAuth } from '../auth.jsx';

// Parents see only their own child's sign-in and sign-out, notices from the center, and (if the center allows) the daily report.
export default function Parent() {
  const { has } = useAuth();
  const kids = useLoad(() => api.get('/parent/children'));
  const sio = useLoad(() => api.get('/parent/sign-in-out'));
  const notes = useLoad(() => api.get('/notifications'));
  const rep = useLoad(() => api.get('/parent/daily-report'));
  const run = useAction();
  const reply = (flagId, response) => run(async () => { await api.post('/parent/supply-response', { flagId, response }); notes.reload(); }, 'Thank you. The school has your reply.');
  return (
    <Page title="My child" sub={(kids.data || []).map((k) => k.first_name).join(' and ')}>
      <div className="stack">
        <Panel title="Sign in and sign out" flush>
          <Loading q={sio}>{(rows) => <Table rows={rows} empty="No sign-ins yet." keyOf={(r) => r.child_id + r.service_date} cols={[{ h: 'Day', render: (r) => fmtDate(r.service_date) }, { h: 'Child', k: 'child_first_name' }, { h: 'Signed in', render: (r) => <>{fmtTime(r.checked_in_at)} <span className="muted small">{r.dropped_off_by}</span></> }, { h: 'Signed out', render: (r) => r.checked_out_at ? <>{fmtTime(r.checked_out_at)} <span className="muted small">by {r.picked_up_by}</span></> : <span className="muted">Still here</span> }]} />}</Loading>
        </Panel>
        <Panel title="Notices from the school">
          <Loading q={notes}>{(d) => d.items.length === 0 ? <p className="empty">No notices.</p> : d.items.slice(0, 15).map((n) => (
            <div key={n.id} className="note"><b>{n.title}</b><div className="muted small">{n.body}</div><div className="faint small">{fmtDateTime(n.created_at)}</div>
              {n.kind === 'supply_flag' && n.source_id && <div className="row" style={{ marginTop: 6 }}>{[['bringing_today', 'Bringing today'], ['bringing_tomorrow', 'Bringing tomorrow'], ['please_supply', 'Please supply it'], ['already_sent', 'Already sent']].map(([v, t]) => <Btn key={v} small kind="ghost" onClick={() => reply(n.source_id, v)}>{t}</Btn>)}</div>}</div>))}</Loading>
        </Panel>
        <Panel title="Today's report">
          <Loading q={rep}>{(d) => !d.enabled ? <Banner tone="info">The daily report is not turned on for families at this center.</Banner> : d.lines.length === 0 ? <p className="empty">No report has been published yet.</p> : <Table rows={d.lines} keyOf={(r) => r.occurred_at + r.title} cols={[{ h: 'Time', render: (r) => fmtTime(r.occurred_at) }, { h: '', k: 'title' }, { h: 'Details', render: (r) => `${r.detail || ''}${r.amount_eaten ? `, ate ${r.amount_eaten}` : ''}` }]} />}</Loading>
        </Panel>
      </div>
    </Page>
  );
}
