import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { PurchaseOrders } from './shared.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Modal, Field, Banner, Loading, useLoad, useAction, useForm, money, fmtDate, label } from '../ui.jsx';

function AddNeed({ onClose, onDone }) {
  const meta = useLoad(() => api.get('/purchasing/meta'));
  const [v, bind, set] = useForm({ catalog_item_id: '', custom_name: '', quantity: 1, price: '', category_id: '', preferred_vendor_id: '', needed_by: '', priority: 'normal', reason: '' });
  const run = useAction();
  const pick = (id) => { const c = meta.data.catalog.find((x) => x.id === id); set({ ...v, catalog_item_id: id, custom_name: '', price: c ? (c.est_unit_cents / 100).toFixed(2) : '', category_id: c?.category_id || '', preferred_vendor_id: c?.vendor_id || '' }); };
  return (
    <Modal title="Add to the master list" onClose={onClose} wide>
      <Loading q={meta}>{(m) => (
        <>
          <div className="row2">
            <Field label="From the catalog"><select value={v.catalog_item_id} onChange={(e) => pick(e.target.value)}><option value="">Not in the catalog</option>{m.catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="or type a new item"><input {...bind('custom_name')} disabled={!!v.catalog_item_id} /></Field>
          </div>
          <div className="row3"><Field label="Quantity"><input type="number" min="1" {...bind('quantity')} /></Field><Field label="Price each"><input type="number" step="0.01" {...bind('price')} /></Field><Field label="How soon"><select {...bind('priority')}><option value="normal">Normal</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></Field></div>
          <div className="row3"><Field label="Category"><select {...bind('category_id')}><option value="">None</option>{m.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Vendor"><select {...bind('preferred_vendor_id')}><option value="">Any</option>{m.vendors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><Field label="Needed by"><input type="date" {...bind('needed_by')} /></Field></div>
          <Field label="Why"><input {...bind('reason')} /></Field>
          <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn onClick={() => run(async () => { await api.post('/purchasing/needs', { catalog_item_id: v.catalog_item_id || null, custom_name: v.custom_name || null, quantity: Number(v.quantity), estimated_unit_cents: v.price ? Math.round(Number(v.price) * 100) : null, category_id: v.category_id || null, preferred_vendor_id: v.preferred_vendor_id || null, needed_by: v.needed_by || null, priority: v.priority, reason: v.reason || null }); onDone(); }, 'Added')}>Add</Btn></div>
        </>)}</Loading>
    </Modal>
  );
}

function MasterList() {
  const { has } = useAuth();
  const q = useLoad(() => api.get('/purchasing/list'));
  const [sel, setSel] = useState({});
  const [add, setAdd] = useState(false);
  const run = useAction();
  const ids = Object.keys(sel).filter((k) => sel[k]);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <Btn onClick={() => setAdd(true)}>Add an item</Btn>
        <Btn kind="ghost" disabled={!ids.length} onClick={() => run(async () => { const r = await api.post('/purchasing/submit', { needIds: ids }); setSel({}); q.reload(); return r; }, 'Sent for review')}>Submit {ids.length || ''} for approval</Btn>
      </div>
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="The list is empty. Add what the facility needs to buy." keyOf={(r) => r.need_id} cols={[
        { h: '', render: (r) => r.status === 'proposed' ? <input type="checkbox" aria-label="Select" checked={!!sel[r.need_id]} onChange={(e) => setSel({ ...sel, [r.need_id]: e.target.checked })} /> : '' },
        { h: 'Item', render: (r) => <><b>{r.item}</b><div className="small muted">{r.category || 'No category'}{r.vendor ? `, ${r.vendor}` : ''}</div></> }, { h: 'Qty', k: 'quantity', num: true }, { h: 'Estimate', render: (r) => money(r.estimated_total_cents), num: true },
        { h: 'Source', render: (r) => label(r.source) }, { h: 'Priority', render: (r) => r.priority === 'normal' ? '' : <Pill tone={r.priority === 'urgent' ? 'bad' : 'warn'}>{label(r.priority)}</Pill> },
        { h: 'Status', render: (r) => <><StatusPill value={r.status} />{r.awaiting_approval_from && <div className="small muted">Waiting for {r.awaiting_approval_from}</div>}</> }]} />}</Loading></Panel>
      {add && <AddNeed onClose={() => setAdd(false)} onDone={() => { setAdd(false); q.reload(); }} />}
    </>
  );
}

