'use strict';
const db = require('../db');
const { redirect, sendHtml, sendJson, parseJsonBody, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml, groupTabs } = require('../lib/render');
const { hasAccess, isSuperAdmin, hasDirectOrIndirectReports } = require('../lib/auth');
const { getSetting, isModuleEnabled } = require('../lib/settings');

function nowTimeHM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// The Super Admin always keeps access to a disabled module (they're the only
// one who can re-enable it under Settings > System Settings); everyone else
// is bounced back to the dashboard.
function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('tams');
}

module.exports = function (router) {
  router.get('/attendance', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Attendance (TAMS) is not enabled for your company.'));
    const user = ctx.user;
    const today = db.prepare('SELECT * FROM attendance_logs WHERE user_id = ? AND work_date = ?').get(user.id, todayISO());
    const todayPunches = db.prepare('SELECT * FROM attendance_punches WHERE user_id = ? AND work_date = ? ORDER BY id ASC').all(user.id, todayISO());
    const myLogs = db.prepare('SELECT * FROM attendance_logs WHERE user_id = ? ORDER BY work_date DESC LIMIT 30').all(user.id);

    // Determine current status: if last punch was IN, user can clock OUT. If last punch was OUT or no punches, user can clock IN.
    const lastPunch = todayPunches.length > 0 ? todayPunches[todayPunches.length - 1] : null;
    const isClockedInCurrently = lastPunch && lastPunch.action === 'IN';

    let teamHtml = '';
    // Admin/Super Admin see the whole company; anyone listed as a Direct or
    // Indirect Superior sees just their own reports — dynamic replacement
    // for the old fixed Approver role tier (see lib/auth.js).
    const seeAllTeam = hasAccess(user, ['admin']);
    if (seeAllTeam || hasDirectOrIndirectReports(user.id)) {
      // Guardrail: never allow a future-dated attendance query.
      let selectedDate = ctx.url.searchParams.get('date') || todayISO();
      if (selectedDate > todayISO()) selectedDate = todayISO();

      const teamRows = seeAllTeam
        ? db.prepare(`
            SELECT u.id, u.name, u.department, al.clock_in, al.clock_out, al.status, al.clock_in_address, al.clock_out_address, al.clock_in_lat, al.clock_in_lng
            FROM users u LEFT JOIN attendance_logs al ON al.user_id = u.id AND al.work_date = ?
            WHERE u.status = 'active' ORDER BY u.name
          `).all(selectedDate)
        : db.prepare(`
            SELECT u.id, u.name, u.department, al.clock_in, al.clock_out, al.status, al.clock_in_address, al.clock_out_address, al.clock_in_lat, al.clock_in_lng
            FROM users u LEFT JOIN attendance_logs al ON al.user_id = u.id AND al.work_date = ?
            WHERE (u.direct_superior_id = ? OR u.indirect_superior_id = ?) AND u.status = 'active' ORDER BY u.name
          `).all(selectedDate, user.id, user.id);

      teamHtml = card(`
        <div class="flex items-center justify-between mb-4">
          <h2 class="font-semibold">Team attendance</h2>
          <form method="get" action="/attendance" class="flex items-center gap-2 text-sm">
            <input type="date" name="date" value="${escapeHtml(selectedDate)}" max="${todayISO()}" class="rounded-lg border border-slate-300 px-2 py-1 text-sm"/>
            <button class="text-indigo-600 font-medium">Go</button>
          </form>
        </div>
        <div class="overflow-x-auto">
          <table class="data-table w-full">
            <thead><tr><th>Employee</th><th>Department</th><th>First In</th><th>Last Out</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>
              ${teamRows.map((r) => `
                <tr>
                  <td class="font-medium">${escapeHtml(r.name)}</td>
                  <td>${escapeHtml(r.department || '—')}</td>
                  <td>${r.clock_in ? escapeHtml(r.clock_in) : '—'}</td>
                  <td>${r.clock_out ? escapeHtml(r.clock_out) : '—'}</td>
                  <td class="text-xs text-slate-500 max-w-xs truncate" title="${escapeHtml(r.clock_in_address || r.clock_out_address || '')}">
                    ${r.clock_in_address ? `📍 ${escapeHtml(r.clock_in_address)}` : (r.clock_in_lat ? `📍 ${r.clock_in_lat.toFixed(4)}, ${r.clock_in_lng.toFixed(4)}` : '—')}
                  </td>
                  <td>${r.status ? statusBadge(r.status) : `<span class="text-slate-400 text-xs">No record</span>`}</td>
                </tr>
              `).join('') || `<tr><td colspan="6" class="text-center text-slate-400 py-6">No team members found.</td></tr>`}
            </tbody>
          </table>
        </div>
      `, 'mt-6');
    }

    const punchesListHtml = todayPunches.length > 0 ? `
      <div class="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
        <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">Today's Punch Log (${todayPunches.length} punches recorded)</div>
        <div class="space-y-1.5 max-h-36 overflow-y-auto">
          ${todayPunches.map(p => `
            <div class="flex items-center justify-between text-xs px-3 py-1.5 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
              <div class="flex items-center gap-2">
                <span class="px-1.5 py-0.5 rounded text-[10px] font-bold ${p.action === 'IN' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}">${p.action}</span>
                <span class="font-medium text-slate-700 dark:text-slate-300">${escapeHtml(p.punch_time)}</span>
              </div>
              <span class="text-slate-400 truncate max-w-xs" title="${escapeHtml(p.address || '')}">${p.address ? `📍 ${escapeHtml(p.address)}` : '—'}</span>
            </div>
          `).join('')}
        </div>
      </div>
    ` : '';

    const body = `
      ${groupTabs('TAMS', ctx.user, '/attendance')}
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-semibold">Attendance</h1>
      </div>

      ${card(`
        <div class="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h2 class="font-semibold mb-1">Today · ${escapeHtml(todayISO())}</h2>
            <div class="text-sm text-slate-500">
              First Clock in: <span class="font-medium text-slate-700">${today && today.clock_in ? escapeHtml(today.clock_in) : '—'}</span>
              &nbsp;·&nbsp; Last Clock out: <span class="font-medium text-slate-700">${today && today.clock_out ? escapeHtml(today.clock_out) : '—'}</span>
              ${today ? ` &nbsp;·&nbsp; ${statusBadge(today.status)}` : ''}
              ${lastPunch && lastPunch.address ? `<div class="text-xs text-indigo-600 dark:text-indigo-400 mt-1 font-medium truncate" title="${escapeHtml(lastPunch.address)}">📍 Latest: ${escapeHtml(lastPunch.address)} (${lastPunch.action} at ${lastPunch.punch_time})</div>` : ''}
            </div>
          </div>
          <div class="flex gap-3">
            <button data-clock-action="IN" ${isClockedInCurrently ? 'disabled' : ''} class="px-4 py-2 rounded-lg text-sm font-medium ${isClockedInCurrently ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-indigo-600 hover:bg-indigo-700 text-white'}">Clock In</button>
            <button data-clock-action="OUT" ${!isClockedInCurrently ? 'disabled' : ''} class="px-4 py-2 rounded-lg text-sm font-medium ${!isClockedInCurrently ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-slate-800 hover:bg-slate-900 text-white'}">Clock Out</button>
          </div>
        </div>
        ${punchesListHtml}
      `)}

      ${card(`
        <h2 class="font-semibold mb-4">My attendance history</h2>
        <div class="overflow-x-auto">
          <table class="data-table w-full">
            <thead><tr><th>Date</th><th>First In</th><th>Last Out</th><th>Location</th><th>Status</th></tr></thead>
            <tbody>
              ${myLogs.map((l) => `
                <tr>
                  <td class="font-medium">${escapeHtml(l.work_date)}</td>
                  <td>${l.clock_in ? escapeHtml(l.clock_in) : '—'}</td>
                  <td>${l.clock_out ? escapeHtml(l.clock_out) : '—'}</td>
                  <td class="text-xs text-slate-500 max-w-xs truncate" title="${escapeHtml(l.clock_in_address || l.clock_out_address || '')}">
                    ${l.clock_in_address ? `📍 ${escapeHtml(l.clock_in_address)}` : (l.clock_in_lat ? `📍 ${l.clock_in_lat.toFixed(4)}, ${l.clock_in_lng.toFixed(4)}` : '—')}
                  </td>
                  <td>${statusBadge(l.status)}</td>
                </tr>
              `).join('') || `<tr><td colspan="5" class="text-center text-slate-400 py-6">No attendance records yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      `, 'mt-6')}

      ${teamHtml}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Attendance', user, activePath: '/attendance', url: ctx.url, body }));
  });

  router.post('/api/attendance/clock', async (ctx) => {
    if (!ctx.user) return sendJson(ctx.res, 401, { error: 'Not authenticated.' });
    if (!moduleGate(ctx)) return sendJson(ctx.res, 403, { error: 'Attendance (TAMS) is not enabled for your company.' });
    const { action, latitude, longitude } = await parseJsonBody(ctx.req);
    if (action !== 'IN' && action !== 'OUT') return sendJson(ctx.res, 400, { error: 'Invalid action.' });

    const date = todayISO(); // Guardrail: attendance is always recorded against the server's current date, never client-supplied.
    const time = nowTimeHM();
    const existing = db.prepare('SELECT * FROM attendance_logs WHERE user_id = ? AND work_date = ?').get(ctx.user.id, date);

    let lat = latitude ? parseFloat(latitude) : null;
    let lng = longitude ? parseFloat(longitude) : null;
    let address = null;

    if (lat && lng) {
      try {
        const geoUrl = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`;
        const res = await fetch(geoUrl, { headers: { 'User-Agent': 'StaffHub-HRMS/1.0' } });
        const geoData = await res.json();
        address = geoData.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      } catch (e) {
        address = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
      }
    }

    // 1. Record punch in attendance_punches audit table
    db.prepare('INSERT INTO attendance_punches (user_id, work_date, punch_time, action, latitude, longitude, address) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.user.id, date, time, action, lat, lng, address);

    // 2. Update master daily attendance record (First In, Last Out rule)
    if (action === 'IN') {
      const lateCutoff = getSetting('late_cutoff', '09:15');
      const status = time > lateCutoff ? 'late' : 'present';

      if (!existing) {
        // First clock-in of the day
        db.prepare('INSERT INTO attendance_logs (user_id, work_date, clock_in, status, clock_in_lat, clock_in_lng, clock_in_address) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(ctx.user.id, date, time, status, lat, lng, address);
      } else if (!existing.clock_in) {
        db.prepare('UPDATE attendance_logs SET clock_in = ?, status = ?, clock_in_lat = ?, clock_in_lng = ?, clock_in_address = ? WHERE id = ?')
          .run(time, status, lat, lng, address, existing.id);
      }
      // If already clocked in earlier today, keep original first clock_in time & status (first-in rule)
    } else {
      // Clock OUT: always update last clock_out time and location (last-out rule)
      if (existing) {
        db.prepare('UPDATE attendance_logs SET clock_out = ?, clock_out_lat = ?, clock_out_lng = ?, clock_out_address = ? WHERE id = ?')
          .run(time, lat, lng, address, existing.id);
      } else {
        // Edge case: clock out without prior clock in record
        db.prepare('INSERT INTO attendance_logs (user_id, work_date, clock_out, clock_out_lat, clock_out_lng, clock_out_address) VALUES (?, ?, ?, ?, ?, ?)')
          .run(ctx.user.id, date, time, lat, lng, address);
      }
    }

    sendJson(ctx.res, 200, { ok: true, address, action, time });
  });
};
