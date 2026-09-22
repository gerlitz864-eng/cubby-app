import React, { useState } from 'react';
import { api } from '../api.js';
import { Btn, Field, Panel, StatusPill, Table, Modal, Loading, useLoad, useAction, fmtDate, money, label } from '../ui.jsx';

// Purchase orders: one list used by classroom orders and by the master purchasing list.
// Marking an order ordered, shipped, or delivered updates every item on it, including the teachers' requests.
export function PurchaseOrders({ canCreate = true }) {
  const toOrder = useLoad(() => api.get('/purchasing/to-order'));
  const meta = useLoad(() => api.get('/purchasing/meta'));
  const pos = useLoad(() => api.get('/pos'));
  const [vendor, setVendor] = useState('');
  const [picked, setPicked] = useState({ items: {}, lines: {} });
  const [track, setTrack] = useState(null);
  const run = useAction();
  const refresh = () => { toOrder.reload(); pos.reload(); };
  const chosen = { needIds: Object.keys(picked.items).filter((k) => picked.items[k]), lineIds: Object.keys(picked.lines).filter((k) => picked.lines[k]) };
  const sel = (kind, id) => (
    <input type="checkbox" aria-label="Select" checked={!!picked[kind][id]} onChange={(e) => setPicked({ ...picked, [kind]: { ...picked[kind], [id]: e.target.checked } })} />
  );
  const next = { draft: ['ordered', 'Mark ordered'], ordered: ['shipped', 'Mark shipped'], shipped: ['delivered', 'Mark delivered'] };
  const advance = (po) => {
    const [status] = next[po.status];
    if (status === 'shipped') return setTrack(po);
    return run(async () => { await api.post(`/pos/${po.id}/status`, { status }); refresh(); }, `Order ${status}`);
  };
  return (
    <div className="stack">
      {canCreate && (
        <Panel title="Ready to order" flush>
          <Loading q={toOrder}>{(d) => (
            <>
              <Table rows={[...d.items.map((i) => ({ ...i, key: 'i' + i.id, kind: 'items', from: 'Purchasing list' })), ...d.classroomLines.map((l) => ({ ...l, key: 'l' + l.id, kind: 'lines', from: 'Classroom request' }))]} keyOf={(r) => r.key}
                empty="Nothing approved is waiting to be ordered."
                cols={[{ h: '', render: (r) => sel(r.kind, r.id) }, { h: 'Item', k: 'item' }, { h: 'Quantity', k: 'quantity', num: true }, { h: 'Estimate', render: (r) => money((r.estimated_unit_cents || 0) * r.quantity), num: true }, { h: 'From', k: 'from' }]} />
              <div className="row" style={{ padding: 16 }}>
                <select value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor"><option value="">Choose a vendor</option>{(meta.data?.vendors || []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
                <Btn disabled={!vendor || (!chosen.needIds.length && !chosen.lineIds.length)} onClick={() => run(async () => { await api.post('/pos', { vendorId: vendor, ...chosen }); setPicked({ items: {}, lines: {} }); refresh(); }, 'Purchase order created')}>Create purchase order</Btn>
              </div>
            </>)}</Loading>
        </Panel>
      )}
      <Panel title="Purchase orders" flush>
        <Loading q={pos}>{(list) => <Table rows={list} empty="No purchase orders yet." cols={[
          { h: 'Order', k: 'po_number' }, { h: 'Vendor', k: 'vendor' }, { h: 'Lines', k: 'lines', num: true }, { h: 'Subtotal', render: (p) => money(p.subtotal_cents), num: true }, { h: 'Status', render: (p) => <StatusPill value={p.status} /> },
          { h: 'Tracking', render: (p) => p.tracking_number ? `${p.carrier || ''} ${p.tracking_number}` : '' }, { h: 'Expected', render: (p) => fmtDate(p.expected_delivery) },
          { h: '', render: (p) => next[p.status] && <div className="acell"><Btn small onClick={() => advance(p)}>{next[p.status][1]}</Btn><Btn small kind="danger" onClick={() => run(async () => { await api.post(`/pos/${p.id}/status`, { status: 'cancelled' }); refresh(); }, 'Order cancelled')}>Cancel</Btn></div> }]} />}</Loading>
      </Panel>
      {track && (
        <Modal title={`${track.po_number}: shipped`} onClose={() => setTrack(null)}>
          <ShipForm onDone={async (v) => { await run(async () => { await api.post(`/pos/${track.id}/status`, { status: 'shipped', ...v }); refresh(); }, 'Marked shipped. Teachers can see the tracking.'); setTrack(null); }} />
        </Modal>)}
    </div>
  );
}

function ShipForm({ onDone }) {
  const [v, setV] = useState({ carrier: '', trackingNumber: '', expectedDelivery: '' });
  return (
    <>
      <Field label="Carrier"><input value={v.carrier} onChange={(e) => setV({ ...v, carrier: e.target.value })} /></Field>
      <Field label="Tracking number"><input value={v.trackingNumber} onChange={(e) => setV({ ...v, trackingNumber: e.target.value })} /></Field>
      <Field label="Expected delivery"><input type="date" value={v.expectedDelivery} onChange={(e) => setV({ ...v, expectedDelivery: e.target.value })} /></Field>
      <div className="macts"><Btn onClick={() => onDone(v)}>Save</Btn></div>
    </>
  );
}
