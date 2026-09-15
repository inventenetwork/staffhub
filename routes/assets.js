'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('assets');
}

module.exports = function (router) {
  router.get('/assets', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Asset Management is disabled.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'registry';

    const subTabs = [
      { id: 'registry', label: 'Asset Registry & Issuance' },
      { id: 'requests', label: 'Asset Requests' },
      { id: 'my', label: 'My Assets' },
      { id: 'depreciation', label: 'Depreciation & Valuation' },
    ];

    const assets = db.prepare(`
      SELECT a.*, u.name as assigned_user_name, u.employee_no
      FROM company_assets a
      LEFT JOIN users u ON u.id = a.assigned_user_id
      ORDER BY a.id DESC
    `).all();

    const requests = db.prepare(`
      SELECT ar.*, u.name as applicant_name, u.employee_no, u.department
      FROM asset_requests ar
      JOIN users u ON u.id = ar.user_id
      ORDER BY ar.created_at DESC
    `).all();

    const myAssets = assets.filter(a => a.assigned_user_id === user.id);
    const usersList = db.prepare("SELECT id, name, employee_no, department FROM users WHERE status = 'active' ORDER BY name").all();

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Asset Management</h1>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/assets?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'registry') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin', 'it']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Company Asset Registry', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Tag #</th>
                    <th style="padding:10px;">Asset Name</th>
                    <th style="padding:10px;">Category</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Assigned To</th>
                    <th style="padding:10px;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${assets.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No assets registered.</td></tr>' : ''}
                  ${assets.map(a => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-family:monospace; font-weight:700; color:#2563eb;">${escapeHtml(a.asset_tag)}</td>
                      <td style="padding:10px; font-weight:600;">${escapeHtml(a.name)}</td>
                      <td style="padding:10px;">${escapeHtml(a.category)}</td>
                      <td style="padding:10px;">${statusBadge(a.status)}</td>
                      <td style="padding:10px;">${escapeHtml(a.assigned_user_name || 'Unassigned')}</td>
                      <td style="padding:10px;">
                        ${hasAccess(user, ['admin', 'it']) ? (a.status === 'issued' ? `
                          <form method="POST" action="/assets/${a.id}/return" style="display:inline;">
                            <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#6b7280; color:#fff; border:none; border-radius:4px; cursor:pointer;">Return</button>
                          </form>
                        ` : `
                          <button onclick="openIssueModal(${a.id})" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Issue</button>
                        `) : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>

          ${hasAccess(user, ['admin', 'it']) ? `
            <div>
              ${card('Register New Asset', `
                <form method="POST" action="/assets/register">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Asset Tag #</label>
                    <input type="text" name="asset_tag" required placeholder="AST-1001" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Asset Name</label>
                    <input type="text" name="name" required placeholder="e.g. MacBook Pro 16&quot;" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Category</label>
                    <select name="category" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      <option value="Laptop/Hardware">Laptop/Hardware</option>
                      <option value="Mobile Device">Mobile Device</option>
                      <option value="Access Card">Access Card</option>
                      <option value="Office Equipment">Office Equipment</option>
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Serial Number</label>
                    <input type="text" name="serial_number" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
                    <div>
                      <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Purchase Cost (RM)</label>
                      <input type="number" step="0.01" name="purchase_cost" value="0" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    </div>
                    <div>
                      <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Purchase Date</label>
                      <input type="date" name="purchase_date" value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    </div>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Register Asset</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>

        <!-- Issue Modal -->
        <div id="issueModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;">
          <div style="background:#fff; width:400px; margin:120px auto; padding:24px; border-radius:8px;">
            <h3 style="margin-top:0;">Issue Asset to Employee</h3>
            <form method="POST" action="" id="issueForm">
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Assign To Employee</label>
                <select name="user_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  ${usersList.map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.employee_no)})</option>`).join('')}
                </select>
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button type="button" onclick="document.getElementById('issueModal').style.display='none'" style="padding:8px 16px; background:#e5e7eb; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
                <button type="submit" style="padding:8px 16px; background:#10b981; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Issue Asset</button>
              </div>
            </form>
          </div>
        </div>
        <script>
          function openIssueModal(id) {
            document.getElementById('issueForm').action = '/assets/' + id + '/issue';
            document.getElementById('issueModal').style.display = 'block';
          }
        </script>
      `;
    } else if (tab === 'requests') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['ess']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Asset Requests Queue', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Applicant</th>
                    <th style="padding:10px;">Department</th>
                    <th style="padding:10px;">Asset Category</th>
                    <th style="padding:10px;">Reason</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${requests.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No asset requests submitted.</td></tr>' : ''}
                  ${requests.map(r => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(r.applicant_name)}</td>
                      <td style="padding:10px;">${escapeHtml(r.department || 'General')}</td>
                      <td style="padding:10px;">${escapeHtml(r.asset_category)}</td>
                      <td style="padding:10px;">${escapeHtml(r.reason || '-')}</td>
                      <td style="padding:10px;">${statusBadge(r.status)}</td>
                      <td style="padding:10px;">
                        ${r.status === 'pending' && hasAccess(user, ['admin', 'manager', 'it']) ? `
                          <form method="POST" action="/assets/requests/${r.id}/approve" style="display:inline;">
                            <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve</button>
                          </form>
                        ` : ''}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          <div>
            ${card('Request Hardware / Asset', `
              <form method="POST" action="/assets/requests">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Asset Category</label>
                  <select name="asset_category" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    <option value="Laptop/Hardware">Laptop / Workstation</option>
                    <option value="Mobile Device">Mobile Device</option>
                    <option value="Access Card">Building Access Card</option>
                    <option value="Office Equipment">Monitor / Peripheral</option>
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Business Justification</label>
                  <textarea name="reason" rows="3" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Request</button>
              </form>
            `)}
          </div>
        </div>
      `;
    } else if (tab === 'my') {
      content += `
        ${card('My Issued Company Assets', `
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Asset Tag #</th>
                <th style="padding:10px;">Asset Name</th>
                <th style="padding:10px;">Category</th>
                <th style="padding:10px;">Serial Number</th>
                <th style="padding:10px;">Issued Date</th>
              </tr>
            </thead>
            <tbody>
              ${myAssets.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No company assets issued to you.</td></tr>' : ''}
              ${myAssets.map(a => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-family:monospace; font-weight:700; color:#2563eb;">${escapeHtml(a.asset_tag)}</td>
                  <td style="padding:10px; font-weight:600;">${escapeHtml(a.name)}</td>
                  <td style="padding:10px;">${escapeHtml(a.category)}</td>
                  <td style="padding:10px;">${escapeHtml(a.serial_number || 'N/A')}</td>
                  <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(a.issued_date || '-')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    } else if (tab === 'depreciation') {
      content += `
        ${card('Asset Straight-Line Depreciation & Current Book Valuation', `
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Asset Tag #</th>
                <th style="padding:10px;">Asset Name</th>
                <th style="padding:10px;">Original Cost (RM)</th>
                <th style="padding:10px;">Purchase Date</th>
                <th style="padding:10px;">Annual Depr. Rate</th>
                <th style="padding:10px;">Estimated Net Book Value (RM)</th>
              </tr>
            </thead>
            <tbody>
              ${assets.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No asset valuation records found.</td></tr>' : ''}
              ${assets.map(a => {
                const cost = Number(a.purchase_cost || 0);
                const years = a.purchase_date ? (new Date().getFullYear() - new Date(a.purchase_date).getFullYear()) : 0;
                const deprRate = Number(a.depreciation_rate_annual || 0.20);
                const nbv = Math.max(0, cost * (1 - (years * deprRate)));
                return `
                  <tr style="border-bottom:1px solid #f3f4f6;">
                    <td style="padding:10px; font-family:monospace; font-weight:700;">${escapeHtml(a.asset_tag)}</td>
                    <td style="padding:10px; font-weight:600;">${escapeHtml(a.name)}</td>
                    <td style="padding:10px;">RM ${cost.toFixed(2)}</td>
                    <td style="padding:10px;">${escapeHtml(a.purchase_date || '-')}</td>
                    <td style="padding:10px;">${(deprRate * 100).toFixed(0)}%</td>
                    <td style="padding:10px; font-weight:700; color:#047857;">RM ${nbv.toFixed(2)}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        `)}
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Asset Management - StaffHub', body: content, user, activePath: '/assets' }));
  });

  // Action: Register Asset
  router.post('/assets/register', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'it'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { asset_tag, name, category, serial_number, purchase_cost, purchase_date } = body;
    db.prepare(`
      INSERT INTO company_assets (asset_tag, name, category, serial_number, purchase_cost, purchase_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'available')
    `).run(asset_tag, name, category || 'Laptop/Hardware', serial_number || '', parseFloat(purchase_cost || '0'), purchase_date || todayISO());
    logAudit(ctx.user.id, 'register_asset', `Registered asset ${asset_tag} (${name})`);
    redirect(ctx.res, '/assets?tab=registry');
  });

  // Action: Issue Asset
  router.post('/assets/:id/issue', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'it'])) return redirect(ctx.res, '/login');
    const assetId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);
    db.prepare(`UPDATE company_assets SET status = 'issued', assigned_user_id = ?, issued_date = ? WHERE id = ?`).run(parseInt(body.user_id, 10), todayISO(), assetId);
    logAudit(ctx.user.id, 'issue_asset', `Issued asset #${assetId} to user #${body.user_id}`);
    redirect(ctx.res, '/assets?tab=registry');
  });

  // Action: Return Asset
  router.post('/assets/:id/return', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'it'])) return redirect(ctx.res, '/login');
    const assetId = parseInt(ctx.params.id, 10);
    db.prepare(`UPDATE company_assets SET status = 'available', assigned_user_id = NULL, issued_date = NULL WHERE id = ?`).run(assetId);
    logAudit(ctx.user.id, 'return_asset', `Returned asset #${assetId} to inventory`);
    redirect(ctx.res, '/assets?tab=registry');
  });

  // Action: Create Asset Request
  router.post('/assets/requests', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { asset_category, reason } = body;
    db.prepare(`
      INSERT INTO asset_requests (user_id, asset_category, reason, status)
      VALUES (?, ?, ?, 'pending')
    `).run(ctx.user.id, asset_category, reason || '');
    logAudit(ctx.user.id, 'create_asset_request', `Submitted request for asset category: ${asset_category}`);
    redirect(ctx.res, '/assets?tab=requests');
  });

  // Action: Approve Asset Request
  router.post('/assets/requests/:id/approve', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'manager', 'it'])) return redirect(ctx.res, '/login');
    const reqId = parseInt(ctx.params.id, 10);
    db.prepare(`UPDATE asset_requests SET status = 'approved', approver_id = ? WHERE id = ?`).run(ctx.user.id, reqId);
    logAudit(ctx.user.id, 'approve_asset_request', `Approved asset request #${reqId}`);
    redirect(ctx.res, '/assets?tab=requests');
  });
};
