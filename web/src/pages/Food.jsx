import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Page, Panel, Btn, Pill, StatusPill, Table, Tabs, Modal, Field, Banner, Loading, useLoad, useAction, useForm, fmtDate, label } from '../ui.jsx';

const UNITS = ['piece', 'oz', 'fl_oz', 'cup', 'tbsp', 'tsp', 'g', 'ml', 'lb', 'oz_eq', 'cup_eq'];
const BASES = ['cn_label', 'product_formulation_statement', 'usda_food_buying_guide', 'standardized_recipe', 'manufacturer_spec', 'calculated'];
const CERTS = ['cn_label', 'product_formulation_statement', 'allergen_control', 'haccp_plan', 'gfsi_audit', 'food_safety_inspection', 'organic', 'kosher', 'halal', 'gluten_free', 'non_gmo', 'vendor_license', 'insurance', 'other'];

const readFile = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

function ProductForm({ product, meta, onClose, onDone }) {
  const [v, bind, set] = useForm({ name: product?.product.name || '', vendorId: product?.product.vendor_id || '', brand: '', ingredientStatement: '', allergenStatement: '', component: '', qty: '', unit: 'oz_eq', per: '', basis: 'cn_label', calories: '', sodiumMg: '' });
  const [al, setAl] = useState({});
  const run = useAction();
  const save = () => run(async () => {
    const body = { ...v, allergens: Object.keys(al).filter((k) => al[k]).map((code) => ({ code, declaration: 'contains' })), crediting: v.component ? { component: v.component, quantity: Number(v.qty), unit: v.unit, per: v.per, basis: v.basis } : null, calories: v.calories || null, sodiumMg: v.sodiumMg || null };
    if (product) await api.post(`/products/${product.product.id}/versions`, body); else await api.post('/products', body);
    onDone();
  }, product ? 'New version saved. The old one is kept.' : 'Product saved');
  return (
    <Modal title={product ? `Reformulated: ${product.product.name}` : 'Add a product'} onClose={onClose} wide>
      {!product && <div className="row2"><Field label="Product name"><input {...bind('name')} /></Field><Field label="Vendor"><select {...bind('vendorId')}><option value="">Choose</option>{meta.vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field></div>}
      <Field label="Ingredient list, exactly as printed on the label" hint="Separate ingredients with commas. Keep sub-ingredients in (parentheses)."><textarea rows={3} {...bind('ingredientStatement')} /></Field>
      <Field label="Allergen statement as printed"><input {...bind('allergenStatement')} placeholder="Contains: wheat, soy." /></Field>
      <Field label="Contains these allergens"><div className="chips">{meta.allergens.map((a) => <label key={a.code} className="chip" style={{ cursor: 'pointer' }}><input type="checkbox" checked={!!al[a.code]} onChange={(e) => setAl({ ...al, [a.code]: e.target.checked })} /> {a.label}</label>)}</div></Field>
      <h4 style={{ margin: '8px 0' }}>What one serving credits toward the meal</h4>
      <div className="row3"><Field label="Component"><select {...bind('component')}><option value="">Not entered</option>{meta.components.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></Field><Field label="Amount"><input type="number" step="0.25" {...bind('qty')} /></Field><Field label="Unit"><select {...bind('unit')}>{UNITS.map((u) => <option key={u} value={u}>{label(u)}</option>)}</select></Field></div>
      <div className="row2"><Field label="Per serving"><input {...bind('per')} placeholder="4 pieces" /></Field><Field label="Documented by"><select {...bind('basis')}>{BASES.map((b) => <option key={b} value={b}>{label(b)}</option>)}</select></Field></div>
      <div className="macts"><Btn kind="ghost" onClick={onClose}>Cancel</Btn><Btn onClick={save}>Save</Btn></div>
    </Modal>
  );
}

function ProductDetail({ id, meta, onClose, onChange }) {
  const q = useLoad(() => api.get(`/products/${id}`));
  const [reform, setReform] = useState(false);
  return (
    <Modal title={q.data?.product.name || 'Product'} onClose={onClose} wide>
      <Loading q={q}>{(d) => (
        <div className="stack">
          <p className="muted">{d.product.vendor}{d.product.brand ? `, ${d.product.brand}` : ''}. SKU {d.product.vendor_sku}.</p>
          {d.versions.map((v) => (
            <Panel key={v.id} title={`Version ${v.version_no}${v.effective_to ? '' : ' (current)'}`} actions={<span className="small muted">{fmtDate(v.effective_from)}{v.effective_to ? ` to ${fmtDate(v.effective_to)}` : ' onward'}</span>}>
              <p><b>Ingredients:</b> {v.ingredient_statement}</p>
              {v.allergen_statement && <p><b>Allergens:</b> {v.allergen_statement}</p>}
              <div className="row" style={{ marginTop: 6 }}>{d.allergens.filter((a) => a.product_version_id === v.id).map((a) => <Pill key={a.allergen_code + a.declaration} tone="bad">{label(a.allergen_code)} ({a.declaration.replace('_', ' ')})</Pill>)}
                {d.crediting.filter((c) => c.product_version_id === v.id).map((c) => <Pill key={c.id} tone="info">Credits {Number(c.credited_quantity)} {label(c.credited_unit)} of {label(c.component_code)} ({label(c.basis)})</Pill>)}</div>
            </Panel>))}
          <Panel title="Manufacturer and vendor certificates" flush><Table rows={d.certificates} empty="No certificates are linked to this product." cols={[{ h: 'Certificate', render: (c) => c.title }, { h: 'Type', render: (c) => label(c.cert_type) }, { h: 'Expires', render: (c) => fmtDate(c.expires_on) }, { h: 'Status', render: (c) => <StatusPill value={c.status} /> }]} /></Panel>
          {d.deliveries.length > 0 && <Panel title="Recent deliveries" flush><Table rows={d.deliveries} cols={[{ h: 'Received', render: (x) => fmtDate(x.received_at) }, { h: 'Lot', k: 'lot_code' }, { h: 'Best by', render: (x) => fmtDate(x.best_by) }, { h: 'Temp', k: 'temperature_f' }]} /></Panel>}
          <div className="row"><Btn onClick={() => setReform(true)}>The manufacturer changed this product</Btn></div>
          {reform && <ProductForm product={d} meta={meta} onClose={() => setReform(false)} onDone={() => { setReform(false); q.reload(); onChange(); }} />}
        </div>)}</Loading>
    </Modal>
  );
}

function Products({ meta }) {
  const q = useLoad(() => api.get('/products'));
  const [open, setOpen] = useState(null);
  const [add, setAdd] = useState(false);
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Btn onClick={() => setAdd(true)}>Add a product</Btn></div>
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="No products yet." onRow={(p) => setOpen(p.id)} cols={[
        { h: 'Product', render: (p) => <><b>{p.name}</b><div className="small muted">{p.vendor}</div></> }, { h: 'Ingredients (as printed)', render: (p) => <span className="small">{p.ingredient_statement}</span> },
        { h: 'Allergens', render: (p) => <div className="row">{(p.allergens || []).map((a) => <Pill key={a} tone="bad">{label(a)}</Pill>)}</div> },
        { h: 'Crediting', render: (p) => p.crediting ? `${Number(p.crediting.quantity)} ${label(p.crediting.unit)} ${label(p.crediting.component)}` : <Pill tone="warn">Missing</Pill> },
        { h: 'Certificates', render: (p) => <>{p.valid_certificates > 0 && <Pill tone="ok">{p.valid_certificates} valid</Pill>} {p.lapsed_certificates > 0 && <Pill tone="bad">{p.lapsed_certificates} lapsed</Pill>}{!p.valid_certificates && !p.lapsed_certificates && <Pill tone="warn">None</Pill>}</> }]} />}</Loading></Panel>
      {open && <ProductDetail id={open} meta={meta} onClose={() => setOpen(null)} onChange={q.reload} />}
      {add && <ProductForm meta={meta} onClose={() => setAdd(false)} onDone={() => { setAdd(false); q.reload(); }} />}
    </>
  );
}

