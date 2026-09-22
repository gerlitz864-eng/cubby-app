import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Modal, Field, Banner, Loading, useLoad, useAction, useForm, fmtTime, dollars, fmtDate, label } from '../ui.jsx';

const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const portion = (i) => `${i.food}: ${Number(i.portion_quantity)} ${String(i.portion_unit).replace('_', ' ')}`;
const AMOUNTS = ['all', 'most', 'half', 'some', 'none'];

function RecordModal({ svc, child, onClose, onDone }) {
  const [v, bind, set] = useForm({ status: 'served', ateAt: nowHM(), overallAmount: 'all', notes: '' });
  const [amounts, setAmounts] = useState(Object.fromEntries(child.items.map((i) => [i.item_id, child.record?.items?.find((x) => x.itemId === i.item_id)?.amount || 'all'])));
  const run = useAction();
  const save = () => run(async () => {
    const r = await api.post('/meals/record', { mealServiceId: svc.id, childId: child.childId, ...v, items: child.items.map((i) => ({ itemId: i.item_id, amount: v.status === 'served' ? amounts[i.item_id] : 'none' })) });
    if (r.warnings?.length) alert('Allergy warning: ' + r.warnings.join(', '));
    onDone(r);
  });
  return (
    <Modal title={`${child.firstName}: ${label(svc.mealType)}`} onClose={onClose} wide>
      {child.alerts?.length > 0 && <div className="alertbox" style={{ marginBottom: 12 }}>{child.alerts.map((a, i) => <div className="ai" key={i}><span style={{ color: 'var(--bad)' }}>!</span><div className="body"><b>{label(a.kind)}: {a.name}</b> <span className="tag bad">{a.severity}</span><p className="small">{a.plan}</p></div></div>)}</div>}
      {child.conflicts.length > 0 && <Banner tone="bad">Today's menu has {child.conflicts.join(', ')}, which contains an allergen for {child.firstName}. Serve the safe alternative.</Banner>}
      <div className="row2" style={{ marginTop: 12 }}>
        <Field label="What happened"><select {...bind('status')}><option value="served">Served and ate</option><option value="declined">Declined the meal</option><option value="not_present">Was not here for this meal</option></select></Field>
        <Field label="Time they ate"><input type="time" {...bind('ateAt')} /></Field>
      </div>
      {v.status === 'served' && (
        <>
          <p className="muted small" style={{ marginBottom: 6 }}>The portion for {child.firstName}'s age group, and how much was eaten:</p>
          <Table rows={child.items} keyOf={(i) => i.item_id} cols={[{ h: 'Food', render: portion }, { h: 'How much', render: (i) => <select value={amounts[i.item_id]} onChange={(e) => setAmounts({ ...amounts, [i.item_id]: e.target.value })}>{AMOUNTS.map((a) => <option key={a}>{a}</option>)}</select> }]} />
          <Field label="Overall"><select {...bind('overallAmount')}>{AMOUNTS.map((a) => <option key={a}>{a}</option>)}</select></Field>
        </>)}
      <Field label="Notes (staff only)"><input {...bind('notes')} /></Field>
      <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={save}>Save</Btn></div>
    </Modal>
  );
}

function ExtrasModal({ child, onClose }) {
  const [f, bindF] = useForm({ amountOz: '', feedingType: 'formula', suppliedBy: 'parent' });
  const [e, bindE] = useForm({ description: '', suppliedBy: 'parent' });
  const run = useAction();
  return (
    <Modal title={`${child.firstName}: bottle or extra food`} onClose={onClose}>
      <h4 style={{ marginBottom: 8 }}>Bottle or feeding (infants)</h4>
      <div className="row3"><Field label="Type"><select {...bindF('feedingType')}><option value="formula">Formula</option><option value="breast_milk">Breast milk</option><option value="solid">Solid food</option></select></Field><Field label="Ounces"><input type="number" step="0.5" {...bindF('amountOz')} /></Field><Field label="Supplied by"><select {...bindF('suppliedBy')}><option value="parent">Parent</option><option value="center">Center</option></select></Field></div>
      <Btn small onClick={() => run(async () => { await api.post('/meals/infant-feeding', { childId: child.childId, ...f }); onClose(); }, 'Feeding recorded')}>Record feeding</Btn>
      <hr style={{ margin: '18px 0', border: 0, borderTop: '1px solid var(--line)' }} />
      <h4 style={{ marginBottom: 8 }}>Extra food outside the meal</h4>
      <Field label="What did they have?"><input {...bindE('description')} placeholder="Banana slices from home" /></Field>
      <Btn small onClick={() => run(async () => { await api.post('/meals/food-event', { childId: child.childId, ...e }); onClose(); }, 'Recorded. It does not count toward the state claim.')}>Record</Btn>
    </Modal>
  );
}

function Today() {
  const { has } = useAuth();
  const q = useLoad(() => api.get('/meals/room'));
  const [meal, setMeal] = useState('');
  const [roomId, setRoomId] = useState('');
  const [modal, setModal] = useState(null);
  const run = useAction();
  const services = q.data?.services || [];
  const mealTypes = [...new Set(services.map((s) => s.mealType))];
  const m = meal || mealTypes[0];
  const inMeal = services.filter((s) => s.mealType === m);
  const svc = inMeal.find((s) => s.classroomId === roomId) || inMeal[0];

  const quick = (child, status, amount) => run(async () => {
    await api.post('/meals/record', { mealServiceId: svc.id, childId: child.childId, status, ateAt: nowHM(), overallAmount: amount, items: child.items.map((i) => ({ itemId: i.item_id, amount: status === 'served' ? amount : 'none' })) });
    q.reload();
  });

  return (
    <>
      {has('meals.claims', 'food_products.manage') && <div className="row" style={{ marginBottom: 12 }}><Btn kind="ghost" onClick={() => run(async () => { const r = await api.post('/meals/services/ensure', { mealType: 'lunch' }); q.reload(); return r; }, "Today's lunch is set up from the menu")}>Prepare today's lunch from the menu</Btn></div>}
      <Loading q={q}>{() => !services.length ? <Banner>No meals are set up for today yet. The kitchen or office prepares them from the menu.</Banner> : (
        <>
          <Tabs value={m} onChange={(x) => { setMeal(x); setRoomId(''); }} tabs={mealTypes.map((t) => ({ id: t, label: label(t) }))} />
          {inMeal.length > 1 && <div className="chips" style={{ marginBottom: 14 }}>{inMeal.map((s) => <button key={s.id} className={`chip ${svc?.id === s.id ? 'on' : ''}`} onClick={() => setRoomId(s.classroomId)}>{s.classroom}</button>)}</div>}
          {svc && (
            <Panel title={`${label(svc.mealType)}, ${svc.classroom}`} actions={<><StatusPill value={svc.status} />{svc.status === 'open' && has('meals.record') && <Btn small onClick={() => run(async () => { await api.post(`/meals/services/${svc.id}/finalize`); q.reload(); }, 'Meal finalized')}>Finalize</Btn>}</>} flush>
              <Table rows={svc.children} empty="Nobody is signed in for this room yet." keyOf={(c) => c.childId} cols={[
                { h: 'Child', render: (c) => <><b>{c.firstName} {c.lastName}</b>{(c.alerts || []).map((a, i) => <span key={i} className="tag bad" style={{ marginLeft: 6 }}>{a.name}</span>)}{c.conflicts.length > 0 && <div className="small" style={{ color: 'var(--bad)' }}>Menu conflict: {c.conflicts.join(', ')}</div>}</> },
                { h: 'On the plate', render: (c) => <div className="small">{c.items.length ? c.items.map((i) => <div key={i.item_id}>{portion(i)}</div>) : <span className="muted">No portions set for this age group</span>}</div> },
                { h: 'Recorded', render: (c) => c.record ? <><StatusPill value={c.record.status} /> <span className="small muted">{fmtTime(c.record.ate_at)}, {c.record.overall_amount_eaten}</span><div>{c.record.is_claimable ? <Pill tone="ok">Counts for the state claim</Pill> : c.record.status === 'served' && <Pill tone="warn">{c.record.non_claim_reason}</Pill>}</div></> : <span className="muted">Not yet</span> },
                { h: '', render: (c) => svc.status === 'open' && has('meals.record') && (
                  <div className="acell" style={{ flexWrap: 'wrap' }}>
                    <Btn small onClick={() => quick(c, 'served', 'all')}>Ate as served</Btn><Btn small kind="ghost" onClick={() => quick(c, 'declined', 'none')}>Declined</Btn>
                    <Btn small kind="ghost" onClick={() => setModal({ t: 'rec', c })}>Details</Btn><Btn small kind="ghost" onClick={() => setModal({ t: 'extra', c })}>Bottle or extra</Btn></div>) }]} />
            </Panel>)}
          {modal?.t === 'rec' && <RecordModal svc={svc} child={modal.c} onClose={() => setModal(null)} onDone={() => { setModal(null); q.reload(); }} />}
          {modal?.t === 'extra' && <ExtrasModal child={modal.c} onClose={() => setModal(null)} />}
        </>)}</Loading>
    </>
  );
}

function Claims() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const q = useLoad(() => api.get('/meals/claims?month=' + month), [month]);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field></div>
      <Loading q={q}>{(d) => (
        <div className="stack">
          <Banner tone="info">{d.note} Reimbursement counts meals served that meet the meal pattern for a child who was present. How much a child ate does not change it.</Banner>
          <Panel title={`Estimated reimbursement: ${dollars(d.total)}`} flush>
            <Table rows={d.lines} empty="No meals recorded this month." keyOf={(r) => r.meal_type + r.category} cols={[{ h: 'Meal', render: (r) => label(r.meal_type) }, { h: 'Category', render: (r) => label(r.category) }, { h: 'Meals counted', render: (r) => r.claimable, num: true }, { h: 'Records', render: (r) => r.records, num: true }, { h: 'Rate', render: (r) => dollars(r.rate), num: true }, { h: 'Amount', render: (r) => dollars(r.amount), num: true }]} />
          </Panel>
          <div className="split2">
            <Panel title="Meals that do not count, and why" flush><Table rows={d.issues} empty="Every served meal counts." keyOf={(r) => r.reason} cols={[{ h: 'Reason', k: 'reason' }, { h: 'Meals', k: 'n', num: true }]} /></Panel>
            <Panel title="By day" flush><Table rows={d.days} empty="No days yet." keyOf={(r) => String(r.service_date)} cols={[{ h: 'Day', render: (r) => fmtDate(r.service_date) }, { h: 'Counted', k: 'claimable', num: true }, { h: 'Records', k: 'records', num: true }, { h: 'Locked', render: (r) => r.all_finalized ? <Pill tone="ok">Finalized</Pill> : <Pill tone="warn">Open</Pill> }]} /></Panel>
          </div>
        </div>)}</Loading>
    </>
  );
}

