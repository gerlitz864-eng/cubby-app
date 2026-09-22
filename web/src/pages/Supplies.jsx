import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Banner, Loading, useLoad, useAction, fmtDateTime, label } from '../ui.jsx';

// Teachers tap an item once for "running low" and again for "out". The family and the front office are told at once.
function QuickTap() {
  const q = useLoad(() => api.get('/supplies/room'));
  const run = useAction();
  const tap = (child, item) => run(async () => {
    const level = item.flag_id && item.level === 'low' ? 'out' : 'low';
    await api.post('/supplies/flag', { childId: child.child_id, itemTypeId: item.item_type_id, level });
    q.reload();
  }, 'Family and office notified');
  const undo = (item) => run(async () => { await api.post(`/supplies/flags/${item.flag_id}/undo`); q.reload(); }, 'Undone');
  return (
    <Loading q={q}>{(kids) => (
      <div className="stack">
        <Banner tone="info">Tap an item once when a child is running low. Tap it again when it is all gone. Each child's family and the front office are told right away. Items that do not suit a child's age do not appear.</Banner>
        {kids.length === 0 && <p className="empty">No children with items to track in your room today.</p>}
        {kids.map((c) => (
          <Panel key={c.child_id} title={c.first_name + ' ' + c.last_name}>
            <div className="tilegrid">
              {c.items.map((i) => (
                <div key={i.item_type_id}>
                  <button className={`tile ${i.flag_id ? (i.level === 'out' ? 'bad' : 'warn') : ''}`} style={{ width: '100%' }} onClick={() => tap(c, i)} aria-label={`${i.label} for ${c.first_name}`}>
                    <b>{i.label}</b>
                    <div className="small">{i.flag_id ? (i.level === 'out' ? 'Out. Tap to keep' : 'Running low. Tap for out') : 'Tap if running low'}</div>
                    {i.details && <div className="small muted">{i.details}</div>}
                    {i.parent_response && <div className="small">Parent: {label(i.parent_response)}</div>}
                  </button>
                  {i.flag_id && <button className="linkbtn" style={{ color: 'var(--muted)' }} onClick={() => undo(i)}>Undo</button>}
                </div>))}
            </div>
          </Panel>))}
      </div>
    )}</Loading>
  );
}

function OfficeQueue() {
  const q = useLoad(() => api.get('/supplies/queue'));
  const run = useAction();
  const act = (id, what, body, msg) => run(async () => { await api.post(`/supplies/flags/${id}/${what}`, body); q.reload(); }, msg);
  return (
    <Panel flush>
      <Loading q={q}>{(rows) => <Table rows={rows} empty="No child is waiting on supplies." keyOf={(r) => r.flag_id}
        rowClass={(r) => r.ack_overdue ? 'sel' : ''}
        cols={[
          { h: 'Child', render: (r) => <><b>{r.first_name} {r.last_name}</b><div className="small muted">{r.classroom}{r.child_here_now ? ', here now' : ''}</div></> },
          { h: 'Item', render: (r) => <>{r.item} {r.urgency === 'urgent' && <Pill tone="bad">Urgent</Pill>}{r.allergy_check && <div className="small" style={{ color: 'var(--bad)' }}>Check allergy alerts before supplying</div>}</> },
          { h: 'Level', render: (r) => <Pill tone={r.level === 'out' ? 'bad' : 'warn'}>{label(r.level)}</Pill> },
          { h: 'Since', render: (r) => fmtDateTime(r.flagged_at) },
          { h: 'Family reply', render: (r) => r.parent_response ? label(r.parent_response) : <span className="muted">No reply yet</span> },
          { h: 'Status', render: (r) => <StatusPill value={r.status} /> },
          { h: '', render: (r) => <div className="acell">{r.status === 'open' && <Btn small kind="ghost" onClick={() => act(r.flag_id, 'ack', {}, 'Acknowledged')}>Seen</Btn>}
            <Btn small onClick={() => act(r.flag_id, 'resolve', { resolution: 'parent_delivered' }, 'Closed')}>Received</Btn>
            <Btn small kind="ghost" onClick={() => act(r.flag_id, 'resolve', { resolution: 'center_supplied' }, 'Supplied from our stock')}>We supplied it</Btn></div> }]} />}</Loading>
    </Panel>
  );
}

export default function Supplies() {
  const { has } = useAuth();
  const [tab, setTab] = useState(has('supplies.flag') ? 'tap' : 'queue');
  return (
    <Page title="Child supplies" sub="Diapers, wipes, bottles, formula, baby food, and blankets that families send for their own child">
      <Tabs value={tab} onChange={setTab} tabs={[...(has('supplies.flag') ? [{ id: 'tap', label: 'Quick tap' }] : []), ...(has('supplies.review') ? [{ id: 'queue', label: 'Office queue' }] : [])]} />
      {tab === 'tap' ? <QuickTap /> : <OfficeQueue />}
    </Page>
  );
}
