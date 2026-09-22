import { centerInfo, notifyRole, notifyRoles, guardiansOf } from '../lib/notifications.js';

// Background jobs. Each one is safe to run repeatedly (they are idempotent), so the scheduler can run them every minute
// and an administrator can also trigger them by hand.

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Only notify once per (kind, source).
async function notifyOnce(q, centerId, role, kind, sourceId, title, body, table = null) {
  const exists = (await q(`SELECT 1 FROM in_app_notifications WHERE kind = $1 AND source_id = $2 AND for_role = $3::user_role LIMIT 1`, [kind, sourceId, role]))[0];
  if (exists) return false;
  await notifyRole(q, centerId, role, kind, title, body, { table, id: sourceId });
  return true;
}

// 1. Who should be here today. Built from the roster, each child's schedule, closures, and parent-reported absences.
export async function generateExpectedAttendance(q, c) {
  const rows = await q(`
    INSERT INTO expected_attendance (center_id, child_id, service_date, expected_arrival, source, status)
    SELECT $1, r.child_id, $2::date, coalesce(s.expected_arrival, ce.program_start_time), 'schedule',
           CASE WHEN EXISTS (SELECT 1 FROM planned_absences pa WHERE pa.child_id = r.child_id AND $2::date BETWEEN pa.absent_from AND pa.absent_to)
                THEN 'excused'::expected_status ELSE 'expected'::expected_status END
      FROM roster_on($1, $2::date) r
      JOIN centers ce ON ce.id = $1
      JOIN child_schedules s ON s.child_id = r.child_id AND s.valid_during @> $2::date
       AND extract(isodow FROM $2::date)::smallint = ANY (s.days_of_week)
     WHERE extract(isodow FROM $2::date)::smallint = ANY (ce.days_open)
       AND NOT EXISTS (SELECT 1 FROM closure_calendar cc WHERE cc.center_id = $1 AND cc.closure_date = $2::date AND cc.opens_at IS NULL)
    ON CONFLICT (child_id, service_date) DO NOTHING RETURNING id`, [c.id, c.today]);
  return rows.length;
}

// 2. Open an alert for every expected child who is past the grace period with no sign-in and no absence report.
export async function scanMissingChildren(q, c) {
  const rows = await q(`
    INSERT INTO attendance_alerts (center_id, child_id, service_date, expected_attendance_id, policy_id, status, current_step, next_action_at)
    SELECT center_id, child_id, service_date, expected_attendance_id, policy_id, 'open', 0, now()
      FROM v_missing_child_candidates WHERE center_id = $1
    ON CONFLICT (child_id, service_date) DO NOTHING RETURNING id, child_id`, [c.id]);
  for (const a of rows) {
    const ch = (await q('SELECT first_name, last_name FROM children WHERE id = $1', [a.child_id]))[0];
    await notifyRoles(q, c.id, ['front_office', 'director'], 'missing_child', `${ch.first_name} has not arrived`,
      `${ch.first_name} ${ch.last_name} is 30 minutes past the expected arrival and has not been signed in. Parents are being contacted.`, { table: 'attendance_alerts', id: a.id });
  }
  return rows.length;
}