function Certificates({ meta }) {
  const q = useLoad(() => api.get('/certificates'));
  const [add, setAdd] = useState(false);
  const [v, bind, set] = useForm({ title: '', certType: 'gfsi_audit', vendorId: '', certificateNumber: '', issuingBody: '', issuedOn: '', expiresOn: '' });
  const [file, setFile] = useState(null);
  const [prods, setProds] = useState({});
  const run = useAction();
  const save = () => run(async () => {
    const body = { ...v, productIds: Object.keys(prods).filter((k) => prods[k]) };
    if (file) { body.base64 = await readFile(file); body.filename = file.name; }
    else body.base64 = btoa('No file uploaded (demo)');
    await api.post('/certificates', body); setAdd(false); q.reload();
  }, 'Certificate saved. Verify it once you have checked the document.');
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Btn onClick={() => setAdd(true)}>Add a certificate</Btn></div>
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="No certificates yet." keyOf={(c) => c.id} cols={[
        { h: 'Certificate', render: (c) => <><b>{c.title}</b><div className="small muted">{c.vendor}{c.certificate_number ? `, ${c.certificate_number}` : ''}</div></> }, { h: 'Type', render: (c) => label(c.cert_type) },
        { h: 'Covers', render: (c) => <span className="small">{(c.products || []).join(', ')}</span> }, { h: 'Expires', render: (c) => <>{fmtDate(c.expires_on)}{c.days_left != null && c.days_left <= 60 && <div className="small" style={{ color: c.days_left < 0 ? 'var(--bad)' : 'var(--warn)' }}>{c.days_left < 0 ? `Expired ${-c.days_left} days ago` : `${c.days_left} days left`}</div>}</> },
        { h: 'Status', render: (c) => <StatusPill value={c.status} /> },
        { h: '', render: (c) => <div className="acell">{c.status === 'pending' && <Btn small onClick={() => run(async () => { await api.post(`/certificates/${c.id}/verify`, {}); q.reload(); }, 'Verified')}>Verify</Btn>}<a className="btn ghost sm" href={`/api/documents/${c.document_id}/download`} onClick={async (e) => { e.preventDefault(); const t = localStorage.getItem('cubby_token'); const r = await fetch(`/api/documents/${c.document_id}/download`, { headers: { Authorization: 'Bearer ' + t } }); if (!r.ok) return alert('No file is attached to this demo record.'); const b = await r.blob(); window.open(URL.createObjectURL(b)); }}>Open file</a></div> }]} />}</Loading></Panel>
      {add && (
        <Modal title="Add a certificate" onClose={() => setAdd(false)} wide>
          <Field label="Title"><input {...bind('title')} placeholder="SQF audit, Granite State plant" /></Field>
          <div className="row3"><Field label="Type"><select {...bind('certType')}>{CERTS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field><Field label="Vendor"><select {...bind('vendorId')}><option value="">Choose</option>{meta.vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field><Field label="Certificate number"><input {...bind('certificateNumber')} /></Field></div>
          <div className="row3"><Field label="Issued by"><input {...bind('issuingBody')} /></Field><Field label="Issued"><input type="date" {...bind('issuedOn')} /></Field><Field label="Expires"><input type="date" {...bind('expiresOn')} /></Field></div>
          <Field label="The document (PDF or image, up to 5 MB)"><input type="file" onChange={(e) => setFile(e.target.files[0])} /></Field>
          <Field label="Products this certificate covers"><div className="chips">{meta.products.map((p) => <label key={p.id} className="chip" style={{ cursor: 'pointer' }}><input type="checkbox" checked={!!prods[p.id]} onChange={(e) => setProds({ ...prods, [p.id]: e.target.checked })} /> {p.name}</label>)}</div></Field>
          <div className="macts"><Btn kind="ghost" onClick={() => setAdd(false)}>Cancel</Btn><Btn onClick={save}>Save</Btn></div>
        </Modal>)}
    </>
  );
}