function Review() {
  const q = useLoad(() => api.get('/purchasing/review'));
  const run = useAction();
  const decide = (id, decision) => {
    const note = decision === 'approved' ? null : prompt(decision === 'denied' ? 'Reason for denying' : 'What do you need to know?');
    if (decision !== 'approved' && !note) return;
    return run(async () => { await api.post(`/purchasing/needs/${id}/decide`, { decision, note }); q.reload(); }, 'Recorded');
  };
  return (
    <>
      <Banner tone="info">Items over your center's limit need the director and the owner, two different people. Nobody can approve an item they entered themselves.</Banner>
      <div style={{ height: 12 }} />
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="Nothing is waiting for approval." keyOf={(r) => r.need_id} cols={[
        { h: 'Item', render: (r) => <><b>{r.item}</b><div className="small muted">{r.category}{r.vendor ? `, ${r.vendor}` : ''}</div></> }, { h: 'Qty', k: 'quantity', num: true }, { h: 'Estimate', render: (r) => money(r.estimated_total_cents), num: true },
        { h: 'Category budget left', render: (r) => r.category_budget_remaining_cents == null ? '' : money(r.category_budget_remaining_cents), num: true },
        { h: 'Needs', k: 'awaiting_approval_from' }, { h: 'Waiting', render: (r) => `${r.hours_waiting}h` },
        { h: '', render: (r) => <div className="acell"><Btn small onClick={() => decide(r.need_id, 'approved')}>Approve</Btn><Btn small kind="ghost" onClick={() => decide(r.need_id, 'hold')}>Ask</Btn><Btn small kind="danger" onClick={() => decide(r.need_id, 'denied')}>Deny</Btn></div> }]} />}</Loading></Panel>
    </>
  );
}

export default function Purchasing() {
  const { has } = useAuth();
  const [tab, setTab] = useState('list');
  const pipe = useLoad(() => api.get('/purchasing/pipeline'), [tab]);
  const bud = useLoad(() => api.get('/purchasing/budgets'), [tab]);
  const review = useLoad(() => (has('purchasing.approve') ? api.get('/purchasing/review') : []), [tab]);
  return (
    <Page title="Purchasing" sub="Everything the facility needs to buy, approved by the director and tracked until it arrives">
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'list', label: 'Master list' }, ...(has('purchasing.approve') ? [{ id: 'review', label: 'Director review', count: (review.data || []).length }] : []), { id: 'order', label: 'Order and receive' }, { id: 'pipe', label: 'On its way' }, { id: 'budget', label: 'Budgets' }]} />
      {tab === 'list' && <MasterList />}
      {tab === 'review' && <Review />}
      {tab === 'order' && <PurchaseOrders />}
      {tab === 'pipe' && <Panel flush><Loading q={pipe}>{(rows) => <Table rows={rows} empty="Nothing is in the purchasing stage." keyOf={(r) => r.need_id} cols={[{ h: 'Item', k: 'item' }, { h: 'Status', render: (r) => <StatusPill value={r.status} /> }, { h: 'Order', k: 'po_number' }, { h: 'Vendor', k: 'vendor' }, { h: 'Expected', render: (r) => fmtDate(r.expected_delivery) }, { h: 'Late', render: (r) => r.days_late > 0 ? <Pill tone="bad">{r.days_late} days</Pill> : '' }]} />}</Loading></Panel>}
      {tab === 'budget' && <Panel flush><Loading q={bud}>{(rows) => <Table rows={rows} empty="No budgets are set. Add category budgets to see how much is left." keyOf={(r) => r.budget_id} cols={[{ h: 'Category', k: 'category' }, { h: 'Budget', render: (r) => money(r.amount_cents), num: true }, { h: 'Committed', render: (r) => money(r.committed_cents), num: true }, { h: 'Left', render: (r) => money(r.remaining_cents), num: true }]} />}</Loading></Panel>}
    </Page>
  );
}
