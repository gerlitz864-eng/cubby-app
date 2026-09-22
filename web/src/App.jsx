import React, { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth.jsx';
import { api } from './api.js';
import { label } from './ui.jsx';
import Login from './pages/Login.jsx';
import Today from './pages/Today.jsx';
import Attendance from './pages/Attendance.jsx';
import Alerts from './pages/Alerts.jsx';
import Kiosk from './pages/Kiosk.jsx';
import Hours from './pages/Hours.jsx';
import Enrollment from './pages/Enrollment.jsx';
import Supplies from './pages/Supplies.jsx';
import Orders from './pages/Orders.jsx';
import Purchasing from './pages/Purchasing.jsx';
import Meals from './pages/Meals.jsx';
import Food from './pages/Food.jsx';
import Parent from './pages/Parent.jsx';
import Admin from './pages/Admin.jsx';

// Each screen appears only for people who hold one of its permissions.
export const NAV = [
  { to: '/', label: 'Today', perms: ['attendance.view'], officeOnly: true, icon: '☀' },
  { to: '/attendance', label: 'Attendance', perms: ['attendance.view'], icon: '✓' },
  { to: '/alerts', label: 'Alerts', perms: ['attendance.record'], icon: '!' },
  { to: '/hours', label: 'Staff hours', perms: ['time.view_all', 'time.punch'], icon: '⏱' },
  { to: '/enrollment', label: 'Enrollment', perms: ['enrollment.view'], icon: '☺' },
  { to: '/supplies', label: 'Child supplies', perms: ['supplies.flag', 'supplies.review'], icon: '◧' },
  { to: '/orders', label: 'Classroom orders', perms: ['orders.request', 'orders.review'], icon: '▤' },
  { to: '/purchasing', label: 'Purchasing', perms: ['purchasing.view'], icon: '$' },
  { to: '/meals', label: 'Meals', perms: ['meals.view'], icon: '◔' },
  { to: '/food', label: 'Food program', perms: ['food_products.manage', 'recipes.manage', 'meals.claims'], icon: '❖' },
  { to: '/parent', label: 'My child', perms: ['portal.sign_in_out'], icon: '♥' },
  { to: '/admin', label: 'Admin', perms: ['users.manage', 'settings.manage'], icon: '⚙' }
];

const PAGES = { '/attendance': Attendance, '/alerts': Alerts, '/hours': Hours, '/enrollment': Enrollment, '/supplies': Supplies, '/orders': Orders, '/purchasing': Purchasing, '/meals': Meals, '/food': Food, '/parent': Parent, '/admin': Admin };

function Bell() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ items: [], unread: 0 });
  const load = () => api.get('/notifications').then(setData).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  const toggle = async () => {
    const next = !open; setOpen(next);
    if (next) { await load(); if (data.unread) { await api.post('/notifications/read'); setTimeout(load, 800); } }
  };
  return (
    <div className="bell">
      <button className="btn ghost sm" onClick={toggle} aria-label="Notifications">
        Notices {data.unread > 0 && <span className="badge">{data.unread}</span>}
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          {data.items.length === 0 && <p className="empty">No notices yet.</p>}
          {data.items.map((n) => (
            <div key={n.id} className={`note ${n.read_at ? '' : 'unread'}`}>
              <b>{n.title}</b>
              <div className="muted small">{n.body}</div>
              <div className="faint small">{new Date(n.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Shell() {
  const { user, ready, has, signOut } = useAuth();
  const loc = useLocation();
  if (!ready) return <p className="muted" style={{ padding: 40 }}>Loading…</p>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  const isOffice = ['owner', 'director', 'front_office', 'billing', 'cook'].includes(user.role);
  const items = NAV.filter((n) => has(...n.perms) && (!n.officeOnly || isOffice));
  const home = isOffice ? '/' : user.role === 'parent' ? '/parent' : (items[0]?.to || '/attendance');
  return (
    <div className="app">
      <nav id="nav" aria-label="Main">
        <div className="brand"><span className="logo" aria-hidden="true"><i /><i /><i /><i /></span><b>Cubby</b></div>
        <div className="center-name">{user.center.name}</div>
        {items.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => `nb ${isActive ? 'on' : ''}`}>
            <span style={{ width: 19, textAlign: 'center' }}>{n.icon}</span>{n.label}
          </NavLink>
        ))}
        <div className="navfoot">
          <div className="me"><span className="av">{user.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span><div><b>{user.name}</b><small>{label(user.role)}</small></div></div>
          <button className="linkbtn" onClick={() => { document.documentElement.setAttribute('data-theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }}>Switch light or dark</button>
          <button className="linkbtn" onClick={signOut}>Sign out</button>
        </div>
      </nav>
      <main className="content">
        <div className="spread" style={{ marginBottom: 6 }}><span /><Bell /></div>
        <Routes>
          <Route path="/" element={isOffice ? <Today /> : <Navigate to={home} replace />} />
          {NAV.filter((n) => n.to !== '/').map((n) => {
            const Page = PAGES[n.to];
            // A page the person has no permission for sends them home instead of showing an error.
            return <Route key={n.to} path={n.to} element={has(...n.perms) ? <Page /> : <Navigate to={home} replace />} />;
          })}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/kiosk" element={<Kiosk />} />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </AuthProvider>
  );
}
