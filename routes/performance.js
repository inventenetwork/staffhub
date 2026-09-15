'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('performance');
}

module.exports = function (router) {
  router.get('/performance', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Performance Management module is disabled.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'goals';

    const subTabs = [
      { id: 'goals', label: 'Goals & KPIs' },
      { id: 'reviews', label: 'Self & Manager Appraisals' },
      { id: 'feedback360', label: '360 Peer Feedback' },
      { id: 'pip', label: 'Performance Improvement Plans' },
      { id: 'cycles', label: 'Appraisal Cycles' },
    ];

    const cycles = db.prepare('SELECT * FROM appraisal_cycles ORDER BY id DESC').all();
    const activeCycle = cycles.find(c => c.status === 'active') || cycles[0];

    // Goals data
    let goals = [];
    if (isSuperAdmin(user) || hasAccess(user, ['admin'])) {
      goals = db.prepare(`
        SELECT g.*, u.name as user_name, u.employee_no, u.department
        FROM performance_goals g
        JOIN users u ON u.id = g.user_id
        ORDER BY g.id DESC
      `).all();
    } else {
      goals = db.prepare(`
        SELECT g.*, u.name as user_name, u.employee_no, u.department
        FROM performance_goals g
        JOIN users u ON u.id = g.user_id
        WHERE g.user_id = ? OR u.direct_superior_id = ? OR u.department = ?
        ORDER BY g.id DESC
      `).all(user.id, user.id, user.department || '');
    }

    // Reviews data
    const reviews = db.prepare(`
      SELECT r.*, u.name as user_name, u.employee_no, u.department, e.name as evaluator_name
      FROM performance_reviews r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN users e ON e.id = r.evaluator_id
      ORDER BY r.id DESC
    `).all();

    // 360 Feedback
    const feedbacks360 = db.prepare(`
      SELECT f.*, r.name as reviewer_name, s.name as subject_name
      FROM performance_360_feedback f
      JOIN users r ON r.id = f.reviewer_id
      JOIN users s ON s.id = f.subject_user_id
      ORDER BY f.submitted_at DESC
    `).all();

    // PIP Records
    const pips = db.prepare(`
      SELECT p.*, u.name as user_name, u.employee_no, m.name as manager_name
      FROM performance_improvement_plans p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN users m ON m.id = p.manager_id
      ORDER BY p.id DESC
    `).all();

    const usersList = db.prepare("SELECT id, name, employee_no, department FROM users WHERE status = 'active' ORDER BY name").all();

    let content = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Performance Management & Appraisal</h1>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/performance?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'goals') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Goals & KPI Targets', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Employee</th>
                    <th style="padding:10px;">Goal Title</th>
                    <th style="padding:10px;">Weight (%)</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${goals.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No goals submitted.</td></tr>' : ''}
                  ${goals.map(g => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(g.user_name)}</td>
                      <td style="padding:10px;">${escapeHtml(g.title)}</td>
                      <td style="padding:10px;">${g.weight}%</td>
                      <td style="padding:10px;">${statusBadge(g.status)}</td>
                      <td style="padding:10px;">
                        ${g.status === 'pending_approval' && hasAccess(user, ['admin', 'manager', 'hiring_manager']) ? `
                          <form method="POST" action="/performance/goals/${g.id}/approve" style="display:inline;">
                            <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve Goal</button>
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
            ${card('Submit Goal / KPI', `
              <form method="POST" action="/performance/goals">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Goal Title</label>
                  <input type="text" name="title" required placeholder="e.g. Increase product adoption by 15%" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Weight (%)</label>
                  <input type="number" name="weight" value="20" min="5" max="100" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Description / Key Results</label>
                  <textarea name="description" rows="3" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Goal</button>
              </form>
            `)}
          </div>
        </div>
      `;
    } else if (tab === 'reviews') {
      content += `
        ${card('Appraisal Review Workflow', `
          <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Employee</th>
                <th style="padding:10px;">Self Rating</th>
                <th style="padding:10px;">Manager Rating</th>
                <th style="padding:10px;">Overall Score</th>
                <th style="padding:10px;">Status</th>
                <th style="padding:10px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${reviews.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No review records found.</td></tr>' : ''}
              ${reviews.map(r => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-weight:600;">${escapeHtml(r.user_name)}</td>
                  <td style="padding:10px;">${r.self_rating ? '★'.repeat(r.self_rating) : 'Pending'}</td>
                  <td style="padding:10px;">${r.manager_rating ? '★'.repeat(r.manager_rating) : 'Pending'}</td>
                  <td style="padding:10px; font-weight:700;">${r.overall_score ? r.overall_score.toFixed(1) : '-'}</td>
                  <td style="padding:10px;">${statusBadge(r.status)}</td>
                  <td style="padding:10px;">
                    ${r.user_id === user.id && r.status === 'self_review' ? `
                      <button onclick="openSelfModal(${r.id})" style="padding:4px 8px; font-size:12px; background:#2563eb; color:#fff; border:none; border-radius:4px; cursor:pointer;">Submit Self Appraisal</button>
                    ` : ''}
                    ${hasAccess(user, ['admin', 'manager', 'hiring_manager']) && r.status === 'manager_review' ? `
                      <button onclick="openManagerModal(${r.id})" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Evaluate</button>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}

        <!-- Self Review Modal -->
        <div id="selfModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;">
          <div style="background:#fff; width:450px; margin:120px auto; padding:24px; border-radius:8px;">
            <h3 style="margin-top:0;">Submit Self Appraisal</h3>
            <form method="POST" action="" id="selfForm">
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Self Rating (1 - 5 Stars)</label>
                <select name="self_rating" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  <option value="5">5 - Outstanding</option>
                  <option value="4">4 - Exceeds Expectations</option>
                  <option value="3">3 - Meets Expectations</option>
                  <option value="2">2 - Needs Improvement</option>
                  <option value="1">1 - Unsatisfactory</option>
                </select>
              </div>
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Self Reflection / Accomplishments</label>
                <textarea name="self_comments" rows="3" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button type="button" onclick="document.getElementById('selfModal').style.display='none'" style="padding:8px 16px; background:#e5e7eb; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
                <button type="submit" style="padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Submit</button>
              </div>
            </form>
          </div>
        </div>

        <script>
          function openSelfModal(id) {
            document.getElementById('selfForm').action = '/performance/reviews/' + id + '/self';
            document.getElementById('selfModal').style.display = 'block';
          }
        </script>
      `;
    } else if (tab === 'feedback360') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Submitted 360 Peer Feedbacks', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Subject Employee</th>
                    <th style="padding:10px;">Peer Reviewer</th>
                    <th style="padding:10px;">Rating</th>
                    <th style="padding:10px;">Feedback</th>
                  </tr>
                </thead>
                <tbody>
                  ${feedbacks360.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No 360 peer feedback submitted yet.</td></tr>' : ''}
                  ${feedbacks360.map(f => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(f.subject_name)}</td>
                      <td style="padding:10px;">${escapeHtml(f.reviewer_name)}</td>
                      <td style="padding:10px; color:#f59e0b; font-weight:700;">${'★'.repeat(f.rating || 5)}</td>
                      <td style="padding:10px;">${escapeHtml(f.feedback_text)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          <div>
            ${card('Submit Peer Feedback', `
              <form method="POST" action="/performance/360">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Colleague / Peer</label>
                  <select name="subject_user_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    ${usersList.filter(u => u.id !== user.id).map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.department || 'General')})</option>`).join('')}
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Peer Rating (1 - 5 Stars)</label>
                  <select name="rating" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    <option value="5">5 - Excellent Team Player</option>
                    <option value="4">4 - Very Good</option>
                    <option value="3">3 - Good Collaboration</option>
                    <option value="2">2 - Satisfactory</option>
                    <option value="1">1 - Needs Improvement</option>
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Peer Feedback / Comments</label>
                  <textarea name="feedback_text" rows="3" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Peer Review</button>
              </form>
            `)}
          </div>
        </div>
      `;
    } else if (tab === 'pip') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin', 'manager', 'hiring_manager']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Performance Improvement Plans (PIP)', `
              <p style="color:#6b7280; font-size:14px; margin-bottom:16px;">Records created here sync seamlessly to the employee's Profile > Employee Occupation PIP summary card.</p>
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Employee</th>
                    <th style="padding:10px;">Reason</th>
                    <th style="padding:10px;">Timeline</th>
                    <th style="padding:10px;">Manager</th>
                    <th style="padding:10px;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${pips.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No active or past PIP records.</td></tr>' : ''}
                  ${pips.map(p => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(p.user_name)}</td>
                      <td style="padding:10px;">${escapeHtml(p.reason)}</td>
                      <td style="padding:10px;">${escapeHtml(p.start_date)} → ${escapeHtml(p.end_date)}</td>
                      <td style="padding:10px;">${escapeHtml(p.manager_name || 'HR')}</td>
                      <td style="padding:10px;">${statusBadge(p.status)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>

          ${hasAccess(user, ['admin', 'manager', 'hiring_manager']) ? `
            <div>
              ${card('Initiate PIP', `
                <form method="POST" action="/performance/pip">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Employee</label>
                    <select name="user_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      ${usersList.map(u => `<option value="${u.id}">${escapeHtml(u.name)} (${escapeHtml(u.employee_no)})</option>`).join('')}
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Reason for PIP</label>
                    <input type="text" name="reason" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Action Plan & Objectives</label>
                    <textarea name="action_plan" rows="3" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                  </div>
                  <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:12px;">
                    <div>
                      <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Start Date</label>
                      <input type="date" name="start_date" required value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    </div>
                    <div>
                      <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">End Date</label>
                      <input type="date" name="end_date" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    </div>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#ef4444; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Initiate PIP</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    } else if (tab === 'cycles') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Appraisal Cycles', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Cycle Title</th>
                    <th style="padding:10px;">Start Date</th>
                    <th style="padding:10px;">End Date</th>
                    <th style="padding:10px;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${cycles.length === 0 ? '<tr><td colspan="4" style="padding:15px; text-align:center; color:#9ca3af;">No appraisal cycles created.</td></tr>' : ''}
                  ${cycles.map(c => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(c.title)}</td>
                      <td style="padding:10px;">${escapeHtml(c.start_date)}</td>
                      <td style="padding:10px;">${escapeHtml(c.end_date)}</td>
                      <td style="padding:10px;">${statusBadge(c.status)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}
          </div>
          ${hasAccess(user, ['admin']) ? `
            <div>
              ${card('Create Appraisal Cycle', `
                <form method="POST" action="/performance/cycles">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Cycle Title</label>
                    <input type="text" name="title" required value="Annual Review ${new Date().getFullYear()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Start Date</label>
                    <input type="date" name="start_date" required value="${todayISO()}" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">End Date</label>
                    <input type="date" name="end_date" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Create Cycle</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Performance - StaffHub', body: content, user, activePath: '/performance' }));
  });

  // Action: Create Goal
  router.post('/performance/goals', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { title, description, weight } = body;
    db.prepare(`
      INSERT INTO performance_goals (user_id, title, description, weight, status)
      VALUES (?, ?, ?, ?, 'pending_approval')
    `).run(ctx.user.id, title, description || '', parseInt(weight || '10', 10));
    logAudit(ctx.user.id, 'create_performance_goal', `Created goal: ${title}`);
    redirect(ctx.res, '/performance?tab=goals');
  });

  // Action: Approve Goal
  router.post('/performance/goals/:id/approve', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'manager', 'hiring_manager'])) return redirect(ctx.res, '/login');
    const goalId = parseInt(ctx.params.id, 10);
    db.prepare(`UPDATE performance_goals SET status = 'approved' WHERE id = ?`).run(goalId);
    logAudit(ctx.user.id, 'approve_performance_goal', `Approved goal #${goalId}`);
    redirect(ctx.res, '/performance?tab=goals');
  });

  // Action: Submit Self Review
  router.post('/performance/reviews/:id/self', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const revId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);
    db.prepare(`
      UPDATE performance_reviews SET self_rating = ?, self_comments = ?, status = 'manager_review' WHERE id = ?
    `).run(parseInt(body.self_rating, 10), body.self_comments || '', revId);
    logAudit(ctx.user.id, 'submit_self_appraisal', `Submitted self appraisal for review #${revId}`);
    redirect(ctx.res, '/performance?tab=reviews');
  });

  // Action: Submit 360 Feedback
  router.post('/performance/360', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { subject_user_id, rating, feedback_text } = body;
    db.prepare(`
      INSERT INTO performance_360_feedback (reviewer_id, subject_user_id, rating, feedback_text)
      VALUES (?, ?, ?, ?)
    `).run(ctx.user.id, parseInt(subject_user_id, 10), parseInt(rating || '5', 10), feedback_text || '');
    logAudit(ctx.user.id, 'submit_360_feedback', `Submitted 360 feedback for user #${subject_user_id}`);
    redirect(ctx.res, '/performance?tab=feedback360');
  });

  // Action: Initiate PIP
  router.post('/performance/pip', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'manager', 'hiring_manager'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { user_id, reason, action_plan, start_date, end_date } = body;
    db.prepare(`
      INSERT INTO performance_improvement_plans (user_id, manager_id, reason, action_plan, start_date, end_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(parseInt(user_id, 10), ctx.user.id, reason, action_plan, start_date, end_date);
    logAudit(ctx.user.id, 'initiate_pip', `Initiated PIP for user #${user_id}`);
    redirect(ctx.res, '/performance?tab=pip');
  });

  // Action: Create Cycle
  router.post('/performance/cycles', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { title, start_date, end_date } = body;
    db.prepare(`
      INSERT INTO appraisal_cycles (title, start_date, end_date, status)
      VALUES (?, ?, ?, 'active')
    `).run(title, start_date, end_date);
    logAudit(ctx.user.id, 'create_appraisal_cycle', `Created appraisal cycle: ${title}`);
    redirect(ctx.res, '/performance?tab=cycles');
  });
};
