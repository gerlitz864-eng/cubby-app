import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';

// ---------- formatting ----------
export const fmtTime = (v) => (v ? new Date(v).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');
export const fmtDate = (v) => (v ? new Date(String(v).length === 10 ? v + 'T12:00:00' : v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
export const fmtDateTime = (v) => (v ? `${fmtDate(v)}, ${fmtTime(v)}` : '');
export const money = (cents) => (cents == null ? '' : (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
export const dollars = (n) => (n == null ? '' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
export const hoursText = (seconds) => { const s = Math.round(Number(seconds) || 0); return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`; };
export const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
export const ageText = (dob) => {
  if (!dob) return '';
  const b = new Date(String(dob).slice(0, 10) + 'T12:00:00'), n = new Date();
  let m = (n.getFullYear() - b.getFullYear()) * 12 + n.getMonth() - b.getMonth();
  if (n.getDate() < b.getDate()) m--;
  return m < 24 ? `${m} mo` : `${Math.floor(m / 12)} yr ${m % 12} mo`;
};

// ---------- toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, tone) => {
    const id = Math.random();
    setItems((x) => [...x, { id, message, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div id="toasts" role="status" aria-live="polite">
        {items.map((i) => <div key={i.id} className={'toast ' + (i.tone || '')}>{i.message}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// Runs an action and reports errors as a toast. Returns undefined on failure.
export function useAction() {
  const toast = useToast();
  return useCallback(async (fn, okMessage) => {
    try { const r = await fn(); if (okMessage) toast(okMessage); return r === undefined ? true : r; }
    catch (e) { toast(e.message, 'warn'); return undefined; }
  }, [toast]);
}

// ---------- data loading ----------
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    Promise.resolve().then(fn).then(
      (data) => alive.current && setState({ data, error: null, loading: false }),
      (error) => alive.current && setState({ data: null, error, loading: false })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

// ---------- components ----------
export const Page = ({ title, sub, actions, children }) => (
  <>
    <header className="ph">
      <div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div>
      <div className="acts">{actions}</div>
    </header>
    {children}
  </>
);
export const Panel = ({ title, actions, flush, children, className = '' }) => (
  <section className={`panel ${flush ? 'flush' : ''} ${className}`}>
    {(title || actions) && <div className="spread" style={{ marginBottom: 12, padding: flush ? '16px 20px 0' : 0 }}><h3>{title}</h3><div className="row">{actions}</div></div>}
    {children}
  </section>
);
export const Btn = ({ kind, small, children, ...p }) => (
  <button {...p} className={`btn ${kind === 'ghost' ? 'ghost' : ''} ${kind === 'danger' ? 'warnb' : ''} ${small ? 'sm' : ''} ${p.className || ''}`}>{children}</button>
);
export const Pill = ({ tone = 'mute', children }) => <span className={`pill ${tone}`}>{children}</span>;
export const statusTone = (s) => ({
  ok: 'ok', in: 'ok', present: 'ok', approved: 'ok', received: 'ok', verified: 'ok', paid: 'ok', published: 'ok', resolved: 'ok', on_time: 'ok', accepted: 'ok', enrolled: 'ok', active: 'ok', delivered: 'ok',
  late: 'warn', pending: 'warn', pending_review: 'warn', on_hold: 'warn', open: 'warn', submitted: 'info', ordered: 'info', shipped: 'info', acknowledged: 'info', limit: 'warn', draft: 'mute', proposed: 'mute',
  denied: 'bad', over: 'bad', no_show: 'bad', expired: 'bad', rejected: 'bad', cancelled: 'mute', out: 'info', absent: 'warn'
}[s] || 'mute');
export const StatusPill = ({ value }) => <Pill tone={statusTone(value)}>{label(value)}</Pill>;

export function Table({ cols, rows, onRow, empty = 'Nothing here yet.', rowClass, keyOf }) {
  if (!rows?.length) return <p className="empty">{empty}</p>;
  return (
    <div className="tw">
      <table>
        <thead><tr>{cols.map((c, i) => <th key={i} className={c.num ? 'num' : ''}>{c.h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={keyOf ? keyOf(r) : r.id ?? ri} className={`${onRow ? 'clk' : ''} ${rowClass ? rowClass(r) : ''}`} onClick={onRow ? () => onRow(r) : undefined}>
              {cols.map((c, i) => <td key={i} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.k]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} style={wide ? { width: 'min(860px,100%)' } : undefined}>
        <div className="spread"><h2>{title}</h2><button className="iconbtn" aria-label="Close" onClick={onClose}>✕</button></div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

// Ties the label to its input so screen readers (and tests) can find the control by its label.
export function Field({ label: l, children, hint }) {
  const id = useId();
  const one = React.isValidElement(children) && ['input', 'select', 'textarea'].includes(children.type);
  return (
    <div className="fld">
      <label htmlFor={one ? children.props.id || id : undefined}>{l}</label>
      {one ? React.cloneElement(children, { id: children.props.id || id }) : children}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  );
}

// Form state helper: const [v, bind, set] = useForm({name: ''}); <input {...bind('name')} />
export function useForm(initial) {
  const [v, set] = useState(initial);
  const bind = (k) => ({ value: v[k] ?? '', onChange: (e) => set((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })) });
  const check = (k) => ({ checked: !!v[k], onChange: (e) => set((s) => ({ ...s, [k]: e.target.checked })) });
  return [v, bind, set, check];
}

export const Tabs = ({ tabs, value, onChange }) => (
  <div className="tabs" role="tablist">
    {tabs.map((t) => (
      <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'on' : ''}`} onClick={() => onChange(t.id)}>
        {t.label}{t.count != null && t.count > 0 && <span className="badge" style={{ marginLeft: 6 }}>{t.count}</span>}
      </button>
    ))}
  </div>
);

export const Loading = ({ q, children }) => {
  if (q.loading && !q.data) return <p className="muted">Loading…</p>;
  if (q.error) return <div className="banner bad">{q.error.message}</div>;
  return children(q.data);
};

export const Banner = ({ tone, children }) => <div className={`banner ${tone || ''}`}>{children}</div>;
export const Empty = ({ children }) => <p className="empty">{children}</p>;

export const RoomDot = ({ color }) => <i className="dot" style={{ background: color || 'var(--faint)', marginRight: 8 }} />;