// 3. Carry out the next step of each open alert whose time has come. Every step re-checks arrival and consent first.
export async function runAlertSteps(ctx, q, c) {
  const due = await q(`SELECT a.*, ch.first_name FROM attendance_alerts a JOIN children ch ON ch.id = a.child_id
                        WHERE a.center_id = $1 AND a.status IN ('open','parent_responded') AND a.next_action_at IS NOT NULL AND a.next_action_at <= now()`, [c.id]);
  let ran = 0;
  for (const a of due) {
    const arrived = (await q(`SELECT id FROM attendance_records WHERE child_id = $1 AND service_date = $2 AND status = 'present' AND checked_in_at IS NOT NULL`, [a.child_id, a.service_date]))[0];
    if (arrived) {
      await q(`UPDATE attendance_alerts SET status = 'resolved_arrived', resolved_at = now(), next_action_at = NULL, attendance_record_id = $2 WHERE id = $1`, [a.id, arrived.id]);
      continue;
    }
    const steps = await q('SELECT s.*, t.body FROM alert_policy_steps s LEFT JOIN message_templates t ON t.id = s.template_id WHERE s.policy_id = $1 ORDER BY s.step_no', [a.policy_id]);
    const step = steps.find((s) => s.step_no > a.current_step);
    if (!step) { await q(`UPDATE attendance_alerts SET next_action_at = NULL WHERE id = $1`, [a.id]); continue; }
    const text = (step.body || 'We have not seen {child_first_name} yet today.').replace('{child_first_name}', a.first_name).replace('{center_name}', c.name);

    if (step.target === 'director' || step.channel === 'in_app') {
      await notifyRoles(q, c.id, ['director', 'front_office'], 'missing_child_escalation', `${a.first_name}: family has not responded`, text, { table: 'attendance_alerts', id: a.id });
    } else if (step.target === 'emergency_contacts') {
      // Emergency contacts are never called automatically. Staff are given the names and numbers to call themselves.
      const list = await q(`SELECT ct.first_name, ct.last_name, ct.phone, cc.relationship FROM child_contacts cc JOIN contacts ct ON ct.id = cc.contact_id WHERE cc.child_id = $1 AND cc.role = 'emergency' ORDER BY cc.priority`, [a.child_id]);
      await notifyRoles(q, c.id, ['director', 'front_office'], 'call_emergency_contacts', `Please call ${a.first_name}'s emergency contacts`,
        list.length ? list.map((x) => `${x.first_name} ${x.last_name} (${x.relationship}) ${x.phone || ''}`).join('; ') : 'No emergency contacts are on file.', { table: 'attendance_alerts', id: a.id });
    } else {
      const gs = await guardiansOf(q, a.child_id);
      const targets = step.target === 'primary_guardian' ? gs.filter((g) => g.is_primary) : gs.filter((g) => !g.is_primary);
      for (const g of targets) {
        const key = `${a.id}:${step.step_no}:${g.id}`;
        if ((await q('SELECT 1 FROM notification_attempts WHERE idempotency_key = $1', [key]))[0]) continue;
        const consent = step.channel === 'sms' ? g.sms_consent : g.voice_consent;
        let status = 'sent', provider = null, providerId = null;
        if (!consent || g.opted_out_at || !g.phone_mobile) status = 'blocked_no_consent';
        else {
          try {
            const res = step.channel === 'sms'
              ? await ctx.notifier.sendSms(g.phone_mobile, text, { alertId: a.id, childId: a.child_id })
              : await ctx.notifier.sendCall(g.phone_mobile, text, { alertId: a.id, childId: a.child_id });
            provider = res.provider; providerId = res.id;
          } catch (e) { status = 'failed'; console.error('notify failed', e.message); }
        }
        await q(`INSERT INTO notification_attempts (alert_id, step_no, channel, guardian_id, to_address, template_id, idempotency_key, provider, provider_message_id, status, sent_at)
                 VALUES ($1,$2,$3::notify_channel,$4,$5,$6,$7,$8,$9,$10::attempt_status,$11)`,
          [a.id, step.step_no, step.channel, g.id, g.phone_mobile || 'none', step.template_id, key, provider, providerId, status, status === 'sent' ? new Date().toISOString() : null]);
      }
    }
    const following = steps.find((s) => s.step_no > step.step_no);
    await q(`UPDATE attendance_alerts SET current_step = $2, status = 'open',
                    next_action_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(mins => $3::int) END WHERE id = $1`,
      [a.id, step.step_no, following ? following.wait_minutes : null]);
    ran++;
  }
  return ran;
}