function Recipes({ meta }) {
  const q = useLoad(() => api.get('/recipes'));
  const [open, setOpen] = useState(null);
  const [portions, setPortions] = useState('');
  const d = useLoad(() => (open ? api.get(`/recipes/${open}${portions ? `?portions=${portions}` : ''}`) : null), [open, portions]);
  const [add, setAdd] = useState(false);
  const [v, bind] = useForm({ name: '', portionsYielded: 25, portionSizeDesc: '' });
  const [lines, setLines] = useState([{ productId: '', quantity: '', unit: 'piece' }]);
  const run = useAction();
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Btn onClick={() => setAdd(true)}>Add a recipe</Btn></div>
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="No recipes yet." onRow={(r) => { setOpen(r.id); setPortions(''); }} cols={[{ h: 'Recipe', render: (r) => <b>{r.name}</b> }, { h: 'Makes', render: (r) => `${Number(r.portions_yielded)} portions` }, { h: 'Portion', k: 'portion_size_desc' }, { h: 'Allergens', render: (r) => <div className="row">{(r.allergens || []).map((a) => <Pill key={a} tone="bad">{label(a)}</Pill>)}</div> }]} />}</Loading></Panel>
      {open && (
        <Modal title="Recipe" onClose={() => setOpen(null)} wide>
          <Loading q={d}>{(x) => !x ? null : (
            <div className="stack">
              <div className="row"><Field label="Make this many portions"><input type="number" min="1" style={{ width: 120 }} value={portions || Number(x.recipe.portions_yielded)} onChange={(e) => setPortions(e.target.value)} /></Field><span className="muted small">Base recipe: {Number(x.recipe.portions_yielded)} portions of {x.recipe.portion_size_desc}</span></div>
              <Table rows={x.lines} keyOf={(l) => l.line_no} cols={[{ h: 'Ingredient', k: 'item' }, { h: 'Exact quantity', render: (l) => `${Number(l.quantity)} ${label(l.unit)}`, num: true }, { h: 'Prep', k: 'prep_note' }]} />
              <div className="row">{x.credits.map((c) => <Pill key={c.component_code} tone="info">One portion credits {Number(c.credited_quantity)} {label(c.credited_unit)} {label(c.component_code)}</Pill>)}{x.allergens.map((a) => <Pill key={a} tone="bad">Contains {label(a)}</Pill>)}</div>
              <p className="small muted">{x.recipe.instructions}</p>
            </div>)}</Loading>
        </Modal>)}
      {add && (
        <Modal title="Add a recipe" onClose={() => setAdd(false)} wide>
          <div className="row3"><Field label="Name"><input {...bind('name')} /></Field><Field label="Portions the batch makes"><input type="number" {...bind('portionsYielded')} /></Field><Field label="One portion is"><input {...bind('portionSizeDesc')} placeholder="3 nuggets and 1/2 cup rice" /></Field></div>
          <h4 style={{ margin: '6px 0' }}>Ingredients for the whole batch</h4>
          {lines.map((l, i) => <div key={i} className="row3"><select value={l.productId} aria-label="Product" onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, productId: e.target.value } : x))}><option value="">Product</option>{meta.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select><input type="number" step="0.25" aria-label="Quantity" placeholder="Quantity" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, quantity: e.target.value } : x))} /><select value={l.unit} aria-label="Unit" onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, unit: e.target.value } : x))}>{UNITS.map((u) => <option key={u} value={u}>{label(u)}</option>)}</select></div>)}
          <Btn small kind="ghost" onClick={() => setLines([...lines, { productId: '', quantity: '', unit: 'piece' }])}>Add another ingredient</Btn>
          <div className="macts"><Btn kind="ghost" onClick={() => setAdd(false)}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post('/recipes', { ...v, lines: lines.filter((l) => l.productId && l.quantity) }); setAdd(false); q.reload(); }, 'Recipe saved')}>Save</Btn></div>
        </Modal>)}
    </>
  );
}