function DailyReports() {
  const { has } = useAuth();
  const q = useLoad(() => api.get('/reports/daily/readiness'));
  const run = useAction();
  return (
    <>
      <Banner tone="info">Each day, a summary is built for every child who was here: every meal and snack with the time, plus notes. Check that no meal is missing, then publish. Families see it in their portal once the center turns the daily report on for parents.</Banner>
      {has('daily_report.publish') && <div className="row" style={{ margin: '12px 0' }}><Btn kind="ghost" onClick={() => run(async () => { const r = await api.post('/reports/daily/build'); q.reload(); return r; }, 'Drafts built')}>Build today's drafts</Btn><Btn onClick={() => run(async () => { const r = await api.post('/reports/daily/publish'); q.reload(); return r; }, 'Published')}>Publish today's reports</Btn></div>}
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="Nobody has signed in yet today." keyOf={(r) => r.child_id} cols={[{ h: 'Child', render: (r) => `${r.first_name} ${r.last_name}` }, { h: 'Meals while here', k: 'meals_while_present', num: true }, { h: 'Recorded', k: 'meals_logged', num: true }, { h: 'Missing', render: (r) => r.meals_missing > 0 ? <Pill tone="warn">{r.meals_missing}</Pill> : '' }, { h: 'Report', render: (r) => r.report_status ? <StatusPill value={r.report_status} /> : <span className="muted">Not built</span> }]} />}</Loading></Panel>
    </>
  );
}

export default function Meals() {
  const { has } = useAuth();
  const [tab, setTab] = useState('today');
  return (
    <Page title="Meals" sub="Record what each child ate, meal by meal. The state food program report is built from this.">
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'today', label: "Today's meals" }, ...(has('meals.claims') ? [{ id: 'claims', label: 'State claim' }] : []), ...(has('daily_report.view') ? [{ id: 'reports', label: 'Parent daily reports' }] : [])]} />
      {tab === 'today' && <Today />}{tab === 'claims' && <Claims />}{tab === 'reports' && <DailyReports />}
    </Page>
  );
}