// 4. On time or late, for children and staff, then tell the right people once.
export async function punctualityAndLateAlerts(q, c) {
  await q('SELECT compute_daily_punctuality($1, $2::date)', [c.id, c.today]);
  const pol = (await q('SELECT staff_late_alert_after_minutes FROM punctuality_policies WHERE center_id = $1', [c.id]))[0] || { staff_late_alert_after_minutes: 10 };
  const late = await q(`SELECT dp.id, dp.subject_type, dp.status, dp.minutes_late, dp.expected_time,
                               coalesce(ch.first_name || ' ' || ch.last_name, s.first_name || ' ' || s.last_name) AS person
                          FROM daily_punctuality dp LEFT JOIN children ch ON ch.id = dp.child_id LEFT JOIN staff s ON s.id = dp.staff_id
                         WHERE dp.center_id = $1 AND dp.service_date = $2::date AND dp.status IN ('late','no_show') AND NOT dp.excused`, [c.id, c.today]);
  let sent = 0;
  for (const p of late) {
    if (p.subject_type === 'staff') {
      if (p.status === 'late' && p.minutes_late < pol.staff_late_alert_after_minutes) continue;
      const title = p.status === 'no_show' ? `${p.person} has not clocked in` : `${p.person} is ${p.minutes_late} minutes late`;
      if (await notifyOnce(q, c.id, 'director', 'staff_late', p.id, title, `Scheduled at ${String(p.expected_time).slice(0, 5)}.`, 'daily_punctuality')) sent++;
      if (p.status === 'no_show') await notifyOnce(q, c.id, 'front_office', 'staff_no_show', p.id, title, 'Check room coverage and ratios.', 'daily_punctuality');
    } else if (await notifyOnce(q, c.id, 'front_office', 'child_late', p.id,
      p.status === 'no_show' ? `${p.person} is not in yet` : `${p.person} arrived ${p.minutes_late} minutes late`, `Expected at ${String(p.expected_time).slice(0, 5)}.`, 'daily_punctuality')) sent++;
  }
  return sent;
}