function Portions({ meta }) {
  const q = useLoad(() => api.get('/portions'));
  const [add, setAdd] = useState(false);
  const [v, bind] = useForm({ foodItemId: '', ageGroupId: 4, mealType: 'lunch', servingQuantity: '', servingUnit: 'piece', pieceCount: '', servingTool: '', creditedComponent: 'meat_alt', creditedQuantity: '', creditedUnit: 'oz_eq' });
  const run = useAction();
  return (
    <>
      <Banner tone="info">Exact serving sizes per child, by food and age group: a count of pieces or an amount in ounces or cups. Meals are checked against these when they are recorded.</Banner>
      <div className="row" style={{ margin: '12px 0' }}><Btn onClick={() => setAdd(true)}>Add a portion size</Btn></div>
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="No portion sizes yet." keyOf={(r) => r.id} cols={[{ h: 'Food', k: 'food' }, { h: 'Age group', k: 'age_group' }, { h: 'Meal', render: (r) => label(r.meal_type || 'any') }, { h: 'Serving', render: (r) => <b>{r.piece_count ? `${r.piece_count} pieces` : `${Number(r.serving_quantity)} ${label(r.serving_unit)}`}</b> }, { h: 'Tool', k: 'serving_tool' }, { h: 'Credits', render: (r) => r.credited_quantity ? `${Number(r.credited_quantity)} ${label(r.credited_unit)} ${label(r.credited_component)}` : label(r.credited_component) }]} />}</Loading></Panel>
      {add && (
        <Modal title="Add a portion size" onClose={() => setAdd(false)} wide>
          <div className="row3"><Field label="Food"><select {...bind('foodItemId')}><option value="">Choose</option>{meta.foods.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field><Field label="Age group"><select {...bind('ageGroupId')}>{meta.ageGroups.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field><Field label="Meal"><select {...bind('mealType')}>{['breakfast', 'am_snack', 'lunch', 'pm_snack', 'supper'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field></div>
          <div className="row3"><Field label="Serving amount"><input type="number" step="0.125" {...bind('servingQuantity')} /></Field><Field label="Unit"><select {...bind('servingUnit')}>{UNITS.map((u) => <option key={u} value={u}>{label(u)}</option>)}</select></Field><Field label="Pieces (if counted)"><input type="number" {...bind('pieceCount')} /></Field></div>
          <Field label="Serving tool"><input {...bind('servingTool')} placeholder="#8 scoop, count pieces" /></Field>
          <div className="row3"><Field label="Credits component"><select {...bind('creditedComponent')}>{meta.components.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></Field><Field label="Credited amount"><input type="number" step="0.125" {...bind('creditedQuantity')} /></Field><Field label="Credited unit"><select {...bind('creditedUnit')}>{UNITS.map((u) => <option key={u} value={u}>{label(u)}</option>)}</select></Field></div>
          <div className="macts"><Btn kind="ghost" onClick={() => setAdd(false)}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post('/portions', v); setAdd(false); q.reload(); }, 'Saved')}>Save</Btn></div>
        </Modal>)}
    </>
  );
}

function Menu({ meta }) {
  const q = useLoad(() => api.get('/menus/day'));
  const [add, setAdd] = useState(false);
  const [v, bind] = useForm({ date: new Date().toISOString().slice(0, 10), mealType: 'lunch' });
  const [items, setItems] = useState({});
  const run = useAction();
  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><Btn onClick={() => setAdd(true)}>Plan a meal</Btn></div>
      <Panel flush><Loading q={q}>{(rows) => <Table rows={rows} empty="No meals are planned." keyOf={(r) => r.id} cols={[{ h: 'Day', render: (r) => fmtDate(r.service_date) }, { h: 'Meal', render: (r) => label(r.meal_type) }, { h: 'Foods', render: (r) => (r.items || []).map((i) => `${i.food} (${label(i.component)})`).join(', ') }]} />}</Loading></Panel>
      {add && (
        <Modal title="Plan a meal" onClose={() => setAdd(false)} wide>
          <div className="row2"><Field label="Day"><input type="date" {...bind('date')} /></Field><Field label="Meal"><select {...bind('mealType')}>{['breakfast', 'am_snack', 'lunch', 'pm_snack', 'supper'].map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field></div>
          <Field label="Foods and the meal component each fills">{meta.foods.map((f) => (
            <div key={f.id} className="row" style={{ marginBottom: 6 }}><label className="chk" style={{ margin: 0, minWidth: 260 }}><input type="checkbox" checked={!!items[f.id]} onChange={(e) => setItems({ ...items, [f.id]: e.target.checked ? 'grain' : undefined })} /> {f.name}</label>
              {items[f.id] && <select value={items[f.id]} onChange={(e) => setItems({ ...items, [f.id]: e.target.value })}>{meta.components.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select>}</div>))}</Field>
          <div className="macts"><Btn kind="ghost" onClick={() => setAdd(false)}>Cancel</Btn><Btn onClick={() => run(async () => { await api.post('/menus/day', { ...v, items: Object.entries(items).filter(([, c]) => c).map(([foodItemId, component]) => ({ foodItemId, component })) }); setAdd(false); q.reload(); }, 'Meal planned')}>Save</Btn></div>
        </Modal>)}
    </>
  );
}

export default function Food() {
  const { has } = useAuth();
  const [tab, setTab] = useState('products');
  const meta = useLoad(() => api.get('/meta/food'));
  const sum = useLoad(() => api.get('/compliance/summary'));
  return (
    <Page title="Food program" sub="Vendor products, exact ingredients, manufacturer certificates, recipes, and portion sizes for the New Jersey program">
      {(sum.data?.expiring || []).length > 0 && <Banner>{sum.data.expiring.length} certificate(s) are expired or expire within 60 days: {sum.data.expiring.map((c) => c.title).join('; ')}.</Banner>}
      <div style={{ height: 12 }} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'products', label: 'Products' }, { id: 'certs', label: 'Certificates' }, { id: 'recipes', label: 'Recipes' }, { id: 'portions', label: 'Portion sizes' }, { id: 'menu', label: 'Menu' }]} />
      <Loading q={meta}>{(m) => (<>{tab === 'products' && <Products meta={m} />}{tab === 'certs' && <Certificates meta={m} />}{tab === 'recipes' && <Recipes meta={m} />}{tab === 'portions' && <Portions meta={m} />}{tab === 'menu' && <Menu meta={m} />}</>)}</Loading>
    </Page>
  );
}
