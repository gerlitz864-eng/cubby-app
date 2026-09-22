import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, tokenStore } from './api.js';

const Ctx = createContext(null);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const load = async () => {
    if (!tokenStore.get()) { setUser(null); setReady(true); return; }
    try { setUser(await api.get('/me')); } catch { tokenStore.clear(); setUser(null); }
    setReady(true);
  };
  useEffect(() => { load(); }, []);

  const value = {
    user, ready,
    // Does the signed-in person have any of these permissions? Screens use this to hide what they cannot use.
    has: (...codes) => !!user && codes.some((c) => user.permissions.some((p) => p.code === c)),
    scope: (code) => user?.permissions.find((p) => p.code === code)?.scope,
    signIn: async (token) => { tokenStore.set(token); await load(); },
    signOut: () => { tokenStore.clear(); setUser(null); }
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