// 5. Staff who did not punch in or out when they should have.
export async function missedPunches(q, c) {
  const rows = await q('SELECT * FROM v_missing_punches WHERE center_id = $1', [c.id]);
  let n = 0;
  for (const m of rows) {
    const key = `${m.problem}:${m.staff_id}:${iso(m.work_date)}`;
    const ex = await q(`INSERT INTO time_exceptions (center_id, staff_id, exception, dedupe_key) VALUES ($1,$2,$3::time_exception_type,$4) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, [c.id, m.staff_id, m.problem, key]);
    if (ex[0]) {
      const s = (await q('SELECT first_name, last_name FROM staff WHERE id = $1', [m.staff_id]))[0];
      await notifyRole(q, c.id, 'director', m.problem, m.problem === 'missed_clock_in' ? `${s.first_name} ${s.last_name} has not clocked in` : `${s.first_name} ${s.last_name} has not clocked out`, 'Please check and correct the time record if needed.', { table: 'time_exceptions', id: ex[0].id });
      n++;
    }
  }
  return n;
}

// 6. Expiring staff and vendor paperwork.
export async function certificateAlerts(q, c) {
  let n = 0;
  const staffCerts = await q(`SELECT sc.id, s.first_name, s.last_name, ct.label, sc.expires_on, (sc.expires_on - current_date) AS days
                                FROM staff_certifications sc JOIN staff s ON s.id = sc.staff_id JOIN certification_types ct ON ct.id = sc.cert_type_id
                               WHERE s.center_id = $1 AND s.terminated_on IS NULL AND sc.expires_on <= current_date + 30`, [c.id]);
  for (const x of staffCerts)
    if (await notifyOnce(q, c.id, 'director', 'staff_cert_expiring', x.id, `${x.first_name} ${x.last_name}: ${x.label} ${x.days < 0 ? 'expired' : 'expires soon'}`, `Date: ${iso(x.expires_on)}.`, 'staff_certifications')) n++;
  const vendorCerts = await q(`SELECT vc.id, vc.title, vc.expires_on, (vc.expires_on - current_date) AS days FROM vendor_certificates vc WHERE vc.center_id = $1 AND vc.expires_on IS NOT NULL AND vc.expires_on <= current_date + 30`, [c.id]);
  for (const x of vendorCerts) {
    await q(`UPDATE vendor_certificates SET status = 'expired' WHERE id = $1 AND expires_on < current_date AND status = 'verified'`, [x.id]);
    for (const role of ['director', 'cook'])
      if (await notifyOnce(q, c.id, role, 'vendor_cert_expiring', x.id, `${x.title} ${x.days < 0 ? 'has expired' : 'expires soon'}`, `Date: ${iso(x.expires_on)}. Request a renewed certificate from the vendor.`, 'vendor_certificates')) n++;
  }
  return n;
}

// 7. Weekly hours: a preliminary report on Friday evening and the final one on Monday morning.
export async function weeklyHours(q, c, { force = false } = {}) {
  const dow = (await q(`SELECT extract(isodow FROM $1::date)::int AS d`, [c.today]))[0].d; // 1 = Monday
  const time = c.now_local.slice(0, 5);
  const prelim = dow === 5 && time >= '18:30';
  const final = dow === 1 && time >= '07:00';
  if (!force && !prelim && !final) return 0;
  const ws = (await q(`SELECT ($1::date - (extract(isodow FROM $1::date)::int - 1))::date AS ws`, [c.today]))[0].ws;
  const weekStart = final && !force ? (await q(`SELECT ($1::date - 7)::date AS d`, [iso(ws)]))[0].d : ws;
  const key = `${iso(weekStart)}:${final ? 'final' : 'prelim'}`;
  if (!force && (await q(`SELECT 1 FROM in_app_notifications WHERE kind = 'weekly_hours' AND body LIKE $1 LIMIT 1`, [`%[${key}]%`]))[0]) return 0;
  const built = await buildTimesheets(q, c.id, iso(weekStart));
  await notifyRoles(q, c.id, ['director', 'owner', 'front_office'], 'weekly_hours',
    `${final ? 'Final' : 'Preliminary'} weekly hours are ready`, `Week of ${iso(weekStart)}: ${built.length} timesheets built. Review and approve them. [${key}]`);
  return built.length;
}

export async function buildTimesheets(q, centerId, weekStart) {
  const staff = await q('SELECT id FROM staff WHERE center_id = $1 AND terminated_on IS NULL', [centerId]);
  const out = [];
  for (const s of staff) {
    const status = (await q('SELECT status FROM timesheets WHERE staff_id = $1 AND week_start = $2::date', [s.id, weekStart]))[0]?.status;
    if (status && status !== 'open') continue;
    out.push((await q('SELECT build_timesheet($1, $2::date) AS id', [s.id, weekStart]))[0].id);
  }
  return out;
}

// One pass of everything, for one center.
export async function runAll(ctx, centerId) {
  return ctx.asSystem(async (q) => {
    const c = await centerInfo(q, centerId);
    const result = {};
    result.expected = await generateExpectedAttendance(q, c);
    result.alertsOpened = await scanMissingChildren(q, c);
    result.stepsRun = await runAlertSteps(ctx, q, c);
    result.lateNotices = await punctualityAndLateAlerts(q, c);
    result.missedPunches = await missedPunches(q, c);
    result.certNotices = await certificateAlerts(q, c);
    result.weekly = await weeklyHours(q, c);
    result.templatesDeleted = await deleteQueuedTemplates(ctx, q);
    if (c.now_local >= '07:00') for (const mt of ['breakfast', 'lunch', 'pm_snack']) result['meals_' + mt] = await ensureMealServices(q, c, mt).catch(() => 0);
    return result;
  });
}

export function startScheduler(ctx, intervalMs) {
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      const centers = await ctx.asSystem((q) => q('SELECT id FROM centers'));
      for (const c of centers) await runAll(ctx, c.id);
    } catch (e) { console.error('job run failed:', e.message); }
    finally { busy = false; }
  };
  const t = setInterval(tick, intervalMs);
  setTimeout(tick, 2000);
  return () => clearInterval(t);
}

// Create today's meal service for every classroom from the published menu, with the portion each age group gets.
export async function ensureMealServices(q, c, mealType) {
  const mm = (await q(`SELECT mm.id FROM menu_meals mm JOIN menus m ON m.id = mm.menu_id WHERE m.center_id = $1 AND mm.service_date = $2::date AND mm.meal_type = $3::meal_type`, [c.id, c.today, mealType]))[0];
  const rooms = await q('SELECT id FROM classrooms WHERE center_id = $1 AND is_active', [c.id]);
  let created = 0;
  for (const rm of rooms) {
    const svc = (await q(`INSERT INTO meal_services (center_id, classroom_id, service_date, meal_type, planned_menu_meal_id) VALUES ($1,$2,$3::date,$4::meal_type,$5)
                          ON CONFLICT (classroom_id, service_date, meal_type) DO NOTHING RETURNING id`, [c.id, rm.id, c.today, mealType, mm?.id || null]))[0];
    if (!svc) continue;
    created++;
    if (!mm) continue;
    const groups = await q(`SELECT DISTINCT cacfp_age_group_on(r.child_id, $2::date) AS age_group_id FROM roster_on($1, $2::date) r WHERE r.classroom_id = $3`, [c.id, c.today, rm.id]);
    const items = await q(`SELECT mi.food_item_id, mi.component_code,
                                  (SELECT current_version_id FROM products WHERE id = fi.product_id) AS product_version_id,
                                  (SELECT current_version_id FROM recipes WHERE id = fi.recipe_id) AS recipe_version_id
                             FROM menu_meal_items mi JOIN food_items fi ON fi.id = mi.food_item_id WHERE mi.menu_meal_id = $1`, [mm.id]);
    for (const g of groups.filter((x) => x.age_group_id)) for (const it of items) {
      const ps = (await q(`SELECT id, serving_quantity, serving_unit::text AS serving_unit, piece_count FROM portion_standards
                            WHERE food_item_id = $1 AND age_group_id = $2 AND (meal_type = $3::meal_type OR meal_type IS NULL)
                              AND effective_from <= $4::date AND (effective_to IS NULL OR effective_to >= $4::date) ORDER BY meal_type NULLS LAST LIMIT 1`,
        [it.food_item_id, g.age_group_id, mealType, c.today]))[0];
      if (!ps) continue;
      await q(`INSERT INTO meal_service_items (meal_service_id, food_item_id, component_code, age_group_id, portion_quantity, portion_unit, portion_standard_id, product_version_id, recipe_version_id, pieces_served)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [svc.id, it.food_item_id, it.component_code, g.age_group_id, ps.serving_quantity, ps.serving_unit, ps.id, it.product_version_id, it.recipe_version_id, ps.piece_count]);
    }
  }
  return created;
}

// Templates for the daily parent reports: build drafts for children who were here.
export async function buildDailyReports(q, c) {
  const kids = await q(`SELECT DISTINCT child_id FROM attendance_records WHERE center_id = $1 AND service_date = $2::date AND status = 'present'`, [c.id, c.today]);
  let n = 0;
  for (const k of kids) {
    const pub = (await q(`SELECT 1 FROM daily_reports WHERE child_id = $1 AND report_date = $2::date AND status = 'published'`, [k.child_id, c.today]))[0];
    if (pub) continue;
    await q('SELECT build_daily_report($1, $2::date)', [k.child_id, c.today]); n++;
  }
  return n;
}

// Delete face templates whose consent was withdrawn (the secure store confirms, then the record is marked deleted).
export async function deleteQueuedTemplates(ctx, q) {
  const rows = await q('SELECT id, template_ref FROM staff_biometric_templates WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL');
  for (const t of rows) {
    await ctx.face.deleteTemplate(t.template_ref);
    await q('UPDATE staff_biometric_templates SET deleted_at = now() WHERE id = $1', [t.id]);
  }
  return rows.length;
}
