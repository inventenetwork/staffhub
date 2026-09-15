'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto, normalizeNricOrPassport, formatMoney } = require('../lib/util');
const { layout, card, escapeHtml, groupTabs, subTabs, badge } = require('../lib/render');
const { hasAccess, verifyPassword, isSalaryUnlocked, unlockSalary } = require('../lib/auth');
const { getListValues } = require('../lib/lists');
const { monthName } = require('../lib/util');
const { createRequest, getPendingRequestsForUser, withdrawRequest } = require('../lib/approvals');
const { logAudit } = require('../lib/audit');

const { getAllCustomTabs, getCustomTab, getUserCustomValues, saveUserCustomValues } = require('../lib/custom_profile');

const RELATIONSHIPS = ['spouse', 'child', 'parent', 'sibling', 'other'];

const STANDARD_TABS = [
  { key: 'details', label: 'Employee Details' },
  { key: 'occupation', label: 'Employee Occupation' },
  { key: 'family', label: 'Family' },
  { key: 'history', label: 'Employment History' },
];

function renderPendingBanner(requests, isSelf, targetId) {
  if (!requests || requests.length === 0) return '';
  const categoryLabels = {
    details: 'Personal & Contact Information Update',
    family_add: 'Add Family Member',
    family_delete: 'Remove Family Member',
    emergency_add: 'Add Emergency Contact',
    emergency_delete: 'Remove Emergency Contact',
  };

  return `
    <div class="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      <div class="font-semibold mb-2 flex items-center gap-2">
        <svg class="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>
        Pending Profile Changes Awaiting HR Approval (${requests.length})
      </div>
      <div class="space-y-2">
        ${requests.map((r) => {
          let desc = categoryLabels[r.category] || r.category;
          try {
            const p = JSON.parse(r.payload);
            if ((r.category === 'family_add' || r.category === 'emergency_add') && p.name) desc += `: ${escapeHtml(p.name)}`;
          } catch {}
          return `
            <div class="flex items-center justify-between border-t border-amber-200/60 pt-2 first:border-0 first:pt-0">
              <div>
                <span class="font-medium">${escapeHtml(desc)}</span>
                <span class="text-xs text-amber-700 ml-2">Submitted ${escapeHtml(r.requested_at)}</span>
              </div>
              ${isSelf ? `
                <form method="post" action="/profile/${targetId}/withdraw/${r.id}">
                  <button class="text-xs font-medium text-red-600 hover:text-red-800 bg-white border border-amber-300 rounded px-2.5 py-1">Withdraw</button>
                </form>
              ` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

function renderCustomTab(ctx, target, customTab, isSelf) {
  const fieldsWithValues = getUserCustomValues(target.id, customTab.id);
  const okMsg = ctx.url.searchParams.get('ok');
  const errorMsg = ctx.url.searchParams.get('error');

  const fieldsHtml = fieldsWithValues.map((f) => {
    const val = f.field_value !== null ? f.field_value : '';
    const reqAttr = f.is_required ? 'required' : '';
    const reqStar = f.is_required ? `<span class="text-red-500 ml-0.5">*</span>` : '';

    let inputHtml = '';
    if (f.field_type === 'textarea') {
      inputHtml = `<textarea name="field_${f.id}" rows="3" ${reqAttr} class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2 focus:ring-2 focus:ring-indigo-500">${escapeHtml(val)}</textarea>`;
    } else if (f.field_type === 'select') {
      let options = [];
      try { options = JSON.parse(f.options_json) || []; } catch {}
      inputHtml = `
        <select name="field_${f.id}" ${reqAttr} class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2 focus:ring-2 focus:ring-indigo-500">
          <option value="">-- Select --</option>
          ${options.map((opt) => `<option value="${escapeHtml(opt)}" ${val === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
        </select>
      `;
    } else if (f.field_type === 'date') {
      inputHtml = `<input type="date" name="field_${f.id}" value="${escapeHtml(val)}" ${reqAttr} class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2 focus:ring-2 focus:ring-indigo-500" />`;
    } else if (f.field_type === 'number') {
      inputHtml = `<input type="number" step="any" name="field_${f.id}" value="${escapeHtml(val)}" ${reqAttr} class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2 focus:ring-2 focus:ring-indigo-500" />`;
    } else {
      inputHtml = `<input type="text" name="field_${f.id}" value="${escapeHtml(val)}" ${reqAttr} class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2 focus:ring-2 focus:ring-indigo-500" />`;
    }

    return `
      <div>
        <label class="block text-xs font-semibold text-slate-600 mb-1">${escapeHtml(f.label)}${reqStar}</label>
        ${inputHtml}
      </div>
    `;
  }).join('');

  const actionUrl = isSelf ? `/profile/custom-tab/${customTab.id}` : `/profile/${target.id}/custom-tab/${customTab.id}`;

  return card(
    `
      <div class="mb-4 pb-3 border-b border-slate-100">
        <h3 class="font-semibold text-slate-800 text-base">${escapeHtml(customTab.label)}</h3>
        ${customTab.description ? `<p class="text-xs text-slate-500 mt-0.5">${escapeHtml(customTab.description)}</p>` : ''}
      </div>
      ${okMsg ? `<div class="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg p-3">${escapeHtml(okMsg)}</div>` : ''}
      ${errorMsg ? `<div class="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">${escapeHtml(errorMsg)}</div>` : ''}
      
      ${fieldsWithValues.length === 0 ? `
        <p class="text-sm text-slate-500 italic">No custom fields defined for this tab yet. HR Admins can define fields in HR Settings.</p>
      ` : `
        <form method="post" action="${actionUrl}">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${fieldsHtml}
          </div>
          <div class="mt-6 flex justify-end">
            <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm px-4 py-2 rounded-lg shadow-sm transition-colors">
              Save Changes
            </button>
          </div>
        </form>
      `}
    `
  );
}

function renderProfile(ctx, target, opts = {}) {
  const isSelf = ctx.user.id === target.id;
  const baseHref = isSelf ? '/profile' : `/profile/${target.id}`;

  const customTabs = getAllCustomTabs();
  const allTabs = [
    ...STANDARD_TABS,
    ...customTabs.map((ct) => ({ key: ct.tab_key, label: ct.label, customTab: ct })),
  ];

  const requestedTab = ctx.url.searchParams.get('tab');
  const activeTabObj = allTabs.find((t) => t.key === requestedTab) || allTabs[0];
  const activeTabKey = activeTabObj.key;

  const pendingRequests = getPendingRequestsForUser(target.id);

  let tabBody;
  if (activeTabObj.customTab) {
    tabBody = renderCustomTab(ctx, target, activeTabObj.customTab, isSelf);
  } else if (activeTabKey === 'occupation') {
    tabBody = renderOccupationTab(ctx, target);
  } else if (activeTabKey === 'family') {
    tabBody = renderFamilyTab(ctx, target, isSelf);
  } else if (activeTabKey === 'history') {
    tabBody = renderHistoryTab(target, ctx, isSelf);
  } else {
    tabBody = renderDetailsTab(ctx, target, isSelf);
  }

  const body = `
    ${groupTabs('Employee Center', ctx.user, isSelf ? '/profile' : '/directory')}
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-semibold">${isSelf ? 'My Profile' : escapeHtml(target.name)}</h1>
        <p class="text-slate-500 text-sm mt-1">${escapeHtml(target.employee_no)} · ${escapeHtml(target.position || '—')}</p>
      </div>
      ${!isSelf ? `<a href="/directory" class="text-sm text-indigo-600 font-medium">← Back to directory</a>` : ''}
    </div>
    ${renderPendingBanner(pendingRequests, isSelf, target.id)}
    ${subTabs(allTabs.map(t => ({ key: t.key, label: t.label })), activeTabKey, baseHref)}
    ${tabBody}
  `;
  sendHtml(ctx.res, 200, layout({ title: 'Profile', user: ctx.user, activePath: '/profile', url: ctx.url, body }));
}

// ==================== Tab 1: Employee Details ====================

function renderDetailsTab(ctx, target, isSelf) {
  const emergencyContacts = db.prepare('SELECT * FROM emergency_contacts WHERE user_id = ? ORDER BY id').all(target.id);
  const nationalities = getListValues('nationality');
  const genders = getListValues('gender');
  const isMalaysian = target.nationality === 'Malaysian';
  const canSeeSalary = hasAccess(ctx.user, ['admin']);

  return `
    <div class="grid lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2 space-y-6">
        ${card(`
          <h2 class="font-semibold mb-4">Contact & personal information</h2>
          ${isSelf ? `
            <form method="post" action="/profile/${target.id}" class="grid grid-cols-2 gap-4 text-sm">
              ${field('Phone', 'phone', target.phone)}
              ${selectField('Gender', 'gender', target.gender, genders)}
              ${selectField('Nationality', 'nationality', target.nationality, nationalities, { dataAttr: 'data-nationality-input' })}
              <div data-nric-wrap ${isMalaysian ? '' : 'hidden'}>
                <label class="block text-slate-600 mb-1">NRIC No.</label>
                <input name="ic_number" data-nric-input value="${escapeHtml(target.ic_number)}" placeholder="xxxxxx-xx-xxxx" maxlength="14" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              </div>
              <div data-passport-wrap ${isMalaysian ? 'hidden' : ''}>
                <label class="block text-slate-600 mb-1">Passport No.</label>
                <input name="passport_no" value="${escapeHtml(target.passport_no)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              </div>
              ${field('Address', 'address', target.address, 'col-span-2')}
              ${field('Bank name', 'bank_name', target.bank_name)}
              ${field('Bank account no.', 'bank_account', target.bank_account)}
              ${selectField('Marital status', 'marital_status', target.marital_status, ['single', 'married'])}
              ${field('Number of children', 'num_children', target.num_children, '', 'number')}
              ${field('Date of birth', 'date_of_birth', target.date_of_birth, '', 'date', { dataAttr: 'data-dob-input' })}
              <div class="col-span-2 pt-2">
                <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Save changes</button>
              </div>
            </form>
          ` : `
            <dl class="grid grid-cols-2 gap-y-3 text-sm">
              ${dl('Phone', target.phone)}
              ${dl('Gender', target.gender)}
              ${dl('Nationality', target.nationality)}
              ${dl(isMalaysian ? 'NRIC No.' : 'Passport No.', isMalaysian ? target.ic_number : target.passport_no)}
              ${dl('Address', target.address)}
              ${dl('Bank name', target.bank_name)}
              ${dl('Bank account no.', target.bank_account)}
              ${dl('Marital status', target.marital_status)}
              ${dl('Number of children', target.num_children)}
              ${dl('Date of birth', target.date_of_birth)}
            </dl>
          `}
        `)}
      </div>

      <div class="space-y-6">
        ${card(`
          <h2 class="font-semibold mb-4">Emergency contacts</h2>
          ${emergencyContacts.length ? `<div class="space-y-3 mb-4 text-sm">${emergencyContacts.map((c) => `
            <div class="flex items-start justify-between border-b border-slate-100 pb-2 last:border-0">
              <div>
                <div class="font-medium">${escapeHtml(c.name)}</div>
                <div class="text-slate-500">${escapeHtml(c.relationship || '')} · ${escapeHtml(c.phone || '')}</div>
              </div>
              ${isSelf ? `<form method="post" action="/profile/${target.id}/emergency-contact/${c.id}/delete"><button class="text-red-500 text-xs font-medium">Remove</button></form>` : ''}
            </div>`).join('')}</div>` : `<p class="text-sm text-slate-400 mb-4">No emergency contacts on file.</p>`}
          ${isSelf ? `
            <form method="post" action="/profile/${target.id}/emergency-contact" class="space-y-2 text-sm border-t border-slate-100 pt-4">
              <input name="name" placeholder="Name" required class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              <input name="relationship" placeholder="Relationship" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              <input name="phone" placeholder="Phone" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              <button class="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg py-2">Add contact</button>
            </form>
          ` : ''}
        `)}

        ${canSeeSalary ? renderSalaryCard(target, ctx) : ''}
      </div>
    </div>
  `;
}

function renderSalaryCard(target, ctx) {
  if (!isSalaryUnlocked(ctx.req)) {
    return card(`
      <h2 class="font-semibold mb-1">Salary</h2>
      <p class="text-xs text-slate-400 mb-4">Re-enter your password to unlock confidential salary information (unlocked for 15 min).</p>
      <form method="post" action="/profile/${target.id}/salary/unlock" class="space-y-3 text-sm">
        <input name="password" type="password" required placeholder="Your password" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
        <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg py-2">Unlock Salary Card</button>
      </form>
    `, 'mt-6');
  }

  const latestPayslip = db.prepare(`
    SELECT p.*, pr.month, pr.year FROM payslips p
    JOIN payroll_runs pr ON pr.id = p.payroll_run_id
    WHERE p.user_id = ? ORDER BY pr.year DESC, pr.month DESC LIMIT 1
  `).get(target.id);

  return card(`
    <h2 class="font-semibold mb-1">Salary</h2>
    <p class="text-xs text-slate-400 mb-4">Admin only. Set by HR under Employee Directory — not self-editable here.</p>
    <dl class="grid grid-cols-2 gap-y-3 text-sm mb-4">
      ${dl('Basic salary', target.basic_salary ? formatMoney(target.basic_salary) + ' / month' : null)}
    </dl>
    ${latestPayslip ? `
      <div class="border-t border-slate-100 pt-4">
        <p class="text-sm font-medium mb-2">Latest payslip — ${monthName(latestPayslip.month)} ${latestPayslip.year}</p>
        <dl class="grid grid-cols-2 gap-y-3 text-sm">
          ${dl('Gross pay', formatMoney(latestPayslip.gross_pay))}
          ${dl('Net pay', formatMoney(latestPayslip.net_pay))}
        </dl>
        <p class="text-xs text-slate-400 mt-3">Full payslip history is under Payroll / Reports.</p>
      </div>
    ` : ''}
  `, 'mt-6');
}

// ==================== Tab 2: Employee Occupation ====================

function renderOccupationTab(ctx, target) {
  const directSuperior = target.direct_superior_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(target.direct_superior_id) : null;
  const indirectSuperior = target.indirect_superior_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(target.indirect_superior_id) : null;

  const isAdmin = hasAccess(ctx.user, ['admin']);
  const isSelf = ctx.user.id === target.id;

  const contracts = db.prepare('SELECT * FROM employee_contracts WHERE user_id = ? ORDER BY start_date DESC').all(target.id);
  const belongings = db.prepare('SELECT * FROM company_belongings WHERE user_id = ? ORDER BY issued_date DESC').all(target.id);
  const certs = db.prepare('SELECT * FROM certifications_skills WHERE user_id = ? ORDER BY id DESC').all(target.id);

  return `
    ${card(`
      <h2 class="font-semibold mb-1">Employment details</h2>
      <p class="text-xs text-slate-400 mb-4">Set by HR under Employee Directory — not self-editable here.</p>
      <dl class="grid grid-cols-2 gap-y-3 text-sm">
        ${dl('Department', target.department)}
        ${dl('Position', target.position)}
        ${dl('Division', target.division)}
        ${dl('Team', target.team)}
        ${dl('Type of employment', target.employment_type)}
        ${dl('Employee status', target.employee_status)}
        ${dl('Occupation level', target.occupation_level)}
        ${dl('Location', target.location)}
        ${dl('Job group', target.job_group)}
        ${dl('Job grade', target.job_grade)}
        ${dl('Job band', target.job_band)}
        ${dl('Authorization level', target.authorization_level)}
        ${dl('Direct Superior', directSuperior ? directSuperior.name : '—')}
        ${dl('Indirect Superior', indirectSuperior ? indirectSuperior.name : '—')}
        ${dl('Role', target.role_name)}
        ${dl('Account status', target.status)}
      </dl>
    `)}
    ${card(`
      <h2 class="font-semibold mb-1">Important dates</h2>
      <p class="text-xs text-slate-400 mb-4">Set by HR under Employee Directory — not self-editable here.</p>
      <dl class="grid grid-cols-2 gap-y-3 text-sm">
        ${dl('Join date', target.join_date)}
        ${dl('Group join date', target.group_join_date)}
        ${dl('Confirmation date', target.confirmation_date)}
        ${dl('Probation period', target.probation_period_months ? `${target.probation_period_months} month(s)` : null)}
        ${dl('Last working date', target.last_working_date)}
        ${dl('Resignation date', target.resignation_date)}
        ${dl('Rejoin date', target.rejoin_date)}
        ${dl('Deceased date', target.deceased_date)}
      </dl>
    `, 'mt-6')}
    ${card(`
      <h2 class="font-semibold mb-1">Malaysian Statutory</h2>
      <p class="text-xs text-slate-400 mb-4">Set by HR under Employee Directory — not self-editable here. Records only; doesn't change how Payroll calculates contributions.</p>
      <dl class="grid grid-cols-2 gap-y-3 text-sm">
        ${dl('EPF No.', target.epf_no)}
        ${dl('SOCSO No.', target.socso_no)}
        ${dl('Income Tax No. (TIN)', target.income_tax_no)}
        ${dl('EPF voluntary contribution', target.epf_voluntary_rate !== null && target.epf_voluntary_rate !== undefined ? `${target.epf_voluntary_rate}%` : null)}
        ${dl('SOCSO category', target.socso_category)}
        ${dl('Tax exemption category', target.tax_exemption_category)}
      </dl>
    `, 'mt-6')}

    ${card(`
      <h2 class="font-semibold mb-4">Contracts & Bonds</h2>
      ${contracts.length ? `
        <div class="overflow-x-auto mb-6">
          <table class="data-table w-full text-sm">
            <thead><tr><th>Contract Type</th><th>Start Date</th><th>End Date</th><th>Renewal Status</th><th>Notes</th><th></th></tr></thead>
            <tbody>
              ${contracts.map((c) => `
                <tr>
                  <td class="font-medium">${escapeHtml(c.contract_type)}</td>
                  <td>${escapeHtml(c.start_date)}</td>
                  <td>${escapeHtml(c.end_date || '—')}</td>
                  <td>${escapeHtml(c.renewal_status || '—')}</td>
                  <td>${escapeHtml(c.notes || '—')}</td>
                  <td>${isAdmin ? `<form method="post" action="/profile/${target.id}/contracts/${c.id}/delete"><button class="text-red-500 text-xs font-medium">Remove</button></form>` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<p class="text-sm text-slate-400 mb-6">No contracts or bonds recorded.</p>`}

      ${isAdmin ? `
        <form method="post" action="/profile/${target.id}/contracts" class="grid grid-cols-2 gap-4 text-sm border-t border-slate-100 pt-4">
          ${field('Contract type', 'contract_type', '', '', 'text', { required: true })}
          ${field('Start date', 'start_date', '', '', 'date', { required: true })}
          ${field('End date', 'end_date', '', '', 'date')}
          ${field('Renewal status', 'renewal_status', '', '', 'text')}
          ${field('Notes', 'notes', '', 'col-span-2')}
          <div class="col-span-2 pt-2">
            <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Add contract record</button>
          </div>
        </form>
      ` : ''}
    `, 'mt-6')}

    ${card(`
      <h2 class="font-semibold mb-4">Company Belongings</h2>
      ${belongings.length ? `
        <div class="overflow-x-auto mb-6">
          <table class="data-table w-full text-sm">
            <thead><tr><th>Item Name</th><th>Serial No.</th><th>Issued Date</th><th>Returned Date</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${belongings.map((b) => `
                <tr>
                  <td class="font-medium">${escapeHtml(b.item_name)}</td>
                  <td>${escapeHtml(b.serial_no || '—')}</td>
                  <td>${escapeHtml(b.issued_date)}</td>
                  <td>${escapeHtml(b.returned_date || '—')}</td>
                  <td><span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${b.status === 'issued' ? 'bg-blue-100 text-blue-800' : b.status === 'returned' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}">${escapeHtml(b.status)}</span></td>
                  <td>${isAdmin ? `<form method="post" action="/profile/${target.id}/belongings/${b.id}/delete"><button class="text-red-500 text-xs font-medium">Remove</button></form>` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<p class="text-sm text-slate-400 mb-6">No company belongings recorded.</p>`}

      ${isAdmin ? `
        <form method="post" action="/profile/${target.id}/belongings" class="grid grid-cols-2 gap-4 text-sm border-t border-slate-100 pt-4">
          ${field('Item name', 'item_name', '', '', 'text', { required: true })}
          ${field('Serial no.', 'serial_no', '')}
          ${field('Issued date', 'issued_date', '', '', 'date', { required: true })}
          ${field('Returned date', 'returned_date', '', '', 'date')}
          <div>
            <label class="block text-slate-600 mb-1">Status</label>
            <select name="status" class="w-full rounded-lg border border-slate-300 px-3 py-2">
              <option value="issued">Issued</option>
              <option value="returned">Returned</option>
              <option value="lost">Lost</option>
              <option value="damaged">Damaged</option>
            </select>
          </div>
          <div class="col-span-2 pt-2">
            <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Add company belonging</button>
          </div>
        </form>
      ` : ''}
    `, 'mt-6')}

    ${card(`
      <h2 class="font-semibold mb-4">Certifications & Skills</h2>
      ${certs.length ? `
        <div class="overflow-x-auto mb-6">
          <table class="data-table w-full text-sm">
            <thead><tr><th>Name / Skill</th><th>Issuing Body</th><th>Issue Date</th><th>Expiry Date</th><th></th></tr></thead>
            <tbody>
              ${certs.map((c) => `
                <tr>
                  <td class="font-medium">${escapeHtml(c.name)}</td>
                  <td>${escapeHtml(c.issuing_body || '—')}</td>
                  <td>${escapeHtml(c.issue_date || '—')}</td>
                  <td>${escapeHtml(c.expiry_date || '—')}</td>
                  <td>${isAdmin || isSelf ? `<form method="post" action="/profile/${target.id}/certifications/${c.id}/delete"><button class="text-red-500 text-xs font-medium">Remove</button></form>` : ''}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : `<p class="text-sm text-slate-400 mb-6">No certifications or skills recorded.</p>`}

      ${isAdmin || isSelf ? `
        <form method="post" action="/profile/${target.id}/certifications" class="grid grid-cols-2 gap-4 text-sm border-t border-slate-100 pt-4">
          ${field('Name / Skill title', 'name', '', '', 'text', { required: true })}
          ${field('Issuing body / Provider', 'issuing_body', '')}
          ${field('Issue date', 'issue_date', '', '', 'date')}
          ${field('Expiry date', 'expiry_date', '', '', 'date')}
          <div class="col-span-2 pt-2">
            <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Add certification / skill</button>
          </div>
        </form>
      ` : ''}
    `, 'mt-6')}

    ${(() => {
      const suppRecords = db.prepare('SELECT * FROM occupation_supplementary WHERE user_id = ? ORDER BY id DESC').all(target.id);
      const categoryLabels = {
        bik: 'Benefit In Kind (BIK)',
        job_desc: 'Job Description',
        health: 'Employee Health Record',
        pip: 'Performance Improvement Plan (PIP)',
        service_progression: 'Service Progression / Event',
      };

      return card(`
        <h2 class="font-semibold mb-1">Supplementary Occupation Records</h2>
        <p class="text-xs text-slate-400 mb-4">Benefit in Kind, Job Descriptions, Health Records, PIP, and Service Progression Events (Admin editable).</p>
        ${suppRecords.length ? `
          <div class="overflow-x-auto mb-6">
            <table class="data-table w-full text-sm">
              <thead><tr><th>Category</th><th>Title / Reference</th><th>Details</th><th>Effective Date</th><th></th></tr></thead>
              <tbody>
                ${suppRecords.map((s) => `
                  <tr>
                    <td><span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">${escapeHtml(categoryLabels[s.category] || s.category)}</span></td>
                    <td class="font-medium">${escapeHtml(s.title)}</td>
                    <td class="max-w-xs truncate text-xs text-slate-600" title="${escapeHtml(s.details || '')}">${escapeHtml(s.details || '—')}</td>
                    <td>${escapeHtml(s.effective_date || '—')}</td>
                    <td>${isAdmin ? `<form method="post" action="/profile/${target.id}/occupation-supp/${s.id}/delete"><button class="text-red-500 text-xs font-medium">Remove</button></form>` : ''}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `<p class="text-sm text-slate-400 mb-6">No supplementary occupation records on file.</p>`}

        ${isAdmin ? `
          <form method="post" action="/profile/${target.id}/occupation-supp" class="grid grid-cols-2 gap-4 text-sm border-t border-slate-100 pt-4">
            <div>
              <label class="block text-slate-600 mb-1">Category</label>
              <select name="category" required class="w-full rounded-lg border border-slate-300 px-3 py-2">
                <option value="bik">Benefit In Kind (BIK)</option>
                <option value="job_desc">Job Description</option>
                <option value="health">Employee Health</option>
                <option value="pip">Performance Improvement Plan (PIP)</option>
                <option value="service_progression">Service Progression – Event</option>
              </select>
            </div>
            ${field('Title / Summary', 'title', '', '', 'text', { required: true })}
            ${field('Effective date', 'effective_date', '', '', 'date')}
            ${field('Details / Notes', 'details', '', 'col-span-2')}
            <div class="col-span-2 pt-2">
              <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Add supplementary record</button>
            </div>
          </form>
        ` : ''}
      `, 'mt-6');
    })()}
  `;
}

// ==================== Tab 3: Family ====================

function relationshipLabel(r) {
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : '—';
}
function yesNo(v) {
  return v === 1 ? 'Yes' : v === 0 ? 'No' : '—';
}

function renderFamilyTab(ctx, target, isSelf) {
  const members = db.prepare('SELECT * FROM family_members WHERE user_id = ? ORDER BY id').all(target.id);
  const genders = getListValues('gender');

  return card(`
    <h2 class="font-semibold mb-4">Family members</h2>
    ${members.length ? `
      <div class="overflow-x-auto mb-6">
        <table class="data-table w-full text-sm">
          <thead><tr><th>Name</th><th>Relationship</th><th>IC/Passport</th><th>Date of birth</th><th>Gender</th><th>Occupation</th><th>Spouse working?</th><th>Studying full-time?</th><th></th></tr></thead>
          <tbody>
            ${members.map((m) => `
              <tr>
                <td class="font-medium">${escapeHtml(m.name)}</td>
                <td>${escapeHtml(relationshipLabel(m.relationship))}</td>
                <td>${escapeHtml(m.ic_or_passport || '—')}</td>
                <td>${escapeHtml(m.date_of_birth || '—')}</td>
                <td>${escapeHtml(m.gender || '—')}</td>
                <td>${escapeHtml(m.occupation || '—')}</td>
                <td>${m.relationship === 'spouse' ? yesNo(m.spouse_working) : 'N/A'}</td>
                <td>${m.relationship === 'child' ? yesNo(m.child_studying_fulltime) : 'N/A'}</td>
                <td>${isSelf ? `<form method="post" action="/profile/${target.id}/family/${m.id}/delete"><button class="text-red-500 text-xs font-medium">Remove</button></form>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : `<p class="text-sm text-slate-400 mb-6">No family members on file.</p>`}

    ${isSelf ? `
      <form method="post" action="/profile/${target.id}/family" class="grid grid-cols-2 gap-4 text-sm border-t border-slate-100 pt-4">
        ${field('Name', 'name', '', '', 'text', { required: true })}
        <div><label class="block text-slate-600 mb-1">Relationship</label><select name="relationship" required class="w-full rounded-lg border border-slate-300 px-3 py-2">${RELATIONSHIPS.map((r) => `<option value="${r}">${relationshipLabel(r)}</option>`).join('')}</select></div>
        ${field('IC / Passport No.', 'ic_or_passport', '')}
        ${field('Date of birth', 'date_of_birth', '', '', 'date')}
        ${selectField('Gender', 'gender', '', genders)}
        ${field('Occupation', 'occupation', '')}
        <div>
          <label class="block text-slate-600 mb-1">Spouse working? <span class="text-slate-400">(if relationship = spouse)</span></label>
          <select name="spouse_working" class="w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">N/A</option><option value="1">Yes</option><option value="0">No</option></select>
        </div>
        <div>
          <label class="block text-slate-600 mb-1">Studying full-time? <span class="text-slate-400">(if relationship = child)</span></label>
          <select name="child_studying_fulltime" class="w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">N/A</option><option value="1">Yes</option><option value="0">No</option></select>
        </div>
        <div class="col-span-2 pt-2">
          <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Add family member</button>
        </div>
      </form>
    ` : ''}
  `);
}

// ==================== Tab 4: Employment History ====================

function renderHistoryTab(target, ctx, isSelf) {
  const history = db.prepare('SELECT * FROM employment_history WHERE user_id = ? ORDER BY start_date DESC').all(target.id);
  const education = db.prepare('SELECT * FROM education_background WHERE user_id = ? ORDER BY end_year DESC').all(target.id);

  return `
    ${card(`
      <h2 class="font-semibold mb-4">Employment history</h2>
      ${history.length ? `<div class="space-y-3 text-sm">${history.map((h) => `
        <div class="flex justify-between border-b border-slate-100 pb-2 last:border-0 last:pb-0">
          <div>
            <div class="font-medium">${escapeHtml(h.title)}</div>
            <div class="text-slate-500">${escapeHtml(h.department || '')}</div>
          </div>
          <div class="text-slate-500 text-right">${escapeHtml(h.start_date)} → ${h.end_date ? escapeHtml(h.end_date) : 'Present'}</div>
        </div>`).join('')}</div>` : `<p class="text-sm text-slate-400">No employment history on file.</p>`}
    `)}

    ${card(`
      <h2 class="font-semibold mb-4">Education background</h2>
      ${education.length ? `<div class="space-y-3 mb-6 text-sm">${education.map((e) => `
        <div class="flex items-start justify-between border-b border-slate-100 pb-2 last:border-0">
          <div>
            <div class="font-medium">${escapeHtml(e.institution)} — ${escapeHtml(e.qualification)}</div>
            <div class="text-slate-500">${escapeHtml(e.field_of_study || '')} ${e.grade ? `· Grade: ${escapeHtml(e.grade)}` : ''}</div>
          </div>
          <div class="text-slate-500 text-right flex items-center gap-3">
            <span class="text-xs text-slate-400">${e.start_year || ''} - ${e.end_year || 'Present'}</span>
            ${isSelf || hasAccess(ctx.user, ['admin']) ? `<form method="post" action="/profile/${target.id}/education/${e.id}/delete"><button class="text-red-500 text-xs font-medium">Remove</button></form>` : ''}
          </div>
        </div>`).join('')}</div>` : `<p class="text-sm text-slate-400 mb-6">No education records on file.</p>`}

      ${isSelf || hasAccess(ctx.user, ['admin']) ? `
        <form method="post" action="/profile/${target.id}/education" class="grid grid-cols-2 gap-4 text-sm border-t border-slate-100 pt-4">
          ${field('Institution', 'institution', '', '', 'text', { required: true })}
          ${field('Qualification', 'qualification', '', '', 'text', { required: true })}
          ${field('Field of study', 'field_of_study', '')}
          ${field('Grade / CGPA', 'grade', '')}
          ${field('Start year', 'start_year', '', '', 'number')}
          ${field('End year', 'end_year', '', '', 'number')}
          <div class="col-span-2 pt-2">
            <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Add education record</button>
          </div>
        </form>
      ` : ''}
    `, 'mt-6')}
  `;
}

// ==================== Shared field helpers ====================

function dl(label, value) {
  return `<div><dt class="text-slate-400 text-xs uppercase tracking-wide">${escapeHtml(label)}</dt><dd class="font-medium mt-0.5">${escapeHtml(value || '—')}</dd></div>`;
}
function field(label, name, value, extraCls = '', type = 'text', opts = {}) {
  return `<div class="${extraCls}"><label class="block text-slate-600 mb-1">${escapeHtml(label)}</label><input name="${name}" ${opts.dataAttr || ''} ${opts.required ? 'required' : ''} type="${type}" value="${escapeHtml(value)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>`;
}
function selectField(label, name, value, options, opts = {}) {
  return `<div><label class="block text-slate-600 mb-1">${escapeHtml(label)}</label><select name="${name}" ${opts.dataAttr || ''} class="w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">— Select —</option>${options.map((o) => `<option value="${escapeHtml(o)}" ${o === value ? 'selected' : ''}>${o[0].toUpperCase() + o.slice(1)}</option>`).join('')}</select></div>`;
}

module.exports = function (router) {
  router.get('/profile', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    renderProfile(ctx, ctx.user);
  });

  router.get('/profile/:id', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    const isSelf = id === ctx.user.id;
    if (!isSelf && !hasAccess(ctx.user, ['admin'])) {
      return redirect(ctx.res, '/profile?error=' + encodeURIComponent('You can only view your own profile.'));
    }
    const target = db.prepare(`
      SELECT u.*, r.name as role_name, r.permission_tier
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = ?
    `).get(id);
    if (!target) return redirect(ctx.res, '/directory?error=' + encodeURIComponent('Employee not found.'));
    renderProfile(ctx, target);
  });

  router.post('/profile/:id', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    const b = await parseBodyAuto(ctx.req);

    const idResult = normalizeNricOrPassport(b.nationality || '', b.ic_number, b.passport_no);
    if (idResult.error) return redirect(ctx.res, '/profile?error=' + encodeURIComponent(idResult.error));

    const payload = {
      phone: b.phone || null,
      ic_number: idResult.ic_number,
      passport_no: idResult.passport_no,
      nationality: b.nationality || null,
      gender: b.gender || null,
      address: b.address || null,
      bank_name: b.bank_name || null,
      bank_account: b.bank_account || null,
      marital_status: b.marital_status || 'single',
      num_children: Number(b.num_children || 0),
      date_of_birth: b.date_of_birth || null,
    };

    if (!hasAccess(ctx.user, ['admin'])) {
      createRequest(id, 'details', payload);
      return redirect(ctx.res, '/profile?tab=details&ok=' + encodeURIComponent('Profile update submitted for HR approval.'));
    }

    db.prepare(`
      UPDATE users SET phone=?, ic_number=?, passport_no=?, nationality=?, gender=?, address=?, bank_name=?, bank_account=?, marital_status=?, num_children=?, date_of_birth=?
      WHERE id = ?
    `).run(
      payload.phone, payload.ic_number, payload.passport_no, payload.nationality, payload.gender,
      payload.address, payload.bank_name, payload.bank_account, payload.marital_status,
      payload.num_children, payload.date_of_birth, id,
    );
    logAudit(ctx.user.id, 'update_profile', { target_user_id: id });
    redirect(ctx.res, `/profile/${id}?tab=details&ok=` + encodeURIComponent('Profile updated.'));
  });

  router.post('/profile/:id/emergency-contact', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    const b = await parseBodyAuto(ctx.req);
    if (!b.name) return redirect(ctx.res, '/profile?tab=details&error=' + encodeURIComponent('Contact name is required.'));

    if (!hasAccess(ctx.user, ['admin'])) {
      createRequest(id, 'emergency_add', { name: b.name, relationship: b.relationship || null, phone: b.phone || null });
      return redirect(ctx.res, '/profile?tab=details&ok=' + encodeURIComponent('Emergency contact addition submitted for HR approval.'));
    }

    db.prepare('INSERT INTO emergency_contacts (user_id, name, relationship, phone) VALUES (?, ?, ?, ?)').run(id, b.name, b.relationship || null, b.phone || null);
    logAudit(ctx.user.id, 'add_emergency_contact', { target_user_id: id, name: b.name });
    redirect(ctx.res, `/profile/${id}?tab=details&ok=` + encodeURIComponent('Emergency contact added.'));
  });

  router.post('/profile/:id/emergency-contact/:cid/delete', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    const cid = Number(ctx.params.cid);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));

    if (!hasAccess(ctx.user, ['admin'])) {
      createRequest(id, 'emergency_delete', {}, cid);
      return redirect(ctx.res, '/profile?tab=details&ok=' + encodeURIComponent('Emergency contact removal submitted for HR approval.'));
    }

    db.prepare('DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?').run(cid, id);
    logAudit(ctx.user.id, 'delete_emergency_contact', { target_user_id: id, contact_id: cid });
    redirect(ctx.res, `/profile/${id}?tab=details&ok=` + encodeURIComponent('Contact removed.'));
  });

  router.post('/profile/:id/family', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    const b = await parseBodyAuto(ctx.req);
    if (!b.name || !b.relationship) return redirect(ctx.res, '/profile?tab=family&error=' + encodeURIComponent('Name and relationship are required.'));
    if (!RELATIONSHIPS.includes(b.relationship)) return redirect(ctx.res, '/profile?tab=family&error=' + encodeURIComponent('Please choose a valid relationship.'));
    const toFlag = (v) => (v === '1' ? 1 : v === '0' ? 0 : null);

    const payload = {
      name: b.name,
      relationship: b.relationship,
      ic_or_passport: b.ic_or_passport || null,
      date_of_birth: b.date_of_birth || null,
      gender: b.gender || null,
      occupation: b.occupation || null,
      spouse_working: toFlag(b.spouse_working),
      child_studying_fulltime: toFlag(b.child_studying_fulltime),
    };

    if (!hasAccess(ctx.user, ['admin'])) {
      createRequest(id, 'family_add', payload);
      return redirect(ctx.res, '/profile?tab=family&ok=' + encodeURIComponent('Family member addition submitted for HR approval.'));
    }

    db.prepare(`
      INSERT INTO family_members (user_id, name, relationship, ic_or_passport, date_of_birth, gender, occupation, spouse_working, child_studying_fulltime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, payload.name, payload.relationship, payload.ic_or_passport, payload.date_of_birth, payload.gender,
      payload.occupation, payload.spouse_working, payload.child_studying_fulltime,
    );
    logAudit(ctx.user.id, 'add_family_member', { target_user_id: id, name: payload.name });
    redirect(ctx.res, `/profile/${id}?tab=family&ok=` + encodeURIComponent('Family member added.'));
  });

  router.post('/profile/:id/family/:fid/delete', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    const fid = Number(ctx.params.fid);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));

    if (!hasAccess(ctx.user, ['admin'])) {
      createRequest(id, 'family_delete', {}, fid);
      return redirect(ctx.res, '/profile?tab=family&ok=' + encodeURIComponent('Family member removal submitted for HR approval.'));
    }

    db.prepare('DELETE FROM family_members WHERE id = ? AND user_id = ?').run(fid, id);
    logAudit(ctx.user.id, 'delete_family_member', { target_user_id: id, family_member_id: fid });
    redirect(ctx.res, `/profile/${id}?tab=family&ok=` + encodeURIComponent('Family member removed.'));
  });

  router.post('/profile/:id/withdraw/:reqId', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    if (id !== ctx.user.id) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    withdrawRequest(Number(ctx.params.reqId), id);
    logAudit(ctx.user.id, 'withdraw_profile_request', { request_id: ctx.params.reqId });
    redirect(ctx.res, '/profile?ok=' + encodeURIComponent('Request withdrawn.'));
  });

  router.post('/profile/:id/salary/unlock', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    const id = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!row || !verifyPassword(b.password || '', row.password_hash)) {
      return redirect(ctx.res, `/profile/${id}?tab=details&error=` + encodeURIComponent('Incorrect password.'));
    }
    unlockSalary(ctx.req);
    logAudit(ctx.user.id, 'unlock_salary_card', { target_user_id: id });
    redirect(ctx.res, `/profile/${id}?tab=details&ok=` + encodeURIComponent('Salary card unlocked.'));
  });

  router.post('/profile/:id/education', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    const b = await parseBodyAuto(ctx.req);
    if (!b.institution || !b.qualification) return redirect(ctx.res, `/profile/${id}?tab=history&error=` + encodeURIComponent('Institution and qualification are required.'));

    db.prepare(`
      INSERT INTO education_background (user_id, institution, qualification, field_of_study, start_year, end_year, grade)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, b.institution, b.qualification, b.field_of_study || null,
      b.start_year ? parseInt(b.start_year, 10) : null,
      b.end_year ? parseInt(b.end_year, 10) : null,
      b.grade || null,
    );
    logAudit(ctx.user.id, 'add_education', { target_user_id: id, institution: b.institution, qualification: b.qualification });
    redirect(ctx.res, `/profile/${id}?tab=history&ok=` + encodeURIComponent('Education record added.'));
  });

  router.post('/profile/:id/education/:eid/delete', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    const eid = Number(ctx.params.eid);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    db.prepare('DELETE FROM education_background WHERE id = ? AND user_id = ?').run(eid, id);
    logAudit(ctx.user.id, 'delete_education', { target_user_id: id, education_id: eid });
    redirect(ctx.res, `/profile/${id}?tab=history&ok=` + encodeURIComponent('Education record removed.'));
  });

  // ---------------- Extended HR Occupation Records (Contracts, Belongings, Certifications) ----------------

  router.post('/profile/:id/contracts', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized. HR Admin required.'));
    const id = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    if (!b.contract_type || !b.start_date) return redirect(ctx.res, `/profile/${id}?tab=occupation&error=` + encodeURIComponent('Contract type and start date are required.'));

    db.prepare(`
      INSERT INTO employee_contracts (user_id, contract_type, start_date, end_date, renewal_status, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, b.contract_type, b.start_date, b.end_date || null, b.renewal_status || null, b.notes || null);

    logAudit(ctx.user.id, 'add_employee_contract', { target_user_id: id, contract_type: b.contract_type });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Contract record added.'));
  });

  router.post('/profile/:id/contracts/:cid/delete', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized. HR Admin required.'));
    const id = Number(ctx.params.id);
    const cid = Number(ctx.params.cid);
    db.prepare('DELETE FROM employee_contracts WHERE id = ? AND user_id = ?').run(cid, id);
    logAudit(ctx.user.id, 'delete_employee_contract', { target_user_id: id, contract_id: cid });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Contract record removed.'));
  });

  router.post('/profile/:id/belongings', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized. HR Admin required.'));
    const id = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    if (!b.item_name || !b.issued_date) return redirect(ctx.res, `/profile/${id}?tab=occupation&error=` + encodeURIComponent('Item name and issued date are required.'));

    db.prepare(`
      INSERT INTO company_belongings (user_id, item_name, serial_no, issued_date, returned_date, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, b.item_name, b.serial_no || null, b.issued_date, b.returned_date || null, b.status || 'issued');

    logAudit(ctx.user.id, 'add_company_belonging', { target_user_id: id, item_name: b.item_name });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Company belonging added.'));
  });

  router.post('/profile/:id/belongings/:bid/delete', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized. HR Admin required.'));
    const id = Number(ctx.params.id);
    const bid = Number(ctx.params.bid);
    db.prepare('DELETE FROM company_belongings WHERE id = ? AND user_id = ?').run(bid, id);
    logAudit(ctx.user.id, 'delete_company_belonging', { target_user_id: id, belonging_id: bid });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Belonging record removed.'));
  });

  router.post('/profile/:id/certifications', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    const b = await parseBodyAuto(ctx.req);
    if (!b.name) return redirect(ctx.res, `/profile/${id}?tab=occupation&error=` + encodeURIComponent('Certification / skill name is required.'));

    db.prepare(`
      INSERT INTO certifications_skills (user_id, name, issuing_body, issue_date, expiry_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, b.name, b.issuing_body || null, b.issue_date || null, b.expiry_date || null);

    logAudit(ctx.user.id, 'add_certification_skill', { target_user_id: id, name: b.name });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Certification / skill added.'));
  });

  router.post('/profile/:id/certifications/:cid/delete', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    const cid = Number(ctx.params.cid);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized.'));
    db.prepare('DELETE FROM certifications_skills WHERE id = ? AND user_id = ?').run(cid, id);
    logAudit(ctx.user.id, 'delete_certification_skill', { target_user_id: id, certification_id: cid });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Certification / skill removed.'));
  });

  router.post('/profile/:id/occupation-supp', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized. HR Admin required.'));
    const id = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    if (!b.category || !b.title) return redirect(ctx.res, `/profile/${id}?tab=occupation&error=` + encodeURIComponent('Category and title are required.'));

    db.prepare(`
      INSERT INTO occupation_supplementary (user_id, category, title, details, effective_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, b.category, b.title, b.details || null, b.effective_date || null);

    logAudit(ctx.user.id, 'add_occupation_supplementary', { target_user_id: id, category: b.category, title: b.title });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Supplementary record added.'));
  });

  router.post('/profile/:id/occupation-supp/:suppId/delete', async (ctx) => {
    if (!ctx.user || !hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized. HR Admin required.'));
    const id = Number(ctx.params.id);
    const suppId = Number(ctx.params.suppId);
    db.prepare('DELETE FROM occupation_supplementary WHERE id = ? AND user_id = ?').run(suppId, id);
    logAudit(ctx.user.id, 'delete_occupation_supplementary', { target_user_id: id, supp_id: suppId });
    redirect(ctx.res, `/profile/${id}?tab=occupation&ok=` + encodeURIComponent('Supplementary record removed.'));
  });

  router.post('/profile/custom-tab/:tabId', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const tabId = Number(ctx.params.tabId);
    const customTab = getCustomTab(tabId);
    if (!customTab) return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Tab not found.'));

    const body = await parseBodyAuto(ctx.req);
    const valuesMap = {};
    for (const f of customTab.fields) {
      valuesMap[f.id] = body[`field_${f.id}`] !== undefined ? body[`field_${f.id}`] : '';
    }

    saveUserCustomValues(ctx.user.id, valuesMap);
    logAudit(ctx.user.id, 'update_custom_profile', { target_user_id: ctx.user.id, tab_id: tabId });
    redirect(ctx.res, `/profile?tab=${encodeURIComponent(customTab.tab_key)}&ok=` + encodeURIComponent(`${customTab.label} updated successfully.`));
  });

  router.post('/profile/:id/custom-tab/:tabId', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const id = Number(ctx.params.id);
    if (id !== ctx.user.id && !hasAccess(ctx.user, ['admin'])) {
      return redirect(ctx.res, '/profile?error=' + encodeURIComponent('Not authorized. HR Admin required.'));
    }

    const tabId = Number(ctx.params.tabId);
    const customTab = getCustomTab(tabId);
    if (!customTab) return redirect(ctx.res, `/profile/${id}?error=` + encodeURIComponent('Tab not found.'));

    const body = await parseBodyAuto(ctx.req);
    const valuesMap = {};
    for (const f of customTab.fields) {
      valuesMap[f.id] = body[`field_${f.id}`] !== undefined ? body[`field_${f.id}`] : '';
    }

    saveUserCustomValues(id, valuesMap);
    logAudit(ctx.user.id, 'update_custom_profile', { target_user_id: id, tab_id: tabId });
    const redirectUrl = id === ctx.user.id ? `/profile?tab=${encodeURIComponent(customTab.tab_key)}` : `/profile/${id}?tab=${encodeURIComponent(customTab.tab_key)}`;
    redirect(ctx.res, `${redirectUrl}&ok=` + encodeURIComponent(`${customTab.label} updated successfully.`));
  });
};
