import React from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Banner, Loading, useLoad, useAction, fmtTime, fmtDateTime, label } from '../ui.jsx';

export default function Alerts() {
  const { has } = useAuth();
  const q = useLoad(() => api.get('/alerts?status=all'));
  const outbox = useLoad(() => (has('settings.manage') ? api.get('/dev/outbox') : []));
  const run = useAction();
  const refresh = () => { q.reload(); outbox.reload(); };
  const active = (q.data || []).filter((a) => ['open', 'parent_responded'].includes(a.status));
  const done = (q.data || []).filter((a) => !['open', 'parent_responded'].includes(a.status));

  const respond = (a, meaning) => run(async () => { await api.post(`/alerts/${a.id}/response`, { meaning }); refresh(); }, 'Recorded');
  const attemptText = (x) => `${label(x.channel)} to ${x.who || 'contact'}: ${label(x.status)}${x.response ? `, replied "${label(x.response)}"` : ''}`;

  return (
    <Page title="Missing-child alerts" sub="If a child is not signed in 30 minutes after they were expected, the family is contacted automatically, and staff are told."
      actions={has('settings.manage') && <>
        <Btn kind="ghost" onClick={() => run(async () => { const r = await api.post('/jobs/demo/start-day-late', { minutesAgo: 45 }); refresh(); return r; }, 'Demo: expected arrivals moved 45 minutes earlier')}>Demo: start the day late</Btn>
        <Btn onClick={() => run(async () => { const r = await api.post('/jobs/run'); refresh(); return r; }, 'Checks ran')}>Run checks now</Btn></>}>
      <Banner tone="info">The contact plan: text the primary parent, then call them 10 minutes later, then other parents 10 minutes after that, then staff are given the emergency contacts to call themselves, and the director is told. Parents without consent for texts or calls are skipped and staff are told. Emergency contacts are never called automatically.</Banner>
      <div style={{ height: 16 }} />
      <Panel title={`Open alerts (${active.length})`} flush>
        <Loading q={q}>{() => <Table rows={active} empty="No children are missing right now."
          cols={[
            { h: 'Child', render: (a) => <><b>{a.first_name} {a.last_name}</b><div className="small muted">Expected {String(a.expected_arrival || '').slice(0, 5)}</div></> },
            { h: 'Status', render: (a) => <StatusPill value={a.status} /> },
            { h: 'What has happened', render: (a) => <div className="small">{(a.attempts || []).length === 0 && <span className="muted">Waiting for the first step</span>}{(a.attempts || []).map((x, i) => <div key={i}>{attemptText(x)}</div>)}</div> },
            { h: 'Record a reply', render: (a) => <div className="row"><Btn small kind="ghost" onClick={() => respond(a, 'arriving_late')}>On the way</Btn><Btn small kind="ghost" onClick={() => respond(a, 'absent_today')}>Staying home</Btn><Btn small kind="ghost" onClick={() => respond(a, 'call_me')}>Wants a call</Btn>
              <Btn small kind="danger" onClick={() => run(async () => { await api.post(`/alerts/${a.id}/resolve`, { note: 'Resolved by staff' }); refresh(); }, 'Closed')}>Close</Btn></div> }
          ]} />}</Loading>
      </Panel>
      <div style={{ height: 18 }} />
      <div className="split2">
        <Panel title="Recently closed" flush>
          <Table rows={done.slice(0, 15)} empty="Nothing closed yet." cols={[
            { h: 'Child', render: (a) => `${a.first_name} ${a.last_name}` }, { h: 'Result', render: (a) => <StatusPill value={a.status} /> }, { h: 'When', render: (a) => fmtDateTime(a.resolved_at || a.opened_at) }]} />
        </Panel>
        {has('settings.manage') && (
          <Panel title="Messages sent (demo outbox)" flush>
            <p className="small muted" style={{ padding: '0 20px' }}>In this demo, texts and calls are recorded here instead of being sent. Connect a provider to send real ones.</p>
            <Table rows={(outbox.data || []).slice(0, 12)} empty="No messages yet." keyOf={(m) => m.id} cols={[
              { h: 'Type', render: (m) => <Pill tone="info">{m.kind === 'call' ? 'Call' : 'Text'}</Pill> }, { h: 'To', render: (m) => m.to }, { h: 'Message', render: (m) => <span className="small">{m.body}</span> }, { h: 'At', render: (m) => fmtTime(m.at) }]} />
          </Panel>
        )}
      </div>
    </Page>
  );
}
