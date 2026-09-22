import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PurchaseOrders } from './shared.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Field, Banner, Loading, useLoad, useAction, useForm, money, fmtDate, label } from '../ui.jsx';

function Marketplace({ onSubmitted }) {
  const cat = useLoad(() => api.get('/orders/catalog'));
  const meta = useLoad(() => api.get('/admin/meta'));
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState('');
  const [room, setRoom] = useState('');
  const [v, bind, set] = useForm({ priority: 'normal', neededBy: '', note: '' });
  const [custom, setCustom, , ] = useState({ customName: '', quantity: 1, estimatedUnitCents: '', customUrl: '', reason: '', isFood: false });
  const run = useAction();
  const rooms = meta.data?.classrooms || [];
  const add = (item) => setCart((c) => { const ex = c.find((x) => x.catalogItemId === item.id); return ex ? c.map((x) => x === ex ? { ...x, quantity: x.quantity + 1 } : x) : [...c, { catalogItemId: item.id, name: item.name, quantity: 1 }]; });
  const groups = {};
  (cat.data || []).filter((i) => i.name.toLowerCase().includes(search.toLowerCase())).forEach((i) => { (groups[i.category || 'Other'] ||= []).push(i); });

  const submit = () => run(async () => {
    await api.post('/orders/requests', { classroomId: room || rooms[0]?.id, ...v, lines: cart.map((c) => c.catalogItemId ? { catalogItemId: c.catalogItemId, quantity: c.quantity } : { ...c, estimatedUnitCents: c.estimatedUnitCents ? Math.round(Number(c.estimatedUnitCents) * 100) : null }) });
    setCart([]); onSubmitted();
  }, 'Request sent to the office');

  return (
    <div className="split2" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)' }}>
      <div className="stack">
        <input placeholder="Search supplies" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search supplies" />
        <Loading q={cat}>{() => Object.entries(groups).map(([g, items]) => (
          <Panel key={g} title={g} flush><Table rows={items} cols={[{ h: 'Item', render: (i) => <><b>{i.name}</b><div className="small muted">{i.unit_label}{i.est_unit_cents ? `, about ${money(i.est_unit_cents)}` : ''}</div></> },
            { h: 'On the shelf', render: (i) => i.on_hand == null ? '' : <Pill tone={i.on_hand > 0 ? 'ok' : 'mute'}>{i.on_hand} in the closet</Pill> },
            { h: '', render: (i) => <div className="acell">{i.on_hand > 0 && <Btn small kind="ghost" onClick={() => run(async () => { await api.post('/orders/stockroom/take', { catalogItemId: i.id, quantity: 1, classroomId: room || rooms[0]?.id }); cat.reload(); }, 'Taken from the closet')}>Take 1</Btn>}<Btn small onClick={() => add(i)}>Add to request</Btn></div> }]} /></Panel>))}</Loading>
      </div>
      <div className="stack">
        <Panel title="Your request">
          {cart.length === 0 && <p className="muted">Add items from the list, or add one that is not listed below.</p>}
          {cart.map((c, i) => (
            <div key={i} className="ctc"><div><b>{c.name || c.customName}</b>{c.customName && <small>Custom item{c.isFood ? ', food' : ''}</small>}</div>
              <div className="row"><input type="number" min="1" style={{ width: 70 }} value={c.quantity} onChange={(e) => setCart(cart.map((x, j) => j === i ? { ...x, quantity: Number(e.target.value) } : x))} aria-label="Quantity" /><button className="iconbtn" aria-label="Remove" onClick={() => setCart(cart.filter((_, j) => j !== i))}>✕</button></div></div>))}
          <div style={{ height: 10 }} />
          <Field label="Room"><select value={room || rooms[0]?.id || ''} onChange={(e) => setRoom(e.target.value)}>{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <div className="row2"><Field label="How soon"><select {...bind('priority')}><option value="normal">Normal</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></Field><Field label="Needed by"><input type="date" {...bind('neededBy')} /></Field></div>
          <Field label="Note for the office"><input {...bind('note')} /></Field>
          <Btn onClick={submit} disabled={!cart.length} style={{ width: '100%' }}>Send request</Btn>
        </Panel>
        <Panel title="Not on the list?">
          <Field label="Item name"><input value={custom.customName} onChange={(e) => setCustom({ ...custom, customName: e.target.value })} /></Field>
          <div className="row2"><Field label="Quantity"><input type="number" min="1" value={custom.quantity} onChange={(e) => setCustom({ ...custom, quantity: Number(e.target.value) })} /></Field><Field label="Price each (optional)"><input type="number" step="0.01" value={custom.estimatedUnitCents} onChange={(e) => setCustom({ ...custom, estimatedUnitCents: e.target.value })} /></Field></div>
          <Field label="Link (optional)"><input value={custom.customUrl} onChange={(e) => setCustom({ ...custom, customUrl: e.target.value })} /></Field>
          <Field label="Why do you need it?"><input value={custom.reason} onChange={(e) => setCustom({ ...custom, reason: e.target.value })} /></Field>
          <label className="chk"><input type="checkbox" checked={custom.isFood} onChange={(e) => setCustom({ ...custom, isFood: e.target.checked })} /> This is food or a drink</label>
          {custom.isFood && <div className="banner small" style={{ marginBottom: 10 }}>Food is held for the kitchen and director, so its ingredients and paperwork can be checked first.</div>}
          <Btn kind="ghost" disabled={!custom.customName} onClick={() => { setCart([...cart, custom]); setCustom({ customName: '', quantity: 1, estimatedUnitCents: '', customUrl: '', reason: '', isFood: false }); }}>Add to request</Btn>
        </Panel>
      </div>
    </div>
  );
}

