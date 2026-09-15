'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('training');
}

module.exports = function (router) {
  router.get('/training', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Training & Development module is disabled.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'catalog';

    const subTabs = [
      { id: 'catalog', label: 'Course Catalog & Calendar' },
      { id: 'enrollment', label: 'Enrollment & Nomination' },
      { id: 'completion', label: 'Completion & Certificates' },
      { id: 'budget', label: 'Training Budget Tracking' },
    ];

    const courses = db.prepare('SELECT * FROM training_courses ORDER BY id DESC').all();
    const sessions = db.prepare(`
      SELECT s.*, c.title as course_title, c.category, c.trainer
      FROM training_sessions s
      JOIN training_courses c ON c.id = s.course_id
      ORDER BY s.session_date ASC
    `).all();

    const enrollments = db.prepare(`
      SELECT e.*, u.name as user_name, u.employee_no, u.department, s.session_date, c.title as course_title, n.name as nominator_name
      FROM training_enrollments e
      JOIN users u ON u.id = e.user_id
      JOIN training_sessions s ON s.id = e.session_id
      JOIN training_courses c ON c.id = s.course_id
      LEFT JOIN users n ON n.id = e.nominated_by
      ORDER BY e.id DESC
    `).all();

    const budgets = db.prepare('SELECT * FROM training_budgets ORDER BY year DESC, department ASC').all();
    const usersList = db.prepare("SELECT id, name, employee_no, department FROM users WHERE status = 'active' ORDER BY name").all();
    const depts = db.prepare("SELECT value FROM list_options WHERE list_key = 'department' ORDER BY value").all();

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Training & Development</h1>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/training?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'catalog') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Upcoming Scheduled Training Sessions', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Course Title</th>
                    <th style="padding:10px;">Category</th>
                    <th style="padding:10px;">Session Date</th>
                    <th style="padding:10px;">Location</th>
                    <th style="padding:10px;">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${sessions.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No scheduled sessions.</td></tr>' : ''}
                  ${sessions.map(s => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(s.course_title)}</td>
                      <td style="padding:10px;">${escapeHtml(s.category)}</td>
                      <td style="padding:10px;">${escapeHtml(s.session_date)}</td>
                      <td style="padding:10px;">${escapeHtml(s.location || 'Online')}</td>
                      <td style="padding:10px;">
                        <form method="POST" action="/training/enroll" style="display:inline;">
                          <input type="hidden" name="session_id" value="${s.id}">
                          <input type="hidden" name="user_id" value="${user.id}">
                          <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Self-Enroll</button>
                        </form>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>

          ${hasAccess(user, ['admin']) ? `
            <div>
              ${card('Add Course & Schedule Session', `
                <form method="POST" action="/training/courses">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Course Title</label>
                    <input type="text" name="title" required placeholder="e.g. AWS Cloud Architecture" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Category</label>
                    <input type="text" name="category" value="Technical Certification" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Trainer / Provider</label>
                    <input type="text" name="trainer" placeholder="Internal HR / Vendor" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Session Date</label>
                    <input type="date" name="session_date" required value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Publish Session</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    } else if (tab === 'enrollment') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin', 'manager', 'hiring_manager']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Training Enrollments & Nominations', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Employee</th>
                    <th style="padding:10px;">Course</th>
                    <th style="padding:10px;">Nominated By</th>
                    <th style="padding:10px;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${enrollments.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No active enrollments.</td></tr>' : ''}
                  ${enrollments.map(e => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(e.user_name)}</td>
                      <td style="padding:10px;">${escapeHtml(e.course_title)}</td>
                      <td style="padding:10px;">${escapeHtml(e.nominator_name || 'Self-Enrolled')}</td>
                      <td style="padding:10px;">${statusBadge(e.status)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>

          ${hasAccess(user, ['admin', 'manager', 'hiring_manager']) ? `
            <div>
              ${card('Nominate Team Member', `
                <form method="POST" action="/training/enroll">
                  <input type="hidden" name="nominated_by" value="${user.id}">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Team Member</label>
                    <select name="user_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      ${usersList.map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.employee_no)})</option>`).join('')}
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Training Session</label>
                    <select name="session_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      ${sessions.map(s => `<option value="${s.id}">${escapeHtml(s.course_title)} (${escapeHtml(s.session_date)})</option>`).join('')}
                    </select>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Nomination</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    } else if (tab === 'completion') {
      content += `
        ${card('Training Completion & Qualification Auto-Sync', `
          <p style="color:#6b7280; font-size:14px; margin-bottom:16px;">Marking a course completed auto-syncs the earned qualification to the employee's Profile > Employee Occupation Certifications & Skills card!</p>
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Employee</th>
                <th style="padding:10px;">Course Title</th>
                <th style="padding:10px;">Completion Status</th>
                <th style="padding:10px;">Completed Date</th>
                <th style="padding:10px;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${enrollments.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No completion records.</td></tr>' : ''}
              ${enrollments.map(e => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-weight:600;">${escapeHtml(e.user_name)}</td>
                  <td style="padding:10px;">${escapeHtml(e.course_title)}</td>
                  <td style="padding:10px;">${statusBadge(e.status)}</td>
                  <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(e.completed_at || '-')}</td>
                  <td style="padding:10px;">
                    ${e.status !== 'completed' && hasAccess(user, ['admin']) ? `
                      <form method="POST" action="/training/enrollments/${e.id}/complete" style="display:inline;">
                        <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Mark Completed & Sync Profile</button>
                      </form>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    } else if (tab === 'budget') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Department Training Budgets', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Department</th>
                    <th style="padding:10px;">Year</th>
                    <th style="padding:10px;">Allocated Budget</th>
                    <th style="padding:10px;">Spent Budget</th>
                  </tr>
                </thead>
                <tbody>
                  ${budgets.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No budget allocations set.</td></tr>' : ''}
                  ${budgets.map(b => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(b.department)}</td>
                      <td style="padding:10px;">${b.year}</td>
                      <td style="padding:10px; font-weight:700; color:#2563eb;">RM ${Number(b.allocated_budget).toFixed(2)}</td>
                      <td style="padding:10px; color:#047857;">RM ${Number(b.spent_budget).toFixed(2)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          ${hasAccess(user, ['admin']) ? `
            <div>
              ${card('Set Training Budget', `
                <form method="POST" action="/training/budget">
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
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Allocated Budget (RM)</label>
                    <input type="number" step="0.01" name="allocated_budget" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Save Budget</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Training & Development - StaffHub', body: content, user, activePath: '/training' }));
  });

  // Action: Add Course & Session
  router.post('/training/courses', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { title, category, trainer, session_date } = body;
    const res = db.prepare(`
      INSERT INTO training_courses (title, category, trainer)
      VALUES (?, ?, ?)
    `).run(title, category || 'Professional Skills', trainer || '');

    const courseId = Number(res.lastInsertRowid);
    db.prepare(`
      INSERT INTO training_sessions (course_id, session_date, status)
      VALUES (?, ?, 'scheduled')
    `).run(courseId, session_date || todayISO());

    logAudit(ctx.user.id, 'create_training_course', `Created training course: ${title}`);
    redirect(ctx.res, '/training?tab=catalog');
  });

  // Action: Enroll / Nominate
  router.post('/training/enroll', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { session_id, user_id, nominated_by } = body;
    const targetUserId = user_id ? parseInt(user_id, 10) : ctx.user.id;
    db.prepare(`
      INSERT INTO training_enrollments (session_id, user_id, nominated_by, status)
      VALUES (?, ?, ?, 'enrolled')
    `).run(parseInt(session_id, 10), targetUserId, nominated_by ? parseInt(nominated_by, 10) : null);
    logAudit(ctx.user.id, 'enroll_training', `Enrolled user #${targetUserId} in training session #${session_id}`);
    redirect(ctx.res, '/training?tab=enrollment');
  });

  // Action: Mark Complete & Auto-Sync Profile Certifications
  router.post('/training/enrollments/:id/complete', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const enrId = parseInt(ctx.params.id, 10);
    const enr = db.prepare(`
      SELECT e.*, c.title as course_title, c.category
      FROM training_enrollments e
      JOIN training_sessions s ON s.id = e.session_id
      JOIN training_courses c ON c.id = s.course_id
      WHERE e.id = ?
    `).get(enrId);

    if (enr) {
      db.prepare(`UPDATE training_enrollments SET status = 'completed', completed_at = ? WHERE id = ?`).run(todayISO(), enrId);
      // Auto-sync into certifications_skills table on employee profile
      db.prepare(`
        INSERT INTO certifications_skills (user_id, name, issuing_body, issue_date)
        VALUES (?, ?, 'StaffHub L&D', ?)
      `).run(enr.user_id, enr.course_title, todayISO());
    }

    logAudit(ctx.user.id, 'complete_training', `Marked training enrollment #${enrId} completed & synced profile qualification`);
    redirect(ctx.res, '/training?tab=completion');
  });

  // Action: Set Budget
  router.post('/training/budget', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { department, year, allocated_budget } = body;
    db.prepare(`
      INSERT INTO training_budgets (department, year, allocated_budget)
      VALUES (?, ?, ?)
      ON CONFLICT(department, year) DO UPDATE SET allocated_budget = excluded.allocated_budget
    `).run(department, parseInt(year, 10), parseFloat(allocated_budget || '0'));
    logAudit(ctx.user.id, 'set_training_budget', `Set training budget for ${department} (${year})`);
    redirect(ctx.res, '/training?tab=budget');
  });
};
