'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { logAudit } = require('../lib/audit');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('engagement');
}

module.exports = function (router) {
  router.get('/engagement', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Employee Engagement module is disabled.'));

    const user = ctx.user;
    const tab = ctx.url.searchParams.get('tab') || 'surveys';

    const subTabs = [
      { id: 'surveys', label: 'Take Active Surveys' },
      { id: 'builder', label: 'Survey Builder' },
      { id: 'analytics', label: 'eNPS & Survey Analytics' },
    ];

    const activeSurveys = db.prepare(`
      SELECT s.*,
             (SELECT COUNT(DISTINCT user_id) FROM survey_responses r WHERE r.survey_id = s.id) as response_count,
             (SELECT COUNT(*) FROM survey_responses r WHERE r.survey_id = s.id AND r.user_id = ?) as user_responded
      FROM surveys s
      ORDER BY s.created_at DESC
    `).all(user.id);

    // Compute eNPS score from rating survey questions
    const ratings = db.prepare('SELECT rating_value FROM survey_responses WHERE rating_value IS NOT NULL').all();
    let promoters = 0, detractors = 0, totalRatings = ratings.length;
    ratings.forEach(r => {
      if (r.rating_value >= 9) promoters++;
      else if (r.rating_value <= 6) detractors++;
    });
    const enpsScore = totalRatings > 0 ? Math.round(((promoters - detractors) / totalRatings) * 100) : 0;

    let content = `
      <div style="display:flex; justify-space-between; align-items:center; margin-bottom: 20px;">
        <h1 style="font-size:24px; font-weight:700; margin:0;">Employee Engagement & eNPS</h1>
      </div>

      <div style="display:flex; gap:12px; margin-bottom:20px; border-bottom:1px solid var(--border-color, #e5e7eb); padding-bottom:10px;">
        ${subTabs.map(st => `
          <a href="/engagement?tab=${st.id}" style="padding:8px 16px; border-radius:6px; font-size:14px; font-weight:600; text-decoration:none; color:${tab === st.id ? '#ffffff' : 'var(--text-color, #374151)'}; background:${tab === st.id ? 'var(--primary-color, #2563eb)' : 'transparent'};">
            ${st.label}
          </a>
        `).join('')}
      </div>
    `;

    if (tab === 'surveys') {
      content += `
        <div style="display:flex; flex-direction:column; gap:16px;">
          ${activeSurveys.length === 0 ? '<div style="padding:20px; text-align:center; color:#9ca3af; background:#fff; border-radius:8px;">No active engagement surveys.</div>' : ''}
          ${activeSurveys.map(s => {
            const questions = db.prepare('SELECT * FROM survey_questions WHERE survey_id = ? ORDER BY sort_order ASC').all(s.id);
            return `
              <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                  <div>
                    <h3 style="font-size:18px; font-weight:700; margin:0 0 4px 0;">${escapeHtml(s.title)}</h3>
                    <p style="font-size:14px; color:#6b7280; margin:0 0 12px 0;">${escapeHtml(s.description || 'Employee pulse survey')}</p>
                  </div>
                  ${statusBadge(s.status)}
                </div>

                ${s.user_responded > 0 ? `
                  <div style="background:#ecfdf5; border-left:4px solid #10b981; padding:12px; border-radius:4px; font-size:14px; color:#065f46; font-weight:600;">✓ You have submitted your responses for this survey.</div>
                ` : `
                  <form method="POST" action="/engagement/surveys/${s.id}/submit" style="margin-top:12px; border-top:1px solid #f3f4f6; padding-top:12px;">
                    ${questions.map((q, idx) => `
                      <div style="margin-bottom:14px;">
                        <label style="display:block; font-size:14px; font-weight:600; margin-bottom:6px;">${idx + 1}. ${escapeHtml(q.question_text)}</label>
                        ${q.question_type === 'rating' ? `
                          <select name="q_${q.id}" required style="padding:8px; border:1px solid #d1d5db; border-radius:4px; width:200px;">
                            <option value="">Rate 1 to 10</option>
                            ${[10,9,8,7,6,5,4,3,2,1].map(n => `<option value="${n}">${n} ${n >= 9 ? '— Extremely Likely' : (n <= 6 ? '— Unlikely' : '')}</option>`).join('')}
                          </select>
                        ` : `
                          <textarea name="q_${q.id}" rows="2" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                        `}
                      </div>
                    `).join('')}
                    <button type="submit" style="padding:8px 20px; background:#10b981; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Submit Survey Responses</button>
                  </form>
                `}
              </div>
            `;
          }).join('')}
        </div>
      `;
    } else if (tab === 'builder') {
      content += `
        <div style="display:grid; grid-template-columns: ${hasAccess(user, ['admin']) ? '2fr 1fr' : '1fr'}; gap:20px;">
          <div>
            ${card('Active Survey Templates', `
              <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
                <thead>
                  <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                    <th style="padding:10px;">Survey Title</th>
                    <th style="padding:10px;">Status</th>
                    <th style="padding:10px;">Responses</th>
                    <th style="padding:10px;">Action</th>
                  </tr>
                </thead>
                <tbody>
                  ${activeSurveys.map(s => `
                    <tr style="border-bottom:1px solid #f3f4f6;">
                      <td style="padding:10px; font-weight:600;">${escapeHtml(s.title)}</td>
                      <td style="padding:10px;">${statusBadge(s.status)}</td>
                      <td style="padding:10px;">${s.response_count} respondent(s)</td>
                      <td style="padding:10px;">
                        ${hasAccess(user, ['admin']) ? `
                          <form method="POST" action="/engagement/surveys/${s.id}/status" style="display:inline;">
                            <input type="hidden" name="status" value="${s.status === 'active' ? 'closed' : 'active'}">
                            <button type="submit" class="btn btn-sm" style="padding:4px 8px; font-size:12px; background:#4b5563; color:#fff; border:none; border-radius:4px; cursor:pointer;">
                              ${s.status === 'active' ? 'Close' : 'Activate'}
                            </button>
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
              ${card('Build New Engagement Survey', `
                <form method="POST" action="/engagement/surveys">
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Survey Title</label>
                    <input type="text" name="title" required placeholder="e.g. Q3 eNPS Pulse Survey" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Description</label>
                    <textarea name="description" rows="2" style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;"></textarea>
                  </div>
                  <div style="margin-bottom:12px;">
                    <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Primary eNPS Question</label>
                    <input type="text" name="enps_question" value="How likely are you to recommend StaffHub as a great place to work?" required style="width:100%; padding:8px; border:1px solid #d1d5db; border-radius:4px;">
                  </div>
                  <button type="submit" style="width:100%; padding:10px; background:#2563eb; color:#fff; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Create & Publish Survey</button>
                </form>
              `)}
            </div>
          ` : ''}
        </div>
      `;
    } else if (tab === 'analytics') {
      content += `
        <div style="display:grid; grid-template-columns: 1fr 2fr; gap:20px;">
          ${card('eNPS Score Overview', `
            <div style="text-align:center; padding:20px 0;">
              <div style="font-size:48px; font-weight:800; color:${enpsScore >= 0 ? '#10b981' : '#ef4444'};">${enpsScore > 0 ? '+' : ''}${enpsScore}</div>
              <div style="font-size:14px; font-weight:700; text-transform:uppercase; color:#6b7280; margin-top:4px;">Net Promoter Score</div>
              <div style="display:flex; justify-content:space-around; margin-top:24px; font-size:13px;">
                <div><span style="color:#10b981; font-weight:700;">Promoters (9-10):</span> ${promoters}</div>
                <div><span style="color:#ef4444; font-weight:700;">Detractors (1-6):</span> ${detractors}</div>
              </div>
            </div>
          `)}

          ${card('Survey Response Feedbacks', `
            <table style="width:100%; border-collapse:collapse; text-align:left; font-size:14px;">
              <thead>
                <tr style="border-bottom:2px solid #e5e7eb; color:#6b7280;">
                  <th style="padding:10px;">Rating</th>
                  <th style="padding:10px;">Feedback Comment</th>
                  <th style="padding:10px;">Submitted</th>
                </tr>
              </thead>
              <tbody>
                ${ratings.length === 0 ? '<tr><td colspan="3" style="padding:15px; text-align:center; color:#9ca3af;">No responses received yet.</td></tr>' : ''}
                ${db.prepare('SELECT * FROM survey_responses ORDER BY submitted_at DESC LIMIT 20').all().map(r => `
                  <tr style="border-bottom:1px solid #f3f4f6;">
                    <td style="padding:10px; font-weight:700; color:${r.rating_value >= 9 ? '#10b981' : (r.rating_value <= 6 ? '#ef4444' : '#f59e0b')};">${r.rating_value ? r.rating_value + '/10' : '-'}</td>
                    <td style="padding:10px;">${escapeHtml(r.text_value || 'No text comment')}</td>
                    <td style="padding:10px; color:#6b7280; font-size:12px;">${escapeHtml(r.submitted_at.substring(0,10))}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          `)}
        </div>
      `;
    }

    sendHtml(ctx.res, 200, layout({ title: 'Employee Engagement - StaffHub', body: content, user, activePath: '/engagement' }));
  });

  // Action: Create Survey
  router.post('/engagement/surveys', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const body = await parseBodyAuto(ctx.req);
    const { title, description, enps_question } = body;
    const res = db.prepare(`
      INSERT INTO surveys (title, description, status)
      VALUES (?, ?, 'active')
    `).run(title, description || '');

    const surveyId = Number(res.lastInsertRowid);
    db.prepare(`
      INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order)
      VALUES (?, ?, 'rating', 1)
    `).run(surveyId, enps_question);

    logAudit(ctx.user.id, 'create_engagement_survey', `Created engagement survey: ${title}`);
    redirect(ctx.res, '/engagement?tab=builder');
  });

  // Action: Submit Survey Responses
  router.post('/engagement/surveys/:id/submit', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const surveyId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);

    for (const [key, val] of Object.entries(body)) {
      if (key.startsWith('q_')) {
        const qId = parseInt(key.replace('q_', ''), 10);
        const ratingVal = !isNaN(parseInt(val, 10)) ? parseInt(val, 10) : null;
        const textVal = isNaN(parseInt(val, 10)) ? val : null;
        db.prepare(`
          INSERT INTO survey_responses (survey_id, user_id, question_id, rating_value, text_value)
          VALUES (?, ?, ?, ?, ?)
        `).run(surveyId, ctx.user.id, qId, ratingVal, textVal);
      }
    }

    logAudit(ctx.user.id, 'submit_survey_responses', `Submitted survey responses for survey #${surveyId}`);
    redirect(ctx.res, '/engagement?tab=surveys&success=' + encodeURIComponent('Thank you for your feedback!'));
  });

  // Action: Update Survey Status
  router.post('/engagement/surveys/:id/status', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/login');
    const surveyId = parseInt(ctx.params.id, 10);
    const body = await parseBodyAuto(ctx.req);
    db.prepare(`UPDATE surveys SET status = ? WHERE id = ?`).run(body.status, surveyId);
    redirect(ctx.res, '/engagement?tab=builder');
  });
};
