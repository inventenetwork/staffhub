'use strict';
const db = require('../db');
const { redirect, sendHtml, sendJson, parseBodyAuto, daysBetweenInclusive, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin, hasDirectOrIndirectReports } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

// The Super Admin always keeps access to a disabled module (they're the only
// one who can re-enable it under Settings > System Settings); everyone else
// is bounced back to the dashboard.
function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('leave');
}

// Dynamic replacement for the old fixed Approver role tier: Admin/Super Admin
// see every pending application, and anyone listed as a Direct or Indirect
// Superior sees their own reports' — see lib/auth.js hasDirectOrIndirectReports().
function canApprove(user) {
  return hasAccess(user, ['admin']) || hasDirectOrIndirectReports(user.id);
}

module.exports = function (router) {
  router.get('/api/public-holidays', async (ctx) => {
    const holidays = db.prepare('SELECT holiday_date as date, name FROM public_holidays ORDER BY holiday_date').all();
    sendJson(ctx.res, 200, holidays);
  });
  router.get('/leave', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Leave is not enabled for your company.'));
    const user = ctx.user;
    const year = new Date().getFullYear();
    const userCanApprove = canApprove(user);
    const tabParam = ctx.url.searchParams.get('tab');
    let tab = 'my';
    if (tabParam === 'approvals' && userCanApprove) tab = 'approvals';
    else if (tabParam === 'plan') tab = 'plan';

    const leaveTypes = db.prepare('SELECT * FROM leave_types ORDER BY name').all();
    const holidays = db.prepare('SELECT holiday_date as date, name FROM public_holidays ORDER BY holiday_date').all();
    const balances = db.prepare(`
      SELECT lb.*, lt.name FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.user_id = ? AND lb.year = ? ORDER BY lt.name
    `).all(user.id, year);

    const myApplications = db.prepare(`
      SELECT la.*, lt.name as leave_type_name FROM leave_applications la JOIN leave_types lt ON lt.id = la.leave_type_id
      WHERE la.user_id = ? ORDER BY la.applied_at DESC LIMIT 50
    `).all(user.id);

    const plannedLeaves = db.prepare(`
      SELECT pl.*, lt.name as leave_type_name FROM planned_leaves pl JOIN leave_types lt ON lt.id = pl.leave_type_id
      WHERE pl.user_id = ? ORDER BY pl.start_date ASC
    `).all(user.id);

    let approvalsHtml = '';
    if (userCanApprove) {
      const seeAll = hasAccess(user, ['admin']) ? 1 : 0; // Admin and Super Admin see every pending application
      const pending = db.prepare(`
        SELECT la.*, lt.name as leave_type_name, u.name as employee_name
        FROM leave_applications la
        JOIN leave_types lt ON lt.id = la.leave_type_id
        JOIN users u ON u.id = la.user_id
        WHERE la.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR ? = 1)
        ORDER BY la.applied_at ASC
      `).all(user.id, user.id, seeAll);

      approvalsHtml = `
        <div class="overflow-x-auto">
          <table class="data-table w-full">
            <thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Reason</th><th></th></tr></thead>
            <tbody>
              ${pending.map((l) => `
                <tr>
                  <td class="font-medium">${escapeHtml(l.employee_name)}</td>
                  <td>${escapeHtml(l.leave_type_name)}</td>
                  <td>${escapeHtml(l.start_date)} → ${escapeHtml(l.end_date)}</td>
                  <td>${l.days}</td>
                  <td class="max-w-xs truncate" title="${escapeHtml(l.reason || '')}">${escapeHtml(l.reason || '—')}</td>
                  <td class="whitespace-nowrap">
                    <form method="post" action="/leave/${l.id}/approve" class="inline"><button class="text-emerald-600 font-medium text-xs mr-3">Approve</button></form>
                    <form method="post" action="/leave/${l.id}/reject" class="inline"><button class="text-red-600 font-medium text-xs">Reject</button></form>
                  </td>
                </tr>
              `).join('') || `<tr><td colspan="6" class="text-center text-slate-400 py-6">Nothing pending approval.</td></tr>`}
            </tbody>
          </table>
        </div>
      `;
    }

    const tabs = `
      <div class="flex gap-2 mb-6 text-sm">
        <a href="/leave" class="px-3 py-1.5 rounded-lg font-medium ${tab === 'my' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}">My Leave</a>
        <a href="/leave?tab=plan" class="px-3 py-1.5 rounded-lg font-medium ${tab === 'plan' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}">Plan Leave</a>
        ${userCanApprove ? `<a href="/leave?tab=approvals" class="px-3 py-1.5 rounded-lg font-medium ${tab === 'approvals' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}">Approvals</a>` : ''}
      </div>
    `;

    const myTabBody = `
      <div class="grid lg:grid-cols-3 gap-6">
        <div class="lg:col-span-1">
          ${card(`
            <h2 class="font-semibold mb-4">Apply for leave</h2>
            <form method="post" action="/leave/apply" class="space-y-3 text-sm">
              <div>
                <label class="block text-slate-600 mb-1">Leave type</label>
                <select name="leave_type_id" required class="w-full rounded-lg border border-slate-300 px-3 py-2">
                  ${leaveTypes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
                </select>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div class="relative">
                  <label class="block text-slate-600 mb-1">Start date</label>
                  <div class="relative">
                    <input id="start_date" name="start_date" type="text" placeholder="YYYY-MM-DD" autocomplete="off" required readonly class="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 cursor-pointer bg-white dark:bg-slate-900" data-daypicker-toggle="start_date"/>
                    <button type="button" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" data-daypicker-toggle="start_date">
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 9v7.5"/></svg>
                    </button>
                  </div>
                  <div class="daypicker-panel absolute z-30 mt-1 left-0 w-64 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 bg-white dark:bg-slate-900 shadow-xl" data-daypicker-panel="start_date" hidden></div>
                </div>
                <div class="relative">
                  <label class="block text-slate-600 mb-1">End date</label>
                  <div class="relative">
                    <input id="end_date" name="end_date" type="text" placeholder="YYYY-MM-DD" autocomplete="off" required readonly class="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 cursor-pointer bg-white dark:bg-slate-900" data-daypicker-toggle="end_date"/>
                    <button type="button" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" data-daypicker-toggle="end_date">
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 9v7.5"/></svg>
                    </button>
                  </div>
                  <div class="daypicker-panel absolute z-30 mt-1 right-0 w-64 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 bg-white dark:bg-slate-900 shadow-xl" data-daypicker-panel="end_date" hidden></div>
                </div>
              </div>
              <div class="flex items-center gap-3 text-xs text-slate-500">
                <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-amber-200 inline-block"></span> Weekend</span>
                <span class="flex items-center gap-1"><span class="w-2.5 h-2.5 rounded-full bg-rose-300 inline-block"></span> Public holiday</span>
              </div>
              <div class="text-slate-500 text-xs">Duration: <span id="leave_days_display" class="font-medium text-slate-700">—</span></div>
              <script>window.PUBLIC_HOLIDAYS = ${JSON.stringify(holidays)};</script>
              <div><label class="block text-slate-600 mb-1">Reason</label><textarea name="reason" rows="2" class="w-full rounded-lg border border-slate-300 px-3 py-2"></textarea></div>
              <div><label class="block text-slate-600 mb-1">Medical certificate ref. (if applicable)</label><input name="mc_reference" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
              <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg py-2.5">Submit application</button>
            </form>
          `)}
          ${card(`
            <h2 class="font-semibold mb-3">Balance ${year}</h2>
            <div class="space-y-2 text-sm">
              ${balances.map((b) => `<div class="flex justify-between"><span>${escapeHtml(b.name)}</span><span class="font-medium">${(b.entitled_days - b.used_days).toFixed(1)} / ${b.entitled_days}</span></div>`).join('') || `<p class="text-slate-400">No balance on file.</p>`}
            </div>
          `, 'mt-6')}
        </div>
        <div class="lg:col-span-2">
          ${card(`
            <h2 class="font-semibold mb-4">My applications</h2>
            <div class="overflow-x-auto">
              <table class="data-table w-full">
                <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Applied</th><th>Action</th></tr></thead>
                <tbody>
                  ${myApplications.map((l) => `
                    <tr>
                      <td class="font-medium">${escapeHtml(l.leave_type_name)}</td>
                      <td>${escapeHtml(l.start_date)} → ${escapeHtml(l.end_date)}</td>
                      <td>${l.days}</td>
                      <td>${statusBadge(l.status)}</td>
                      <td class="text-slate-500">${escapeHtml((l.applied_at || '').slice(0, 10))}</td>
                      <td>
                        ${(l.status === 'pending' || l.status === 'approved') ? `
                          <form method="post" action="/leave/${l.id}/cancel" class="inline" onsubmit="return confirm('Are you sure you want to cancel this leave?');">
                            <button class="text-red-600 text-xs font-medium hover:underline">Cancel</button>
                          </form>
                        ` : '—'}
                      </td>
                    </tr>
                  `).join('') || `<tr><td colspan="6" class="text-center text-slate-400 py-6">No applications yet.</td></tr>`}
                </tbody>
              </table>
            </div>
          `)}
        </div>
      </div>
    `;

    const planTabBody = `
      <div class="grid lg:grid-cols-3 gap-6">
        <div class="lg:col-span-1">
          ${card(`
            <h2 class="font-semibold mb-1">Plan leave (tentative)</h2>
            <p class="text-xs text-slate-400 mb-4">Outline tentative leave dates on your planner without deducting from your leave balance.</p>
            <form method="post" action="/leave/plan" class="space-y-3 text-sm">
              <div>
                <label class="block text-slate-600 mb-1">Leave type</label>
                <select name="leave_type_id" required class="w-full rounded-lg border border-slate-300 px-3 py-2">
                  ${leaveTypes.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
                </select>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div class="relative">
                  <label class="block text-slate-600 mb-1">Start date</label>
                  <div class="relative">
                    <input id="plan_start_date" name="start_date" type="text" placeholder="YYYY-MM-DD" autocomplete="off" required readonly class="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 cursor-pointer bg-white dark:bg-slate-900" data-daypicker-toggle="plan_start_date"/>
                    <button type="button" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" data-daypicker-toggle="plan_start_date">
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 9v7.5"/></svg>
                    </button>
                  </div>
                  <div class="daypicker-panel absolute z-30 mt-1 left-0 w-64 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 bg-white dark:bg-slate-900 shadow-xl" data-daypicker-panel="plan_start_date" hidden></div>
                </div>
                <div class="relative">
                  <label class="block text-slate-600 mb-1">End date</label>
                  <div class="relative">
                    <input id="plan_end_date" name="end_date" type="text" placeholder="YYYY-MM-DD" autocomplete="off" required readonly class="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 cursor-pointer bg-white dark:bg-slate-900" data-daypicker-toggle="plan_end_date"/>
                    <button type="button" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" data-daypicker-toggle="plan_end_date">
                      <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 9v7.5"/></svg>
                    </button>
                  </div>
                  <div class="daypicker-panel absolute z-30 mt-1 right-0 w-64 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 bg-white dark:bg-slate-900 shadow-xl" data-daypicker-panel="plan_end_date" hidden></div>
                </div>
              </div>
              <div><label class="block text-slate-600 mb-1">Notes / Tentative reason</label><textarea name="notes" rows="2" class="w-full rounded-lg border border-slate-300 px-3 py-2"></textarea></div>
              <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg py-2.5">Save planned leave</button>
            </form>
          `)}
        </div>
        <div class="lg:col-span-2">
          ${card(`
            <h2 class="font-semibold mb-4">My planned leave entries</h2>
            <div class="overflow-x-auto">
              <table class="data-table w-full">
                <thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Notes</th><th>Action</th></tr></thead>
                <tbody>
                  ${plannedLeaves.map((pl) => {
                    const days = daysBetweenInclusive(pl.start_date, pl.end_date);
                    return `
                      <tr>
                        <td class="font-medium">${escapeHtml(pl.leave_type_name)}</td>
                        <td>${escapeHtml(pl.start_date)} → ${escapeHtml(pl.end_date)}</td>
                        <td>${days}</td>
                        <td class="max-w-xs truncate" title="${escapeHtml(pl.notes || '')}">${escapeHtml(pl.notes || '—')}</td>
                        <td>
                          <form method="post" action="/leave/plan/${pl.id}/delete" class="inline">
                            <button class="text-red-600 text-xs font-medium hover:underline">Remove</button>
                          </form>
                        </td>
                      </tr>
                    `;
                  }).join('') || `<tr><td colspan="5" class="text-center text-slate-400 py-6">No planned leaves yet.</td></tr>`}
                </tbody>
              </table>
            </div>
          `)}
        </div>
      </div>
    `;

    const approvalsTabBody = card(approvalsHtml);

    let tabBody = myTabBody;
    if (tab === 'approvals') tabBody = approvalsTabBody;
    else if (tab === 'plan') tabBody = planTabBody;

    const body = `
      <div class="flex items-center justify-between mb-6"><h1 class="text-2xl font-semibold">Leave</h1></div>
      ${tabs}
      ${tabBody}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Leave', user, activePath: '/leave', url: ctx.url, body }));
  });

  router.post('/leave/apply', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Leave is not enabled for your company.'));
    const b = await parseBodyAuto(ctx.req);
    const leaveTypeId = Number(b.leave_type_id);
    const leaveType = db.prepare('SELECT * FROM leave_types WHERE id = ?').get(leaveTypeId);
    if (!leaveType) return redirect(ctx.res, '/leave?error=' + encodeURIComponent('Invalid leave type.'));
    if (!b.start_date || !b.end_date || b.end_date < b.start_date) {
      return redirect(ctx.res, '/leave?error=' + encodeURIComponent('Please provide a valid date range.'));
    }
    const days = daysBetweenInclusive(b.start_date, b.end_date);
    if (leaveType.requires_mc && !b.mc_reference) {
      return redirect(ctx.res, '/leave?error=' + encodeURIComponent(`${leaveType.name} requires a medical certificate reference.`));
    }

    const year = new Date(b.start_date).getFullYear();
    const balance = db.prepare('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?').get(ctx.user.id, leaveTypeId, year);
    const remaining = balance ? balance.entitled_days - balance.used_days : 0;
    if (days > remaining) {
      return redirect(ctx.res, '/leave?error=' + encodeURIComponent(`Insufficient balance: requested ${days} day(s), ${remaining} day(s) remaining.`));
    }

    const superiorRow = db.prepare('SELECT direct_superior_id FROM users WHERE id = ?').get(ctx.user.id);
    const res = db.prepare(`
      INSERT INTO leave_applications (user_id, leave_type_id, start_date, end_date, days, reason, mc_reference, approver_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ctx.user.id, leaveTypeId, b.start_date, b.end_date, days, b.reason || null, b.mc_reference || null, superiorRow ? superiorRow.direct_superior_id : null);

    logAudit(ctx.user.id, 'apply_leave', { leave_application_id: res.lastInsertRowid, leave_type: leaveType.name, days, start_date: b.start_date, end_date: b.end_date });
    redirect(ctx.res, '/leave?ok=' + encodeURIComponent('Leave application submitted.'));
  });

  router.post('/leave/:id/cancel', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Leave is not enabled for your company.'));
    const id = Number(ctx.params.id);
    const app = db.prepare('SELECT * FROM leave_applications WHERE id = ?').get(id);
    if (!app) return redirect(ctx.res, '/leave?error=' + encodeURIComponent('Application not found.'));
    if (app.user_id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) {
      return redirect(ctx.res, '/leave?error=' + encodeURIComponent('Not authorized.'));
    }
    if (app.status !== 'pending' && app.status !== 'approved') {
      return redirect(ctx.res, '/leave?error=' + encodeURIComponent('Only pending or approved applications can be cancelled.'));
    }

    if (app.status === 'approved') {
      const year = new Date(app.start_date).getFullYear();
      db.prepare(`
        UPDATE leave_balances SET used_days = MAX(0, used_days - ?)
        WHERE user_id = ? AND leave_type_id = ? AND year = ?
      `).run(app.days, app.user_id, app.leave_type_id, year);
    }

    db.prepare("UPDATE leave_applications SET status = 'cancelled' WHERE id = ?").run(id);
    logAudit(ctx.user.id, 'cancel_leave', { leave_application_id: id, previous_status: app.status, days: app.days });
    redirect(ctx.res, '/leave?ok=' + encodeURIComponent('Leave application cancelled.'));
  });

  router.post('/leave/plan', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Leave is not enabled for your company.'));
    const b = await parseBodyAuto(ctx.req);
    const leaveTypeId = Number(b.leave_type_id);
    if (!b.start_date || !b.end_date || b.end_date < b.start_date) {
      return redirect(ctx.res, '/leave?tab=plan&error=' + encodeURIComponent('Please provide a valid date range.'));
    }
    db.prepare(`
      INSERT INTO planned_leaves (user_id, leave_type_id, start_date, end_date, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(ctx.user.id, leaveTypeId, b.start_date, b.end_date, b.notes || null);

    logAudit(ctx.user.id, 'plan_leave', { leave_type_id: leaveTypeId, start_date: b.start_date, end_date: b.end_date });
    redirect(ctx.res, '/leave?tab=plan&ok=' + encodeURIComponent('Leave planned successfully.'));
  });

  router.post('/leave/plan/:id/delete', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Leave is not enabled for your company.'));
    const id = Number(ctx.params.id);
    db.prepare('DELETE FROM planned_leaves WHERE id = ? AND user_id = ?').run(id, ctx.user.id);
    logAudit(ctx.user.id, 'delete_planned_leave', { planned_leave_id: id });
    redirect(ctx.res, '/leave?tab=plan&ok=' + encodeURIComponent('Planned leave entry removed.'));
  });

  function decide(status) {
    return async (ctx) => {
      if (!canApprove(ctx.user)) return redirect(ctx.res, '/leave?error=' + encodeURIComponent('Not authorized.'));
      if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Leave is not enabled for your company.'));
      const id = Number(ctx.params.id);
      const app = db.prepare('SELECT * FROM leave_applications WHERE id = ?').get(id);
      if (!app || app.status !== 'pending') return redirect(ctx.res, '/leave?tab=approvals&error=' + encodeURIComponent('Application not found or already decided.'));

      db.prepare('UPDATE leave_applications SET status = ?, approver_id = ?, decided_at = datetime(\'now\') WHERE id = ?').run(status, ctx.user.id, id);

      if (status === 'approved') {
        const year = new Date(app.start_date).getFullYear();
        db.prepare(`
          INSERT INTO leave_balances (user_id, leave_type_id, year, entitled_days, used_days)
          VALUES (?, ?, ?, 0, ?)
          ON CONFLICT(user_id, leave_type_id, year) DO UPDATE SET used_days = used_days + excluded.used_days
        `).run(app.user_id, app.leave_type_id, year, app.days);
      }
      logAudit(ctx.user.id, `leave_application_${status}`, { leave_application_id: id, employee_id: app.user_id, days: app.days });
      redirect(ctx.res, '/leave?tab=approvals&ok=' + encodeURIComponent(`Application ${status}.`));
    };
  }
  router.post('/leave/:id/approve', decide('approved'));
  router.post('/leave/:id/reject', decide('rejected'));
};
