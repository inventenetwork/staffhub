'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('org');
}

module.exports = function (router) {
  router.get('/org', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Organization Management is disabled.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'chart';

    const subTabs = [
      { id: 'chart', label: 'Org Chart' },
      { id: 'departments', label: 'Department & Position Settings' },
      { id: 'headcount', label: 'Headcount & Position Planning' },
      { id: 'lines', label: 'Reporting Line Management' },
    ];

    // Data for Org Chart
    const allUsers = db.prepare(`
      SELECT u.id, u.employee_no, u.name, u.email, u.department, u.position, u.direct_superior_id, u.indirect_superior_id,
             m.name as manager_name
      FROM users u
      LEFT JOIN users m ON m.id = u.direct_superior_id
      WHERE u.status = 'active'
      ORDER BY u.name
    `).all();

    // Data for Headcount Planning
    const headcountPlans = db.prepare('SELECT * FROM headcount_plans ORDER BY year DESC, department ASC').all();
    const depts = db.prepare("SELECT value FROM list_options WHERE list_key = 'department' ORDER BY value").all();
    const positions = db.prepare("SELECT value FROM list_options WHERE list_key = 'position' ORDER BY value").all();

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Organization Management</h1>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/org?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'chart') {
      content += `
        ${card('Interactive Organization Hierarchy', `
          <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap:16px;">
            ${allUsers.map(u => `
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px;">
                <div style="font-weight:700; font-size:15px; color:#1f2937;">${escapeHtml(u.name)}</div>
                <div style="font-size:13px; color:#2563eb; font-weight:600; margin-top:2px;">${escapeHtml(u.position || 'Staff')}</div>
                <div style="font-size:12px; color:#6b7280; margin-top:4px;">${escapeHtml(u.department || 'General')} (${escapeHtml(u.employee_no)})</div>
                <div style="margin-top:10px; padding-top:8px; border-top:1px solid #e5e7eb; font-size:12px; color:#4b5563;">
                  <strong>Direct Superior:</strong> ${escapeHtml(u.manager_name || 'Top Executive / None')}
                </div>
              </div>
            `).join('')}
          </div>
        `)}
      `;
    } else if (tab === 'departments') {
      content += `
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
          ${card('Departments Catalog', `
            <table style="width:100%; border-collapse:collapse; font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                  <th style="padding:8px;">Department Name</th>
                </tr>
              </thead>
              <tbody>
                ${depts.map(d => `<tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:8px; font-weight:600;">${escapeHtml(d.value)}</td></tr>`).join('')}
              </tbody>
            </table>
          `)}

          ${card('Positions Catalog', `
            <table style="width:100%; border-collapse:collapse; font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                  <th style="padding:8px;">Position Title</th>
                </tr>
              </thead>
              <tbody>
                ${positions.map(p => `<tr style="border-bottom:1px solid #f3f4f6;"><td style="padding:8px; font-weight:600;">${escapeHtml(p.value)}</td></tr>`).join('')}
              </tbody>
            </table>
          `)}
        </div>
      `;
    } else if (tab === 'headcount') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Headcount & Position Planning (Budgeted vs Actual)', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Department</th>
                    <th style="padding:10px;">Year</th>
                    <th style="padding:10px;">Budgeted</th>
                    <th style="padding:10px;">Actual</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${headcountPlans.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No headcount plans recorded.</td></tr>' : ''}
                  ${headcountPlans.map(hp => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(hp.department)}</td>
                      <td style="padding:10px;">${hp.year}</td>
                      <td style="padding:10px; font-weight:700;">${hp.budgeted_headcount}</td>
                      <td style="padding:10px;">${hp.actual_headcount}</td>
                      <td style="padding:10px;">${statusBadge(hp.status)}</td>
                      <td style="padding:10px;">
                        ${hp.status === 'pending_approval' && isSuperAdmin(user) ? `
                          <form method="POST" action="/org/headcount/${hp.id}/approve" style="display:inline;">
                            <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve Threshold</button>
                          </form>
                        ` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>

          ${hasAccess(user, ['admin']) ? `
            <div>
              ${card('New Headcount Plan', `
                <form method="POST" action="/org/headcount">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Department</label>
                    <select name="department" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      ${depts.map(d => `<option value="${d.value}">${escapeHtml(d.value)}</option>`).join('')}
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Year</label>
                    <input type="number" name="year" value="${new Date().getFullYear()}" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Budgeted Headcount Target</label>
                    <input type="number" name="budgeted_headcount" min="1" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    <span style="font-size:11px; color:#6b7280;">Plans > 10 headcount require Super Admin threshold approval.</span>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Plan</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    } else if (tab === 'lines') {
      content += `
        ${card('Reporting Line Matrix', `
          <table style="width:100%; border-collapse:collapse; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Employee</th>
                <th style="padding:10px;">Department</th>
                <th style="padding:10px;">Current Direct Superior</th>
                <th style="padding:10px;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${allUsers.map(u => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-weight:600;">${escapeHtml(u.name)} (${escapeHtml(u.employee_no)})</td>
                  <td style="padding:10px;">${escapeHtml(u.department || 'General')}</td>
                  <td style="padding:10px;">${escapeHtml(u.manager_name || 'Unassigned')}</td>
                  <td style="padding:10px;">
                    ${hasAccess(user, ['admin']) ? `
                      <form method="POST" action="/org/reporting-line" style="display:flex; gap:8px;">
                        <input type="hidden" name="user_id" value="${u.id}">
                        <select name="direct_superior_id" style="font-size:12px; padding:4px; border:1px solid #d1d5db; border-radius:4px;">
                          <option value="">Select Superior</option>
                          ${allUsers.filter(x => x.id !== u.id).map(m => `<option value="${m.id}" ${m.id === u.direct_superior_id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
                        </select>
                        <button type="submit" style="padding:4px 8px; font-size:12px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer;">Update</button>
                      </form>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Organization Management - StaffHub', body: content, user, activePath: '/org' }));
  });

  // Action: Submit Headcount Plan
  router.post('/org/headcount', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { department, year, budgeted_headcount } = body;
    const budgeted = parseInt(budgeted_headcount || '0', 10);
    const actual = db.prepare("SELECT COUNT(*) c FROM users WHERE department = ? AND status = 'active'").get(department).c;
    const status = budgeted > 10 && !isSuperAdmin(ctx.user) ? 'pending_approval' : 'approved';

    db.prepare(`
      INSERT INTO headcount_plans (department, year, budgeted_headcount, actual_headcount, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(department, parseInt(year, 10), budgeted, actual, status);

    logAudit(ctx.user.id, 'create_headcount_plan', `Created headcount plan for ${department} (${year})`);
    redirect(ctx.res, '/org?tab=headcount');
  });

  // Action: Approve Headcount Plan Threshold
  router.post('/org/headcount/:id/approve', async (ctx) => {
    if (!ctx.user || !isSuperAdmin(ctx.user)) return redirect(ctx.res, '/login');
    const hpId = parseInt(ctx.params.id, 10);
    db.prepare(`UPDATE headcount_plans SET status = 'approved' WHERE id = ?`).run(hpId);
    logAudit(ctx.user.id, 'approve_headcount_plan', `Super Admin approved headcount plan #${hpId}`);
    redirect(ctx.res, '/org?tab=headcount');
  });

  // Action: Update Reporting Line
  router.post('/org/reporting-line', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { user_id, direct_superior_id } = body;
    db.prepare(`UPDATE users SET direct_superior_id = ? WHERE id = ?`).run(direct_superior_id ? parseInt(direct_superior_id, 10) : null, parseInt(user_id, 10));
    logAudit(ctx.user.id, 'update_reporting_line', `Updated direct superior for user #${user_id}`);
    redirect(ctx.res, '/org?tab=lines');
  });
};
