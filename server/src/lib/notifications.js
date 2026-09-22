// In-app notifications (the bell in the app) and the message log. Text and call delivery goes through lib/notify.js.

export async function notifyRole(q, centerId, role, kind, title, body, source = {}) {
  await q(`INSERT INTO in_app_notifications (center_id, for_role, kind, title, body, source_table, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [centerId, role, kind, title, body, source.table || null, source.id || null]);
}

export async function notifyRoles(q, centerId, roles, kind, title, body, source) {
  for (const r of roles) await notifyRole(q, centerId, r, kind, title, body, source);
}

export async function notifyUser(q, centerId, userId, kind, title, body, source = {}) {
  await q(`INSERT INTO in_app_notifications (center_id, user_id, kind, title, body, source_table, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [centerId, userId, kind, title, body, source.table || null, source.id || null]);
}

export async function notifyGuardian(q, centerId, guardianId, kind, title, body, source = {}) {
  await q(`INSERT INTO in_app_notifications (center_id, guardian_id, kind, title, body, source_table, source_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [centerId, guardianId, kind, title, body, source.table || null, source.id || null]);
}

// Guardians of a child who have allowed portal access and this kind of notice.
export async function guardiansOf(q, childId, { supply = false } = {}) {
  return q(`SELECT g.id, g.first_name, g.last_name, g.phone_mobile, cg.is_primary,
                   coalesce(p.sms_consent, false) AS sms_consent, coalesce(p.voice_consent, false) AS voice_consent, p.opted_out_at
              FROM child_guardians cg
              JOIN guardians g ON g.id = cg.guardian_id
              LEFT JOIN guardian_communication_prefs p ON p.guardian_id = g.id
             WHERE cg.child_id = $1 ${supply ? 'AND cg.receive_supply_alerts' : ''}
             ORDER BY cg.is_primary DESC`, [childId]);
}

export async function centerInfo(q, centerId) {
  const c = (await q(`SELECT id, name, timezone, program_start_time, days_open,
                             (now() AT TIME ZONE timezone)::date AS today, to_char(now() AT TIME ZONE timezone, 'HH24:MI:SS') AS now_local
                        FROM centers WHERE id = $1`, [centerId]))[0];
  if (c && c.today instanceof Date) c.today = c.today.toISOString().slice(0, 10);
  return c;
}
