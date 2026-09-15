'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, formatMoney, monthName } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');
const { computePayslip } = require('../lib/statutory');

function requireHrAdmin(ctx) {
  if (!ctx.user) {
    redirect(ctx.res, '/login');
    return false;
  }
  if (!hasAccess(ctx.user, ['admin'])) {
    redirect(ctx.res, '/?error=' + encodeURIComponent('Payroll is restricted to Admin and Super Admin.'));
    return false;
  }
  // The Super Admin always keeps access to a disabled module so they can
  // re-enable it under Settings > System Settings.
  if (!isSuperAdmin(ctx.user) && !isModuleEnabled('payroll')) {
    redirect(ctx.res, '/?error=' + encodeURIComponent('Payroll is not enabled for your company.'));
    return false;
  }
  return true;
}

function regeneratePayslip(runId, userId) {
  const emp = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const existing = db.prepare('SELECT * FROM payslips WHERE payroll_run_id = ? AND user_id = ?').get(runId, userId);
  const calc = computePayslip({
    basic_salary: emp.basic_salary,
    allowances: existing ? existing.allowances : 0,
    overtime: existing ? existing.overtime : 0,
    other_deductions: existing ? existing.other_deductions : 0,
    date_of_birth: emp.date_of_birth,
    marital_status: emp.marital_status,
    num_children: emp.num_children,
  });
  if (existing) {
    db.prepare(`
      UPDATE payslips SET basic_salary=?, allowances=?, overtime=?, gross_pay=?, epf_employee=?, epf_employer=?, socso_employee=?, socso_employer=?, eis_employee=?, eis_employer=?, pcb=?, other_deductions=?, net_pay=?
      WHERE id = ?
    `).run(calc.basic_salary, calc.allowances, calc.overtime, calc.gross_pay, calc.epf_employee, calc.epf_employer, calc.socso_employee, calc.socso_employer, calc.eis_employee, calc.eis_employer, calc.pcb, calc.other_deductions, calc.net_pay, existing.id);
  } else {
    db.prepare(`
      INSERT INTO payslips (payroll_run_id, user_id, basic_salary, allowances, overtime, gross_pay, epf_employee, epf_employer, socso_employee, socso_employer, eis_employee, eis_employer, pcb, other_deductions, net_pay)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(runId, userId, calc.basic_salary, calc.allowances, calc.overtime, calc.gross_pay, calc.epf_employee, calc.epf_employer, calc.socso_employee, calc.socso_employer, calc.eis_employee, calc.eis_employer, calc.pcb, calc.other_deductions, calc.net_pay);
  }
}

module.exports = function (router) {
  router.get('/payroll', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const runs = db.prepare('SELECT * FROM payroll_runs ORDER BY year DESC, month DESC').all();
    const runsWithTotals = runs.map((r) => {
      const totals = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(net_pay),0) net, COALESCE(SUM(gross_pay),0) gross FROM payslips WHERE payroll_run_id = ?').get(r.id);
      return { ...r, ...totals };
    });

    const body = `
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-semibold">Payroll</h1>
      </div>

      <div class="grid lg:grid-cols-3 gap-6">
        <div class="lg:col-span-1">
          ${card(`
            <h2 class="font-semibold mb-4">Create payroll run</h2>
            <form method="post" action="/payroll" class="space-y-3 text-sm">
              <div>
                <label class="block text-slate-600 mb-1">Month</label>
                <select name="month" class="w-full rounded-lg border border-slate-300 px-3 py-2">
                  ${Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}" ${m === new Date().getMonth() + 1 ? 'selected' : ''}>${monthName(m)}</option>`).join('')}
                </select>
              </div>
              <div>
                <label class="block text-slate-600 mb-1">Year</label>
                <input name="year" type="number" value="${new Date().getFullYear()}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              </div>
              <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg py-2.5">Generate run</button>
              <p class="text-xs text-slate-400">Generates a draft payslip for every active employee using their basic salary on file, with EPF/SOCSO/EIS/PCB computed automatically. Review and finalize before employees can download payslips.</p>
            </form>
          `)}
        </div>
        <div class="lg:col-span-2">
          ${card(`
            <h2 class="font-semibold mb-4">Payroll runs</h2>
            <div class="overflow-x-auto">
              <table class="data-table w-full">
                <thead><tr><th>Period</th><th>Employees</th><th>Gross</th><th>Net</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  ${runsWithTotals.map((r) => `
                    <tr>
                      <td class="font-medium">${monthName(r.month)} ${r.year}</td>
                      <td>${r.c}</td>
                      <td>${formatMoney(r.gross)}</td>
                      <td>${formatMoney(r.net)}</td>
                      <td>${statusBadge(r.status)}</td>
                      <td><a href="/payroll/${r.id}" class="text-indigo-600 font-medium text-xs">Open →</a></td>
                    </tr>
                  `).join('') || `<tr><td colspan="6" class="text-center text-slate-400 py-6">No payroll runs yet.</td></tr>`}
                </tbody>
              </table>
            </div>
          `)}
        </div>
      </div>
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Payroll', user: ctx.user, activePath: '/payroll', url: ctx.url, body }));
  });

  router.post('/payroll', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    const month = Number(b.month);
    const year = Number(b.year);
    if (!month || month < 1 || month > 12 || !year) {
      return redirect(ctx.res, '/payroll?error=' + encodeURIComponent('Please choose a valid month and year.'));
    }
    const exists = db.prepare('SELECT * FROM payroll_runs WHERE month = ? AND year = ?').get(month, year);
    if (exists) return redirect(ctx.res, `/payroll/${exists.id}?error=` + encodeURIComponent('A payroll run for this period already exists.'));

    const info = db.prepare('INSERT INTO payroll_runs (month, year) VALUES (?, ?)').run(month, year);
    const runId = info.lastInsertRowid;
    const activeUsers = db.prepare(`SELECT id FROM users WHERE status = 'active'`).all();
    for (const u of activeUsers) regeneratePayslip(runId, u.id);

    redirect(ctx.res, `/payroll/${runId}?ok=` + encodeURIComponent('Payroll run generated.'));
  });

  function isWithinOneMonth(runMonth, runYear) {
    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1; // 1-12
    const monthsDiff = (curYear - runYear) * 12 + (curMonth - runMonth);
    return monthsDiff <= 1;
  }

  router.get('/payroll/:id', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(Number(ctx.params.id));
    if (!run) return redirect(ctx.res, '/payroll?error=' + encodeURIComponent('Payroll run not found.'));
    const payslips = db.prepare(`
      SELECT p.*, u.name, u.employee_no, u.department FROM payslips p JOIN users u ON u.id = p.user_id
      WHERE p.payroll_run_id = ? ORDER BY u.name
    `).all(run.id);

    const editable = run.status === 'draft';
    const canModify = isWithinOneMonth(run.month, run.year);

    const body = `
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-semibold">${monthName(run.month)} ${run.year} payroll</h1>
          <div class="mt-1 flex items-center gap-2">
            ${statusBadge(run.status)}
            ${!canModify ? `<span class="text-xs text-amber-600 font-medium bg-amber-50 px-2 py-0.5 rounded border border-amber-200">🔒 Locked (>1 Month Old)</span>` : ''}
          </div>
        </div>
        <div class="flex gap-3">
          <a href="/payroll" class="text-sm text-slate-500 font-medium self-center">← All runs</a>
          ${editable ? `
            <form method="post" action="/payroll/${run.id}/finalize" onsubmit="return confirm('Finalize this payroll run? Payslips will become read-only and visible to employees under Reports.');">
              <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Finalize run</button>
            </form>
          ` : canModify ? `
            <form method="post" action="/payroll/${run.id}/revert" onsubmit="return confirm('Revert this payroll run back to Draft status? You will be able to edit or recalculate payslips again.');">
              <button class="bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium rounded-lg px-4 py-2">↩ Revert to Draft</button>
            </form>
          ` : ''}
          ${canModify ? `
            <form method="post" action="/payroll/${run.id}/delete" onsubmit="return confirm('Are you sure you want to DELETE this entire payroll run? All generated payslips for this period will be deleted.');">
              <button class="bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg px-3 py-2">🗑️ Delete Run</button>
            </form>
          ` : ''}
        </div>
      </div>

      ${card(`
        <div class="overflow-x-auto">
          <table class="data-table w-full">
            <thead><tr>
              <th>Employee</th><th>Basic</th><th>Allowances</th><th>OT</th><th>Gross</th>
              <th>EPF (EE)</th><th>SOCSO (EE)</th><th>EIS (EE)</th><th>PCB</th><th>Other ded.</th><th>Net pay</th>
              ${editable ? '<th></th>' : ''}
            </tr></thead>
            <tbody>
              ${payslips.map((p) => `
                <tr>
                  <td class="font-medium">${escapeHtml(p.name)}<div class="text-xs text-slate-400">${escapeHtml(p.employee_no)}</div></td>
                  <td>${formatMoney(p.basic_salary)}</td>
                  <td>${editable ? `<input form="ps-${p.id}" name="allowances" type="number" step="0.01" value="${p.allowances}" class="w-24 rounded border border-slate-300 px-2 py-1"/>` : formatMoney(p.allowances)}</td>
                  <td>${editable ? `<input form="ps-${p.id}" name="overtime" type="number" step="0.01" value="${p.overtime}" class="w-24 rounded border border-slate-300 px-2 py-1"/>` : formatMoney(p.overtime)}</td>
                  <td class="font-medium">${formatMoney(p.gross_pay)}</td>
                  <td>${formatMoney(p.epf_employee)}</td>
                  <td>${formatMoney(p.socso_employee)}</td>
                  <td>${formatMoney(p.eis_employee)}</td>
                  <td>${formatMoney(p.pcb)}</td>
                  <td>${editable ? `<input form="ps-${p.id}" name="other_deductions" type="number" step="0.01" value="${p.other_deductions}" class="w-24 rounded border border-slate-300 px-2 py-1"/>` : formatMoney(p.other_deductions)}</td>
                  <td class="font-semibold">${formatMoney(p.net_pay)}</td>
                  ${editable ? `<td><form id="ps-${p.id}" method="post" action="/payroll/${run.id}/payslip/${p.user_id}"><button class="text-indigo-600 text-xs font-medium">Recalculate</button></form></td>` : ''}
                </tr>
              `).join('') || `<tr><td colspan="11" class="text-center text-slate-400 py-6">No payslips in this run.</td></tr>`}
            </tbody>
          </table>
        </div>
      `)}

      <p class="text-xs text-slate-400 mt-4 max-w-2xl">
        EPF/SOCSO/EIS/PCB figures use simplified statutory rate approximations for 2025/2026 (see <code>lib/statutory.js</code>).
        Verify against the official KWSP, PERKESO and LHDN tables before relying on these for real payroll.
      </p>
    `;
    sendHtml(ctx.res, 200, layout({ title: `Payroll · ${monthName(run.month)} ${run.year}`, user: ctx.user, activePath: '/payroll', url: ctx.url, body }));
  });

  router.post('/payroll/:id/payslip/:userId', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const runId = Number(ctx.params.id);
    const userId = Number(ctx.params.userId);
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
    if (!run || run.status !== 'draft') return redirect(ctx.res, `/payroll/${runId}?error=` + encodeURIComponent('This run is no longer editable.'));
    const b = await parseBodyAuto(ctx.req);
    db.prepare('UPDATE payslips SET allowances = ?, overtime = ?, other_deductions = ? WHERE payroll_run_id = ? AND user_id = ?')
      .run(Number(b.allowances || 0), Number(b.overtime || 0), Number(b.other_deductions || 0), runId, userId);
    regeneratePayslip(runId, userId);
    redirect(ctx.res, `/payroll/${runId}?ok=` + encodeURIComponent('Payslip recalculated.'));
  });

  router.post('/payroll/:id/finalize', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const runId = Number(ctx.params.id);
    db.prepare(`UPDATE payroll_runs SET status = 'finalized', finalized_at = datetime('now') WHERE id = ?`).run(runId);
    redirect(ctx.res, `/payroll/${runId}?ok=` + encodeURIComponent('Payroll run finalized.'));
  });

  router.post('/payroll/:id/revert', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const runId = Number(ctx.params.id);
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
    if (!run) return redirect(ctx.res, '/payroll?error=' + encodeURIComponent('Payroll run not found.'));
    if (!isWithinOneMonth(run.month, run.year)) {
      return redirect(ctx.res, `/payroll/${runId}?error=` + encodeURIComponent('Cannot revert payroll runs older than 1 month. Period is locked.'));
    }
    db.prepare(`UPDATE payroll_runs SET status = 'draft', finalized_at = NULL WHERE id = ?`).run(runId);
    redirect(ctx.res, `/payroll/${runId}?ok=` + encodeURIComponent('Payroll run reverted to Draft. You can now make changes and recalculate.'));
  });

  router.post('/payroll/:id/delete', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const runId = Number(ctx.params.id);
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
    if (!run) return redirect(ctx.res, '/payroll?error=' + encodeURIComponent('Payroll run not found.'));
    if (!isWithinOneMonth(run.month, run.year)) {
      return redirect(ctx.res, `/payroll/${runId}?error=` + encodeURIComponent('Cannot delete payroll runs older than 1 month. Period is locked.'));
    }
    db.prepare('DELETE FROM payslips WHERE payroll_run_id = ?').run(runId);
    db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(runId);
    redirect(ctx.res, '/payroll?ok=' + encodeURIComponent('Payroll run deleted. You can now create a fresh run for this period.'));
  });
};
