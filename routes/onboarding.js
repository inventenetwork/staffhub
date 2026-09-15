'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('onboarding');
}

module.exports = function (router) {
  router.get('/onboarding', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Onboarding module is not enabled.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'onboarding';

    // Sub-tabs
    const subTabs = [
      { id: 'onboarding', label: 'Onboarding Tasks' },
      { id: 'preboarding', label: 'Pre-boarding Portal' },
      { id: 'assets', label: 'IT & Asset Requests' },
      { id: 'offboarding', label: 'Offboarding & Clearances' },
    ];

    // Data queries
    let onboardingTasks = [];
    if (isSuperAdmin(user) || hasAccess(user, ['admin', 'it', 'manager'])) {
      onboardingTasks = db.prepare(`
        SELECT c.*, u.name as user_name, u.employee_no, u.department, pic.name as pic_name
        FROM onboarding_checklists c
        JOIN users u ON u.id = c.user_id
        LEFT JOIN users pic ON pic.id = c.pic_id
        ORDER BY c.status ASC, c.id DESC
      `).all();
    } else {
      onboardingTasks = db.prepare(`
        SELECT c.*, u.name as user_name, u.employee_no, u.department, pic.name as pic_name
        FROM onboarding_checklists c
        JOIN users u ON u.id = c.user_id
        LEFT JOIN users pic ON pic.id = c.pic_id
        WHERE c.user_id = ? OR c.pic_id = ?
        ORDER BY c.status ASC, c.id DESC
      `).all(user.id, user.id);
    }

    const templates = db.prepare('SELECT * FROM onboarding_checklist_templates ORDER BY sort_order ASC').all();
    const usersList = db.prepare("SELECT id, name, employee_no, department FROM users WHERE status = 'active' ORDER BY name").all();

    // Offboarding records & detailed itemized checklist
    let offboardingRecords = [];
    if (isSuperAdmin(user) || hasAccess(user, ['admin', 'it', 'manager'])) {
      offboardingRecords = db.prepare(`
        SELECT o.*, u.name as user_name, u.employee_no, u.department, u.position
        FROM offboarding_checklists o
        JOIN users u ON u.id = o.user_id
        ORDER BY o.id DESC
      `).all();
    } else {
      offboardingRecords = db.prepare(`
        SELECT o.*, u.name as user_name, u.employee_no, u.department, u.position
        FROM offboarding_checklists o
        JOIN users u ON u.id = o.user_id
        WHERE o.user_id = ?
        ORDER BY o.id DESC
      `).all(user.id);
    }

    // Attach offboarding items to each offboarding record
    for (const record of offboardingRecords) {
      record.items = db.prepare(`
        SELECT oi.*, pic.name as pic_name
        FROM offboarding_items oi
        LEFT JOIN users pic ON pic.id = oi.pic_id
        WHERE oi.offboarding_id = ?
        ORDER BY oi.id ASC
      `).all(record.id);
    }

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <div>
          <h1 style="font-size:24px; font-weight:700; margin:0;">Onboarding & Offboarding Lifecycle</h1>
          <p style="color:#6b7280; font-size:14px; margin:4px 0 0 0;">Manage employee orientation, asset assignments, and offboarding checklist clearances with assigned Person-In-Charge (PIC).</p>
        </div>
      </div>
      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/onboarding?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'onboarding') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin', 'manager']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Active Onboarding & Asset Provisioning Checklists', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Employee</th>
                    <th style="padding:10px;">Task / Item Assigned</th>
                    <th style="padding:10px;">Type</th>
                    <th style="padding:10px;">Assigned PIC</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${onboardingTasks.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No onboarding tasks assigned.</td></tr>' : ''}
                  ${onboardingTasks.map(t => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(t.user_name)} <span style="font-size:12px; color:#6b7280;">(${escapeHtml(t.employee_no)})</span></td>
                      <td style="padding:10px;">${escapeHtml(t.task_name)}</td>
                      <td style="padding:10px;"><span style="text-transform:uppercase; font-size:11px; font-weight:700; background:${t.item_type === 'asset' ? '#dbeafe' : '#f3f4f6'}; color:${t.item_type === 'asset' ? '#1e40af' : '#374151'}; padding:2px 8px; border-radius:4px;">${t.item_type || 'task'}</span></td>
                      <td style="padding:10px; font-weight:600; color:#374151;">${escapeHtml(t.pic_name || 'Unassigned')}</td>
                      <td style="padding:10px;">${statusBadge(t.status)}</td>
                      <td style="padding:10px;">
                        ${t.status === 'pending' && (t.user_id === user.id || t.pic_id === user.id || hasAccess(user, ['admin']) || (t.assigned_role === 'it' && hasAccess(user, ['it']))) ? `
                          <form method="POST" action="/onboarding/checklists/${t.id}/complete" style="display:inline;">
                            <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Mark Complete</button>
                          </form>
                        ` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>

          ${hasAccess(user, ['admin', 'manager']) ? `
            <div>
              ${card('Assign Onboarding Task / Asset', `
                <form method="POST" action="/onboarding/checklists/assign">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Select Employee</label>
                    <select name="user_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      ${usersList.map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.employee_no)})</option>`).join('')}
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Task / Item Name</label>
                    <input type="text" name="task_name" placeholder="e.g. Dell XPS Laptop, Access Card, Security Briefing" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Item Type</label>
                    <select name="item_type" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      <option value="task">General Task</option>
                      <option value="asset">Company Asset (Auto-Syncs to Employee Belongings)</option>
                      <option value="document">Document / Policy</option>
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Person-In-Charge (PIC)</label>
                    <select name="pic_id" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      <option value="">Select PIC Officer</option>
                      ${usersList.map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.department || 'General')})</option>`).join('')}
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Responsible Role Group</label>
                    <select name="assigned_role" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      <option value="ess">ESS (New Hire Self-Service)</option>
                      <option value="admin">Admin / HR</option>
                      <option value="it">IT Department</option>
                      <option value="manager">Reporting Manager</option>
                    </select>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Assign & Sync Belongings</button>
                </form>
              `)}

              <div style="margin-top:20px;">
                ${card('Standard Task Templates', `
                  <form method="POST" action="/onboarding/templates" style="margin-bottom:12px;">
                    <input type="text" name="task_name" placeholder="Template Task Name" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px; margin-bottom:8px;">
                    <select name="assigned_role" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px; margin-bottom:8px;">
                      <option value="ess">ESS</option>
                      <option value="admin">Admin</option>
                      <option value="it">IT</option>
                    </select>
                    <button type="submit" style="width:100%; padding:6px; background:#4b5563; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">+ Add Template</button>
                  </form>
                  <ul style="padding-left:20px; font-size:13px; margin:0;">
                    ${templates.map(tmp => `<li>${escapeHtml(tmp.task_name)} (<strong>${tmp.assigned_role.toUpperCase()}</strong>)</li>`).join('')}
                  </ul>
                `)}
              </div>
            </div>
          ` : ''}
        </div>
      `;
    } else if (tab === 'preboarding') {
      content += `
        ${card('New Hire Pre-boarding Portal', `
          <div style="background:#eff6ff; border-left:4px solid #2563eb; padding:15px; border-radius:4px; margin-bottom:20px;">
            <h4 style="margin:0 0 6px 0; color:#1e40af;">Welcome to StaffHub!</h4>
            <p style="margin:0; font-size:14px; color:#1e3a8a;">Please review your onboarding checklist, complete your employee details in Profile, and submit your statutory compliance verification details below.</p>
          </div>

          <form method="POST" action="/onboarding/preboarding/submit">
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Emergency Contact Person</label>
                <input type="text" name="emergency_contact_name" placeholder="e.g. Jane Doe (Spouse)" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
              </div>
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Emergency Contact Phone</label>
                <input type="text" name="emergency_contact_phone" placeholder="e.g. +60 12-345 6789" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
              </div>
            </div>
            <div style="margin-top:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Identity / Working Rights Document Reference</label>
              <input type="text" name="doc_ref" placeholder="MyKad / Passport verification reference number" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
            </div>
            <button type="submit" style="margin-top:20px; padding:10px 20px; background:#10b981; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Verification</button>
          </form>
        `)}
      `;
    } else if (tab === 'assets') {
      const itTasks = onboardingTasks.filter(t => t.assigned_role === 'it' || t.item_type === 'asset');
      content += `
        ${card('IT & Hardware Asset Provisioning Queue', `
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Employee</th>
                <th style="padding:10px;">Department</th>
                <th style="padding:10px;">Provisioning Item</th>
                <th style="padding:10px;">Assigned PIC</th>
                <th style="padding:10px;">Status</th>
                <th style="padding:10px;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${itTasks.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No pending IT asset setup requests.</td></tr>' : ''}
              ${itTasks.map(t => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-weight:600;">${escapeHtml(t.user_name)}</td>
                  <td style="padding:10px;">${escapeHtml(t.department || 'General')}</td>
                  <td style="padding:10px;">${escapeHtml(t.task_name)}</td>
                  <td style="padding:10px; font-weight:600;">${escapeHtml(t.pic_name || 'IT Staff')}</td>
                  <td style="padding:10px;">${statusBadge(t.status)}</td>
                  <td style="padding:10px;">
                    ${t.status === 'pending' && (t.pic_id === user.id || hasAccess(user, ['admin', 'it'])) ? `
                      <form method="POST" action="/onboarding/checklists/${t.id}/complete" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Mark Provisioned & Sync</button>
                      </form>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    } else if (tab === 'offboarding') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin', 'ess', 'manager']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Offboarding Clearance & PIC Item Verification', `
              <div style="display:flex; flex-direction:column; gap:20px;">
                ${offboardingRecords.length === 0 ? '<div style="padding:15px; text-align:center; color:#9ca3af;">No offboarding records found.</div>' : ''}
                ${offboardingRecords.map(o => `
                  <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                      <div>
                        <span style="font-weight:700; font-size:16px;">${escapeHtml(o.user_name)}</span>
                        <span style="font-size:12px; color:#6b7280; margin-left:6px;">(${escapeHtml(o.employee_no)} - ${escapeHtml(o.department || 'General')})</span>
                      </div>
                      <div>
                        ${statusBadge(o.status)}
                      </div>
                    </div>

                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; font-size:13px; background:#fff; padding:10px; border-radius:6px; border:1px solid #e5e7eb; margin-bottom:14px;">
                      <div><strong>Resignation Date:</strong> ${escapeHtml(o.resignation_date)}</div>
                      <div><strong>Last Working Date:</strong> ${escapeHtml(o.last_working_date)}</div>
                      <div><strong>Overall Status:</strong> ${escapeHtml(o.status)}</div>
                    </div>

                    <!-- Itemized Offboarding Checklist with PIC -->
                    <h5 style="margin:0 0 8px 0; font-size:14px; font-weight:700; color:#374151;">Offboarding Asset & Clearance Checklist Items</h5>
                    <table style="width:100%; border-collapse:collapse; text-align:left; font-size:13px; background:#fff; border-radius:6px; overflow:hidden; border:1px solid #e5e7eb; margin-bottom:14px;">
                      <thead>
                        <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280; background:#f3f4f6;">
                          <th style="padding:8px;">Item / Clearance Task</th>
                          <th style="padding:8px;">Category</th>
                          <th style="padding:8px;">Assigned PIC</th>
                          <th style="padding:8px;">Return Status</th>
                          <th style="padding:8px;">PIC Verification Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${(!o.items || o.items.length === 0) ? '<tr><td colspan="5" style="padding:10px; text-align:center; color:#9ca3af;">No items listed for clearance.</td></tr>' : ''}
                        ${(o.items || []).map(item => `
                          <tr style="border-bottom:1px solid #f3f4f6;">
                            <td style="padding:8px; font-weight:600;">${escapeHtml(item.item_name)}</td>
                            <td style="padding:8px;"><span style="font-size:11px; font-weight:700; background:#e2e8f0; color:#334155; padding:2px 6px; border-radius:4px;">${escapeHtml(item.category)}</span></td>
                            <td style="padding:8px; font-weight:600; color:#2563eb;">${escapeHtml(item.pic_name || 'Unassigned')}</td>
                            <td style="padding:8px;">${statusBadge(item.status)}</td>
                            <td style="padding:8px;">
                              ${item.status === 'pending' && (item.pic_id === user.id || hasAccess(user, ['admin', 'it'])) ? `
                                <form method="POST" action="/onboarding/offboarding/items/${item.id}/verify" style="display:inline;">
                                  <button type="submit" style="padding:3px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Verify Return / Clear</button>
                                </form>
                              ` : ''}
                            </td>
                          </tr>
                        `).join('')}
                      </tbody>
                    </table>

                    <div style="display:flex; justify-content:flex-end; gap:8px;">
                      ${hasAccess(user, ['admin', 'it']) ? `
                        <button onclick="openClearanceModal(${o.id})" style="padding:6px 12px; font-size:12px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer;">Update Department Sign-off</button>
                      ` : ''}
                      ${o.user_id === user.id && o.exit_interview_status === 'pending' ? `
                        <button onclick="openExitModal(${o.id})" style="padding:6px 12px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Submit Exit Interview</button>
                      ` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            `)}
          </div>

          <div>
            ${card('Initiate Offboarding / Resignation', `
              <form method="POST" action="/onboarding/offboarding/submit">
                ${hasAccess(user, ['admin']) ? `
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Employee</label>
                    <select name="user_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      ${usersList.map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.employee_no)})</option>`).join('')}
                    </select>
                  </div>
                ` : `
                  <input type="hidden" name="user_id" value="${user.id}">
                `}
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Resignation Date</label>
                  <input type="date" name="resignation_date" required value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Last Working Date</label>
                  <input type="date" name="last_working_date" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#ef4444; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Resignation</button>
              </form>
            `)}
          </div>
        </div>

        <!-- Clearance Modal -->
        <div id="clearanceModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;">
          <div style="background:#fff; width:400px; margin:120px auto; padding:24px; border-radius:8px;">
            <h3 style="margin-top:0;">Update Department Clearance</h3>
            <form method="POST" action="" id="clearanceForm">
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Department</label>
                <select name="dept" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  <option value="it">IT Department</option>
                  <option value="finance">Finance Department</option>
                  <option value="admin">Admin / HR Department</option>
                </select>
              </div>
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Clearance Status</label>
                <select name="status" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  <option value="approved">Approved / Cleared</option>
                  <option value="pending">Pending</option>
                  <option value="rejected">Rejected / Hold</option>
                </select>
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button type="button" onclick="document.getElementById('clearanceModal').style.display='none'" style="padding:8px 16px; background:#e5e7eb; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
                <button type="submit" style="padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Save</button>
              </div>
            </form>
          </div>
        </div>

        <!-- Exit Modal -->
        <div id="exitModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;">
          <div style="background:#fff; width:450px; margin:120px auto; padding:24px; border-radius:8px;">
            <h3 style="margin-top:0;">Submit Exit Interview Notes</h3>
            <form method="POST" action="" id="exitForm">
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Exit Interview Notes / Feedback</label>
                <textarea name="notes" rows="4" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button type="button" onclick="document.getElementById('exitModal').style.display='none'" style="padding:8px 16px; background:#e5e7eb; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
                <button type="submit" style="padding:8px 16px; background:#10b981; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Submit</button>
              </div>
            </form>
          </div>
        </div>

        <script>
          function openClearanceModal(id) {
            document.getElementById('clearanceForm').action = '/onboarding/offboarding/' + id + '/clearance';
            document.getElementById('clearanceModal').style.display = 'block';
          }
          function openExitModal(id) {
            document.getElementById('exitForm').action = '/onboarding/offboarding/' + id + '/exit-interview';
            document.getElementById('exitModal').style.display = 'block';
          }
        </script>
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Onboarding & Offboarding - StaffHub', body: content, user, activePath: '/onboarding' }));
  });

  // Action: Mark Checklist Task Complete
  router.post('/onboarding/checklists/:id/complete', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const taskId = parseInt(ctx.params.id, 10);
    const task = db.prepare('SELECT * FROM onboarding_checklists WHERE id = ?').get(taskId);

    db.prepare(`UPDATE onboarding_checklists SET status = 'completed', completed_at = datetime('now') WHERE id = ?`).run(taskId);

    // If item_type is asset or task_name looks like an asset, update/ensure company_belongings
    if (task && (task.item_type === 'asset' || task.assigned_role === 'it')) {
      const existing = db.prepare('SELECT id FROM company_belongings WHERE user_id = ? AND item_name = ?').get(task.user_id, task.task_name);
      if (!existing) {
        db.prepare(`
          INSERT INTO company_belongings (user_id, item_name, serial_no, issued_date, status)
          VALUES (?, ?, 'ONBOARDING-REF', ?, 'issued')
        `).run(task.user_id, task.task_name, todayISO());
      }
    }

    logAudit(ctx.user.id, 'complete_onboarding_task', `Completed onboarding task #${taskId}`);
    redirect(ctx.res, '/onboarding?tab=onboarding');
  });

  // Action: Assign Checklist Task (Auto-syncs asset items to company_belongings)
  router.post('/onboarding/checklists/assign', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'manager'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { user_id, task_name, assigned_role, pic_id, item_type } = body;
    const targetUserId = parseInt(user_id, 10);
    const picId = pic_id ? parseInt(pic_id, 10) : null;
    const type = item_type || 'task';

    db.prepare(`
      INSERT INTO onboarding_checklists (user_id, task_name, assigned_role, pic_id, item_type, status, due_date)
      VALUES (?, ?, ?, ?, ?, 'pending', date('now', '+7 days'))
    `).run(targetUserId, task_name, assigned_role || 'ess', picId, type);

    // If item_type is asset, auto-sync directly into employee company_belongings!
    if (type === 'asset') {
      const existing = db.prepare('SELECT id FROM company_belongings WHERE user_id = ? AND item_name = ?').get(targetUserId, task_name);
      if (!existing) {
        db.prepare(`
          INSERT INTO company_belongings (user_id, item_name, serial_no, issued_date, status)
          VALUES (?, ?, 'ONBOARDING-REF', ?, 'issued')
        `).run(targetUserId, task_name, todayISO());
      }
    }

    logAudit(ctx.user.id, 'assign_onboarding_task', `Assigned task "${task_name}" to user #${targetUserId}`);
    redirect(ctx.res, '/onboarding?tab=onboarding');
  });

  // Action: Add Template Task
  router.post('/onboarding/templates', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { task_name, assigned_role } = body;
    db.prepare(`
      INSERT INTO onboarding_checklist_templates (template_name, task_name, assigned_role)
      VALUES ('Standard Onboarding', ?, ?)
    `).run(task_name, assigned_role || 'ess');
    logAudit(ctx.user.id, 'add_onboarding_template', `Added onboarding template task "${task_name}"`);
    redirect(ctx.res, '/onboarding?tab=onboarding');
  });

  // Action: Preboarding Submission
  router.post('/onboarding/preboarding/submit', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    logAudit(ctx.user.id, 'submit_preboarding_details', `Submitted preboarding verification details`);
    redirect(ctx.res, '/onboarding?tab=preboarding&success=' + encodeURIComponent('Pre-boarding verification submitted successfully.'));
  });

  // Action: Resignation / Offboarding Submit (Generates itemized offboarding checklist items)
  router.post('/onboarding/offboarding/submit', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const targetUserId = body.user_id ? parseInt(body.user_id, 10) : ctx.user.id;
    if (targetUserId !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) {
      return redirect(ctx.res, '/onboarding?tab=offboarding&error=' + encodeURIComponent('Permission denied'));
    }

    const res = db.prepare(`
      INSERT INTO offboarding_checklists (user_id, resignation_date, last_working_date, status)
      VALUES (?, ?, ?, 'in_progress')
    `).run(targetUserId, body.resignation_date || todayISO(), body.last_working_date || todayISO());

    const offId = Number(res.lastInsertRowid);

    // Find IT Lead / Admin PIC for offboarding assignment defaults
    const adminUser = db.prepare("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.permission_tier = 'admin' LIMIT 1").get();
    const itUser = db.prepare("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.permission_tier = 'it' LIMIT 1").get();

    const picAdmin = adminUser ? adminUser.id : ctx.user.id;
    const picIt = itUser ? itUser.id : picAdmin;

    // Create standard offboarding items
    const standardItems = [
      { name: 'Return Laptop / Hardware Assets', cat: 'IT', pic: picIt },
      { name: 'Revoke Email & System Access', cat: 'IT', pic: picIt },
      { name: 'Return Access Card & Office Key', cat: 'Admin', pic: picAdmin },
      { name: 'Settle Claims & Financial Advances', cat: 'Finance', pic: picAdmin },
      { name: 'Complete Exit Interview', cat: 'Admin', pic: picAdmin }
    ];

    for (const item of standardItems) {
      db.prepare(`
        INSERT INTO offboarding_items (offboarding_id, user_id, item_name, category, pic_id, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `).run(offId, targetUserId, item.name, item.cat, item.pic);
    }

    // Import any issued belongings into offboarding checklist
    const issuedBelongings = db.prepare("SELECT * FROM company_belongings WHERE user_id = ? AND status = 'issued'").all(targetUserId);
    for (const b of issuedBelongings) {
      db.prepare(`
        INSERT INTO offboarding_items (offboarding_id, user_id, item_name, category, pic_id, status)
        VALUES (?, ?, ?, 'Asset', ?, 'pending')
      `).run(offId, targetUserId, 'Return Belonging: ' + b.item_name, picAdmin);
    }

    logAudit(ctx.user.id, 'submit_resignation', `Initiated offboarding for user #${targetUserId} with itemized PIC checklist`);
    redirect(ctx.res, '/onboarding?tab=offboarding');
  });

  // Action: Offboarding Item Verification by Assigned PIC
  router.post('/onboarding/offboarding/items/:itemId/verify', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const itemId = parseInt(ctx.params.itemId, 10);
    const item = db.prepare('SELECT * FROM offboarding_items WHERE id = ?').get(itemId);

    if (item) {
      db.prepare(`UPDATE offboarding_items SET status = 'returned', verified_at = datetime('now') WHERE id = ?`).run(itemId);

      // Also update company_belongings if this corresponds to a belonging
      if (item.item_name.startsWith('Return Belonging: ')) {
        const belongingName = item.item_name.replace('Return Belonging: ', '');
        db.prepare(`UPDATE company_belongings SET status = 'returned', returned_date = ? WHERE user_id = ? AND item_name = ?`).run(todayISO(), item.user_id, belongingName);
      }

      // Check if all items in offboarding are returned
      const remainingPending = db.prepare("SELECT COUNT(*) c FROM offboarding_items WHERE offboarding_id = ? AND status = 'pending'").get(item.offboarding_id).c;
      if (remainingPending === 0) {
        db.prepare(`UPDATE offboarding_checklists SET status = 'cleared' WHERE id = ?`).run(item.offboarding_id);
      }
    }

    logAudit(ctx.user.id, 'verify_offboarding_item', `PIC verified return of offboarding item #${itemId}`);
    redirect(ctx.res, '/onboarding?tab=offboarding');
  });

  // Action: Department Clearance Update
  router.post('/onboarding/offboarding/:id/clearance', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'it', 'manager'])) return redirect(ctx.res, '/login');
    const offId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);
    const { dept, status } = body;

    let col = 'clearance_admin';
    if (dept === 'it') col = 'clearance_it';
    else if (dept === 'finance') col = 'clearance_finance';

    db.prepare(`UPDATE offboarding_checklists SET ${col} = ? WHERE id = ?`).run(status, offId);

    const record = db.prepare('SELECT * FROM offboarding_checklists WHERE id = ?').get(offId);
    if (record && record.clearance_it === 'approved' && record.clearance_finance === 'approved' && record.clearance_admin === 'approved') {
      db.prepare(`UPDATE offboarding_checklists SET status = 'cleared' WHERE id = ?`).run(offId);
    }

    logAudit(ctx.user.id, 'update_offboarding_clearance', `Updated ${dept} clearance to ${status} for offboarding #${offId}`);
    redirect(ctx.res, '/onboarding?tab=offboarding');
  });

  // Action: Exit Interview Submit
  router.post('/onboarding/offboarding/:id/exit-interview', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const offId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);
    db.prepare(`UPDATE offboarding_checklists SET exit_interview_status = 'completed', exit_interview_notes = ? WHERE id = ?`).run(body.notes || '', offId);
    logAudit(ctx.user.id, 'submit_exit_interview', `Submitted exit interview notes for offboarding #${offId}`);
    redirect(ctx.res, '/onboarding?tab=offboarding');
  });
};