function MyRequests() {
  const q = useLoad(() => api.get('/orders/mine'));
  const run = useAction();
  return (
    <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="You have not made any requests yet." keyOf={(r) => r.line_id} cols={[
      { h: 'Item', render: (r) => <><b>{r.item}</b><div className="small muted">Quantity {r.quantity}</div></> }, { h: 'Status', render: (r) => <StatusPill value={r.status} /> },
      { h: 'Note from the office', render: (r) => r.decision_note || '' }, { h: 'Delivery', render: (r) => r.tracking_number ? `${r.carrier || ''} ${r.tracking_number}${r.expected_delivery ? ', expected ' + fmtDate(r.expected_delivery) : ''}` : '' },
      { h: '', render: (r) => <div className="acell">{['pending', 'on_hold'].includes(r.status) && <Btn small kind="danger" onClick={() => run(async () => { await api.post(`/orders/lines/${r.line_id}/cancel`); q.reload(); }, 'Cancelled')}>Cancel</Btn>}
        {r.status === 'received' && !r.classroom_confirmed_at && <Btn small onClick={() => run(async () => { await api.post(`/orders/lines/${r.line_id}/confirm`); q.reload(); }, 'Thanks for confirming')}>It reached my room</Btn>}</div> }]} />}</Loading></Panel>
  );
}

function ApprovalQueue() {
  const q = useLoad(() => api.get('/orders/queue'));
  const run = useAction();
  const decide = (id, decision) => {
    const note = decision === 'approved' ? null : prompt(decision === 'denied' ? 'Why is this being denied? The teacher will see this.' : 'What do you need to know?');
    if (decision !== 'approved' && !note) return;
    return run(async () => { await api.post(`/orders/lines/${id}/decide`, { decision, note }); q.reload(); }, 'Teacher notified');
  };
  return (
    <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="Nothing is waiting for review." keyOf={(r) => r.line_id} cols={[
      { h: 'Item', render: (r) => <><b>{r.item}</b> {r.is_custom && <Pill tone="info">Custom</Pill>} {r.is_food && <Pill tone="warn">Food</Pill>}<div className="small muted">{r.reason}</div></> },
      { h: 'Room', render: (r) => <>{r.classroom}<div className="small muted">{r.requested_by_name}</div></> }, { h: 'Qty', k: 'quantity', num: true }, { h: 'Estimate', render: (r) => money(r.estimated_total_cents), num: true },
      { h: 'Budget left', render: (r) => r.budget_remaining_cents == null ? '' : money(r.budget_remaining_cents), num: true }, { h: 'In closet', render: (r) => r.stockroom_on_hand ?? '' },
      { h: 'Waiting', render: (r) => `${r.hours_waiting}h` }, { h: 'Status', render: (r) => <StatusPill value={r.status} /> },
      { h: '', render: (r) => <div className="acell"><Btn small onClick={() => decide(r.line_id, 'approved')}>Approve</Btn><Btn small kind="ghost" onClick={() => decide(r.line_id, 'on_hold')}>Ask</Btn><Btn small kind="danger" onClick={() => decide(r.line_id, 'denied')}>Deny</Btn></div> }]} />}</Loading></Panel>
  );
}

export default function Orders() {
  const { has } = useAuth();
  const [tab, setTab] = useState(has('orders.request') ? 'market' : 'queue');
  const [mineKey, setMineKey] = useState(0);
  return (
    <Page title="Classroom orders" sub="Request supplies for your room and follow each request from pending to received">
      <Tabs value={tab} onChange={setTab} tabs={[...(has('orders.request') ? [{ id: 'market', label: 'Request supplies' }, { id: 'mine', label: 'My requests' }] : []), ...(has('orders.review') ? [{ id: 'queue', label: 'Approval queue' }, { id: 'pos', label: 'Purchase orders' }] : [])]} />
      {tab === 'market' && <Marketplace onSubmitted={() => { setMineKey(mineKey + 1); setTab('mine'); }} />}
      {tab === 'mine' && <MyRequests key={mineKey} />}
      {tab === 'queue' && <ApprovalQueue />}
      {tab === 'pos' && <PurchaseOrders />}
    </Page>
  );
}
