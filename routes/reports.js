'use strict';
const db = require('../db');
const { redirect, sendHtml, formatMoney, monthName } = require('../lib/util');
const { layout, card, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { getSetting, isModuleEnabled } = require('../lib/settings');

// The Super Admin always keeps access to a disabled module (they're the only
// one who can re-enable it under Settings > System Settings); everyone else
// is bounced back to the dashboard.
function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('reports');
}

// Report content is organized per source module ("re-home Reports under
// per-module tabs", Stage 2) — today that's just Payroll (payslips + EA
// form), the only report type actually built yet. As Leave/Attendance/Claims
// reports get built in later stages, give each its own labeled section below
// (or promote this to a subTabs() bar, like Profile/Settings use, once
// there's more than one section to switch between).

module.exports = function (router) {
  router.get('/reports', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Reports is not enabled for your company.'));
    const user = ctx.user;
    const userIsAdmin = hasAccess(user, ['admin']);

    // Active Tab: 'ess' (Self-Service) vs 'hr' (Admin Company-wide)
    const reqTab = ctx.url.searchParams.get('tab');
    const tab = (reqTab === 'hr' && userIsAdmin) ? 'hr' : 'ess';

    let targetId = user.id;
    let employeeOptions = '';

    if (tab === 'ess' && userIsAdmin) {
      const q = ctx.url.searchParams.get('employee_id');
      if (q) targetId = Number(q);
      const all = db.prepare(`SELECT id, name FROM users WHERE status = 'active' ORDER BY name`).all();
      employeeOptions = `
        <form method="get" action="/reports" class="flex items-center gap-2 text-sm mb-4">
          <input type="hidden" name="tab" value="ess">
          <label class="text-xs font-semibold text-slate-600 dark:text-slate-300">Target Employee (Admin View):</label>
          <select name="employee_id" onchange="this.form.submit()" class="rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-1.5 text-xs font-medium">
            ${all.map((u) => `<option value="${u.id}" ${u.id === targetId ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
          </select>
        </form>
      `;
    }

    // Top Mode Switcher Tabs (ESS vs HR Admin)
    const modeTabs = `
      <div class="flex gap-2 mb-6 border-b border-slate-200 dark:border-slate-800 pb-3">
        <a href="/reports?tab=ess" class="px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${tab === 'ess' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50'}">
          <span>👤</span> Employee Self-Service (ESS) Reports
        </a>
        ${userIsAdmin ? `
          <a href="/reports?tab=hr" class="px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition ${tab === 'hr' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50'}">
            <span>📊</span> HR Admin & Company Summary Reports
          </a>
        ` : ''}
      </div>
    `;

    let contentHtml = '';

    if (tab === 'ess') {
      // Fetch Personal Payslips
      const payslips = db.prepare(`
        SELECT p.*, r.month, r.year, r.status as run_status FROM payslips p
        JOIN payroll_runs r ON r.id = p.payroll_run_id
        WHERE p.user_id = ? AND r.status = 'finalized'
        ORDER BY r.year DESC, r.month DESC
      `).all(targetId);

      const years = [...new Set(payslips.map((p) => p.year))];

      // Fetch Personal Leave Summary
      const leaveSummary = db.prepare(`
        SELECT lt.name, COUNT(*) total_requests, SUM(CASE WHEN la.status='approved' THEN 1 ELSE 0 END) approved_cnt
        FROM leave_applications la JOIN leave_types lt ON lt.id=la.leave_type_id
        WHERE la.user_id = ? GROUP BY lt.name
      `).all(targetId);

      // Fetch Personal Claims Summary
      const claimSummary = db.prepare(`
        SELECT category, COUNT(*) total_claims, COALESCE(SUM(amount), 0) total_amt
        FROM claims WHERE user_id = ? AND status='approved' GROUP BY category
      `).all(targetId);

      contentHtml = `
        ${employeeOptions}
        <div class="space-y-6">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            ${card(`
              <h2 class="font-bold text-sm text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
                <span>📄</span> Individual Payslips
              </h2>
              <div class="overflow-x-auto">
                <table class="data-table w-full text-xs">
                  <thead><tr><th>Period</th><th>Net Pay (RM)</th><th>Action</th></tr></thead>
                  <tbody>
                    ${payslips.map((p) => `
                      <tr>
                        <td class="font-medium">${monthName(p.month)} ${p.year}</td>
                        <td class="font-bold text-slate-800 dark:text-slate-100">${formatMoney(p.net_pay)}</td>
                        <td><a href="/reports/payslip/${p.id}" target="_blank" class="text-indigo-600 hover:underline font-semibold">View / Download →</a></td>
                      </tr>
                    `).join('') || `<tr><td colspan="3" class="text-center text-slate-400 py-6">No finalized payslips available.</td></tr>`}
                  </tbody>
                </table>
              </div>
            `)}

            ${card(`
              <h2 class="font-bold text-sm text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
                <span>📋</span> EA Form (CP8A Annual Tax Statement)
              </h2>
              <p class="text-xs text-slate-400 mb-4">Official annual remuneration statement for tax filing derived from finalized payroll runs.</p>
              <div class="space-y-2 text-xs">
                ${years.length ? years.map((y) => `
                  <div class="flex items-center justify-between p-3 rounded-xl border border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
                    <span class="font-semibold text-slate-700 dark:text-slate-200">EA Form ${y}</span>
                    <a href="/reports/ea/${targetId}/${y}" target="_blank" class="px-3 py-1 bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-300 font-semibold rounded-lg hover:bg-indigo-100 transition">View / Print →</a>
                  </div>
                `).join('') : `<p class="text-xs text-slate-400 italic">No finalized tax years on record.</p>`}
              </div>
            `)}
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            ${card(`
              <h2 class="font-bold text-sm text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
                <span>🏖️</span> Personal Leave Utilization Summary
              </h2>
              <div class="overflow-x-auto">
                <table class="data-table w-full text-xs">
                  <thead><tr><th>Leave Type</th><th>Applications</th><th>Approved Days</th></tr></thead>
                  <tbody>
                    ${leaveSummary.map((l) => `
                      <tr>
                        <td class="font-medium">${escapeHtml(l.name)}</td>
                        <td>${l.total_requests}</td>
                        <td class="font-bold text-emerald-600 dark:text-emerald-400">${l.approved_cnt} Days</td>
                      </tr>
                    `).join('') || `<tr><td colspan="3" class="text-center text-slate-400 py-6">No leave applications recorded.</td></tr>`}
                  </tbody>
                </table>
              </div>
            `)}

            ${card(`
              <h2 class="font-bold text-sm text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
                <span>🧾</span> Personal Claims Summary
              </h2>
              <div class="overflow-x-auto">
                <table class="data-table w-full text-xs">
                  <thead><tr><th>Claim Category</th><th>Approved Claims</th><th>Total Reimbursed</th></tr></thead>
                  <tbody>
                    ${claimSummary.map((c) => `
                      <tr>
                        <td class="font-medium uppercase">${escapeHtml(c.category)}</td>
                        <td>${c.total_claims}</td>
                        <td class="font-bold text-indigo-600 dark:text-indigo-400">${formatMoney(c.total_amt)}</td>
                      </tr>
                    `).join('') || `<tr><td colspan="3" class="text-center text-slate-400 py-6">No approved claims found.</td></tr>`}
                  </tbody>
                </table>
              </div>
            `)}
          </div>
        </div>
      `;

    } else if (tab === 'hr') {
      // HR Admin Executive & Statutory Reports
      const finalizedRuns = db.prepare(`
        SELECT r.*, COUNT(p.id) employee_cnt, COALESCE(SUM(p.gross_pay), 0) total_gross, COALESCE(SUM(p.net_pay), 0) total_net,
               COALESCE(SUM(p.epf_employee + p.epf_employer), 0) total_epf,
               COALESCE(SUM(p.socso_employee + p.socso_employer), 0) total_socso,
               COALESCE(SUM(p.eis_employee + p.eis_employer), 0) total_eis,
               COALESCE(SUM(p.pcb), 0) total_pcb
        FROM payroll_runs r JOIN payslips p ON p.payroll_run_id = r.id
        WHERE r.status = 'finalized'
        GROUP BY r.id ORDER BY r.year DESC, r.month DESC
      `).all();

      const deptSummary = db.prepare(`
        SELECT u.department, COUNT(u.id) active_staff, ROUND(AVG(u.basic_salary), 0) avg_salary
        FROM users u WHERE u.status='active' AND u.department IS NOT NULL
        GROUP BY u.department ORDER BY active_staff DESC
      `).all();

      const companyClaims = db.prepare(`
        SELECT category, COUNT(*) cnt, ROUND(SUM(amount), 2) total_amt
        FROM claims WHERE status='approved' GROUP BY category ORDER BY total_amt DESC
      `).all();

      contentHtml = `
        <div class="space-y-6">
          ${card(`
            <div class="flex items-center justify-between mb-3">
              <div>
                <h2 class="font-bold text-base text-slate-800 dark:text-slate-100">Monthly Payroll Audit & Statutory Report (EPF / SOCSO / EIS / PCB)</h2>
                <p class="text-xs text-slate-400">Company-wide audit breakdown of finalized payroll runs and statutory contributions</p>
              </div>
            </div>
            <div class="overflow-x-auto">
              <table class="data-table w-full text-xs">
                <thead>
                  <tr>
                    <th>Payroll Period</th>
                    <th>Processed Staff</th>
                    <th>Gross Payroll (RM)</th>
                    <th>Net Outflow (RM)</th>
                    <th>EPF Total (Ee+Er)</th>
                    <th>SOCSO Total</th>
                    <th>EIS Total</th>
                    <th>PCB Tax Total</th>
                  </tr>
                </thead>
                <tbody>
                  ${finalizedRuns.map((r) => `
                    <tr>
                      <td class="font-bold text-slate-800 dark:text-slate-100">${monthName(r.month)} ${r.year}</td>
                      <td>${r.employee_cnt} Employees</td>
                      <td class="font-semibold">${formatMoney(r.total_gross)}</td>
                      <td class="font-bold text-emerald-600 dark:text-emerald-400">${formatMoney(r.total_net)}</td>
                      <td>${formatMoney(r.total_epf)}</td>
                      <td>${formatMoney(r.total_socso)}</td>
                      <td>${formatMoney(r.total_eis)}</td>
                      <td>${formatMoney(r.total_pcb)}</td>
                    </tr>
                  `).join('') || `<tr><td colspan="8" class="text-center text-slate-400 py-6">No finalized payroll runs recorded.</td></tr>`}
                </tbody>
              </table>
            </div>
          `)}

          <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            ${card(`
              <h2 class="font-bold text-sm text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
                <span>🏢</span> Company Headcount & Salary Report by Department
              </h2>
              <div class="overflow-x-auto">
                <table class="data-table w-full text-xs">
                  <thead><tr><th>Department</th><th>Active Workforce</th><th>Avg Basic Salary</th></tr></thead>
                  <tbody>
                    ${deptSummary.map((d) => `
                      <tr>
                        <td class="font-medium">${escapeHtml(d.department)}</td>
                        <td>${d.active_staff} Staff</td>
                        <td class="font-semibold text-slate-800 dark:text-slate-200">RM ${Number(d.avg_salary).toLocaleString('en-MY')}</td>
                      </tr>
                    `).join('') || `<tr><td colspan="3" class="text-center text-slate-400 py-6">No department data.</td></tr>`}
                  </tbody>
                </table>
              </div>
            `)}

            ${card(`
              <h2 class="font-bold text-sm text-slate-800 dark:text-slate-100 mb-3 flex items-center gap-2">
                <span>🧾</span> Organization Claims Reimbursement Report
              </h2>
              <div class="overflow-x-auto">
                <table class="data-table w-full text-xs">
                  <thead><tr><th>Category</th><th>Approved Claims</th><th>Total Reimbursed</th></tr></thead>
                  <tbody>
                    ${companyClaims.map((c) => `
                      <tr>
                        <td class="font-medium uppercase">${escapeHtml(c.category)}</td>
                        <td>${c.cnt} Claims</td>
                        <td class="font-bold text-indigo-600 dark:text-indigo-400">${formatMoney(c.total_amt)}</td>
                      </tr>
                    `).join('') || `<tr><td colspan="3" class="text-center text-slate-400 py-6">No approved claims found.</td></tr>`}
                  </tbody>
                </table>
              </div>
            `)}
          </div>
        </div>
      `;
    }

    const body = `
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-slate-800 dark:text-slate-100">Reports Center</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">Access Employee Self-Service tax statements and company HR executive reports</p>
      </div>
      ${modeTabs}
      ${contentHtml}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Reports', user, activePath: '/reports', url: ctx.url, body }));
  });

  router.get('/reports/payslip/:id', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const p = db.prepare(`
      SELECT p.*, r.month, r.year, r.status as run_status, u.name, u.employee_no, u.ic_number, u.department, u.position, u.bank_name, u.bank_account
      FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id JOIN users u ON u.id = p.user_id
      WHERE p.id = ?
    `).get(Number(ctx.params.id));
    if (!p) return redirect(ctx.res, '/reports?error=' + encodeURIComponent('Payslip not found.'));
    if (p.user_id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) {
      return redirect(ctx.res, '/reports?error=' + encodeURIComponent('Not authorized to view this payslip.'));
    }

    const row = (label, value, bold = false) => `<div class="flex justify-between py-1 ${bold ? 'font-semibold' : ''}"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
    const companyName = getSetting('company_name', 'StaffHub Sdn Bhd');

    const body = `
      <div class="no-print flex justify-end mb-4">
        <button onclick="window.print()" class="bg-indigo-600 text-white text-sm font-medium rounded-lg px-4 py-2">Print / Save as PDF</button>
      </div>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 max-w-2xl mx-auto">
        <div class="flex items-center justify-between mb-6 border-b border-slate-100 pb-4">
          <div>
            <div class="font-semibold text-lg">${escapeHtml(companyName)}</div>
            <div class="text-xs text-slate-400">Payslip · ${monthName(p.month)} ${p.year}</div>
          </div>
          <div class="text-right text-sm">
            <div class="font-medium">${escapeHtml(p.name)}</div>
            <div class="text-slate-400">${escapeHtml(p.employee_no)}</div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-x-8 text-sm mb-6">
          <div>${row('Department', escapeHtml(p.department || '—'))}${row('Position', escapeHtml(p.position || '—'))}</div>
          <div>${row('Bank', escapeHtml(p.bank_name || '—'))}${row('Account no.', escapeHtml(p.bank_account || '—'))}</div>
        </div>

        <div class="grid grid-cols-2 gap-8 text-sm">
          <div>
            <div class="font-semibold text-slate-500 text-xs uppercase mb-2">Earnings</div>
            ${row('Basic salary', formatMoney(p.basic_salary))}
            ${row('Allowances', formatMoney(p.allowances))}
            ${row('Overtime', formatMoney(p.overtime))}
            ${row('Gross pay', formatMoney(p.gross_pay), true)}
          </div>
          <div>
            <div class="font-semibold text-slate-500 text-xs uppercase mb-2">Deductions</div>
            ${row('EPF (employee)', formatMoney(p.epf_employee))}
            ${row('SOCSO (employee)', formatMoney(p.socso_employee))}
            ${row('EIS (employee)', formatMoney(p.eis_employee))}
            ${row('PCB (MTD)', formatMoney(p.pcb))}
            ${row('Other deductions', formatMoney(p.other_deductions))}
            ${row('Total deductions', formatMoney(p.epf_employee + p.socso_employee + p.eis_employee + p.pcb + p.other_deductions), true)}
          </div>
        </div>

        <div class="mt-6 pt-4 border-t border-slate-200 flex justify-between items-center">
          <span class="font-semibold">Net Pay</span>
          <span class="font-bold text-lg">${formatMoney(p.net_pay)}</span>
        </div>

        <div class="mt-6 pt-4 border-t border-slate-100 text-xs text-slate-400">
          <div class="font-semibold text-slate-500 uppercase mb-1">Employer statutory contributions (not deducted from employee)</div>
          ${row('EPF (employer)', formatMoney(p.epf_employer))}
          ${row('SOCSO (employer)', formatMoney(p.socso_employer))}
          ${row('EIS (employer)', formatMoney(p.eis_employer))}
        </div>
      </div>
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Payslip', user: ctx.user, activePath: '/reports', url: ctx.url, body }));
  });

  router.get('/reports/ea/:userId/:year', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const userId = Number(ctx.params.userId);
    const year = Number(ctx.params.year);
    if (userId !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) {
      return redirect(ctx.res, '/reports?error=' + encodeURIComponent('Not authorized to view this EA form.'));
    }
    const emp = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!emp) return redirect(ctx.res, '/reports?error=' + encodeURIComponent('Employee not found.'));

    const payslips = db.prepare(`
      SELECT p.* FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id
      WHERE p.user_id = ? AND r.year = ? AND r.status = 'finalized'
    `).all(userId, year);

    const sum = (field) => payslips.reduce((acc, p) => acc + p[field], 0);
    const totalGross = sum('gross_pay');
    const totalEpfEe = sum('epf_employee');
    const totalEpfEr = sum('epf_employer');
    const totalSocsoEe = sum('socso_employee');
    const totalEisEe = sum('eis_employee');
    const totalPcb = sum('pcb');

    const row = (label, value, bold = false) => `<div class="flex justify-between py-1.5 border-b border-slate-100 ${bold ? 'font-semibold' : ''}"><span>${escapeHtml(label)}</span><span>${value}</span></div>`;
    const companyName = getSetting('company_name', 'StaffHub Sdn Bhd');

    const body = `
      <div class="no-print flex justify-end mb-4">
        <button onclick="window.print()" class="bg-indigo-600 text-white text-sm font-medium rounded-lg px-4 py-2">Print / Save as PDF</button>
      </div>
      <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 max-w-2xl mx-auto">
        <div class="text-center mb-6 border-b border-slate-100 pb-4">
          <div class="font-semibold text-lg">Penyata Saraan Tahunan / Annual Remuneration Statement</div>
          <div class="text-xs text-slate-400">Borang EA (CP8A) · Year of Assessment ${year}</div>
        </div>
        <div class="grid grid-cols-2 gap-x-8 text-sm mb-6">
          <div>${row('Employee name', escapeHtml(emp.name))}${row('Employee no.', escapeHtml(emp.employee_no))}${row('IC / Passport no.', escapeHtml(emp.ic_number || '—'))}</div>
          <div>${row('Employer', escapeHtml(companyName))}${row('Department', escapeHtml(emp.department || '—'))}${row('Position', escapeHtml(emp.position || '—'))}</div>
        </div>

        <div class="text-sm">
          <div class="font-semibold text-slate-500 text-xs uppercase mb-2 mt-4">Part B — Income & deductions for the year</div>
          ${row('Gross salary/wages (including allowances)', formatMoney(totalGross))}
          ${row('Employee EPF contribution', formatMoney(totalEpfEe))}
          ${row('Employer EPF contribution', formatMoney(totalEpfEr))}
          ${row('Employee SOCSO contribution', formatMoney(totalSocsoEe))}
          ${row('Total PCB (MTD) deducted', formatMoney(totalPcb), true)}
        </div>

        <p class="text-xs text-slate-400 mt-6">
          Generated from ${payslips.length} finalized payroll run(s) for ${year}. This is a prototype-generated statement — verify totals and
          formatting against the official LHDN Borang EA template before issuing to employees or filing.
        </p>
      </div>
    `;
    sendHtml(ctx.res, 200, layout({ title: `EA Form ${year}`, user: ctx.user, activePath: '/reports', url: ctx.url, body }));
  });
};
