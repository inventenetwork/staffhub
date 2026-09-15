'use strict';
const db = require('../db');
const { redirect, sendHtml, sendFile, parseBodyAuto, formatMoney, normalizeNricOrPassport, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml, groupTabs } = require('../lib/render');
const { hasAccess, hashPassword, canAssignRole } = require('../lib/auth');
const { getListValues, insertIfMissing } = require('../lib/lists');
const { getAllRoles, getRole } = require('../lib/roles');
const { buildXlsx, parseXlsx, findSheet, serialDateToISO } = require('../lib/xlsx');
const { getAllPendingRequests, approveRequest, rejectRequest } = require('../lib/approvals');
const { checkHeadcountLimit } = require('../lib/settings');
const { getAllCustomTabs, getUserCustomValues, saveUserCustomValues } = require('../lib/custom_profile');

// Dropdowns backed by lib/lists.js's configurable option lists (Settings >
// HR Settings > Dropdown Lists). Each entry is [users.<column>, list_key, label].
const PROFILE_LISTS = [
  ['department', 'department', 'Department'],
  ['position', 'position', 'Position'],
  ['division', 'division', 'Division'],
  ['team', 'team', 'Team'],
  ['employment_type', 'employment_type', 'Type of employment'],
  ['employee_status', 'employee_status', 'Employee status'],
  ['occupation_level', 'occupation_level', 'Occupation level'],
  ['location', 'location', 'Location'],
  ['job_group', 'job_group', 'Job group'],
  ['job_grade', 'job_grade', 'Job grade'],
  ['job_band', 'job_band', 'Job band'],
  ['authorization_level', 'authorization_level', 'Authorization level'],
];

// Statutory-tab dropdowns (same shape as PROFILE_LISTS above).
const STATUTORY_LISTS = [
  ['socso_category', 'socso_category', 'SOCSO category'],
  ['tax_exemption_category', 'tax_exemption_category', 'Tax exemption category'],
];

// One row of this table = one column in the bulk-upload .xlsx template. The
// same array builds the template's header row (buildBulkTemplate) AND
// parses an uploaded file's header row back into field keys (processBulkRow)
// — matched by exact label text (case-insensitive), not column position, so
// reordering columns is fine but renaming a header makes that column
// unrecognized. `listKey` marks a column backed by a lib/lists.js dropdown
// (any new value HR types gets auto-added to that list, same as the
// department/position migration does); `date`/`numeric` control how a raw
// cell value is coerced. Employee No. is deliberately not a column — it's
// always auto-assigned, same as the Add Employee form.
const BULK_COLUMNS = [
  { key: 'name', label: 'Full Name', required: true },
  { key: 'email', label: 'Email', required: true },
  { key: 'password', label: 'Temporary Password' },
  { key: 'date_of_birth', label: 'Date of Birth (YYYY-MM-DD)', date: true },
  { key: 'gender', label: 'Gender', listKey: 'gender' },
  { key: 'nationality', label: 'Nationality', listKey: 'nationality' },
  { key: 'ic_number', label: 'NRIC No. (if Malaysian, xxxxxx-xx-xxxx)' },
  { key: 'passport_no', label: 'Passport No. (if not Malaysian)' },
  { key: 'department', label: 'Department', listKey: 'department' },
  { key: 'position', label: 'Position', listKey: 'position' },
  { key: 'division', label: 'Division', listKey: 'division' },
  { key: 'team', label: 'Team', listKey: 'team' },
  { key: 'employment_type', label: 'Type of Employment', listKey: 'employment_type' },
  { key: 'employee_status', label: 'Employee Status', listKey: 'employee_status' },
  { key: 'occupation_level', label: 'Occupation Level', listKey: 'occupation_level' },
  { key: 'location', label: 'Location', listKey: 'location' },
  { key: 'job_group', label: 'Job Group', listKey: 'job_group' },
  { key: 'job_grade', label: 'Job Grade', listKey: 'job_grade' },
  { key: 'job_band', label: 'Job Band', listKey: 'job_band' },
  { key: 'authorization_level', label: 'Authorization Level', listKey: 'authorization_level' },
  { key: 'role_name', label: 'Role (must match an existing role name)' },
  { key: 'direct_superior_employee_no', label: 'Direct Superior Employee No.' },
  { key: 'indirect_superior_employee_no', label: 'Indirect Superior Employee No.' },
  { key: 'basic_salary', label: 'Basic Salary (RM/month)', numeric: true },
  { key: 'status', label: 'Account Status (active/inactive)' },
  { key: 'join_date', label: 'Join Date (YYYY-MM-DD)', date: true },
  { key: 'group_join_date', label: 'Group Join Date (YYYY-MM-DD)', date: true },
  { key: 'confirmation_date', label: 'Confirmation Date (YYYY-MM-DD)', date: true },
  { key: 'probation_period_months', label: 'Probation Period (months)', numeric: true },
  { key: 'last_working_date', label: 'Last Working Date (YYYY-MM-DD)', date: true },
  { key: 'resignation_date', label: 'Resignation Date (YYYY-MM-DD)', date: true },
  { key: 'rejoin_date', label: 'Rejoin Date (YYYY-MM-DD)', date: true },
  { key: 'deceased_date', label: 'Deceased Date (YYYY-MM-DD)', date: true },
  { key: 'epf_no', label: 'EPF No.' },
  { key: 'socso_no', label: 'SOCSO No.' },
  { key: 'income_tax_no', label: 'Income Tax No. (TIN)' },
  { key: 'epf_voluntary_rate', label: 'EPF Voluntary Contribution %', numeric: true },
  { key: 'socso_category', label: 'SOCSO Category', listKey: 'socso_category' },
  { key: 'tax_exemption_category', label: 'Tax Exemption Category', listKey: 'tax_exemption_category' },
];

function buildBulkTemplate() {
  const header = BULK_COLUMNS.map((c) => c.label);
  const referenceRows = [
    ['Bulk upload instructions', ''],
    ["Fill in the 'Employees' sheet — one row per new employee. Don't rename or reorder-delete the column headers.", ''],
    ['Leave Employee No. out entirely — every new employee is assigned one automatically.', ''],
    ['Only NEW employees are created. If a row\'s email already belongs to an existing employee, that row is skipped and reported as an error — existing employees are never overwritten by this upload.', ''],
    ['Dates: use YYYY-MM-DD. Blank cells are fine for anything optional.', ''],
    ['A dropdown-backed value that isn\'t in the list below yet (e.g. a new Department) is added to that dropdown automatically — it doesn\'t reject the row.', ''],
    ['', ''],
    ['Field', 'Currently configured values'],
  ];
  for (const col of BULK_COLUMNS) {
    if (col.listKey) referenceRows.push([col.label, getListValues(col.listKey).join(', ') || '(none configured yet)']);
  }
  referenceRows.push(['Role', getAllRoles().map((r) => r.name).join(', ')]);

  return buildXlsx([
    { name: 'Employees', rows: [header] },
    { name: 'Reference', rows: referenceRows },
  ]);
}

