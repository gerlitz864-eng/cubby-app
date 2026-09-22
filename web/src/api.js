// Small fetch wrapper. The sign-in token is kept in localStorage; the kiosk uses a device token instead.
const BASE = (typeof window !== 'undefined' && window.__API_BASE__) || '/api';
export const tokenStore = {
  get: () => localStorage.getItem('cubby_token'),
  set: (t) => localStorage.setItem('cubby_token', t),
  clear: () => localStorage.removeItem('cubby_token')
};

async function request(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const auth = () => (tokenStore.get() ? { Authorization: 'Bearer ' + tokenStore.get() } : {});
export const api = {
  get: (p) => request('GET', p, undefined, auth()),
  post: (p, b = {}) => request('POST', p, b, auth()),
  put: (p, b = {}) => request('PUT', p, b, auth()),
  patch: (p, b = {}) => request('PATCH', p, b, auth())
};
export const publicApi = { get: (p) => request('GET', p), post: (p, b = {}) => request('POST', p, b) };

// Kiosk requests carry a device token, not a person's login.
export const kioskApi = (deviceToken) => ({
  get: (p) => request('GET', p, undefined, { 'x-device-token': deviceToken }),
  post: (p, b = {}) => request('POST', p, b, { 'x-device-token': deviceToken })
});
