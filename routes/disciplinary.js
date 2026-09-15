'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('disciplinary');
}

module.exports = function (router) {
  router.get('/disciplinary', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Disciplinary module is disabled.'));

    const user = ctx.user;
    const isAdmin = isSuperAdmin(user) || hasAccess(user, ['admin']);
    const tab = ctx.url.searchParams.get('tab') || (isAdmin ? 'cases' : 'my');

    // Non-admins can strictly ONLY view the 'my' tab for their own letters!
    if (!isAdmin && tab !== 'my') {
      return redirect(ctx.res, '/disciplinary?tab=my');
    }

    const subTabs = isAdmin ? [
      { id: 'cases', label: 'Case Management' },
      { id: 'letters', label: 'Warning & Show-Cause Letters' },
      { id: 'inquiry', label: 'Domestic Inquiry Tracking' },
      { id: 'my', label: 'My Letters' },
    ] : [
      { id: 'my', label: 'My Letters' },
    ];

    const cases = isAdmin ? db.prepare(`
      SELECT c.*, u.name as user_name, u.employee_no, u.department
      FROM disciplinary_cases c
      JOIN users u ON u.id = c.user_id
      ORDER BY c.id DESC
    `).all() : [];

    const letters = isAdmin ? db.prepare(`
      SELECT l.*, u.name as user_name, u.employee_no, c.case_number
      FROM disciplinary_letters l
      JOIN users u ON u.id = l.user_id
      JOIN disciplinary_cases c ON c.id = l.case_id
      ORDER BY l.id DESC
    `).all() : [];

    const myLetters = db.prepare(`
      SELECT l.*, c.case_number
      FROM disciplinary_letters l
      JOIN disciplinary_cases c ON c.id = l.case_id
      WHERE l.user_id = ?
      ORDER BY l.issued_at DESC
    `).all(user.id);

    const inquiries = isAdmin ? db.prepare(`
      SELECT di.*, c.case_number, u.name as user_name
      FROM domestic_inquiries di
      JOIN disciplinary_cases c ON c.id = di.case_id
      JOIN users u ON u.id = c.user_id
      ORDER BY di.id DESC
    `).all() : [];

    const usersList = db.prepare("SELECT id, name, employee_no, department FROM users WHERE status = 'active' ORDER BY name").all();

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Disciplinary & Industrial Relations</h1>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/disciplinary?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'cases') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Restricted Disciplinary Cases', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Case #</th>
                    <th style="padding:10px;">Employee</th>
                    <th style="padding:10px;">Category</th>
                    <th style="padding:10px;">Incident Date</th>
                    <th style="padding:10px;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${cases.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No active disciplinary cases.</td></tr>' : ''}
                  ${cases.map(c => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-family:monospace; font-weight:700; color:#ef4444;">${escapeHtml(c.case_number)}</td>
                      <td style="padding:10px; font-weight:600;">${escapeHtml(c.user_name)}</td>
                      <td style="padding:10px;">${escapeHtml(c.category)}</td>
                      <td style="padding:10px;">${escapeHtml(c.incident_date)}</td>
                      <td style="padding:10px;">${statusBadge(c.status)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          <div>
            ${card('Open Disciplinary Case', `
              <form method="POST" action="/disciplinary/cases">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Employee</label>
                  <select name="user_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    ${usersList.map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.employee_no)})</option>`).join('')}
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Category</label>
                  <select name="category" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    <option value="Absence/Lateness">Unexplained Absence / Lateness</option>
                    <option value="Insubordination">Insubordination</option>
                    <option value="Misconduct">Misconduct / Policy Breach</option>
                    <option value="Negligence">Gross Negligence</option>
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Incident Date</label>
                  <input type="date" name="incident_date" required value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Case Summary</label>
                  <textarea name="description" rows="3" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#ef4444; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Open Case</button>
              </form>
            `)}
          </div>
        </div>
      `;
    } else if (tab === 'letters') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Issued Warning & Show-Cause Letters', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Case #</th>
                    <th style="padding:10px;">Employee</th>
                    <th style="padding:10px;">Type</th>
                    <th style="padding:10px;">Subject</th>
                    <th style="padding:10px;">Issued Date</th>
                  </tr>
                </thead>
                <tbody>
                  ${letters.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No letters generated.</td></tr>' : ''}
                  ${letters.map(l => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-family:monospace;">${escapeHtml(l.case_number)}</td>
                      <td style="padding:10px; font-weight:600;">${escapeHtml(l.user_name)}</td>
                      <td style="padding:10px;"><span style="text-transform:uppercase; font-size:11px; font-weight:700; padding:2px 6px; border-radius:4px; background:#fee2e2; color:#991b1b;">${escapeHtml(l.letter_type)}</span></td>
                      <td style="padding:10px;">${escapeHtml(l.subject)}</td>
                      <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(l.issued_at.substring(0,10))}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          <div>
            ${card('Generate Disciplinary Letter', `
              <form method="POST" action="/disciplinary/letters">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Disciplinary Case</label>
                  <select name="case_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    ${cases.map(c => `<option value="${c.id}">${escapeHtml(c.case_number)} - ${escapeHtml(c.user_name)}</option>`).join('')}
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Letter Type</label>
                  <select name="letter_type" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    <option value="warning">Written Warning Letter</option>
                    <option value="show_cause">Show-Cause Letter</option>
                    <option value="termination">Termination Notice</option>
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Subject</label>
                  <input type="text" name="subject" required placeholder="e.g. Formal Warning for Absence" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Letter Content</label>
                  <textarea name="content" rows="4" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#ef4444; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Generate & Issue Letter</button>
              </form>
            `)}
          </div>
        </div>
      `;
    } else if (tab === 'inquiry') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Domestic Inquiry (DI) Hearings', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Case #</th>
                    <th style="padding:10px;">Employee</th>
                    <th style="padding:10px;">Inquiry Date</th>
                    <th style="padding:10px;">Panel Members</th>
                    <th style="padding:10px;">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  ${inquiries.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No DI inquiries scheduled.</td></tr>' : ''}
                  ${inquiries.map(di => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-family:monospace;">${escapeHtml(di.case_number)}</td>
                      <td style="padding:10px; font-weight:600;">${escapeHtml(di.user_name)}</td>
                      <td style="padding:10px;">${escapeHtml(di.inquiry_date)}</td>
                      <td style="padding:10px;">${escapeHtml(di.panel_members || 'Panel TBD')}</td>
                      <td style="padding:10px; font-weight:600;">${escapeHtml(di.outcome || 'Pending')}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          <div>
            ${card('Schedule Domestic Inquiry', `
              <form method="POST" action="/disciplinary/inquiries">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Disciplinary Case</label>
                  <select name="case_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    ${cases.map(c => `<option value="${c.id}">${escapeHtml(c.case_number)} - ${escapeHtml(c.user_name)}</option>`).join('')}
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Inquiry Date</label>
                  <input type="date" name="inquiry_date" required value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Panel Members</label>
                  <input type="text" name="panel_members" placeholder="e.g. HR Director, Legal Officer" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Schedule Inquiry</button>
              </form>
            `)}
          </div>
        </div>
      `;
    } else if (tab === 'my') {
      content += `
        ${card('My Official Disciplinary Letters', `
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Reference #</th>
                <th style="padding:10px;">Letter Type</th>
                <th style="padding:10px;">Subject</th>
                <th style="padding:10px;">Issued Date</th>
                <th style="padding:10px;">Content</th>
              </tr>
            </thead>
            <tbody>
              ${myLetters.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No disciplinary letters issued to your record.</td></tr>' : ''}
              ${myLetters.map(ml => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-family:monospace;">${escapeHtml(ml.case_number)}</td>
                  <td style="padding:10px; font-weight:700; text-transform:uppercase;">${escapeHtml(ml.letter_type)}</td>
                  <td style="padding:10px; font-weight:600;">${escapeHtml(ml.subject)}</td>
                  <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(ml.issued_at.substring(0,10))}</td>
                  <td style="padding:10px;">${escapeHtml(ml.content)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Disciplinary & IR - StaffHub', body: content, user, activePath: '/disciplinary' }));
  });

  // Action: Open Case
  router.post('/disciplinary/cases', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { user_id, category, incident_date, description } = body;
    const caseNum = 'DISC-' + String(Math.floor(1000 + Math.random() * 9000));
    db.prepare(`
      INSERT INTO disciplinary_cases (case_number, user_id, category, incident_date, description, status)
      VALUES (?, ?, ?, ?, ?, 'open')
    `).run(caseNum, parseInt(user_id, 10), category || 'Misconduct', incident_date || todayISO(), description);
    logAudit(ctx.user.id, 'open_disciplinary_case', `Opened case ${caseNum} for user #${user_id}`);
    redirect(ctx.res, '/disciplinary?tab=cases');
  });

  // Action: Issue Letter
  router.post('/disciplinary/letters', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { case_id, letter_type, subject, content } = body;
    const caseRow = db.prepare('SELECT * FROM disciplinary_cases WHERE id = ?').get(parseInt(case_id, 10));
    if (!caseRow) return redirect(ctx.res, '/disciplinary?tab=letters');

    db.prepare(`
      INSERT INTO disciplinary_letters (case_id, user_id, letter_type, subject, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(caseRow.id, caseRow.user_id, letter_type, subject, content);
    logAudit(ctx.user.id, 'issue_disciplinary_letter', `Issued ${letter_type} letter for case #${case_id}`);
    redirect(ctx.res, '/disciplinary?tab=letters');
  });

  // Action: Schedule Inquiry
  router.post('/disciplinary/inquiries', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { case_id, inquiry_date, panel_members } = body;
    db.prepare(`
      INSERT INTO domestic_inquiries (case_id, inquiry_date, panel_members)
      VALUES (?, ?, ?)
    `).run(parseInt(case_id, 10), inquiry_date, panel_members || '');
    logAudit(ctx.user.id, 'schedule_domestic_inquiry', `Scheduled DI for case #${case_id}`);
    redirect(ctx.res, '/disciplinary?tab=inquiry');
  });
};
