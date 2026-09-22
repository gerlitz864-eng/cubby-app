// Renders every screen against the real API (real database, real rules) and checks that it loads, shows the right things
// to each role, and that key actions work. The API is started as a separate process with the demo data.
import React from 'react';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let server, base, App, ToastProvider;
const tokens = {};

async function post(p, body, headers = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return r.json();
}
async function login(who) {
  if (tokens[who]) return tokens[who];
  const r = who === 'parent' ? await post('/auth/parent-login', { email: 'parent@willowcreek.test', pin: '123456' }) : await post('/auth/login', { email: `${who}@willowcreek.test`, password: 'demo1234' });
  return (tokens[who] = r.token);
}
async function open(route, who) {
  cleanup();
  localStorage.clear();
  if (who) localStorage.setItem('cubby_token', await login(who));
  render(<MemoryRouter initialEntries={[route]}><ToastProvider><App /></ToastProvider></MemoryRouter>);
}
const settle = () => waitFor(() => expect(screen.queryByText('Loading…')).toBeNull(), { timeout: 20000 });
const noErrors = () => expect(document.querySelectorAll('.banner.bad').length, [...document.querySelectorAll('.banner.bad')].map((b) => b.textContent).join(' | ')).toBe(0);

beforeAll(async () => {
  const dir = path.resolve(__dirname, '../../server');
  server = spawn('node', ['test/serve.js'], { cwd: dir, env: { ...process.env, NODE_ENV: 'test' } });
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('server did not start')), 90000);
    server.stdout.on('data', (d) => { const m = String(d).match(/PORT=(\d+)/); if (m) { clearTimeout(t); res(m[1]); } });
    server.stderr.on('data', (d) => process.stderr.write(d));
  });
  base = `http://127.0.0.1:${port}/api`;
  window.__API_BASE__ = base;
  ({ default: App } = await import('./App.jsx'));
  ({ ToastProvider } = await import('./ui.jsx'));
});
afterAll(() => { cleanup(); server?.kill(); });

describe('the director sees every screen and each one loads without errors', () => {
  const screens = [
    ['/', 'Today'], ['/attendance', 'Attendance'], ['/alerts', 'Missing-child alerts'], ['/hours', 'Staff hours'], ['/enrollment', 'Enrollment'], ['/supplies', 'Child supplies'],
    ['/orders', 'Classroom orders'], ['/purchasing', 'Purchasing'], ['/meals', 'Meals'], ['/food', 'Food program'], ['/admin', 'Admin']
  ];
  for (const [route, heading] of screens) {
    it(`${heading} (${route})`, async () => {
      await open(route, 'director');
      await screen.findByRole('heading', { name: heading }, { timeout: 20000 });
      await settle();
      noErrors();
    });
  }
});

describe('sign in', () => {
  it('shows the demo accounts and signs a director in through the form', async () => {
    await open('/login');
    await screen.findByText(/Demo data is loaded/, {}, { timeout: 20000 });
    fireEvent.click(screen.getByRole('button', { name: 'Director' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: 'Today' }, { timeout: 20000 });
  });
  it('refuses a wrong password with a clear message', async () => {
    await open('/login');
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'director@willowcreek.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Incorrect email or password');
  });
});

describe('each role sees only its own screens', () => {
  it('a teacher gets attendance, supplies, orders, meals, and hours, and no billing, purchasing, or admin', async () => {
    await open('/attendance', 'teacher');
    await screen.findByRole('heading', { name: 'Attendance' }, { timeout: 20000 });
    const nav = within(document.getElementById('nav'));
    for (const name of ['Attendance', 'Child supplies', 'Classroom orders', 'Meals', 'Staff hours']) expect(nav.getByText(name)).toBeTruthy();
    for (const name of ['Purchasing', 'Admin', 'Enrollment', 'Alerts', 'Food program']) expect(nav.queryByText(name)).toBeNull();
    await settle();
    expect(screen.getAllByText('Ladybugs').length).toBeGreaterThan(0);
    expect(screen.queryByText('Bumblebees')).toBeNull();
  });
  it('a teacher who types a manager URL is sent home', async () => {
    await open('/purchasing', 'teacher');
    await screen.findByRole('heading', { name: 'Attendance' }, { timeout: 20000 });
  });
  it('a parent sees only their own child and the sign-in log', async () => {
    await open('/parent', 'parent');
    await screen.findByRole('heading', { name: 'My child' }, { timeout: 20000 });
    await settle();
    const nav = within(document.getElementById('nav'));
    expect(nav.getByText('My child')).toBeTruthy();
    expect(nav.queryByText('Attendance')).toBeNull();
    expect(screen.getByText(/daily report is not turned on/i)).toBeTruthy();
    noErrors();
  });
});

describe('key actions', () => {
  it('the office signs a child in from the attendance board', async () => {
    await open('/attendance', 'office');
    await screen.findByRole('heading', { name: 'Attendance' }, { timeout: 20000 });
    await settle();
    const btn = (await screen.findAllByRole('button', { name: 'Check in' }))[0];
    fireEvent.click(btn);
    await screen.findByText(/signed in/i, {}, { timeout: 20000 });
  });
  it('a teacher taps a supply item: low, then out', async () => {
    await open('/supplies', 'teacher');
    await screen.findByRole('heading', { name: 'Child supplies' }, { timeout: 20000 });
    await settle();
    const tile = (await screen.findAllByRole('button', { name: /Diapers for/ }))[0];
    fireEvent.click(tile);
    await waitFor(() => expect(screen.getAllByText(/Running low/).length).toBeGreaterThan(0), { timeout: 20000 });
    fireEvent.click((await screen.findAllByRole('button', { name: /Diapers for/ }))[0]);
    await waitFor(() => expect(screen.getAllByText(/Out\. Tap to keep/).length).toBeGreaterThan(0), { timeout: 20000 });
  });
  it('the kiosk lists staff and lets a parent look up their family by phone', async () => {
    cleanup(); localStorage.clear(); localStorage.setItem('cubby_device', 'demo-kiosk-token');
    render(<MemoryRouter initialEntries={['/kiosk']}><ToastProvider><App /></ToastProvider></MemoryRouter>);
    await screen.findByText('Maria S.', {}, { timeout: 20000 });
    fireEvent.click(screen.getByRole('button', { name: 'Parents and pick-up' }));
    fireEvent.change(screen.getByPlaceholderText('(555) 010-2311'), { target: { value: '(555) 010-2311' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(/Hello, Rachel/, {}, { timeout: 20000 });
  });
  it('the teacher meal screen shows portions and allergy alerts for a signed-in child', async () => {
    // set up lunch and sign a Bumblebees child in through the API
    const office = await login('office'); const cook = await login('cook');
    const auth = (t) => ({ Authorization: 'Bearer ' + t });
    await post('/meals/services/ensure', { mealType: 'lunch' }, auth(cook));
    const board = await (await fetch(base + '/attendance/today', { headers: auth(office) })).json();
    const eli = board.find((c) => c.first_name === 'Eli');
    await post('/attendance/check-in', { childId: eli.child_id }, auth(office));
    await open('/meals', 'teacher2');
    await screen.findByRole('heading', { name: 'Meals' }, { timeout: 20000 });
    await settle();
    await screen.findByText('Eli Okafor', {}, { timeout: 20000 });
    expect(screen.getAllByText('Peanuts').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Whole grain chicken nuggets: 2 piece/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Ate as served' }));
    await waitFor(() => expect(screen.getAllByText(/Counts for the state claim/).length).toBeGreaterThan(0), { timeout: 20000 });
  });
});
