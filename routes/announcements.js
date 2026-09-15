'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('announcements');
}

module.exports = function (router) {
  router.get('/announcements', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Announcements module is disabled.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'notice';

    const subTabs = [
      { id: 'notice', label: 'Notice Board' },
      { id: 'publish', label: 'Publish Announcement' },
      { id: 'acknowledgements', label: 'Read Acknowledgements' },
      { id: 'policies', label: 'Policy & Document Repository' },
    ];

    const announcements = db.prepare(`
      SELECT a.*, u.name as author_name,
             (SELECT COUNT(*) FROM announcement_acknowledgements ack WHERE ack.announcement_id = a.id AND ack.user_id = ?) as user_ack_count
      FROM announcements a
      LEFT JOIN users u ON u.id = a.author_id
      ORDER BY a.created_at DESC
    `).all(user.id);

    const acks = db.prepare(`
      SELECT ack.*, u.name as user_name, u.employee_no, u.department, a.title as announcement_title
      FROM announcement_acknowledgements ack
      JOIN users u ON u.id = ack.user_id
      JOIN announcements a ON a.id = ack.announcement_id
      ORDER BY ack.acknowledged_at DESC
    `).all();

    const policies = db.prepare('SELECT * FROM policy_documents ORDER BY uploaded_at DESC').all();
    const depts = db.prepare("SELECT value FROM list_options WHERE list_key = 'department' ORDER BY value").all();

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Announcements & Policy Repository</h1>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/announcements?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'notice') {
      content += `
        <div style="display:flex; flex-direction:column; gap:16px;">
          ${announcements.length === 0 ? '<div style="padding:20px; text-align:center; color:#9ca3af; background:#fff; border-radius:8px;">No announcements published.</div>' : ''}
          ${announcements.map(a => `
            <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
              <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                  <span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; background:#e0e7ff; color:#3730a3; text-transform:uppercase;">${escapeHtml(a.category)}</span>
                  ${a.is_mandatory ? '<span style="display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; background:#fee2e2; color:#991b1b; margin-left:6px;">MANDATORY ACKNOWLEDGEMENT</span>' : ''}
                  <h3 style="font-size:18px; font-weight:700; margin:8px 0 4px 0;">${escapeHtml(a.title)}</h3>
                  <div style="font-size:12px; color:#6b7280;">Published by <strong>${escapeHtml(a.author_name || 'Admin')}</strong> on ${escapeHtml(a.created_at)}</div>
                </div>
                ${a.is_mandatory ? (a.user_ack_count > 0 ? `
                  <span style="color:#10b981; font-weight:600; font-size:13px;">✓ Acknowledged</span>
                ` : `
                  <form method="POST" action="/announcements/${a.id}/acknowledge">
                    <button type="submit" style="padding:6px 14px; background:#10b981; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Acknowledge Read</button>
                  </form>
                `) : ''}
              </div>
              <div style="margin-top:14px; font-size:14px; color:#374151; line-height:1.6; white-space:pre-wrap;">${escapeHtml(a.content)}</div>
            </div>
          `).join('')}
        </div>
      `;
    } else if (tab === 'publish') {
      content += `
        ${card('Publish Company Announcement', `
          <form method="POST" action="/announcements/publish">
            <div style="margin-bottom:12px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Title</label>
              <input type="text" name="title" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin-bottom:12px;">
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Category</label>
                <select name="category" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  <option value="General">General</option>
                  <option value="Policy Change">Policy Change</option>
                  <option value="HR Notice">HR Notice</option>
                  <option value="Event">Event</option>
                </select>
              </div>
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Target Audience</label>
                <select name="target_audience" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  <option value="all">All Company</option>
                  <option value="department">Specific Department</option>
                </select>
              </div>
              <div>
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Department (If targeted)</label>
                <select name="target_value" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  <option value="">N/A</option>
                  ${depts.map(d => `<option value="${d.value}">${escapeHtml(d.value)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div style="margin-bottom:12px;">
              <label style="font-size:13px; font-weight:600; cursor:pointer;">
                <input type="checkbox" name="is_mandatory" value="1"> Require Employee Read Acknowledgement
              </label>
            </div>
            <div style="margin-bottom:16px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Announcement Content</label>
              <textarea name="content" rows="6" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
            </div>
            <button type="submit" style="padding:10px 24px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Publish Announcement</button>
          </form>
        `)}
      `;
    } else if (tab === 'acknowledgements') {
      content += `
        ${card('Read Acknowledgement Tracking Log', `
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Employee</th>
                <th style="padding:10px;">Department</th>
                <th style="padding:10px;">Announcement</th>
                <th style="padding:10px;">Acknowledged At</th>
              </tr>
            </thead>
            <tbody>
              ${acks.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No acknowledgements logged yet.</td></tr>' : ''}
              ${acks.map(k => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-weight:600;">${escapeHtml(k.user_name)} (${escapeHtml(k.employee_no)})</td>
                  <td style="padding:10px;">${escapeHtml(k.department || 'General')}</td>
                  <td style="padding:10px;">${escapeHtml(k.announcement_title)}</td>
                  <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(k.acknowledged_at)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    } else if (tab === 'policies') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Company Policy & Guidelines Repository', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Document Title</th>
                    <th style="padding:10px;">Category</th>
                    <th style="padding:10px;">Description</th>
                    <th style="padding:10px;">Uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  ${policies.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No policy documents uploaded.</td></tr>' : ''}
                  ${policies.map(p => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">📄 ${escapeHtml(p.title)}</td>
                      <td style="padding:10px;">${escapeHtml(p.category)}</td>
                      <td style="padding:10px;">${escapeHtml(p.description || '-')}</td>
                      <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(p.uploaded_at.substring(0,10))}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>

          ${hasAccess(user, ['admin']) ? `
            <div>
              ${card('Upload Policy Document', `
                <form method="POST" action="/announcements/policies">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Title</label>
                    <input type="text" name="title" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Category</label>
                    <input type="text" name="category" value="Company Policy" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Description</label>
                    <textarea name="description" rows="3" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Save Policy Document</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Announcements - StaffHub', body: content, user, activePath: '/announcements' }));
  });

  // Action: Publish Announcement
  router.post('/announcements/publish', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { title, content, category, target_audience, target_value, is_mandatory } = body;
    db.prepare(`
      INSERT INTO announcements (title, content, category, target_audience, target_value, is_mandatory, author_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(title, content, category || 'General', target_audience || 'all', target_value || null, is_mandatory === '1' ? 1 : 0, ctx.user.id);
    logAudit(ctx.user.id, 'publish_announcement', `Published announcement: ${title}`);
    redirect(ctx.res, '/announcements?tab=notice');
  });

  // Action: Acknowledge Announcement
  router.post('/announcements/:id/acknowledge', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const ancId = parseInt(ctx.params.id, 10);
    db.prepare(`
      INSERT INTO announcement_acknowledgements (announcement_id, user_id)
      VALUES (?, ?) ON CONFLICT DO NOTHING
    `).run(ancId, ctx.user.id);
    logAudit(ctx.user.id, 'acknowledge_announcement', `Acknowledged read for announcement #${ancId}`);
    redirect(ctx.res, '/announcements?tab=notice');
  });

  // Action: Add Policy Document
  router.post('/announcements/policies', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { title, category, description } = body;
    db.prepare(`
      INSERT INTO policy_documents (title, category, description)
      VALUES (?, ?, ?)
    `).run(title, category || 'Company Policy', description || '');
    logAudit(ctx.user.id, 'upload_policy_document', `Uploaded policy document: ${title}`);
    redirect(ctx.res, '/announcements?tab=policies');
  });
};
