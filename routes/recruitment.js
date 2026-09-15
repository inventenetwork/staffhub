'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('recruitment');
}

function canAccessRequisition(user, reqRow) {
  if (isSuperAdmin(user) || hasAccess(user, ['admin'])) return true;
  if (user.permission_tier === 'hiring_manager') {
    return reqRow.hiring_manager_id === user.id || (user.department && reqRow.department === user.department);
  }
  return false;
}

module.exports = function (router) {
  router.get('/recruitment', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Recruitment is not enabled.'));
    if (!hasAccess(ctx.user, ['admin', 'hiring_manager'])) {
      return redirect(ctx.res, '/?error=' + encodeURIComponent('Access denied to Recruitment.'));
    }

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'requisitions';

    // Fetch requisitions based on role scoping
    let requisitions = [];
    if (isSuperAdmin(user) || hasAccess(user, ['admin'])) {
      requisitions = db.prepare(`
        SELECT r.*, u.name as hiring_manager_name 
        FROM job_requisitions r 
        LEFT JOIN users u ON u.id = r.hiring_manager_id 
        ORDER BY r.id DESC
      `).all();
    } else {
      requisitions = db.prepare(`
        SELECT r.*, u.name as hiring_manager_name 
        FROM job_requisitions r 
        LEFT JOIN users u ON u.id = r.hiring_manager_id 
        WHERE r.hiring_manager_id = ? OR r.department = ?
        ORDER BY r.id DESC
      `).all(user.id, user.department || '');
    }

    // Fetch candidate pipeline
    const reqIds = requisitions.map(r => r.id);
    let candidates = [];
    if (reqIds.length > 0) {
      const placeholders = reqIds.map(() => '?').join(',');
      candidates = db.prepare(`
        SELECT c.*, r.title as requisition_title, r.department
        FROM candidates c
        JOIN job_requisitions r ON r.id = c.requisition_id
        WHERE c.requisition_id IN (${placeholders})
        ORDER BY c.id DESC
      `).all(...reqIds);
    }

    // Fetch interviews & feedback
    const interviews = db.prepare(`
      SELECT i.*, c.name as candidate_name, u.name as interviewer_name, r.title as requisition_title
      FROM interviews i
      JOIN candidates c ON c.id = i.candidate_id
      JOIN job_requisitions r ON r.id = c.requisition_id
      JOIN users u ON u.id = i.interviewer_id
      ORDER BY i.scheduled_at DESC
    `).all();

    const feedbacks = db.prepare(`
      SELECT f.*, u.name as evaluator_name, c.name as candidate_name
      FROM interview_feedback f
      JOIN users u ON u.id = f.evaluator_id
      JOIN candidates c ON c.id = f.candidate_id
      ORDER BY f.submitted_at DESC
    `).all();

    const hiringManagers = db.prepare(`
      SELECT u.id, u.name, u.department 
      FROM users u 
      JOIN roles r ON r.id = u.role_id 
      WHERE r.permission_tier IN ('admin','super_admin','hiring_manager')
      ORDER BY u.name
    `).all();

    // Render Sub-tabs
    const subTabs = [
      { id: 'requisitions', label: 'Job Requisitions' },
      { id: 'pipeline', label: 'Candidate Pipeline' },
      { id: 'interviews', label: 'Interview Management' },
      { id: 'offers', label: 'Offer & Conversion' },
      { id: 'settings', label: 'Recruitment Settings' },
    ];

    let content = `
      <div style="display:flex; justify-space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Recruitment & Applicant Tracking</h1>
      </div>
      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/recruitment?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'requisitions') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Job Requisitions', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Title</th>
                    <th style="padding:10px;">Department</th>
                    <th style="padding:10px;">Headcount</th>
                    <th style="padding:10px;">Hiring Manager</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${requisitions.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No job requisitions found.</td></tr>' : ''}
                  ${requisitions.map(r => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(r.title)}</td>
                      <td style="padding:10px;">${escapeHtml(r.department)}</td>
                      <td style="padding:10px;">${r.headcount}</td>
                      <td style="padding:10px;">${escapeHtml(r.hiring_manager_name || 'Unassigned')}</td>
                      <td style="padding:10px;">${statusBadge(r.status)}</td>
                      <td style="padding:10px;">
                        ${r.status === 'pending_approval' && canAccessRequisition(user, r) ? `
                          <form method="POST" action="/recruitment/requisitions/${r.id}/approve" style="display:inline;">
                            <button type="submit" class="btn btn-sm btn-success" style="padding:4px 8px; font-size:12px; background:#10b981; color:#fff; border:none; border-radius:4px; cursor:pointer;">Approve</button>
                          </form>
                          <form method="POST" action="/recruitment/requisitions/${r.id}/reject" style="display:inline;">
                            <button type="submit" class="btn btn-sm btn-danger" style="padding:4px 8px; font-size:12px; background:#ef4444; color:#fff; border:none; border-radius:4px; cursor:pointer;">Reject</button>
                          </form>
                        ` : ''}
                        ${r.status === 'approved' && hasAccess(user, ['admin']) ? `
                          <form method="POST" action="/recruitment/requisitions/${r.id}/status" style="display:inline;">
                            <input type="hidden" name="status" value="closed">
                            <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#6b7280; color:#fff; border:none; border-radius:4px; cursor:pointer;">Close</button>
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
              ${card('Create Job Requisition', `
                <form method="POST" action="/recruitment/requisitions">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Position Title</label>
                    <input type="text" name="title" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Department</label>
                    <input type="text" name="department" required placeholder="e.g. Engineering" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Headcount Target</label>
                    <input type="number" name="headcount" value="1" min="1" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Hiring Manager</label>
                    <select name="hiring_manager_id" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      <option value="">Select Hiring Manager</option>
                      ${hiringManagers.map(hm => `<option value="${hm.id}">${escapeHtml(hm.name)} (${escapeHtml(hm.department || 'General')})</option>`).join('')}
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Notes / Job Description</label>
                    <textarea name="notes" rows="3" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Requisition</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    } else if (tab === 'pipeline') {
      const stages = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected'];
      content += `
        <div style="margin-bottom:20px; display:flex; justify-content:space-between; align-items:center;">
          <h3 style="font-size:18px; font-weight:600; margin:0;">Candidate Kanban Board</h3>
          ${hasAccess(user, ['admin']) ? `
            <button onclick="document.getElementById('addCandidateModal').style.display='block'" style="padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">+ Add Candidate</button>
          ` : ''}
        </div>

        <div style="display:grid; grid-template-columns: repeat(6, 1fr); gap:12px; overflow-x:auto;">
          ${stages.map(stg => {
            const stageCandidates = candidates.filter(c => c.stage === stg);
            return `
              <div style="background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:12px; min-height:400px;">
                <div style="font-weight:700; font-size:13px; text-transform:uppercase; color:#4b5563; margin-bottom:12px; display:flex; justify-content:space-between;">
                  <span>${stg}</span>
                  <span style="background:#e5e7eb; padding:2px 6px; border-radius:10px; font-size:11px;">${stageCandidates.length}</span>
                </div>
                ${stageCandidates.map(c => `
                  <div style="background:#fff; border:1px solid #e5e7eb; border-radius:6px; padding:10px; margin-bottom:10px; box-shadow:0 1px 2px rgba(0,0,0,0.05);">
                    <div style="font-weight:600; font-size:14px;">${escapeHtml(c.name)}</div>
                    <div style="font-size:12px; color:#6b7280; margin-top:2px;">${escapeHtml(c.requisition_title)}</div>
                    <div style="font-size:11px; color:#9ca3af; margin-top:4px;">${escapeHtml(c.email)}</div>
                    <form method="POST" action="/recruitment/candidates/${c.id}/stage" style="margin-top:8px;">
                      <select name="stage" onchange="this.form.submit()" style="width:100%; font-size:11px; padding:4px; border:1px solid #d1d5db; border-radius:4px;">
                        ${stages.map(s => `<option value="${s}" ${s === c.stage ? 'selected' : ''}>${s}</option>`).join('')}
                      </select>
                    </form>
                  </div>
                `).join('')}
              </div>
            `;
          }).join('')}
        </div>

        <!-- Add Candidate Modal -->
        <div id="addCandidateModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999;">
          <div style="background:#fff; width:450px; margin:100px auto; padding:24px; border-radius:8px;">
            <h3 style="margin-top:0;">Add New Candidate</h3>
            <form method="POST" action="/recruitment/candidates">
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Requisition</label>
                <select name="requisition_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  ${requisitions.map(r => `<option value="${r.id}">${escapeHtml(r.title)} (${escapeHtml(r.department)})</option>`).join('')}
                </select>
              </div>
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Candidate Name</label>
                <input type="text" name="name" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
              </div>
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Email</label>
                <input type="email" name="email" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
              </div>
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Phone</label>
                <input type="text" name="phone" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
              </div>
              <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:20px;">
                <button type="button" onclick="document.getElementById('addCandidateModal').style.display='none'" style="padding:8px 16px; background:#e5e7eb; border:none; border-radius:4px; cursor:pointer;">Cancel</button>
                <button type="submit" style="padding:8px 16px; background:#2563eb; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Save Candidate</button>
              </div>
            </form>
          </div>
        </div>
      `;
    } else if (tab === 'interviews') {
      content += `
        <div style="display:grid; grid-template-columns: 2fr 1fr; gap:20px;">
          <div>
            ${card('Scheduled Interviews', `
              <table style="width:100%; border-collapse:collapse; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Candidate</th>
                    <th style="padding:10px;">Position</th>
                    <th style="padding:10px;">Interviewer</th>
                    <th style="padding:10px;">Scheduled At</th>
                    <th style="padding:10px;">Status</th>
                  </tr>
                </thead>
                <tbody>
                  ${interviews.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No interviews scheduled.</td></tr>' : ''}
                  ${interviews.map(i => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(i.candidate_name)}</td>
                      <td style="padding:10px;">${escapeHtml(i.requisition_title)}</td>
                      <td style="padding:10px;">${escapeHtml(i.interviewer_name)}</td>
                      <td style="padding:10px;">${escapeHtml(i.scheduled_at)}</td>
                      <td style="padding:10px;">${statusBadge(i.status)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `)}

            <div style="margin-top:20px;">
              ${card('Consolidated Interview Feedback', `
                <table style="width:100%; border-collapse:collapse; font-size:14px;">
                  <thead>
                    <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                      <th style="padding:10px;">Candidate</th>
                      <th style="padding:10px;">Evaluator</th>
                      <th style="padding:10px;">Rating</th>
                      <th style="padding:10px;">Feedback</th>
                      <th style="padding:10px;">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${feedbacks.length === 0 ? '<tr><td colspan="5" style="padding:15px; text-align:center; color:#9ca3af;">No feedback submitted yet.</td></tr>' : ''}
                    ${feedbacks.map(f => `
                      <tr style="border-bottom:1px solid #f3f4f6;">
                        <td style="padding:10px; font-weight:600;">${escapeHtml(f.candidate_name)}</td>
                        <td style="padding:10px;">${escapeHtml(f.evaluator_name)}</td>
                        <td style="padding:10px; color:#f59e0b; font-weight:700;">${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)}</td>
                        <td style="padding:10px;">${escapeHtml(f.feedback || '')}</td>
                        <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(f.submitted_at.substring(0,10))}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              `)}
            </div>
          </div>

          <div>
            ${card('Schedule Interview', `
              <form method="POST" action="/recruitment/interviews">
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Candidate</label>
                  <select name="candidate_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    ${candidates.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.requisition_title)})</option>`).join('')}
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Interviewer</label>
                  <select name="interviewer_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                    ${hiringManagers.map(hm => `<option value="${hm.id}">${escapeHtml(hm.name)} (${escapeHtml(hm.department || 'General')})</option>`).join('')}
                  </select>
                </div>
                <div style="margin-bottom:12px;">
                  <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Date & Time</label>
                  <input type="datetime-local" name="scheduled_at" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                </div>
                <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Schedule</button>
              </form>
            `)}

            <div style="margin-top:20px;">
              ${card('Submit Feedback', `
                <form method="POST" action="/recruitment/interviews/feedback">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Interview</label>
                    <select name="interview_id" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      ${interviews.map(i => `<option value="${i.id}">${escapeHtml(i.candidate_name)} with ${escapeHtml(i.interviewer_name)}</option>`).join('')}
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Rating (1 - 5 Stars)</label>
                    <select name="rating" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                      <option value="5">5 - Excellent</option>
                      <option value="4">4 - Good</option>
                      <option value="3">3 - Average</option>
                      <option value="2">2 - Below Average</option>
                      <option value="1">1 - Poor</option>
                    </select>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Evaluator Comments</label>
                    <textarea name="feedback" rows="3" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#10b981; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Feedback</button>
                </form>
              `)}
            </div>
          </div>
        </div>
      `;
    } else if (tab === 'offers') {
      const offerCandidates = candidates.filter(c => c.stage === 'offer' || c.stage === 'hired');
      content += `
        ${card('Offer & Candidate Conversion', `
          <p style="color:#6b7280; font-size:14px; margin-bottom:16px;">Candidates in the <strong>Offer</strong> or <strong>Hired</strong> stage can be converted directly into active employees in Employee Center.</p>
          <table style="width:100%; border-collapse:collapse; font-size:14px;">
            <thead>
              <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                <th style="padding:10px;">Candidate Name</th>
                <th style="padding:10px;">Email</th>
                <th style="padding:10px;">Position / Dept</th>
                <th style="padding:10px;">Stage</th>
                <th style="padding:10px;">Conversion Status</th>
                <th style="padding:10px;">Action</th>
              </tr>
            </thead>
            <tbody>
              ${offerCandidates.length === 0 ? '<tr><td colspan="6" style="padding:15px; text-align:center; color:#9ca3af;">No candidates ready for offer/conversion.</td></tr>' : ''}
              ${offerCandidates.map(c => `
                <tr style="border-bottom:1px solid #f3f4f6;">
                  <td style="padding:10px; font-weight:600;">${escapeHtml(c.name)}</td>
                  <td style="padding:10px;">${escapeHtml(c.email)}</td>
                  <td style="padding:10px;">${escapeHtml(c.requisition_title)} (${escapeHtml(c.department)})</td>
                  <td style="padding:10px;">${statusBadge(c.stage)}</td>
                  <td style="padding:10px;">
                    ${c.converted_user_id ? `<span style="color:#10b981; font-weight:600;">✓ Converted (User #${c.converted_user_id})</span>` : '<span style="color:#f59e0b;">Not Converted</span>'}
                  </td>
                  <td style="padding:10px;">
                    ${!c.converted_user_id && hasAccess(user, ['admin']) ? `
                      <form method="POST" action="/recruitment/candidates/${c.id}/convert">
                        <button type="submit" class="btn btn-sm" style="padding:6px 12px; background:#10b981; color:#fff; border:none; border-radius:4px; font-weight:600; cursor:pointer;">Convert to Employee</button>
                      </form>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `)}
      `;
    } else if (tab === 'settings') {
      content += `
        <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px;">
          ${card('Career Site Settings', `
            <div style="margin-bottom:12px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Public Portal Status</label>
              <input type="text" value="Active (http://localhost:3000/careers)" disabled style="width:100%; padding:8px; background:#f3f4f6; border:1px solid #d1d5db; border-radius:4px;">
            </div>
            <div style="margin-bottom:12px;">
              <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Default Application Notification Email</label>
              <input type="email" value="hr-recruitment@staffhub.com" disabled style="width:100%; padding:8px; background:#f3f4f6; border:1px solid #d1d5db; border-radius:4px;">
            </div>
          `)}
          ${card('Pipeline Metrics', `
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
              <div style="background:#eff6ff; padding:15px; border-radius:8px; text-align:center;">
                <div style="font-size:24px; font-weight:700; color:#1d4ed8;">${requisitions.length}</div>
                <div style="font-size:12px; color:#3b82f6;">Total Requisitions</div>
              </div>
              <div style="background:#ecfdf5; padding:15px; border-radius:8px; text-align:center;">
                <div style="font-size:24px; font-weight:700; color:#047857;">${candidates.length}</div>
                <div style="font-size:12px; color:#10b981;">Total Candidates</div>
              </div>
            </div>
          `)}
        </div>
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Recruitment - StaffHub', body: content, user, activePath: '/recruitment' }));
  });

  // Action: Create Requisition
  router.post('/recruitment/requisitions', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { title, department, headcount, hiring_manager_id, notes } = body;
    db.prepare(`
      INSERT INTO job_requisitions (title, department, headcount, hiring_manager_id, status, notes)
      VALUES (?, ?, ?, ?, 'pending_approval', ?)
    `).run(title, department, parseInt(headcount || '1', 10), hiring_manager_id ? parseInt(hiring_manager_id, 10) : null, notes || '');
    logAudit(ctx.user.id, 'create_job_requisition', `Created requisition: ${title}`);
    redirect(ctx.res, '/recruitment?tab=requisitions');
  });

  // Action: Approve Requisition
  router.post('/recruitment/requisitions/:id/approve', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const reqId = parseInt(ctx.params.id, 10);
    const reqRow = db.prepare('SELECT * FROM job_requisitions WHERE id = ?').get(reqId);
    if (!reqRow || !canAccessRequisition(ctx.user, reqRow)) {
      return redirect(ctx.res, '/recruitment?error=' + encodeURIComponent('Permission denied'));
    }
    db.prepare(`UPDATE job_requisitions SET status = 'approved' WHERE id = ?`).run(reqId);
    logAudit(ctx.user.id, 'approve_job_requisition', `Approved requisition #${reqId}`);
    redirect(ctx.res, '/recruitment?tab=requisitions');
  });

  // Action: Reject Requisition
  router.post('/recruitment/requisitions/:id/reject', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const reqId = parseInt(ctx.params.id, 10);
    const reqRow = db.prepare('SELECT * FROM job_requisitions WHERE id = ?').get(reqId);
    if (!reqRow || !canAccessRequisition(ctx.user, reqRow)) {
      return redirect(ctx.res, '/recruitment?error=' + encodeURIComponent('Permission denied'));
    }
    db.prepare(`UPDATE job_requisitions SET status = 'rejected' WHERE id = ?`).run(reqId);
    logAudit(ctx.user.id, 'reject_job_requisition', `Rejected requisition #${reqId}`);
    redirect(ctx.res, '/recruitment?tab=requisitions');
  });

  // Action: Close Requisition Status
  router.post('/recruitment/requisitions/:id/status', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const reqId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);
    db.prepare(`UPDATE job_requisitions SET status = ? WHERE id = ?`).run(body.status || 'closed', reqId);
    logAudit(ctx.user.id, 'update_job_requisition_status', `Updated requisition #${reqId} to ${body.status}`);
    redirect(ctx.res, '/recruitment?tab=requisitions');
  });

  // Action: Add Candidate
  router.post('/recruitment/candidates', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { requisition_id, name, email, phone } = body;
    db.prepare(`
      INSERT INTO candidates (requisition_id, name, email, phone, stage)
      VALUES (?, ?, ?, ?, 'applied')
    `).run(parseInt(requisition_id, 10), name, email, phone || '');
    logAudit(ctx.user.id, 'add_candidate', `Added candidate ${name} to requisition #${requisition_id}`);
    redirect(ctx.res, '/recruitment?tab=pipeline');
  });

  // Action: Move Candidate Stage
  router.post('/recruitment/candidates/:id/stage', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'hiring_manager'])) return redirect(ctx.res, '/login');
    const candId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);
    db.prepare(`UPDATE candidates SET stage = ? WHERE id = ?`).run(body.stage, candId);
    logAudit(ctx.user.id, 'update_candidate_stage', `Moved candidate #${candId} to stage ${body.stage}`);
    redirect(ctx.res, '/recruitment?tab=pipeline');
  });

  // Action: Schedule Interview
  router.post('/recruitment/interviews', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'hiring_manager'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { candidate_id, interviewer_id, scheduled_at } = body;
    db.prepare(`
      INSERT INTO interviews (candidate_id, interviewer_id, scheduled_at, status)
      VALUES (?, ?, ?, 'scheduled')
    `).run(parseInt(candidate_id, 10), parseInt(interviewer_id, 10), scheduled_at);
    // Auto advance candidate to interview stage
    db.prepare(`UPDATE candidates SET stage = 'interview' WHERE id = ?`).run(parseInt(candidate_id, 10));
    logAudit(ctx.user.id, 'schedule_interview', `Scheduled interview for candidate #${candidate_id}`);
    redirect(ctx.res, '/recruitment?tab=interviews');
  });

  // Action: Submit Interview Feedback
  router.post('/recruitment/interviews/feedback', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin', 'hiring_manager'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { interview_id, rating, feedback } = body;
    const interview = db.prepare('SELECT * FROM interviews WHERE id = ?').get(parseInt(interview_id, 10));
    if (!interview) return redirect(ctx.res, '/recruitment?tab=interviews');

    db.prepare(`
      INSERT INTO interview_feedback (interview_id, candidate_id, evaluator_id, rating, feedback)
      VALUES (?, ?, ?, ?, ?)
    `).run(interview.id, interview.candidate_id, ctx.user.id, parseInt(rating, 10), feedback || '');
    
    db.prepare(`UPDATE interviews SET status = 'completed' WHERE id = ?`).run(interview.id);
    logAudit(ctx.user.id, 'submit_interview_feedback', `Submitted feedback for interview #${interview.id}`);
    redirect(ctx.res, '/recruitment?tab=interviews');
  });

  // Action: Candidate -> Employee Conversion (Seam Bridge)
  router.post('/recruitment/candidates/:id/convert', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const candId = parseInt(ctx.params.id, 10);
    const candidate = db.prepare(`
      SELECT c.*, r.title as position_name, r.department as req_department
      FROM candidates c
      JOIN job_requisitions r ON r.id = c.requisition_id
      WHERE c.id = ?
    `).get(candId);

    if (!candidate) return redirect(ctx.res, '/recruitment?tab=offers');

    if (candidate.converted_user_id) {
      return redirect(ctx.res, '/recruitment?tab=offers&error=' + encodeURIComponent('Candidate already converted to employee.'));
    }

    const essRole = db.prepare(`SELECT id FROM roles WHERE permission_tier = 'ess' AND is_system = 1`).get() ||
                    db.prepare(`SELECT id FROM roles WHERE permission_tier = 'ess' LIMIT 1`).get();

    // 1. Create User
    const empNo = 'EMP-' + String(Math.floor(100000 + Math.random() * 900000));
    const passHash = require('../lib/auth').hashPassword('StaffHub@2026');
    const res = db.prepare(`
      INSERT INTO users (employee_no, name, email, password_hash, role_id, department, position, join_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(empNo, candidate.name, candidate.email, passHash, essRole.id, candidate.req_department, candidate.position_name, todayISO());

    const newUserId = Number(res.lastInsertRowid);

    // 2. Mark candidate converted
    db.prepare(`UPDATE candidates SET stage = 'hired', converted_user_id = ? WHERE id = ?`).run(newUserId, candId);

    // 3. Auto-instantiate onboarding tasks from template if templates exist
    const templates = db.prepare('SELECT * FROM onboarding_checklist_templates ORDER BY sort_order ASC').all();
    for (const t of templates) {
      db.prepare(`
        INSERT INTO onboarding_checklists (user_id, task_name, assigned_role, status, due_date)
        VALUES (?, ?, ?, 'pending', date('now', '+7 days'))
      `).run(newUserId, t.task_name, t.assigned_role);
    }

    // Default checklist items if no template was present
    if (templates.length === 0) {
      const defaultTasks = [
        { name: 'Submit IC Copy & Personal Info Form', role: 'ess' },
        { name: 'Verify Educational Certificates & Bank Info', role: 'admin' },
        { name: 'Provision Company Laptop & Email Access', role: 'it' },
      ];
      for (const dt of defaultTasks) {
        db.prepare(`
          INSERT INTO onboarding_checklists (user_id, task_name, assigned_role, status, due_date)
          VALUES (?, ?, ?, 'pending', date('now', '+7 days'))
        `).run(newUserId, dt.name, dt.role);
      }
    }

    logAudit(ctx.user.id, 'convert_candidate_to_employee', `Converted candidate ${candidate.name} (ID #${candId}) into user #${newUserId}`);
    redirect(ctx.res, `/recruitment?tab=offers&success=` + encodeURIComponent(`Successfully converted candidate ${candidate.name} to employee (${empNo}).`));
  });
};