function nextEmployeeNo(joinDate = null) {
  let yr = new Date().getFullYear().toString().slice(2, 4);
  if (joinDate && /^\d{4}/.test(joinDate)) {
    yr = joinDate.slice(2, 4);
  }
  const prefix = 'SH' + yr;
  const rows = db.prepare(`SELECT employee_no FROM users WHERE employee_no LIKE ?`).all(prefix + '%');
  let maxSeq = 0;
  for (const r of rows) {
    const seq = parseInt(r.employee_no.slice(4), 10);
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  return prefix + String(maxSeq + 1).padStart(4, '0');
}

// New employees start with a full leave balance for the current year, based
// on whatever leave types + default entitlements are configured right now
// (Super Admin > Company Settings > Leave Types).
function provisionLeaveBalances(userId, year) {
  const types = db.prepare('SELECT id, default_days_per_year FROM leave_types').all();
  for (const t of types) {
    const existing = db.prepare('SELECT id FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?').get(userId, t.id, year);
    if (!existing) {
      db.prepare('INSERT INTO leave_balances (user_id, leave_type_id, year, entitled_days, used_days) VALUES (?, ?, ?, ?, 0)').run(userId, t.id, year, t.default_days_per_year);
    }
  }
}

module.exports = function (router) {
  router.get('/directory', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    // Staff Directory is Admin-only (Super Admin included via the hasAccess
    // override) — the old "an Approver sees only their own team" carve-out is
    // retired along with the fixed Approver role tier.
    if (!hasAccess(ctx.user, ['admin'])) return redirect(ctx.res, '/?error=' + encodeURIComponent('Not authorized.'));

    const rows = db.prepare(`SELECT u.*, r.name as role_name FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.name`).all();

    const body = `
      ${groupTabs('Employee Center', ctx.user, '/directory')}
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-semibold">Employee Directory</h1>
        <div class="flex gap-2">
          <a href="/directory/export" class="bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center gap-1.5 shadow-sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
            Export Excel
          </a>
          <a href="/directory/bulk-upload" class="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-sm font-medium rounded-lg px-4 py-2">Bulk upload</a>
          <a href="/directory/new" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">+ Add employee</a>
        </div>
      </div>
      ${card(`
        <div class="overflow-x-auto">
          <table class="data-table w-full">
            <thead><tr><th>Name</th><th>Employee No.</th><th>Department</th><th>Role</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${rows.map((u) => `
                <tr>
                  <td class="font-medium">${escapeHtml(u.name)}</td>
                  <td>${escapeHtml(u.employee_no)}</td>
                  <td>${escapeHtml(u.department || '—')}</td>
                  <td>${escapeHtml(u.role_name)}</td>
                  <td>${statusBadge(u.status)}</td>
                  <td class="whitespace-nowrap">
                    <a href="/profile/${u.id}" class="text-indigo-600 text-xs font-medium mr-3">View</a>
                    <a href="/directory/${u.id}/edit" class="text-slate-500 text-xs font-medium">Edit</a>
                  </td>
                </tr>
              `).join('') || `<tr><td colspan="6" class="text-center text-slate-400 py-6">No employees found.</td></tr>`}
            </tbody>
          </table>
        </div>
      `)}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Employee Directory', user: ctx.user, activePath: '/directory', url: ctx.url, body }));
  });

  function requireManage(ctx) {
    if (!ctx.user) { redirect(ctx.res, '/login'); return false; }
    if (!hasAccess(ctx.user, ['admin'])) { redirect(ctx.res, '/directory?error=' + encodeURIComponent('Only Admins or the Super Admin can do this.')); return false; }
    return true;
  }

  function listSelect(label, name, value) {
    const options = getListValues(name);
    return `<div><label class="block text-slate-600 mb-1">${escapeHtml(label)}</label><select name="${name}" class="w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">— Select —</option>${options.map((o) => `<option value="${escapeHtml(o)}" ${o === value ? 'selected' : ''}>${escapeHtml(o)}</option>`).join('')}</select></div>`;
  }

  function employeeForm(action, emp, superiorOptions, actingUser) {
    const e = emp || {};
    const allRoles = getAllRoles();
    const roleOptions = allRoles.filter((r) => canAssignRole(actingUser, r.permission_tier) || r.id === e.role_id);
    const isMalaysian = e.nationality === 'Malaysian';
    const genders = getListValues('gender');
    const nationalities = getListValues('nationality');

    const customTabs = getAllCustomTabs();

    // Collect field values if editing an employee
    const customTabContentHtml = customTabs.map((ct) => {
      const userCustomValues = emp && emp.id ? getUserCustomValues(emp.id, ct.id) : ct.fields.map(f => ({ ...f, field_value: '' }));

      const fieldsHtml = userCustomValues.map((f) => {
        const val = f.field_value !== null && f.field_value !== undefined ? f.field_value : '';
        const reqAttr = f.is_required ? 'required' : '';
        const reqStar = f.is_required ? `<span class="text-red-500 ml-0.5">*</span>` : '';

        let inputHtml = '';
        if (f.field_type === 'textarea') {
          inputHtml = `<textarea name="custom_field_${f.id || f.field_id}" rows="3" ${reqAttr} class="w-full rounded-lg border border-slate-300 px-3 py-2">${escapeHtml(val)}</textarea>`;
        } else if (f.field_type === 'select') {
          let options = [];
          try { options = JSON.parse(f.options_json) || []; } catch {}
          inputHtml = `
            <select name="custom_field_${f.id || f.field_id}" ${reqAttr} class="w-full rounded-lg border border-slate-300 px-3 py-2">
              <option value="">-- Select --</option>
              ${options.map((opt) => `<option value="${escapeHtml(opt)}" ${val === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}
            </select>
          `;
        } else if (f.field_type === 'date') {
          inputHtml = `<input type="date" name="custom_field_${f.id || f.field_id}" value="${escapeHtml(val)}" ${reqAttr} class="w-full rounded-lg border border-slate-300 px-3 py-2" />`;
        } else if (f.field_type === 'number') {
          inputHtml = `<input type="number" step="any" name="custom_field_${f.id || f.field_id}" value="${escapeHtml(val)}" ${reqAttr} class="w-full rounded-lg border border-slate-300 px-3 py-2" />`;
        } else {
          inputHtml = `<input type="text" name="custom_field_${f.id || f.field_id}" value="${escapeHtml(val)}" ${reqAttr} class="w-full rounded-lg border border-slate-300 px-3 py-2" />`;
        }

        return `
          <div>
            <label class="block text-slate-600 mb-1">${escapeHtml(f.label)}${reqStar}</label>
            ${inputHtml}
          </div>
        `;
      }).join('');

      return `
        <div id="tab-custom-${ct.id}" class="emp-tab-content hidden space-y-4">
          <div class="flex items-center justify-between border-b border-slate-100 pb-2 mb-3">
            <div>
              <h3 class="font-semibold text-slate-700 text-base">${escapeHtml(ct.label)}</h3>
              ${ct.description ? `<p class="text-xs text-slate-400 mt-0.5">${escapeHtml(ct.description)}</p>` : ''}
            </div>
            ${hasAccess(actingUser, ['admin']) ? `
              <div class="flex items-center gap-2">
                <button type="button" onclick="document.getElementById('add-field-modal-${ct.id}').classList.remove('hidden')" class="text-xs text-indigo-600 font-medium hover:underline flex items-center gap-1 bg-indigo-50 px-2.5 py-1 rounded-lg">
                  + Add Field to ${escapeHtml(ct.label)}
                </button>
              </div>
            ` : ''}
          </div>

          ${fieldsHtml ? `
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              ${fieldsHtml}
            </div>
          ` : '<p class="text-xs text-slate-400 italic">No custom fields defined for this tab yet. Click "+ Add Field" above to add one!</p>'}
        </div>

        <!-- Modal to Add Field to Tab ${ct.id} -->
        <div id="add-field-modal-${ct.id}" class="hidden fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div class="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl">
            <h3 class="text-lg font-bold text-slate-800 mb-1">Add Field to ${escapeHtml(ct.label)}</h3>
            <p class="text-xs text-slate-400 mb-4">Define a new field for employee records under this tab.</p>
            <form method="post" action="/settings/custom-tabs/${ct.id}/fields" class="space-y-4">
              <input type="hidden" name="redirect_to" value="${escapeHtml(action)}" />
              <div>
                <label class="block text-xs font-semibold text-slate-600 mb-1">Field Label</label>
                <input name="label" required placeholder="e.g. Highest Qualification" class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2"/>
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-600 mb-1">Field Type</label>
                <select name="field_type" class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2">
                  <option value="text">Text Input</option>
                  <option value="number">Number</option>
                  <option value="date">Date</option>
                  <option value="select">Dropdown Select</option>
                  <option value="textarea">Textarea</option>
                </select>
              </div>
              <div>
                <label class="block text-xs font-semibold text-slate-600 mb-1">Dropdown Options (if Select)</label>
                <input name="options" placeholder="e.g. Diploma, Bachelor, Master" class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2"/>
              </div>
              <div class="flex items-center gap-2">
                <input type="checkbox" name="is_required" value="1" id="req-${ct.id}"/>
                <label for="req-${ct.id}" class="text-xs text-slate-600">Required Field</label>
              </div>
              <div class="flex justify-end gap-2 pt-2">
                <button type="button" onclick="document.getElementById('add-field-modal-${ct.id}').classList.add('hidden')" class="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
                <button type="submit" class="px-4 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg">Add Field</button>
              </div>
            </form>
          </div>
        </div>
      `;
    }).join('');

    const standardTabsCount = 5;

    return `
      <form method="post" action="${action}" class="space-y-6 text-sm">
        <!-- Form Section Tabs -->
        <div class="border-b border-slate-200 overflow-x-auto">
          <nav class="-mb-px flex space-x-6 text-sm font-medium" id="emp-form-tabs">
            <button type="button" data-tab="tab-basic" class="emp-tab-btn whitespace-nowrap border-b-2 border-indigo-600 pb-3 text-indigo-600 font-semibold focus:outline-none">
              1. Basic Information
            </button>
            <button type="button" data-tab="tab-employment" class="emp-tab-btn whitespace-nowrap border-b-2 border-transparent pb-3 text-slate-500 hover:text-slate-700 hover:border-slate-300 focus:outline-none">
              2. Employment Details
            </button>
            <button type="button" data-tab="tab-role" class="emp-tab-btn whitespace-nowrap border-b-2 border-transparent pb-3 text-slate-500 hover:text-slate-700 hover:border-slate-300 focus:outline-none">
              3. Role & Access
            </button>
            <button type="button" data-tab="tab-dates" class="emp-tab-btn whitespace-nowrap border-b-2 border-transparent pb-3 text-slate-500 hover:text-slate-700 hover:border-slate-300 focus:outline-none">
              4. Important Dates
            </button>
            <button type="button" data-tab="tab-statutory" class="emp-tab-btn whitespace-nowrap border-b-2 border-transparent pb-3 text-slate-500 hover:text-slate-700 hover:border-slate-300 focus:outline-none">
              5. Salary & Statutory
            </button>
            ${customTabs.map((ct, idx) => `
              <button type="button" data-tab="tab-custom-${ct.id}" class="emp-tab-btn whitespace-nowrap border-b-2 border-transparent pb-3 text-slate-500 hover:text-slate-700 hover:border-slate-300 focus:outline-none">
                ${standardTabsCount + idx + 1}. ${escapeHtml(ct.label)}
              </button>
            `).join('')}
            ${hasAccess(actingUser, ['admin']) ? `
              <button type="button" onclick="document.getElementById('add-tab-modal').classList.remove('hidden')" title="Add New Custom Tab" class="whitespace-nowrap border-b-2 border-transparent pb-3 text-indigo-600 hover:text-indigo-800 font-bold text-base focus:outline-none flex items-center gap-1 transition-colors">
                <span class="w-6 h-6 rounded-full bg-indigo-50 hover:bg-indigo-100 flex items-center justify-center text-sm">+</span>
              </button>
            ` : ''}
          </nav>
        </div>

        <!-- Tab 1: Basic Information -->
        <div id="tab-basic" class="emp-tab-content space-y-4">
          <h3 class="font-semibold text-slate-700 mb-3">Basic Information</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label class="block text-slate-600 mb-1">Full Name <span class="text-red-500">*</span></label><input name="name" required value="${escapeHtml(e.name)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Email <span class="text-red-500">*</span></label><input name="email" type="email" required value="${escapeHtml(e.email)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Date of Birth</label><input name="date_of_birth" type="date" data-dob-input value="${escapeHtml(e.date_of_birth)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Gender</label><select name="gender" class="w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">— Select —</option>${genders.map((g) => `<option value="${escapeHtml(g)}" ${g === e.gender ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('')}</select></div>
            <div><label class="block text-slate-600 mb-1">Nationality</label><select name="nationality" data-nationality-input class="w-full rounded-lg border border-slate-300 px-3 py-2"><option value="">— Select —</option>${nationalities.map((n) => `<option value="${escapeHtml(n)}" ${n === e.nationality ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}</select></div>
            <div data-nric-wrap ${isMalaysian ? '' : 'hidden'}>
              <label class="block text-slate-600 mb-1">NRIC No.</label>
              <input name="ic_number" data-nric-input value="${escapeHtml(e.ic_number)}" placeholder="xxxxxx-xx-xxxx" maxlength="14" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
            </div>
            <div data-passport-wrap ${isMalaysian ? 'hidden' : ''}>
              <label class="block text-slate-600 mb-1">Passport No.</label>
              <input name="passport_no" value="${escapeHtml(e.passport_no)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
            </div>
            ${!emp ? `
              <div>
                <label class="block text-slate-600 mb-1">Temporary Password</label>
                <input name="password" type="text" value="password123" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Tab 2: Employment Details -->
        <div id="tab-employment" class="emp-tab-content hidden space-y-4">
          <h3 class="font-semibold text-slate-700 mb-3">Employment Details</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            ${PROFILE_LISTS.map(([col, key, label]) => listSelect(label, col, e[col])).join('')}
          </div>
        </div>

        <!-- Tab 3: Role & Access -->
        <div id="tab-role" class="emp-tab-content hidden space-y-4">
          <h3 class="font-semibold text-slate-700 mb-3">Role & Access</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label class="block text-slate-600 mb-1">Role <span class="text-red-500">*</span></label>
              <select name="role_id" class="w-full rounded-lg border border-slate-300 px-3 py-2">
                ${roleOptions.map((r) => `<option value="${r.id}" ${r.id === e.role_id ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
              </select>
              ${actingUser.permission_tier !== 'super_admin' ? `<p class="text-xs text-slate-400 mt-1">Only a Super Admin can grant a Super Admin-tier role.</p>` : ''}
            </div>
            <div>
              <label class="block text-slate-600 mb-1">Account Status</label>
              <select name="status" class="w-full rounded-lg border border-slate-300 px-3 py-2">
                ${['active', 'inactive'].map((s) => `<option value="${s}" ${s === e.status ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-slate-600 mb-1">Direct Superior</label>
              <select name="direct_superior_id" class="w-full rounded-lg border border-slate-300 px-3 py-2">
                <option value="">None</option>
                ${superiorOptions.map((m) => `<option value="${m.id}" ${m.id === e.direct_superior_id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-slate-600 mb-1">Indirect Superior</label>
              <select name="indirect_superior_id" class="w-full rounded-lg border border-slate-300 px-3 py-2">
                <option value="">None</option>
                ${superiorOptions.map((m) => `<option value="${m.id}" ${m.id === e.indirect_superior_id ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
              </select>
            </div>
            <div><label class="block text-slate-600 mb-1">Basic Salary (RM/month)</label><input name="basic_salary" type="number" step="0.01" min="0" value="${e.basic_salary || 0}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
          </div>
        </div>

        <!-- Tab 4: Important Dates -->
        <div id="tab-dates" class="emp-tab-content hidden space-y-4">
          <h3 class="font-semibold text-slate-700 mb-3">Important Dates</h3>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label class="block text-slate-600 mb-1">Join Date</label><input name="join_date" type="date" value="${escapeHtml(e.join_date)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Group Join Date</label><input name="group_join_date" type="date" value="${escapeHtml(e.group_join_date)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Confirmation Date</label><input name="confirmation_date" type="date" value="${escapeHtml(e.confirmation_date)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Probation Period (months)</label><input name="probation_period_months" type="number" min="0" step="1" value="${e.probation_period_months || ''}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Last Working Date</label><input name="last_working_date" type="date" value="${escapeHtml(e.last_working_date)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Resignation Date</label><input name="resignation_date" type="date" value="${escapeHtml(e.resignation_date)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Rejoin Date</label><input name="rejoin_date" type="date" value="${escapeHtml(e.rejoin_date)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Deceased Date</label><input name="deceased_date" type="date" value="${escapeHtml(e.deceased_date)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
          </div>
        </div>

        <!-- Tab 5: Salary & Statutory -->
        <div id="tab-statutory" class="emp-tab-content hidden space-y-4">
          <h3 class="font-semibold text-slate-700 mb-1">Salary & Malaysia Statutory</h3>
          <p class="text-xs text-slate-400 mb-3">Records only — these don't change what Payroll actually calculates (see the Salary & Malaysia Statutory tab on the employee's profile).</p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label class="block text-slate-600 mb-1">EPF No.</label><input name="epf_no" value="${escapeHtml(e.epf_no)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">SOCSO No.</label><input name="socso_no" value="${escapeHtml(e.socso_no)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">Income Tax No. (TIN)</label><input name="income_tax_no" value="${escapeHtml(e.income_tax_no)}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            <div><label class="block text-slate-600 mb-1">EPF Voluntary Contribution %</label><input name="epf_voluntary_rate" type="number" step="0.01" min="0" max="100" value="${e.epf_voluntary_rate ?? ''}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            ${STATUTORY_LISTS.map(([col, key, label]) => listSelect(label, col, e[col])).join('')}
          </div>
        </div>

        <!-- Dynamic Custom Tabs Content -->
        ${customTabContentHtml}

        <!-- Form Actions & Navigation -->
        <div class="pt-6 border-t border-slate-200 flex items-center justify-between">
          <div class="flex gap-2">
            <button type="button" id="prev-tab-btn" class="hidden bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg px-4 py-2">
              ← Previous
            </button>
            <button type="button" id="next-tab-btn" class="bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg px-4 py-2">
              Next →
            </button>
          </div>
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-5 py-2 shadow-sm">
            ${emp ? 'Save Changes' : 'Create Employee'}
          </button>
        </div>
      </form>

      <!-- Google Chrome Style Add Tab Modal -->
      <div id="add-tab-modal" class="hidden fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
        <div class="bg-white rounded-2xl p-6 max-w-md w-full shadow-xl">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold text-slate-800">Add New Profile Tab</h3>
            <button type="button" onclick="document.getElementById('add-tab-modal').classList.add('hidden')" class="text-slate-400 hover:text-slate-600 font-bold text-lg">×</button>
          </div>
          <form method="post" action="/settings/custom-tabs" class="space-y-4">
            <input type="hidden" name="redirect_to" value="${escapeHtml(action)}" />
            <div>
              <label class="block text-xs font-semibold text-slate-600 mb-1">Tab Name / Label <span class="text-red-500">*</span></label>
              <input name="label" required placeholder="e.g. Health & Insurance" class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2"/>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-600 mb-1">Description (Optional)</label>
              <input name="description" placeholder="e.g. Medical records & policy numbers" class="w-full text-sm rounded-lg border border-slate-300 px-3 py-2"/>
            </div>
            <div class="flex justify-end gap-2 pt-2">
              <button type="button" onclick="document.getElementById('add-tab-modal').classList.add('hidden')" class="px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg">Create Tab</button>
            </div>
          </form>
        </div>
      </div>

      <script>
        (function() {
          const standardTabs = ['tab-basic', 'tab-employment', 'tab-role', 'tab-dates', 'tab-statutory'];
          const customTabs = ${JSON.stringify(customTabs.map(ct => `tab-custom-${ct.id}`))};
          const tabs = [...standardTabs, ...customTabs];
          let currentIndex = 0;

          const tabBtns = document.querySelectorAll('.emp-tab-btn');
          const prevBtn = document.getElementById('prev-tab-btn');
          const nextBtn = document.getElementById('next-tab-btn');

          function switchTab(index) {
            currentIndex = index;
            tabs.forEach((tabId, idx) => {
              const content = document.getElementById(tabId);
              const btn = tabBtns[idx];
              if (content) {
                if (idx === index) {
                  content.classList.remove('hidden');
                  if (btn) btn.className = 'emp-tab-btn whitespace-nowrap border-b-2 border-indigo-600 pb-3 text-indigo-600 font-semibold focus:outline-none';
                } else {
                  content.classList.add('hidden');
                  if (btn) btn.className = 'emp-tab-btn whitespace-nowrap border-b-2 border-transparent pb-3 text-slate-500 hover:text-slate-700 hover:border-slate-300 focus:outline-none';
                }
              }
            });

            if (currentIndex === 0) {
              prevBtn.classList.add('hidden');
            } else {
              prevBtn.classList.remove('hidden');
            }

            if (currentIndex === tabs.length - 1) {
              nextBtn.classList.add('hidden');
            } else {
              nextBtn.classList.remove('hidden');
            }
          }

          tabBtns.forEach((btn, idx) => {
            btn.addEventListener('click', () => switchTab(idx));
          });

          if (prevBtn) prevBtn.addEventListener('click', () => switchTab(Math.max(0, currentIndex - 1)));
          if (nextBtn) nextBtn.addEventListener('click', () => switchTab(Math.min(tabs.length - 1, currentIndex + 1)));
        })();
      </script>
    `;
  }

  // Fields shared by create (POST /directory) and edit (POST /directory/:id/edit)
  // beyond name/email/password/role, which each handler validates on its own.
  function readEmployeeFields(b) {
    return {
      department: b.department || null,
      position: b.position || null,
      division: b.division || null,
      team: b.team || null,
      employment_type: b.employment_type || null,
      employee_status: b.employee_status || null,
      occupation_level: b.occupation_level || null,
      location: b.location || null,
      job_group: b.job_group || null,
      job_grade: b.job_grade || null,
      job_band: b.job_band || null,
      authorization_level: b.authorization_level || null,
      gender: b.gender || null,
      nationality: b.nationality || null,
      date_of_birth: b.date_of_birth || null,
      join_date: b.join_date || null,
      group_join_date: b.group_join_date || null,
      confirmation_date: b.confirmation_date || null,
      probation_period_months: b.probation_period_months ? Number(b.probation_period_months) : null,
      last_working_date: b.last_working_date || null,
      resignation_date: b.resignation_date || null,
      rejoin_date: b.rejoin_date || null,
      deceased_date: b.deceased_date || null,
      direct_superior_id: b.direct_superior_id ? Number(b.direct_superior_id) : null,
      indirect_superior_id: b.indirect_superior_id ? Number(b.indirect_superior_id) : null,
      basic_salary: Number(b.basic_salary || 0),
      status: b.status || 'active',
      epf_no: b.epf_no || null,
      socso_no: b.socso_no || null,
      income_tax_no: b.income_tax_no || null,
      epf_voluntary_rate: b.epf_voluntary_rate !== undefined && b.epf_voluntary_rate !== '' ? Number(b.epf_voluntary_rate) : null,
      socso_category: b.socso_category || null,
      tax_exemption_category: b.tax_exemption_category || null,
    };
  }

  router.get('/directory/new', async (ctx) => {
    if (!requireManage(ctx)) return;
    // Direct/Indirect Superior aren't tied to a role or tier — any active
    // employee can be listed as someone's superior — so this is a plain
    // roster, not filtered by permission tier the way the old "approvers"
    // list was.
    const superiorOptions = db.prepare(`SELECT id, name FROM users WHERE status = 'active' ORDER BY name`).all();
    const body = `
      ${groupTabs('Employee Center', ctx.user, '/directory')}
      <div class="flex items-center justify-between mb-6"><h1 class="text-2xl font-semibold">Add employee</h1><a href="/directory" class="text-sm text-slate-500">← Back</a></div>
      ${card(employeeForm('/directory', null, superiorOptions, ctx.user))}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Add employee', user: ctx.user, activePath: '/directory', url: ctx.url, body }));
  });

  router.post('/directory', async (ctx) => {
    if (!requireManage(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    if (!b.name || !b.email) return redirect(ctx.res, '/directory/new?error=' + encodeURIComponent('Name and email are required.'));

    // Enforce Headcount License Limit check for active status
    const targetStatus = b.status || 'active';
    if (targetStatus === 'active') {
      const hcCheck = checkHeadcountLimit();
      if (!hcCheck.allowed) {
        return redirect(ctx.res, '/directory/new?error=' + encodeURIComponent(hcCheck.error));
      }
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(b.email.toLowerCase().trim());
    if (existing) return redirect(ctx.res, '/directory/new?error=' + encodeURIComponent('An employee with this email already exists.'));

    const roleRow = getRole(Number(b.role_id));
    if (!roleRow) return redirect(ctx.res, '/directory/new?error=' + encodeURIComponent('Please choose a valid role.'));
    if (!canAssignRole(ctx.user, roleRow.permission_tier)) {
      return redirect(ctx.res, '/directory/new?error=' + encodeURIComponent('Only a Super Admin can grant a Super Admin-tier role.'));
    }

    const idResult = normalizeNricOrPassport(b.nationality || '', b.ic_number, b.passport_no);
    if (idResult.error) return redirect(ctx.res, '/directory/new?error=' + encodeURIComponent(idResult.error));

    const f = readEmployeeFields(b);
    const employeeNo = nextEmployeeNo(f.join_date);
    const passwordHash = hashPassword(b.password || 'password123');
    const info = db.prepare(`
      INSERT INTO users (
        employee_no, name, email, password_hash, role_id, department, position, division, team,
        employment_type, employee_status, occupation_level, location, job_group, job_grade, job_band,
        authorization_level, gender, nationality, ic_number, passport_no, date_of_birth,
        join_date, group_join_date, confirmation_date, probation_period_months, last_working_date,
        resignation_date, rejoin_date, deceased_date, direct_superior_id, indirect_superior_id, basic_salary, status,
        epf_no, socso_no, income_tax_no, epf_voluntary_rate, socso_category, tax_exemption_category
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      employeeNo, b.name, b.email.toLowerCase().trim(), passwordHash, roleRow.id,
      f.department, f.position, f.division, f.team, f.employment_type, f.employee_status, f.occupation_level,
      f.location, f.job_group, f.job_grade, f.job_band, f.authorization_level, f.gender, f.nationality,
      idResult.ic_number, idResult.passport_no, f.date_of_birth, f.join_date, f.group_join_date,
      f.confirmation_date, f.probation_period_months, f.last_working_date, f.resignation_date,
      f.rejoin_date, f.deceased_date, f.direct_superior_id, f.indirect_superior_id, f.basic_salary, f.status,
      f.epf_no, f.socso_no, f.income_tax_no, f.epf_voluntary_rate, f.socso_category, f.tax_exemption_category,
    );

    const newUserId = info.lastInsertRowid;
    provisionLeaveBalances(newUserId, new Date().getFullYear());

    // Save custom profile field values
    const customTabs = getAllCustomTabs();
    const customValuesMap = {};
    for (const ct of customTabs) {
      for (const field of ct.fields) {
        if (b[`custom_field_${field.id}`] !== undefined) {
          customValuesMap[field.id] = b[`custom_field_${field.id}`];
        }
      }
    }
    if (Object.keys(customValuesMap).length > 0) {
      saveUserCustomValues(newUserId, customValuesMap);
    }

    redirect(ctx.res, '/directory?ok=' + encodeURIComponent(`Employee ${employeeNo} created.`));
  });

  router.get('/directory/:id/edit', async (ctx) => {
    if (!requireManage(ctx)) return;
    const emp = db.prepare(`
      SELECT u.*, r.name as role_name, r.permission_tier
      FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?
    `).get(Number(ctx.params.id));
    if (!emp) return redirect(ctx.res, '/directory?error=' + encodeURIComponent('Employee not found.'));
    if (emp.permission_tier === 'super_admin' && ctx.user.permission_tier !== 'super_admin') {
      return redirect(ctx.res, '/directory?error=' + encodeURIComponent('Only a Super Admin can edit another Super Admin.'));
    }
    const superiorOptions = db.prepare(`SELECT id, name FROM users WHERE status = 'active' AND id != ? ORDER BY name`).all(emp.id);
    const body = `
      ${groupTabs('Employee Center', ctx.user, '/directory')}
      <div class="flex items-center justify-between mb-6"><h1 class="text-2xl font-semibold">Edit ${escapeHtml(emp.name)}</h1><a href="/directory" class="text-sm text-slate-500">← Back</a></div>
      ${card(employeeForm(`/directory/${emp.id}/edit`, emp, superiorOptions, ctx.user))}
      ${card(`
        <h2 class="font-semibold mb-1">Reset Password</h2>
        <p class="text-xs text-slate-400 mb-4">Set a temporary password for this employee.</p>
        <form method="post" action="/directory/${emp.id}/reset-password" class="flex gap-2 text-sm max-w-md">
          <input name="new_password" type="password" required minlength="6" placeholder="New temporary password" class="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
          <button class="bg-amber-600 hover:bg-amber-700 text-white font-medium rounded-lg px-4 py-2 text-xs">Reset password</button>
        </form>
      `, 'mt-6')}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Edit employee', user: ctx.user, activePath: '/directory', url: ctx.url, body }));
  });

  router.post('/directory/:id/reset-password', async (ctx) => {
    if (!requireManage(ctx)) return;
    const id = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    if (!b.new_password || b.new_password.length < 6) {
      return redirect(ctx.res, `/directory/${id}/edit?error=` + encodeURIComponent('Temporary password must be at least 6 characters.'));
    }
    const newHash = hashPassword(b.new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, id);
    redirect(ctx.res, `/directory/${id}/edit?ok=` + encodeURIComponent('Employee password reset successfully.'));
  });

  router.post('/directory/:id/edit', async (ctx) => {
    if (!requireManage(ctx)) return;
    const id = Number(ctx.params.id);
    const emp = db.prepare(`
      SELECT u.*, r.permission_tier FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?
    `).get(id);
    if (!emp) return redirect(ctx.res, '/directory?error=' + encodeURIComponent('Employee not found.'));
    if (emp.permission_tier === 'super_admin' && ctx.user.permission_tier !== 'super_admin') {
      return redirect(ctx.res, '/directory?error=' + encodeURIComponent('Only a Super Admin can edit another Super Admin.'));
    }

    const b = await parseBodyAuto(ctx.req);
    const roleRow = getRole(Number(b.role_id));
    if (!roleRow) return redirect(ctx.res, `/directory/${id}/edit?error=` + encodeURIComponent('Please choose a valid role.'));
    if (!canAssignRole(ctx.user, roleRow.permission_tier)) {
      return redirect(ctx.res, `/directory/${id}/edit?error=` + encodeURIComponent('Only a Super Admin can grant a Super Admin-tier role.'));
    }

    const idResult = normalizeNricOrPassport(b.nationality || '', b.ic_number, b.passport_no);
    if (idResult.error) return redirect(ctx.res, `/directory/${id}/edit?error=` + encodeURIComponent(idResult.error));

    const f = readEmployeeFields(b);
    // If activating an inactive employee, enforce headcount license capacity
    if (emp.status === 'inactive' && f.status === 'active') {
      const hcCheck = checkHeadcountLimit();
      if (!hcCheck.allowed) {
        return redirect(ctx.res, `/directory/${id}/edit?error=` + encodeURIComponent(hcCheck.error));
      }
    }

    db.prepare(`
      UPDATE users SET
        name=?, email=?, role_id=?, department=?, position=?, division=?, team=?,
        employment_type=?, employee_status=?, occupation_level=?, location=?, job_group=?, job_grade=?, job_band=?,
        authorization_level=?, gender=?, nationality=?, ic_number=?, passport_no=?, date_of_birth=?,
        join_date=?, group_join_date=?, confirmation_date=?, probation_period_months=?, last_working_date=?,
        resignation_date=?, rejoin_date=?, deceased_date=?, direct_superior_id=?, indirect_superior_id=?, basic_salary=?, status=?,
        epf_no=?, socso_no=?, income_tax_no=?, epf_voluntary_rate=?, socso_category=?, tax_exemption_category=?
      WHERE id = ?
    `).run(
      b.name, (b.email || '').toLowerCase().trim(), roleRow.id, f.department, f.position, f.division, f.team,
      f.employment_type, f.employee_status, f.occupation_level, f.location, f.job_group, f.job_grade, f.job_band,
      f.authorization_level, f.gender, f.nationality, idResult.ic_number, idResult.passport_no, f.date_of_birth,
      f.join_date, f.group_join_date, f.confirmation_date, f.probation_period_months, f.last_working_date,
      f.resignation_date, f.rejoin_date, f.deceased_date, f.direct_superior_id, f.indirect_superior_id, f.basic_salary, f.status,
      f.epf_no, f.socso_no, f.income_tax_no, f.epf_voluntary_rate, f.socso_category, f.tax_exemption_category, id,
    );

    // Save custom profile field values
    const customTabs = getAllCustomTabs();
    const customValuesMap = {};
    for (const ct of customTabs) {
      for (const field of ct.fields) {
        if (b[`custom_field_${field.id}`] !== undefined) {
          customValuesMap[field.id] = b[`custom_field_${field.id}`];
        }
      }
    }
    if (Object.keys(customValuesMap).length > 0) {
      saveUserCustomValues(id, customValuesMap);
    }

    redirect(ctx.res, '/directory?ok=' + encodeURIComponent('Employee updated.'));
  });

  router.get('/directory/bulk-upload', async (ctx) => {
    if (!requireManage(ctx)) return;
    const body = `
      ${groupTabs('Employee Center', ctx.user, '/directory')}
      <div class="flex items-center justify-between mb-6"><h1 class="text-2xl font-semibold">Bulk upload employees</h1><a href="/directory" class="text-sm text-slate-500">← Back</a></div>
      ${card(`
        <h2 class="font-semibold mb-2">1. Download the template</h2>
        <p class="text-sm text-slate-500 mb-4">One row per new employee on the "Employees" sheet. Don't rename the column headers — the "Reference" sheet lists the dropdown values and role names currently configured, and full instructions.</p>
        <a href="/directory/bulk-template.xlsx" class="inline-block bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg px-4 py-2">Download template (.xlsx)</a>
      `)}
      ${card(`
        <h2 class="font-semibold mb-2">2. Upload your completed file</h2>
        <p class="text-sm text-slate-500 mb-4">Only creates new employees — a row whose email already belongs to someone is skipped and reported as an error, never overwritten.</p>
        <form method="post" action="/directory/bulk-upload" class="space-y-3 text-sm">
          <input type="file" accept=".xlsx" data-file-input="bulk_xlsx_data" data-file-max-mb="8" data-file-label="spreadsheet" class="block w-full text-sm"/>
          <input type="hidden" name="xlsx_data" id="bulk_xlsx_data"/>
          <div id="bulk_xlsx_data-name" class="text-xs text-slate-500"></div>
          <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg px-4 py-2">Upload & create employees</button>
        </form>
      `, 'mt-6')}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Bulk upload employees', user: ctx.user, activePath: '/directory', url: ctx.url, body }));
  });

  router.get('/directory/bulk-template.xlsx', async (ctx) => {
    if (!requireManage(ctx)) return;
    const buf = buildBulkTemplate();
    sendFile(ctx.res, 200, buf, 'staffhub-employee-bulk-upload-template.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  router.post('/directory/bulk-upload', async (ctx) => {
    if (!requireManage(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    const dataUrl = b.xlsx_data || '';
    const m = /^data:[^;]*;base64,(.+)$/.exec(dataUrl);
    if (!m) return redirect(ctx.res, '/directory/bulk-upload?error=' + encodeURIComponent('Please choose a .xlsx file to upload.'));

    let buf;
    try {
      buf = Buffer.from(m[1], 'base64');
    } catch {
      return redirect(ctx.res, '/directory/bulk-upload?error=' + encodeURIComponent('That file could not be read.'));
    }

    let parsed;
    try {
      parsed = parseXlsx(buf);
    } catch (err) {
      return redirect(ctx.res, '/directory/bulk-upload?error=' + encodeURIComponent(err.message));
    }

    const sheetRows = findSheet(parsed, 'Employees');
    if (!sheetRows || sheetRows.length === 0) {
      return redirect(ctx.res, '/directory/bulk-upload?error=' + encodeURIComponent('The uploaded file has no "Employees" sheet.'));
    }

    const headerRow = sheetRows[0].map((h) => String(h || '').trim());
    const colIndexByKey = {};
    for (const col of BULK_COLUMNS) {
      const idx = headerRow.findIndex((h) => h.toLowerCase() === col.label.toLowerCase());
      if (idx !== -1) colIndexByKey[col.key] = idx;
    }
    if (colIndexByKey.name === undefined || colIndexByKey.email === undefined) {
      return redirect(ctx.res, '/directory/bulk-upload?error=' + encodeURIComponent('The "Full Name" and/or "Email" column header was not found — please use the downloaded template without renaming its headers.'));
    }

    const dataRows = sheetRows.slice(1).filter((row) => row.some((c) => String(c || '').trim() !== ''));
    const allRoles = getAllRoles();
    const results = { created: [], errors: [] };

    dataRows.forEach((row, i) => {
      const rowNum = i + 2; // +1 for header row, +1 for 1-indexing
      const get = (key) => {
        const idx = colIndexByKey[key];
        if (idx === undefined) return '';
        const v = row[idx];
        return v === null || v === undefined ? '' : String(v).trim();
      };
      const getDate = (key) => {
        const idx = colIndexByKey[key];
        if (idx === undefined) return null;
        const v = row[idx];
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'number') return serialDateToISO(v);
        const s = String(v).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const d = new Date(s);
        return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
      };
      const getNumber = (key) => {
        const s = get(key);
        if (s === '') return null;
        const n = Number(s);
        return Number.isNaN(n) ? null : n;
      };

      const fail = (error) => results.errors.push({ row: rowNum, error });

      try {
        const name = get('name');
        const email = get('email').toLowerCase();
        if (!name || !email) return fail('Full Name and Email are required.');
        if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
          return fail(`An employee with email "${email}" already exists — row skipped.`);
        }

        const statusVal = (get('employee_status') || 'active').toLowerCase();
        if (statusVal !== 'inactive') {
          const hcCheck = checkHeadcountLimit();
          if (!hcCheck.allowed) {
            return fail(`Headcount license capacity limit reached (${hcCheck.currentActive}/${hcCheck.limit}) — remaining row skipped.`);
          }
        }

        const roleName = get('role_name');
        let roleRow;
        if (roleName) {
          roleRow = allRoles.find((r) => r.name.toLowerCase() === roleName.toLowerCase());
          if (!roleRow) return fail(`Role "${roleName}" was not found — check the Reference sheet for valid role names.`);
        } else {
          roleRow = allRoles.find((r) => r.is_system && r.permission_tier === 'ess');
        }
        if (!canAssignRole(ctx.user, roleRow.permission_tier)) {
          return fail(`You're not allowed to assign the role "${roleRow.name}".`);
        }

        let directSuperiorId = null;
        const directSuperiorNo = get('direct_superior_employee_no');
        if (directSuperiorNo) {
          const sup = db.prepare('SELECT id FROM users WHERE employee_no = ?').get(directSuperiorNo);
          if (!sup) return fail(`Direct Superior Employee No. "${directSuperiorNo}" was not found.`);
          directSuperiorId = sup.id;
        }
        let indirectSuperiorId = null;
        const indirectSuperiorNo = get('indirect_superior_employee_no');
        if (indirectSuperiorNo) {
          const sup = db.prepare('SELECT id FROM users WHERE employee_no = ?').get(indirectSuperiorNo);
          if (!sup) return fail(`Indirect Superior Employee No. "${indirectSuperiorNo}" was not found.`);
          indirectSuperiorId = sup.id;
        }

        const nationality = get('nationality');
        const idResult = normalizeNricOrPassport(nationality, get('ic_number'), get('passport_no'));
        if (idResult.error) return fail(idResult.error);

        // Any new dropdown value HR typed gets added to that list, rather
        // than rejecting the row — same forgiving behavior as the
        // department/position-from-existing-records migration.
        for (const col of BULK_COLUMNS) {
          if (col.listKey) {
            const val = get(col.key);
            if (val) insertIfMissing(col.listKey, val);
          }
        }

        const employeeNo = nextEmployeeNo();
        const passwordHash = hashPassword(get('password') || 'password123');
        const status = get('status').toLowerCase() === 'inactive' ? 'inactive' : 'active';

        const info = db.prepare(`
          INSERT INTO users (
            employee_no, name, email, password_hash, role_id, department, position, division, team,
            employment_type, employee_status, occupation_level, location, job_group, job_grade, job_band,
            authorization_level, gender, nationality, ic_number, passport_no, date_of_birth,
            join_date, group_join_date, confirmation_date, probation_period_months, last_working_date,
            resignation_date, rejoin_date, deceased_date, direct_superior_id, indirect_superior_id, basic_salary, status,
            epf_no, socso_no, income_tax_no, epf_voluntary_rate, socso_category, tax_exemption_category
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          employeeNo, name, email, passwordHash, roleRow.id,
          get('department') || null, get('position') || null, get('division') || null, get('team') || null,
          get('employment_type') || null, get('employee_status') || null, get('occupation_level') || null,
          get('location') || null, get('job_group') || null, get('job_grade') || null, get('job_band') || null,
          get('authorization_level') || null, get('gender') || null, nationality || null,
          idResult.ic_number, idResult.passport_no, getDate('date_of_birth'),
          getDate('join_date'), getDate('group_join_date'), getDate('confirmation_date'),
          getNumber('probation_period_months'), getDate('last_working_date'),
          getDate('resignation_date'), getDate('rejoin_date'), getDate('deceased_date'),
          directSuperiorId, indirectSuperiorId, getNumber('basic_salary') || 0, status,
          get('epf_no') || null, get('socso_no') || null, get('income_tax_no') || null,
          getNumber('epf_voluntary_rate'), get('socso_category') || null, get('tax_exemption_category') || null,
        );

        provisionLeaveBalances(info.lastInsertRowid, new Date().getFullYear());
        results.created.push({ row: rowNum, employee_no: employeeNo, name, email });
      } catch (err) {
        fail(err.message || 'Unexpected error.');
      }
    });

    const body = `
      ${groupTabs('Employee Center', ctx.user, '/directory')}
      <div class="flex items-center justify-between mb-6"><h1 class="text-2xl font-semibold">Bulk upload results</h1><a href="/directory" class="text-sm text-slate-500">← Back to directory</a></div>
      ${card(`
        <p class="text-sm mb-2"><span class="font-semibold text-emerald-700">${results.created.length}</span> employee(s) created, <span class="font-semibold ${results.errors.length ? 'text-red-700' : 'text-slate-500'}">${results.errors.length}</span> row(s) skipped with errors.</p>
      `)}
      ${results.created.length ? card(`
        <h2 class="font-semibold mb-3">Created</h2>
        <table class="data-table w-full text-sm">
          <thead><tr><th>Row</th><th>Employee No.</th><th>Name</th><th>Email</th></tr></thead>
          <tbody>${results.created.map((c) => `<tr><td>${c.row}</td><td>${escapeHtml(c.employee_no)}</td><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.email)}</td></tr>`).join('')}</tbody>
        </table>
      `, 'mt-6') : ''}
      ${results.errors.length ? card(`
        <h2 class="font-semibold mb-3 text-red-700">Errors</h2>
        <table class="data-table w-full text-sm">
          <thead><tr><th>Row</th><th>Error</th></tr></thead>
          <tbody>${results.errors.map((e) => `<tr><td>${e.row}</td><td>${escapeHtml(e.error)}</td></tr>`).join('')}</tbody>
        </table>
      `, 'mt-6') : ''}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Bulk upload results', user: ctx.user, activePath: '/directory', url: ctx.url, body }));
  });

  function renderApprovalsInbox(ctx, requests) {
    const categoryLabels = {
      details: 'Personal & Contact Info Update',
      family_add: 'Add Family Member',
      family_delete: 'Remove Family Member',
      emergency_add: 'Add Emergency Contact',
      emergency_delete: 'Remove Emergency Contact',
    };

    return `
      ${groupTabs('Employee Center', ctx.user, '/directory/approvals')}
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 class="text-2xl font-semibold">Pending Profile Approvals</h1>
          <p class="text-slate-500 text-sm mt-1">Review self-service profile changes submitted by employees.</p>
        </div>
      </div>

      ${requests.length === 0 ? card(`
        <div class="text-center py-12">
          <svg class="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
          <h3 class="text-base font-medium text-slate-700 mb-1">No pending approval requests</h3>
          <p class="text-sm text-slate-400">All self-service profile updates have been reviewed.</p>
        </div>
      `) : `
        <div class="space-y-4">
          ${requests.map((r) => {
            let payload;
            try { payload = JSON.parse(r.payload); } catch { payload = {}; }

            let detailsHtml = '';
            if (r.category === 'details' || r.category === 'family_add' || r.category === 'emergency_add') {
              detailsHtml = `
                <div class="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs bg-slate-50 p-3 rounded-lg border border-slate-100">
                  ${Object.entries(payload).filter(([_, v]) => v !== null && v !== '' && v !== 0).map(([k, v]) => `
                    <div><span class="text-slate-400 capitalize">${escapeHtml(k.replace('_', ' '))}:</span> <span class="font-medium text-slate-700">${escapeHtml(String(v))}</span></div>
                  `).join('')}
                </div>
              `;
            } else if (r.category === 'family_delete' || r.category === 'emergency_delete') {
              detailsHtml = `<p class="text-xs text-slate-500 bg-red-50 text-red-700 p-2.5 rounded-lg border border-red-100 font-medium">Requesting removal of record #${r.target_id}</p>`;
            }

            return card(`
              <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-100 pb-3 mb-3">
                <div>
                  <div class="flex items-center gap-2 mb-1">
                    <a href="/profile/${r.user_id}" class="font-semibold text-indigo-600 hover:underline">${escapeHtml(r.user_name)}</a>
                    <span class="text-xs text-slate-400">(${escapeHtml(r.employee_no)})</span>
                    <span class="bg-amber-100 text-amber-700 text-xs px-2.5 py-0.5 rounded-full font-medium">${escapeHtml(categoryLabels[r.category] || r.category)}</span>
                  </div>
                  <div class="text-xs text-slate-500">${escapeHtml(r.department || 'No department')} · Submitted ${escapeHtml(r.requested_at)}</div>
                </div>
                <div class="flex items-center gap-2">
                  <form method="post" action="/directory/approvals/${r.id}/approve">
                    <button class="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium rounded-lg px-3 py-1.5 shadow-sm">Approve</button>
                  </form>
                  <form method="post" action="/directory/approvals/${r.id}/reject" class="flex items-center gap-2">
                    <input name="note" placeholder="Reason (optional)" class="text-xs rounded-lg border border-slate-300 px-2 py-1.5 w-36"/>
                    <button class="bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg px-3 py-1.5 shadow-sm">Reject</button>
                  </form>
                </div>
              </div>
              ${detailsHtml}
            `);
          }).join('')}
        </div>
      `}
    `;
  }

  router.get('/directory/approvals', async (ctx) => {
    if (!requireManage(ctx)) return;
    const requests = getAllPendingRequests();
    const body = renderApprovalsInbox(ctx, requests);
    sendHtml(ctx.res, 200, layout({ title: 'Pending Profile Approvals', user: ctx.user, activePath: '/directory', url: ctx.url, body }));
  });

  router.post('/directory/approvals/:id/approve', async (ctx) => {
    if (!requireManage(ctx)) return;
    const reqId = Number(ctx.params.id);
    const result = approveRequest(reqId, ctx.user.id);
    if (!result.ok) {
      return redirect(ctx.res, '/directory/approvals?error=' + encodeURIComponent(result.error));
    }
    redirect(ctx.res, '/directory/approvals?ok=' + encodeURIComponent('Change request approved and applied.'));
  });

  router.post('/directory/approvals/:id/reject', async (ctx) => {
    if (!requireManage(ctx)) return;
    const reqId = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    const result = rejectRequest(reqId, ctx.user.id, b.note);
    if (!result.ok) {
      return redirect(ctx.res, '/directory/approvals?error=' + encodeURIComponent(result.error));
    }
    redirect(ctx.res, '/directory/approvals?ok=' + encodeURIComponent('Change request rejected.'));
  });

  router.get('/directory/export', async (ctx) => {
    if (!requireManage(ctx)) return;

    const users = db.prepare(`
      SELECT u.*, r.name as role_name,
             d.name as direct_superior_name,
             ind.name as indirect_superior_name
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN users d ON d.id = u.direct_superior_id
      LEFT JOIN users ind ON ind.id = u.indirect_superior_id
      ORDER BY u.employee_no ASC
    `).all();

    const customTabs = getAllCustomTabs();

    // Sheet 1: Basic Information
    const basicRows = [
      ['Employee No.', 'Full Name', 'Email', 'Date of Birth', 'Gender', 'Nationality', 'NRIC No.', 'Passport No.']
    ];
    for (const u of users) {
      basicRows.push([
        u.employee_no || '',
        u.name || '',
        u.email || '',
        u.date_of_birth || '',
        u.gender || '',
        u.nationality || '',
        u.ic_number || '',
        u.passport_no || ''
      ]);
    }

    // Sheet 2: Employment Details
    const employmentRows = [
      [
        'Employee No.', 'Full Name', 'Department', 'Position', 'Division', 'Team',
        'Type of Employment', 'Employee Status', 'Occupation Level', 'Location',
        'Job Group', 'Job Grade', 'Job Band', 'Authorization Level'
      ]
    ];
    for (const u of users) {
      employmentRows.push([
        u.employee_no || '',
        u.name || '',
        u.department || '',
        u.position || '',
        u.division || '',
        u.team || '',
        u.employment_type || '',
        u.employee_status || '',
        u.occupation_level || '',
        u.location || '',
        u.job_group || '',
        u.job_grade || '',
        u.job_band || '',
        u.authorization_level || ''
      ]);
    }

    // Sheet 3: Role & Access
    const roleRows = [
      ['Employee No.', 'Full Name', 'Role', 'Account Status', 'Direct Superior', 'Indirect Superior', 'Basic Salary (RM)']
    ];
    for (const u of users) {
      roleRows.push([
        u.employee_no || '',
        u.name || '',
        u.role_name || '',
        u.status || '',
        u.direct_superior_name || '',
        u.indirect_superior_name || '',
        u.basic_salary !== null && u.basic_salary !== undefined ? Number(u.basic_salary) : 0
      ]);
    }

    // Sheet 4: Important Dates
    const datesRows = [
      [
        'Employee No.', 'Full Name', 'Join Date', 'Group Join Date', 'Confirmation Date',
        'Probation Period (months)', 'Last Working Date', 'Resignation Date', 'Rejoin Date', 'Deceased Date'
      ]
    ];
    for (const u of users) {
      datesRows.push([
        u.employee_no || '',
        u.name || '',
        u.join_date || '',
        u.group_join_date || '',
        u.confirmation_date || '',
        u.probation_period_months !== null && u.probation_period_months !== undefined ? Number(u.probation_period_months) : '',
        u.last_working_date || '',
        u.resignation_date || '',
        u.rejoin_date || '',
        u.deceased_date || ''
      ]);
    }

    // Sheet 5: Salary & Statutory
    const statutoryRows = [
      [
        'Employee No.', 'Full Name', 'EPF No.', 'SOCSO No.', 'Income Tax No. (TIN)',
        'EPF Voluntary Contribution %', 'SOCSO Category', 'Tax Exemption Category'
      ]
    ];
    for (const u of users) {
      statutoryRows.push([
        u.employee_no || '',
        u.name || '',
        u.epf_no || '',
        u.socso_no || '',
        u.income_tax_no || '',
        u.epf_voluntary_rate !== null && u.epf_voluntary_rate !== undefined ? Number(u.epf_voluntary_rate) : '',
        u.socso_category || '',
        u.tax_exemption_category || ''
      ]);
    }

    const sheets = [
      { name: 'Basic Information', rows: basicRows },
      { name: 'Employment Details', rows: employmentRows },
      { name: 'Role & Access', rows: roleRows },
      { name: 'Important Dates', rows: datesRows },
      { name: 'Salary & Statutory', rows: statutoryRows }
    ];

    // Additional Sheets for Custom Profile Tabs
    for (const ct of customTabs) {
      const headerRow = ['Employee No.', 'Full Name', ...ct.fields.map(f => f.label)];
      const customSheetRows = [headerRow];

      for (const u of users) {
        const userValuesMap = {};
        const valuesList = getUserCustomValues(u.id, ct.id);
        for (const v of valuesList) {
          userValuesMap[v.field_id] = v.field_value !== null && v.field_value !== undefined ? v.field_value : '';
        }

        const rowValues = [u.employee_no || '', u.name || ''];
        for (const field of ct.fields) {
          rowValues.push(userValuesMap[field.id] || '');
        }
        customSheetRows.push(rowValues);
      }

      sheets.push({ name: ct.label.slice(0, 31), rows: customSheetRows });
    }

    const buffer = buildXlsx(sheets);
    const filename = `Employee_Directory_Export_${todayISO()}.xlsx`;
    sendFile(ctx.res, 200, buffer, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });
};
