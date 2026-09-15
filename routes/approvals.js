'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin, hasDirectOrIndirectReports } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('approvals');
}

function canViewApprovals(user) {
  return hasAccess(user, ['admin', 'manager', 'hiring_manager']) || hasDirectOrIndirectReports(user.id);
}

module.exports = function (router) {
  router.get('/approvals', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Approval Center is disabled.'));
    if (!canViewApprovals(ctx.user)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Access denied to Approval Center.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'inbox';

    const subTabs = [
      { id: 'inbox', label: 'Pending Approvals Inbox' },
      { id: 'history', label: 'Approval History' },
      { id: 'delegations', label: 'Delegate Approval' },
      { id: 'settings', label: 'Approval Routing Settings' },
    ];

    // Gather pending approvals from all modules
    let leavePending = [];
    let claimsPending = [];
    let profilePending = [];
    let reqPending = [];
    let assetPending = [];

    const isAdmin = isSuperAdmin(user) || hasAccess(user, ['admin']);

    if (isAdmin) {
      leavePending = db.prepare(`
        SELECT la.*, lt.name as type_name, u.name as applicant_name, u.employee_no, u.department
        FROM leave_applications la
        JOIN leave_types lt ON lt.id = la.leave_type_id
        JOIN users u ON u.id = la.user_id
        WHERE la.status = 'pending' ORDER BY la.applied_at DESC
      `).all();

      claimsPending = db.prepare(`
        SELECT c.*, u.name as applicant_name, u.employee_no, u.department
        FROM claims c
        JOIN users u ON u.id = c.user_id
        WHERE c.status = 'pending' ORDER BY c.submitted_at DESC
      `).all();

      profilePending = db.prepare(`
        SELECT pcr.*, u.name as applicant_name, u.employee_no, u.department
        FROM profile_change_requests pcr
        JOIN users u ON u.id = pcr.user_id
        WHERE pcr.status = 'pending' ORDER BY pcr.requested_at DESC
      `).all();

      reqPending = db.prepare(`
        SELECT r.*, u.name as hiring_manager_name
        FROM job_requisitions r
        LEFT JOIN users u ON u.id = r.hiring_manager_id
        WHERE r.status = 'pending_approval' ORDER BY r.created_at DESC
      `).all();

      assetPending = db.prepare(`
        SELECT ar.*, u.name as applicant_name, u.employee_no, u.department
        FROM asset_requests ar
        JOIN users u ON u.id = ar.user_id
        WHERE ar.status = 'pending' ORDER BY ar.created_at DESC
      `).all();
    } else {
      leavePending = db.prepare(`
        SELECT la.*, lt.name as type_name, u.name as applicant_name, u.employee_no, u.department
        FROM leave_applications la
        JOIN leave_types lt ON lt.id = la.leave_type_id
        JOIN users u ON u.id = la.user_id
        WHERE la.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)
        ORDER BY la.applied_at DESC
      `).all(user.id, user.id, user.department || '');

      claimsPending = db.prepare(`
        SELECT c.*, u.name as applicant_name, u.employee_no, u.department
        FROM claims c
        JOIN users u ON u.id = c.user_id
        WHERE c.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)
        ORDER BY c.submitted_at DESC
      `).all(user.id, user.id, user.department || '');

      profilePending = db.prepare(`
        SELECT pcr.*, u.name as applicant_name, u.employee_no, u.department
        FROM profile_change_requests pcr
        JOIN users u ON u.id = pcr.user_id
        WHERE pcr.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)
        ORDER BY pcr.requested_at DESC
      `).all(user.id, user.id, user.department || '');

      reqPending = db.prepare(`
        SELECT r.*, u.name as hiring_manager_name
        FROM job_requisitions r
        LEFT JOIN users u ON u.id = r.hiring_manager_id
        WHERE r.status = 'pending_approval' AND (r.hiring_manager_id = ? OR r.department = ?)
        ORDER BY r.created_at DESC
      `).all(user.id, user.department || '');

      assetPending = db.prepare(`
        SELECT ar.*, u.name as applicant_name, u.employee_no, u.department
        FROM asset_requests ar
        JOIN users u ON u.id = ar.user_id
        WHERE ar.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR u.department = ?)
        ORDER BY ar.created_at DESC
      `).all(user.id, user.id, user.department || '');
    }

    const totalPending = leavePending.length + claimsPending.length + profilePending.length + reqPending.length + assetPending.length;

    // Delegations & Colleagues list
    const delegations = db.prepare(`
      SELECT d.*, u1.name as delegator_name, u2.name as delegate_name
      FROM approval_delegations d
      JOIN users u1 ON u1.id = d.delegator_id
      JOIN users u2 ON u2.id = d.delegate_id
      ORDER BY d.id DESC
    `).all();

    const colleagues = db.prepare("SELECT id, name, employee_no, department FROM users WHERE id != ? AND status = 'active' ORDER BY name").all(user.id);

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <div>
          <h1 style="font-size:24px; font-weight:700; margin:0;">Unified Approval Center</h1>
          <p style="color:#6b7280; font-size:14px; margin:4px 0 0 0;">Review and act on pending action items across all modules in one place.</p>
        </div>
        <span style="background:#eff6ff; color:#1d4ed8; font-weight:700; padding:6px 14px; border-radius:20px; font-size:14px;">${totalPending} Pending Item(s)</span>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/approvals?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'inbox') {
      content += `
        <div style="display:flex; flex-direction:column; gap:20px;">
          <!-- Leave Approvals -->
          ${card(`Leave Applications (${leavePending.length})`, `
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                  <th style="padding:10px;">Applicant</th>
                  <th style="padding:10px;">Leave Type</th>
                  <th style="padding:10px;">Dates</th>
                  <th style="padding:10px;">Days</th>
                  <th style="padding:10px;">Reason</th>
                  <th style="padding:10px;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${leavePending.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No pending leave applications.</td></tr>' : ''}
                ${leavePending.map(l => `
                  <tr style="border-bottom:1px solid #f3f4f6;">
                    <td style="padding:10px; font-weight:600;">${escapeHtml(l.applicant_name)} <span style="font-size:12px; color:#6b7280;">(${escapeHtml(l.employee_no)})</span></td>
                    <td style="padding:10px;">${escapeHtml(l.type_name)}</td>
                    <td style="padding:10px;">${escapeHtml(l.start_date)} → ${escapeHtml(l.end_date)}</td>
                    <td style="padding:10px;">${l.total_days}</td>
                    <td style="padding:10px;">${escapeHtml(l.reason || '-')}</td>
                    <td style="padding:10px;">
                      <form method="POST" action="/leave/${l.id}/approve" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve</button>
                      </form>
                      <form method="POST" action="/leave/${l.id}/reject" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#ef4444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Reject</button>
                      </form>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `)}

          <!-- Claims Approvals -->
          ${card(`Expense & Medical Claims (${claimsPending.length})`, `
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                  <th style="padding:10px;">Applicant</th>
                  <th style="padding:10px;">Category</th>
                  <th style="padding:10px;">Amount</th>
                  <th style="padding:10px;">Description</th>
                  <th style="padding:10px;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${claimsPending.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No pending claims.</td></tr>' : ''}
                ${claimsPending.map(c => `
                  <tr style="border-bottom:1px solid #f3f4f6;">
                    <td style="padding:10px; font-weight:600;">${escapeHtml(c.applicant_name)}</td>
                    <td style="padding:10px; text-transform:capitalize;">${escapeHtml(c.category)} (${escapeHtml(c.subcategory || '')})</td>
                    <td style="padding:10px; font-weight:700;">RM ${Number(c.amount).toFixed(2)}</td>
                    <td style="padding:10px;">${escapeHtml(c.description || '-')}</td>
                    <td style="padding:10px;">
                      <form method="POST" action="/claims/${c.id}/approve" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve</button>
                      </form>
                      <form method="POST" action="/claims/${c.id}/reject" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#ef4444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Reject</button>
                      </form>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `)}

          <!-- Job Requisitions Approvals -->
          ${card(`Job Requisitions (${reqPending.length})`, `
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                  <th style="padding:10px;">Position Title</th>
                  <th style="padding:10px;">Department</th>
                  <th style="padding:10px;">Headcount</th>
                  <th style="padding:10px;">Hiring Manager</th>
                  <th style="padding:10px;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${reqPending.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No pending job requisitions.</td></tr>' : ''}
                ${reqPending.map(r => `
                  <tr style="border-bottom:1px solid #f3f4f6;">
                    <td style="padding:10px; font-weight:600;">${escapeHtml(r.title)}</td>
                    <td style="padding:10px;">${escapeHtml(r.department)}</td>
                    <td style="padding:10px;">${r.headcount}</td>
                    <td style="padding:10px;">${escapeHtml(r.hiring_manager_name || 'Unassigned')}</td>
                    <td style="padding:10px;">
                      <form method="POST" action="/recruitment/requisitions/${r.id}/approve" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve</button>
                      </form>
                      <form method="POST" action="/recruitment/requisitions/${r.id}/reject" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#ef4444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Reject</button>
                      </form>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `)}

          <!-- Asset Requests Approvals -->
          ${card(`Asset Requests (${assetPending.length})`, `
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                  <th style="padding:10px;">Applicant</th>
                  <th style="padding:10px;">Asset Category</th>
                  <th style="padding:10px;">Reason</th>
                  <th style="padding:10px;">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${assetPending.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No pending asset requests.</td></tr>' : ''}
                ${assetPending.map(a => `
                  <tr style="border-bottom:1px solid #f3f4f6;">
                    <td style="padding:10px; font-weight:600;">${escapeHtml(a.applicant_name)}</td>
                    <td style="padding:10px;">${escapeHtml(a.asset_category)}</td>
                    <td style="padding:10px;">${escapeHtml(a.reason || '-')}</td>
                    <td style="padding:10px;">
                      <form method="POST" action="/assets/requests/${a.id}/approve" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve</button>
                      </form>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `)}
        </div>
      `;
    } else if (tab === 'history') {
      const history = db.prepare(`
        SELECT al.*, u.name as actor_name
        FROM audit_logs al
        LEFT JOIN users u ON u.id = al.user_id
        WHERE al.action LIKE '%approve%' OR al.action LIKE '%reject%'
        ORDER BY al.created_at DESC LIMIT 50
      `).all();

      content += `
        ${card('Approval Decision History', `
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Timestamp</th>
                <th style="padding:10px;">Decision Maker</th>
                <th style="padding:10px;">Action Taken</th>
                <th style="padding:10px;">Details</th>
              </tr>
            </thead>
            <tbody>
              ${history.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No decision history logged.</td></tr>' : ''}
              ${history.map(h => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(h.created_at)}</td>
                  <td style="padding:10px; font-weight:600;">${escapeHtml(h.actor_name || 'System')}</td>
                  <td style="padding:10px;">
                    <span style="padding:2px 8px; border-radius:4px; font-size:12px; font-weight:600; background:${h.action.includes('approve') ? '#d1fae5' : '#fee2e2'}; color:${h.action.includes('approve') ? '#065f46' : '#991b1b'};">
                      ${escapeHtml(h.action)}
                    </span>
                  </td>
                  <td style="padding:10px;">${escapeHtml(h.details || '')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    } else if (tab === 'delegations') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Active Approval Delegations', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Delegator</th>
                    <th style="padding:10px;">Delegate To</th>
                    <th style="padding:10px;">Start Date</th>
                    <th style="padding:10px;">End Date</th>
                    <th style="padding:10px;">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  ${delegations.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No approval delegations configured.</td></tr>' : ''}
                  ${delegations.map(d => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(d.delegator_name)}</td>
                      <td style="padding:10px; font-weight:600; color:#2563eb;">${escapeHtml(d.delegate_name)}</td>
                      <td style="padding:10px;">${escapeHtml(d.start_date)}</td>
                      <td style="padding:10px;">${escapeHtml(d.end_date)}</td>
                      <td style="padding:10px;">${escapeHtml(d.notes || '-')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          <div>
            ${card('Delegate Approval Authority', `
              <form method="POST" action="/approvals/delegate">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Delegate Authority To</label>
                  <select name="delegate_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    ${colleagues.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.department || 'General')})</option>`).join('')}
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Start Date</label>
                  <input type="date" name="start_date" required value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">End Date</label>
                  <input type="date" name="end_date" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Reason / Notes</label>
                  <input type="text" name="notes" placeholder="e.g. Annual Leave Coverage" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Save Delegation</button>
              </form>
            `)}
          </div>
        </div>
      `;
    } else if (tab === 'settings') {
      content += `
        ${card('Approval Routing Configuration Shortcut', `
          <p style="font-size:14px; color:#4b5563; margin-bottom:16px;">Approval routing policy settings (e.g. sequential 2-step direct vs. indirect superior approval, auto-approval monetary limits) are configured centrally under System Settings.</p>
          <a href="/settings?tab=system" style="display:inline-block; padding:10px 20px; background:#2563eb; color:#fff; text-decoration:none; font-weight:600; border-radius:6px;">Go to System Settings &rarr;</a>
        `)}
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Approval Center - StaffHub', body: content, user, activePath: '/approvals' }));
  });

  // Action: Add Approval Delegation
  router.post('/approvals/delegate', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { delegate_id, start_date, end_date, notes } = body;
    db.prepare(`
      INSERT INTO approval_delegations (delegator_id, delegate_id, start_date, end_date, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(ctx.user.id, parseInt(delegate_id, 10), start_date, end_date, notes || '');
    logAudit(ctx.user.id, 'create_approval_delegation', `Delegated approvals to user #${delegate_id} from ${start_date} to ${end_date}`);
    redirect(ctx.res, '/approvals?tab=delegations');
  });
};
