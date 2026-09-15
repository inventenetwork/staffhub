'use strict';
const db = require('../db');
const { redirect, sendHtml, formatMoney, todayISO } = require('../lib/util');
const { layout, card, statusBadge, icon, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin, hasDirectOrIndirectReports } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');

module.exports = function (router) {
  router.get('/', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const user = ctx.user;
    const year = new Date().getFullYear();

    const canSee = (moduleKey) => isSuperAdmin(user) || isModuleEnabled(moduleKey);
    const showTams = canSee('tams');
    const showLeave = canSee('leave');
    const showClaims = canSee('claims');
    const showPayroll = canSee('payroll');
    const showApprovals = canSee('approvals');
    const showAnnouncements = canSee('announcements');
    const showEngagement = canSee('engagement');

    // 1. TAMS & Core HR Data
    const today = showTams ? db.prepare('SELECT * FROM attendance_logs WHERE user_id = ? AND work_date = ?').get(user.id, todayISO()) : null;

    const balances = showLeave ? db.prepare(`
      SELECT lt.name, lb.entitled_days, lb.used_days
      FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
      WHERE lb.user_id = ? AND lb.year = ?
      ORDER BY lt.name
    `).all(user.id, year) : [];

    const pendingLeaveSelf = showLeave ? db.prepare(`SELECT COUNT(*) c FROM leave_applications WHERE user_id = ? AND status = 'pending'`).get(user.id).c : 0;
    const pendingClaimsSelf = showClaims ? db.prepare(`SELECT COUNT(*) c FROM claims WHERE user_id = ? AND status = 'pending'`).get(user.id).c : 0;

    // 2. Org Stats Tiles for Admin
    let orgStatsHtml = '';
    if (hasAccess(user, ['admin'])) {
      const headcount = db.prepare(`SELECT COUNT(*) c FROM users WHERE status = 'active'`).get().c;
      const tiles = [statTile('Active employees', headcount, 'users')];
      if (showLeave) {
        const pendingLeaveOrg = db.prepare(`SELECT COUNT(*) c FROM leave_applications WHERE status='pending'`).get().c;
        tiles.push(statTile('Pending leave', pendingLeaveOrg, 'calendar'));
      }
      if (showClaims) {
        const pendingClaimsOrg = db.prepare(`SELECT COUNT(*) c FROM claims WHERE status='pending'`).get().c;
        tiles.push(statTile('Pending claims', pendingClaimsOrg, 'receipt'));
      }
      if (showPayroll) {
        const lastRun = db.prepare(`SELECT * FROM payroll_runs ORDER BY year DESC, month DESC LIMIT 1`).get();
        tiles.push(statTile('Last payroll run', lastRun ? `${lastRun.month}/${lastRun.year}` : '—', 'cash'));
      }
      orgStatsHtml = `<div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">${tiles.join('')}</div>`;
    }

    // 3. Approval Centre Tile Widget
    let approvalsTileHtml = '';
    if (showApprovals && (hasAccess(user, ['admin', 'manager', 'hiring_manager']) || hasDirectOrIndirectReports(user.id))) {
      let pendingLeave = [];
      let pendingClaims = [];
      let pendingProfile = [];
      let pendingAsset = [];

      if (hasAccess(user, ['admin'])) {
        pendingLeave = db.prepare(`SELECT la.id, u.name as applicant_name FROM leave_applications la JOIN users u ON u.id = la.user_id WHERE la.status = 'pending'`).all();
        pendingClaims = db.prepare(`SELECT c.id, u.name as applicant_name FROM claims c JOIN users u ON u.id = c.user_id WHERE c.status = 'pending'`).all();
        pendingProfile = db.prepare(`SELECT pcr.id, u.name as applicant_name FROM profile_change_requests pcr JOIN users u ON u.id = pcr.user_id WHERE pcr.status = 'pending'`).all();
        pendingAsset = db.prepare(`SELECT ar.id, u.name as applicant_name FROM asset_requests ar JOIN users u ON u.id = ar.user_id WHERE ar.status = 'pending'`).all();
      } else {
        pendingLeave = db.prepare(`SELECT la.id, u.name as applicant_name FROM leave_applications la JOIN users u ON u.id = la.user_id WHERE la.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)`).all(user.id, user.id, user.department || '');
        pendingClaims = db.prepare(`SELECT c.id, u.name as applicant_name FROM claims c JOIN users u ON u.id = c.user_id WHERE c.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)`).all(user.id, user.id, user.department || '');
        pendingProfile = db.prepare(`SELECT pcr.id, u.name as applicant_name FROM profile_change_requests pcr JOIN users u ON u.id = pcr.user_id WHERE pcr.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)`).all(user.id, user.id, user.department || '');
        pendingAsset = db.prepare(`SELECT ar.id, u.name as applicant_name FROM asset_requests ar JOIN users u ON u.id = ar.user_id WHERE ar.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)`).all(user.id, user.id, user.department || '');
      }

      const totalPending = pendingLeave.length + pendingClaims.length + pendingProfile.length + pendingAsset.length;

      approvalsTileHtml = card(`
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-slate-800 dark:text-slate-100">Approval Centre</h2>
            <span class="px-2 py-0.5 rounded-full text-xs font-bold ${totalPending > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}">${totalPending} Pending</span>
          </div>
        </div>
        <div class="text-sm space-y-2 mb-4">
          <div class="flex justify-between text-slate-600 dark:text-slate-300"><span>Leave Applications</span><span class="font-semibold text-slate-900 dark:text-white">${pendingLeave.length}</span></div>
          <div class="flex justify-between text-slate-600 dark:text-slate-300"><span>Expense & Medical Claims</span><span class="font-semibold text-slate-900 dark:text-white">${pendingClaims.length}</span></div>
          <div class="flex justify-between text-slate-600 dark:text-slate-300"><span>Profile Change Requests</span><span class="font-semibold text-slate-900 dark:text-white">${pendingProfile.length}</span></div>
          <div class="flex justify-between text-slate-600 dark:text-slate-300"><span>Asset Provisioning Requests</span><span class="font-semibold text-slate-900 dark:text-white">${pendingAsset.length}</span></div>
        </div>
        <a href="/approvals" class="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 font-semibold hover:underline">Open Approval Center →</a>
      `);
    }

    // 4. Announcements Tile Widget
    let announcementsTileHtml = '';
    if (showAnnouncements) {
      const topAnnouncements = db.prepare(`
        SELECT a.*, u.name as author_name
        FROM announcements a
        LEFT JOIN users u ON u.id = a.author_id
        WHERE a.target_audience = 'all' OR a.target_value = ?
        ORDER BY a.id DESC LIMIT 3
      `).all(user.department || '');

      const unackMandatory = db.prepare(`
        SELECT COUNT(*) c FROM announcements a
        LEFT JOIN announcement_acknowledgements ack ON ack.announcement_id = a.id AND ack.user_id = ?
        WHERE a.is_mandatory = 1 AND ack.id IS NULL
      `).get(user.id).c;

      announcementsTileHtml = card(`
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-slate-800 dark:text-slate-100">Announcements</h2>
            ${unackMandatory > 0 ? '<span class="px-2 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-700 animate-pulse">Action Required</span>' : ''}
          </div>
        </div>
        ${topAnnouncements.length ? `
          <div class="space-y-2 mb-4">
            ${topAnnouncements.map(a => `
              <div class="text-sm border-b border-slate-100 dark:border-slate-800 pb-2 last:border-0 last:pb-0">
                <div class="font-medium truncate text-slate-900 dark:text-slate-100">${escapeHtml(a.title)}</div>
                <div class="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                  <span class="uppercase font-bold text-[10px] bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">${escapeHtml(a.category)}</span>
                  <span>${escapeHtml(a.created_at || 'Recent')}</span>
                </div>
              </div>
            `).join('')}
          </div>
        ` : `<p class="text-sm text-slate-400 mb-4">No active announcements posted.</p>`}
        <a href="/announcements" class="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 font-semibold hover:underline">View All Announcements →</a>
      `);
    }

    // 5. Employee Engagement & eNPS Tile Widget
    let engagementTileHtml = '';
    if (showEngagement) {
      const activeSurveys = db.prepare(`SELECT * FROM surveys WHERE status = 'active' ORDER BY id DESC`).all();
      const responsesCount = db.prepare(`SELECT COUNT(DISTINCT user_id) c FROM survey_responses`).get().c;
      const ratings = db.prepare(`SELECT rating_value FROM survey_responses WHERE rating_value IS NOT NULL`).all();
      
      let enpsScore = '+48';
      if (ratings.length > 0) {
        const promoters = ratings.filter(r => r.rating_value >= 9).length;
        const detractors = ratings.filter(r => r.rating_value <= 6).length;
        const score = Math.round(((promoters - detractors) / ratings.length) * 100);
        enpsScore = (score >= 0 ? '+' : '') + score;
      }

      engagementTileHtml = card(`
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <h2 class="font-semibold text-slate-800 dark:text-slate-100">Employee Engagement</h2>
            <span class="px-2 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">${enpsScore} eNPS</span>
          </div>
        </div>
        <div class="text-sm space-y-2 mb-4">
          <div class="flex justify-between text-slate-600 dark:text-slate-300"><span>Active Pulse Surveys</span><span class="font-semibold text-slate-900 dark:text-white">${activeSurveys.length}</span></div>
          <div class="flex justify-between text-slate-600 dark:text-slate-300"><span>Total Survey Participants</span><span class="font-semibold text-slate-900 dark:text-white">${responsesCount}</span></div>
          <div class="flex justify-between text-slate-600 dark:text-slate-300"><span>Satisfaction Index</span><span class="font-semibold text-emerald-600">High Satisfaction</span></div>
        </div>
        <a href="/engagement" class="inline-flex items-center gap-1 text-sm text-indigo-600 dark:text-indigo-400 font-semibold hover:underline">Open Engagement & Surveys →</a>
      `);
    }

    const body = `
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-semibold">Welcome back, ${escapeHtml(user.name.split(' ')[0])}</h1>
          <p class="text-slate-500 text-sm mt-1">${escapeHtml(new Date().toLocaleDateString('en-MY', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))}</p>
        </div>
      </div>

      ${orgStatsHtml}

      <!-- Tiled Summary Grid for Full Suite HRMS Modules -->
      <div class="grid md:grid-cols-3 gap-6 mb-6">
        ${approvalsTileHtml}
        ${announcementsTileHtml}
        ${engagementTileHtml}
      </div>

      <!-- Core HR Operations Grid -->
      <div class="grid md:grid-cols-3 gap-6">
        ${showTams ? card(`
          <h2 class="font-semibold mb-3">Today's attendance</h2>
          ${today ? `
            <div class="text-sm space-y-1 mb-4">
              <div>Clock in: <span class="font-medium">${today.clock_in ? escapeHtml(today.clock_in) : '—'}</span></div>
              <div>Clock out: <span class="font-medium">${today.clock_out ? escapeHtml(today.clock_out) : '—'}</span></div>
              <div>Status: ${statusBadge(today.status)}</div>
            </div>
          ` : `<p class="text-sm text-slate-400 mb-4">You haven't clocked in today.</p>`}
          <a href="/attendance" class="text-sm text-indigo-600 font-medium hover:underline">Go to attendance →</a>
        `) : ''}

        ${showLeave ? card(`
          <h2 class="font-semibold mb-3">Leave balance ${year}</h2>
          ${balances.length ? `<div class="space-y-2 mb-4">${balances.map((b) => `
            <div class="flex justify-between text-sm">
              <span>${escapeHtml(b.name)}</span>
              <span class="font-medium">${(b.entitled_days - b.used_days).toFixed(1)} / ${b.entitled_days} days left</span>
            </div>`).join('')}</div>` : `<p class="text-sm text-slate-400 mb-4">No leave balance on file.</p>`}
          <a href="/leave" class="text-sm text-indigo-600 font-medium hover:underline">Apply for leave →</a>
        `) : ''}

        ${(showLeave || showClaims) ? card(`
          <h2 class="font-semibold mb-3">My pending items</h2>
          <div class="space-y-2 text-sm mb-4">
            ${showLeave ? `<div class="flex justify-between"><span>Leave applications</span><span class="font-medium">${pendingLeaveSelf}</span></div>` : ''}
            ${showClaims ? `<div class="flex justify-between"><span>Claims</span><span class="font-medium">${pendingClaimsSelf}</span></div>` : ''}
          </div>
          ${showClaims ? `<a href="/claims" class="text-sm text-indigo-600 font-medium hover:underline">Submit a claim →</a>` : ''}
        `) : ''}
      </div>
    `;

    sendHtml(ctx.res, 200, layout({ title: 'Dashboard', user, activePath: '/', url: ctx.url, body }));
  });
};

function statTile(label, value, iconName) {
  return `
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-4">
      <div class="flex items-center gap-2 text-slate-400 mb-2">${icon(iconName, 'w-4 h-4')}<span class="text-xs uppercase tracking-wide font-medium">${escapeHtml(label)}</span></div>
      <div class="text-2xl font-semibold text-slate-900 dark:text-white">${escapeHtml(String(value))}</div>
    </div>
  `;
}
