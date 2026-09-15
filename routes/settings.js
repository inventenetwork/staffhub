'use strict';
const db = require('../db');
const { redirect, sendHtml, parseBodyAuto } = require('../lib/util');
const { layout, card, escapeHtml } = require('../lib/render');
const { getAllSettings, setSetting, MODULES, getModuleStates, setModuleEnabled, checkHeadcountLimit } = require('../lib/settings');
const { hasAccess, isSuperAdmin, verifyPassword, parseCookies } = require('../lib/auth');
const { LIST_DEFS, listDef, isValidListKey, getListOptions, addListOption, renameListOption, deleteListOption } = require('../lib/lists');
const { TIERS, getAllRoles, addRole, updateRole, deleteRole } = require('../lib/roles');
const { logAudit, getAuditLogs } = require('../lib/audit');
const { applyLicenseKey } = require('../lib/license');

const SYSTEM_UNLOCK_WINDOW_MS = 15 * 60 * 1000;

function sessionToken(ctx) {
  const cookies = parseCookies(ctx.req);
  return cookies.hrms_session || cookies.session_token || null;
}

function isSystemUnlocked(ctx) {
  const token = sessionToken(ctx);
  if (!token) return false;
  const s = db.prepare('SELECT system_unlocked_at FROM sessions WHERE token = ?').get(token);
  if (!s || !s.system_unlocked_at) return false;
  const unlockedMs = new Date(s.system_unlocked_at.replace(' ', 'T') + 'Z').getTime();
  return (Date.now() - unlockedMs) < SYSTEM_UNLOCK_WINDOW_MS;
}

function requireSettingAccess(ctx) {
  if (!ctx.user) { redirect(ctx.res, '/login'); return false; }
  if (!hasAccess(ctx.user, ['admin', 'it'])) { redirect(ctx.res, '/?error=' + encodeURIComponent('Setting is restricted to Admin and IT roles.')); return false; }
  return true;
}

function requireHrAdmin(ctx) {
  if (!ctx.user) { redirect(ctx.res, '/login'); return false; }
  if (!hasAccess(ctx.user, ['admin'])) { redirect(ctx.res, '/settings?tab=email&error=' + encodeURIComponent('Section is restricted to Admin and Super Admin.')); return false; }
  return true;
}

function requireSuperAdmin(ctx) {
  if (!ctx.user) { redirect(ctx.res, '/login'); return false; }
  if (!isSuperAdmin(ctx.user)) { redirect(ctx.res, '/settings?error=' + encodeURIComponent('System Settings is restricted to the Super Admin.')); return false; }
  return true;
}

function requireSystemUnlocked(ctx) {
  if (!requireSuperAdmin(ctx)) return false;
  if (!isSystemUnlocked(ctx)) {
    redirect(ctx.res, '/settings?tab=system&error=' + encodeURIComponent('System Settings session expired. Re-enter password.'));
    return false;
  }
  return true;
}

const { getAllCustomTabs, getCustomTab, createCustomTab, deleteCustomTab, addCustomField, deleteCustomField } = require('../lib/custom_profile');

function renderProfileSettingTab(ctx) {
  const selectedKey = ctx.url.searchParams.get('list') || LIST_DEFS[0].key;
  const def = listDef(selectedKey) || LIST_DEFS[0];
  const options = getListOptions(def.key);

  const sidebarItems = LIST_DEFS.map((d) => {
    const isSelected = d.key === def.key;
    return `
      <a href="/settings?tab=hr&sub=employee&list=${d.key}" class="flex items-center justify-between px-3.5 py-2.5 rounded-xl text-xs font-medium transition ${isSelected ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}">
        <span>${escapeHtml(d.label)}</span>
        ${isSelected ? '<span class="text-indigo-600 dark:text-indigo-400">›</span>' : ''}
      </a>
    `;
  }).join('');

  return `
    <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-6">
      <div>
        <h2 class="font-bold text-base text-slate-800 dark:text-slate-100">Employee Module & Master Dropdown Options</h2>
        <p class="text-xs text-slate-400 mt-0.5">Configure employee numbering rules and manage master dropdown lists</p>
      </div>

      <!-- Top Settings Controls Cards -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Default Probation Period</label>
          <select class="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium">
            <option value="6">6 Months</option>
            <option value="3">3 Months</option>
            <option value="1">1 Month</option>
          </select>
        </div>

        <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Automatic Age Calculation</label>
          <select class="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-medium">
            <option value="enabled">Enabled (Derived from NRIC/DOB)</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>

      <hr class="border-slate-100 dark:border-slate-800" />

      <!-- Master Employee Dropdowns Section -->
      <div>
        <div class="text-xs font-bold uppercase tracking-wider text-slate-400 mb-4">
          Master Employee Dropdowns (Departments, Banks, Statuses)
        </div>

        <div class="grid grid-cols-1 md:grid-cols-4 gap-6">
          <!-- Sidebar Options List -->
          <div class="space-y-1">
            <div class="text-[11px] font-bold uppercase tracking-wider text-slate-400 px-2 mb-2">Employees Options</div>
            ${sidebarItems}
          </div>

          <!-- Options Configurator Main Content Area -->
          <div class="md:col-span-3 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 bg-slate-50/30 dark:bg-slate-800/20 space-y-4">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                  <span>🏢</span> ${escapeHtml(def.label)} Configurator
                </h3>
                <p class="text-[11px] text-slate-400 mt-0.5">Manage available options for forms & dropdown selects</p>
              </div>
              <span class="px-3 py-1 rounded-full text-xs font-bold bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                ${options.length} Configured
              </span>
            </div>

            <!-- Option Tiles Grid -->
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              ${options.map((o) => `
                <div class="flex items-center justify-between p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm text-xs font-semibold text-slate-800 dark:text-slate-200">
                  <span class="truncate">${escapeHtml(o.value)}</span>
                  <form method="post" action="/settings/lists/${def.key}/${o.id}/delete" onsubmit="return confirm('Delete option ${escapeHtml(o.value)}?');" class="inline">
                    <button class="text-slate-400 hover:text-red-500 font-bold ml-2">×</button>
                  </form>
                </div>
              `).join('') || '<p class="text-xs text-slate-400 italic col-span-full">No options configured yet.</p>'}
            </div>

            <!-- Add Option Form -->
            <form method="post" action="/settings/lists/${def.key}" class="flex items-center gap-2 pt-2">
              <input name="value" placeholder="+ Add new option..." required class="flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <button class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2 rounded-xl shadow-sm transition">
                + Add Option
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderListPage(ctx, key) {
  const def = listDef(key);
  const options = getListOptions(key);
  return `
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-2xl font-semibold">${escapeHtml(def.label)}</h1>
        <p class="text-slate-500 text-sm mt-1">Manage configurable dropdown options</p>
      </div>
      <a href="/settings" class="text-sm text-indigo-600 font-medium">← Back to settings</a>
    </div>
    ${card(`
      <form method="post" action="/settings/lists/${key}" class="flex gap-3 text-sm mb-6">
        <input name="value" placeholder="New option name" required class="flex-1 rounded-lg border border-slate-300 px-3 py-2"/>
        <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg px-4 py-2">Add option</button>
      </form>
      <div class="space-y-2 text-sm">
        ${options.map((o) => `
          <div class="flex items-center justify-between border-b border-slate-100 pb-2 last:border-0">
            <form method="post" action="/settings/lists/${key}/${o.id}" class="flex items-center gap-2 flex-1 mr-4">
              <input name="value" value="${escapeHtml(o.value)}" class="rounded border border-slate-300 px-2 py-1 text-sm flex-1 max-w-xs"/>
              <button class="text-xs text-slate-600 font-medium hover:underline">Save</button>
            </form>
            <form method="post" action="/settings/lists/${key}/${o.id}/delete" onsubmit="return confirm('Delete this option?');">
              <button class="text-xs text-red-600 font-medium hover:underline">Delete</button>
            </form>
          </div>
        `).join('') || `<p class="text-slate-400 py-4 text-center">No options added yet.</p>`}
      </div>
    `)}
  `;
}

function renderLeaveSettingTab(ctx) {
  const leaveTypes = db.prepare('SELECT * FROM leave_types ORDER BY name').all();
  const holidays = db.prepare('SELECT * FROM public_holidays ORDER BY holiday_date').all();

  return `
    <div class="grid lg:grid-cols-2 gap-6">
      ${card(`
        <h2 class="font-semibold mb-4">Leave Types</h2>
        <form method="post" action="/settings/leave-types" class="space-y-3 text-sm mb-6 pb-6 border-b border-slate-100">
          <input name="name" placeholder="Leave type name" required class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-slate-600 mb-1">Default days / year</label>
              <input name="default_days_per_year" type="number" step="0.5" value="14" required class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
            </div>
            <div class="flex items-center pt-6">
              <label class="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" name="requires_mc" value="1" class="rounded border-slate-300 text-indigo-600"/>
                <span class="text-slate-700 text-xs">Requires MC ref</span>
              </label>
            </div>
          </div>
          <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg py-2">Add Leave Type</button>
        </form>

        <div class="space-y-3 text-sm">
          ${leaveTypes.map((t) => `
            <form method="post" action="/settings/leave-types/${t.id}" class="grid grid-cols-3 gap-2 items-center border-b border-slate-100 pb-2">
              <input name="name" value="${escapeHtml(t.name)}" required class="rounded border border-slate-300 px-2 py-1 text-sm"/>
              <input name="default_days_per_year" type="number" step="0.5" value="${t.default_days_per_year}" required class="rounded border border-slate-300 px-2 py-1 text-sm"/>
              <div class="flex items-center justify-between">
                <label class="text-xs flex items-center gap-1"><input type="checkbox" name="requires_mc" value="1" ${t.requires_mc ? 'checked' : ''}/> MC</label>
                <button class="text-xs text-indigo-600 font-medium hover:underline">Update</button>
              </div>
            </form>
          `).join('')}
        </div>
      `)}

      ${card(`
        <h2 class="font-semibold mb-4">Public Holidays Calendar</h2>
        <form method="post" action="/settings/holidays" class="grid grid-cols-2 gap-3 text-sm mb-6 pb-6 border-b border-slate-100">
          <div>
            <label class="block text-slate-600 mb-1">Date</label>
            <input name="holiday_date" type="date" required class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
          </div>
          <div>
            <label class="block text-slate-600 mb-1">Holiday Name</label>
            <input name="name" placeholder="e.g. Merdeka Day" required class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
          </div>
          <div class="col-span-2">
            <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg py-2">Add Holiday</button>
          </div>
        </form>

        <div class="space-y-2 text-sm max-h-96 overflow-y-auto">
          ${holidays.map((h) => `
            <div class="flex items-center justify-between border-b border-slate-100 pb-2 last:border-0">
              <div>
                <span class="font-medium">${escapeHtml(h.name)}</span>
                <span class="text-xs text-slate-400 ml-2">${escapeHtml(h.holiday_date)}</span>
              </div>
              <form method="post" action="/settings/holidays/${h.id}/delete">
                <button class="text-xs text-red-600 font-medium hover:underline">Remove</button>
              </form>
            </div>
          `).join('') || `<p class="text-slate-400 py-4 text-center">No public holidays added yet.</p>`}
        </div>
      `)}
    </div>
  `;
}

function renderEmailSettingTab(ctx) {
  const s = getAllSettings();
  return card(`
    <h2 class="font-semibold mb-1">Server Setting: Email Server</h2>
    <p class="text-xs text-slate-400 mb-4">Configure SMTP email server settings for system notifications. Accessible to Admin and IT roles.</p>
    <form method="post" action="/settings/email" class="space-y-4 text-sm max-w-lg">
      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-2">
          <label class="block text-slate-600 mb-1">SMTP Host</label>
          <input name="smtp_host" value="${escapeHtml(s.smtp_host || '')}" placeholder="smtp.company.com" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
        </div>
        <div>
          <label class="block text-slate-600 mb-1">Port</label>
          <input name="smtp_port" type="number" value="${escapeHtml(s.smtp_port || '587')}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-slate-600 mb-1">Security</label>
          <select name="smtp_security" class="w-full rounded-lg border border-slate-300 px-3 py-2">
            <option value="tls" ${(s.smtp_security || 'tls') === 'tls' ? 'selected' : ''}>STARTTLS / TLS</option>
            <option value="ssl" ${s.smtp_security === 'ssl' ? 'selected' : ''}>SSL</option>
            <option value="none" ${s.smtp_security === 'none' ? 'selected' : ''}>None</option>
          </select>
        </div>
        <div>
          <label class="block text-slate-600 mb-1">SMTP Username</label>
          <input name="smtp_username" value="${escapeHtml(s.smtp_username || '')}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
        </div>
      </div>
      <div>
        <label class="block text-slate-600 mb-1">SMTP Password</label>
        <input name="smtp_password" type="password" value="${escapeHtml(s.smtp_password || '')}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="block text-slate-600 mb-1">Sender Email</label>
          <input name="smtp_sender_email" type="email" value="${escapeHtml(s.smtp_sender_email || 'noreply@staffhub.my')}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
        </div>
        <div>
          <label class="block text-slate-600 mb-1">Sender Name</label>
          <input name="smtp_sender_name" value="${escapeHtml(s.smtp_sender_name || 'StaffHub HRMS')}" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
        </div>
      </div>
      <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg px-4 py-2 text-sm">Save Email Server Settings</button>
    </form>
  `);
}

function renderAuditTab(ctx) {
  const logs = getAuditLogs(100);
  return card(`
    <h2 class="font-semibold mb-1">System Audit Trail</h2>
    <p class="text-xs text-slate-400 mb-4">Chronological record of system operations, profile changes, leave requests, and setting updates.</p>
    <div class="overflow-x-auto">
      <table class="data-table w-full text-sm">
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>User</th>
            <th>Action</th>
            <th>Details</th>
            <th>IP Address</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((l) => `
            <tr>
              <td class="whitespace-nowrap text-slate-500 text-xs">${escapeHtml(l.created_at)}</td>
              <td class="font-medium">${escapeHtml(l.user_name ? `${l.user_name} (${l.user_email})` : 'System / Guest')}</td>
              <td><span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-50 text-indigo-700 border border-indigo-100">${escapeHtml(l.action)}</span></td>
              <td class="max-w-md truncate text-xs text-slate-600" title="${escapeHtml(l.details || '')}">${escapeHtml(l.details || '—')}</td>
              <td class="text-slate-400 text-xs">${escapeHtml(l.ip_address || '—')}</td>
            </tr>
          `).join('') || `<tr><td colspan="5" class="text-center text-slate-400 py-6">No audit records found.</td></tr>`}
        </tbody>
      </table>
    </div>
  `);
}

function renderClaimSettingTab(ctx) {
  const s = getAllSettings();
  return `
    <div class="space-y-6">
      <div>
        <div class="mb-4">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">Claim Setting & Company Policy Defaults</h2>
          <p class="text-xs text-slate-400">Configure company branding parameters, travel mileage rates, attendance cutoff, and medical claim limits.</p>
        </div>
        <form method="post" action="/settings/system">
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between">
              <div>
                <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Company Name</label>
                <input name="company_name" value="${escapeHtml(s.company_name || 'StaffHub HRMS')}" required class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
              </div>
              <span class="text-[11px] text-slate-400 mt-2">Appears on reports & payslips</span>
            </div>

            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between">
              <div>
                <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Mileage Rate (RM / km)</label>
                <input name="mileage_rate" type="number" step="0.01" value="${s.mileage_rate || '0.80'}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
              </div>
              <span class="text-[11px] text-slate-400 mt-2">Travel claim calculation rate</span>
            </div>

            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between">
              <div>
                <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Late Cutoff Time</label>
                <input name="late_cutoff" type="time" value="${escapeHtml(s.late_cutoff || '09:15')}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
              </div>
              <span class="text-[11px] text-slate-400 mt-2">Attendance late threshold</span>
            </div>

            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between">
              <div>
                <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Default Outpatient Limit (RM)</label>
                <input name="default_outpatient_limit" type="number" value="${s.default_outpatient_limit || '1000'}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
              </div>
              <span class="text-[11px] text-slate-400 mt-2">Annual limit per employee</span>
            </div>

            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between">
              <div>
                <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Default Dental Limit (RM)</label>
                <input name="default_dental_limit" type="number" value="${s.default_dental_limit || '500'}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
              </div>
              <span class="text-[11px] text-slate-400 mt-2">Annual limit per employee</span>
            </div>

            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between">
              <div>
                <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Default Optical Limit (RM)</label>
                <input name="default_optical_limit" type="number" value="${s.default_optical_limit || '300'}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
              </div>
              <span class="text-[11px] text-slate-400 mt-2">Annual limit per employee</span>
            </div>

            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between">
              <div>
                <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5">Default Hospitalization Limit (RM)</label>
                <input name="default_hospitalization_limit" type="number" value="${s.default_hospitalization_limit || '5000'}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
              </div>
              <span class="text-[11px] text-slate-400 mt-2">Annual limit per employee</span>
            </div>
          </div>
          <div class="flex justify-end">
            <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl px-5 py-2.5 text-sm shadow-sm transition-all">Save Claim & Policy Settings</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderTamsSettingTab(ctx) {
  const s = getAllSettings();
  return card(`
    <div class="mb-4">
      <h2 class="font-semibold text-lg text-slate-900 dark:text-slate-100">TAMS (Time & Attendance) Setting & Overtime (OT) Formula</h2>
      <p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Configure Attendance cutoff rules and company-specific Overtime (OT) calculation formulas for Normal Work Days, Rest Days, and Public Holidays.</p>
    </div>
    <form method="post" action="/settings/tams" class="space-y-6 text-sm">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Late Arrival Cutoff Time</label>
          <input name="late_cutoff" type="time" value="${escapeHtml(s.late_cutoff || '09:15')}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm"/>
          <p class="text-xs text-slate-400 mt-1">Clock-ins after this time will be marked as "Late".</p>
        </div>
        <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Standard Work Hours / Month Basis</label>
          <input name="ot_monthly_hours_basis" type="number" step="1" value="${escapeHtml(s.ot_monthly_hours_basis || '104')}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm"/>
          <p class="text-xs text-slate-400 mt-1">Standard divisor for hourly ORP (e.g. 26 days x 8 hrs = 208 hrs or 104 hrs for Ordinary Rate of Pay).</p>
        </div>
      </div>

      <div class="border-t border-slate-200 dark:border-slate-700 pt-5">
        <h3 class="font-semibold text-sm text-slate-800 dark:text-slate-200 mb-3 flex items-center gap-2">
          ⚡ Overtime (OT) Multiplier Rates & Formula Preset
        </h3>
        
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
          <div class="bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl p-4">
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Normal Day OT Rate Multiplier</label>
            <input name="ot_rate_normal" type="number" step="0.1" value="${escapeHtml(s.ot_rate_normal || '1.5')}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm font-semibold"/>
            <span class="text-[11px] text-slate-500 mt-1 block">Standard Statutory: 1.5x Hourly Rate</span>
          </div>

          <div class="bg-amber-50/50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-900/40 rounded-xl p-4">
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Rest Day OT Rate Multiplier</label>
            <input name="ot_rate_restday" type="number" step="0.1" value="${escapeHtml(s.ot_rate_restday || '2.0')}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm font-semibold"/>
            <span class="text-[11px] text-slate-500 mt-1 block">Standard Statutory: 2.0x Hourly Rate</span>
          </div>

          <div class="bg-emerald-50/50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900/40 rounded-xl p-4">
            <label class="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Public Holiday OT Rate Multiplier</label>
            <input name="ot_rate_public_holiday" type="number" step="0.1" value="${escapeHtml(s.ot_rate_public_holiday || '3.0')}" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 px-3 py-2 text-sm font-semibold"/>
            <span class="text-[11px] text-slate-500 mt-1 block">Standard Statutory: 3.0x Hourly Rate</span>
          </div>
        </div>

        <div>
          <label class="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1">Custom Overtime (OT) Formula Expression</label>
          <textarea name="ot_custom_formula" rows="3" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 p-3 font-mono text-xs" placeholder="e.g. (BASIC_SALARY / 26 / 8) * OT_HOURS * OT_RATE">${escapeHtml(s.ot_custom_formula || '(BASIC_SALARY / 26 / 8) * OT_HOURS * OT_RATE')}</textarea>
          <div class="mt-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 p-3 rounded-lg">
            <div class="font-semibold mb-1 text-slate-700 dark:text-slate-200">Available Variables for Custom OT Formula:</div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
              <div><code>BASIC_SALARY</code> : Monthly basic salary</div>
              <div><code>OT_HOURS</code> : Total OT hours claimed</div>
              <div><code>OT_RATE</code> : Multiplier (1.5x / 2.0x / 3.0x)</div>
              <div><code>ALLOWANCES</code> : Fixed monthly allowances</div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex justify-end">
        <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl px-5 py-2.5 text-sm shadow-sm transition-all flex items-center gap-2">
          💾 Save TAMS & OT Settings
        </button>
      </div>
    </form>
  `);
}

function renderHRSettingTab(ctx) {
  const roles = getAllRoles();
  const profileSection = renderProfileSettingTab(ctx);
  return `
    <div class="space-y-10">
      <div>
        ${profileSection}
      </div>

      <hr class="border-slate-200 dark:border-slate-700" />

      <div>
        <div class="mb-4">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">HR Setting & Role Management</h2>
          <p class="text-xs text-slate-400">Manage system and custom roles mapped to permission constituencies.</p>
        </div>

        <div class="bg-white dark:bg-slate-800/80 rounded-xl p-5 border border-slate-200/80 dark:border-slate-700/80 shadow-sm mb-6">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Add New Custom Role</h3>
          <form method="post" action="/settings/roles" class="flex flex-wrap gap-3 items-end">
            <div class="flex-1 min-w-[200px]">
              <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Role Name</label>
              <input name="name" placeholder="e.g. Team Lead" required class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
            </div>
            <div class="w-48">
              <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Permission Tier</label>
              <select name="permission_tier" required class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm focus:bg-white dark:focus:bg-slate-900 transition-colors">
                <option value="ess">ESS (Employee)</option>
                <option value="admin">Admin</option>
                <option value="super_admin">Super Admin</option>
                <option value="it">IT</option>
                <option value="manager">Manager</option>
                <option value="hiring_manager">Hiring Manager</option>
              </select>
            </div>
            <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg px-4 py-2 text-sm h-[38px] transition-colors">+ Add Role</button>
          </form>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          ${roles.map((r) => `
            <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border border-slate-200/80 dark:border-slate-700/80 shadow-sm flex flex-col justify-between gap-3">
              <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-700/50 pb-2.5">
                <div class="font-medium text-slate-800 dark:text-slate-200 text-sm truncate pr-2">${escapeHtml(r.name)}</div>
                ${r.is_system
                  ? `<span class="inline-flex items-center text-[11px] bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 px-2 py-0.5 rounded-full font-medium shrink-0">System</span>`
                  : `<span class="inline-flex items-center text-[11px] bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded-full font-medium shrink-0">Custom</span>`}
              </div>
              <form method="post" action="/settings/roles/${r.id}" id="role-tile-form-${r.id}" class="space-y-3">
                <div>
                  <label class="block text-[11px] font-medium text-slate-400 mb-1">Display Name</label>
                  <input name="name" value="${escapeHtml(r.name)}" required
                    class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-2.5 py-1.5 text-xs"/>
                </div>
                <div>
                  <label class="block text-[11px] font-medium text-slate-400 mb-1">Permission Tier</label>
                  <select name="permission_tier" class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-2.5 py-1.5 text-xs">
                    <option value="ess"           ${r.permission_tier==='ess'?'selected':''}>ESS (Employee)</option>
                    <option value="admin"         ${r.permission_tier==='admin'?'selected':''}>Admin</option>
                    <option value="super_admin"   ${r.permission_tier==='super_admin'?'selected':''}>Super Admin</option>
                    <option value="it"            ${r.permission_tier==='it'?'selected':''}>IT</option>
                    <option value="manager"       ${r.permission_tier==='manager'?'selected':''}>Manager</option>
                    <option value="hiring_manager"${r.permission_tier==='hiring_manager'?'selected':''}>Hiring Manager</option>
                  </select>
                </div>
              </form>
              <div class="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-700/50">
                ${r.is_system
                  ? `<span class="text-xs text-slate-300 dark:text-slate-600 select-none" title="System roles cannot be deleted">Delete</span>`
                  : `<form method="post" action="/settings/roles/${r.id}/delete" onsubmit="return confirm('Delete role \\'${escapeHtml(r.name)}\\'?');" class="inline">
                       <button type="submit" class="text-xs font-medium text-red-500 hover:text-red-700 hover:underline">Delete</button>
                      </form>`}
                <button form="role-tile-form-${r.id}" type="submit" class="text-xs font-medium bg-slate-100 hover:bg-slate-200 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 px-3 py-1 rounded-lg transition-colors">
                  Save Changes
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderLicenseTab(ctx) {
  const modules = getModuleStates();
  const s = getAllSettings();
  const limitInfo = checkHeadcountLimit();
  const maxLimit = s.max_headcount_limit || '0';
  const activeKey = s.active_license_key || '';
  const activeCompany = s.active_license_company || '';
  const activeApplied = s.active_license_applied_at || '';

  return `
    <div class="space-y-8">
      <!-- Section 1: License Key Activation -->
      <div>
        <div class="mb-4">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">Activate License Key / Add-on</h2>
          <p class="text-xs text-slate-400">Enter a signed activation key provided by your project consultant or Central Portal to unlock modules and headcount capacity.</p>
        </div>
        <div class="bg-white dark:bg-slate-800/80 rounded-xl p-5 border border-slate-200/80 dark:border-slate-700/80 shadow-sm max-w-xl">
          <form method="post" action="/settings/license/apply" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Paste License Key</label>
              <textarea name="license_key" rows="3" required placeholder="Paste encrypted base64 license key here..."
                class="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-xs font-mono focus:bg-white dark:focus:bg-slate-900 transition-colors"></textarea>
            </div>
            <div class="flex items-center justify-between pt-1">
              <span class="text-[11px] text-slate-400">
                ${activeApplied ? `Active: <strong class="text-slate-600 dark:text-slate-300">${escapeHtml(activeCompany)}</strong> (${new Date(activeApplied).toLocaleDateString()})` : 'No custom key applied yet.'}
              </span>
              <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg px-4 py-2 text-xs shadow-sm transition-all flex items-center gap-1.5">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 0121 9z"></path></svg>
                Apply License Key
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- Section 2: Headcount Capacity Licensing -->
      <div>
        <div class="mb-4">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">Headcount Capacity License</h2>
          <p class="text-xs text-slate-400">Control the maximum allowed active employee seats. Set to 0 for unlimited seats.</p>
        </div>
        <form method="post" action="/settings/system">
          <div class="bg-white dark:bg-slate-800/80 rounded-xl p-5 border border-slate-200/80 dark:border-slate-700/80 shadow-sm max-w-xl">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
              <div>
                <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">Max Active Employee Seats</label>
                <div class="flex items-center gap-2">
                  <input name="max_headcount_limit" type="number" min="0" value="${escapeHtml(maxLimit)}" required class="w-36 rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 dark:text-slate-100 px-3 py-2 text-sm font-semibold focus:bg-white dark:focus:bg-slate-900 transition-colors"/>
                  <span class="text-xs text-slate-500 font-medium">(0 = Unlimited)</span>
                </div>
              </div>
              <div class="bg-slate-50 dark:bg-slate-900/60 p-3 rounded-lg border border-slate-200/60 dark:border-slate-700/60 text-right shrink-0">
                <div class="text-[11px] text-slate-400 font-medium uppercase tracking-wider">Live Usage</div>
                <div class="text-base font-bold text-slate-800 dark:text-slate-100">
                  ${limitInfo.currentActive} <span class="text-xs font-normal text-slate-500">/ ${limitInfo.limit > 0 ? limitInfo.limit : '∞'} Seats</span>
                </div>
              </div>
            </div>
            <div class="flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-700/50">
              <span class="text-xs ${limitInfo.limit > 0 && limitInfo.currentActive >= limitInfo.limit ? 'text-amber-600 dark:text-amber-400 font-semibold' : 'text-slate-400'}">
                ${limitInfo.limit > 0 && limitInfo.currentActive >= limitInfo.limit ? '⚠️ Capacity limit reached!' : 'Employee creation quota enforced'}
              </span>
              <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg px-4 py-2 text-xs shadow-sm transition-all">Save Headcount Limit</button>
            </div>
          </div>
        </form>
      </div>

      <!-- Section 2: Module Subscriptions -->
      <div>
        <div class="mb-4">
          <h2 class="text-base font-semibold text-slate-800 dark:text-slate-100">Module Licenses & Subscriptions</h2>
          <p class="text-xs text-slate-400">Exclusive Super Admin control to enable or disable customer purchased modules organization-wide.</p>
        </div>
        <form method="post" action="/settings/system/modules">
          <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 mb-4">
            ${MODULES.map((m) => {
              const isEnabled = !!modules[m.key];
              return `
              <div class="bg-white dark:bg-slate-800/80 rounded-xl p-4 border ${isEnabled ? 'border-indigo-200 dark:border-indigo-900/50 bg-indigo-50/20 dark:bg-indigo-950/10' : 'border-slate-200/80 dark:border-slate-700/80'} shadow-sm flex flex-col justify-between gap-3 transition-all hover:border-indigo-300 dark:hover:border-indigo-700">
                <div class="flex items-center justify-between">
                  <span class="font-semibold text-sm text-slate-800 dark:text-slate-100 pr-2">${escapeHtml(m.label)}</span>
                  <label class="relative inline-flex items-center cursor-pointer shrink-0">
                    <input type="checkbox" name="module_${m.key}" value="1" ${isEnabled ? 'checked' : ''} class="sr-only peer">
                    <div class="w-11 h-6 bg-slate-200 dark:bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                  </label>
                </div>
                <div class="flex items-center justify-between text-xs pt-1 border-t border-slate-100 dark:border-slate-700/40">
                  <span class="text-slate-400 font-normal">License Status</span>
                  ${isEnabled 
                    ? `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400 border border-emerald-200/60 dark:border-emerald-800/60">● Licensed</span>`
                    : `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 border border-slate-200 dark:border-slate-700">Not Subscribed</span>`
                  }
                </div>
              </div>
            `;
            }).join('')}
          </div>
          <div class="flex justify-end">
            <button class="bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl px-5 py-2.5 text-sm shadow-sm transition-all flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>
              Save Module Licenses
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

module.exports = function (router) {
  router.get('/settings', async (ctx) => {
    if (!requireSettingAccess(ctx)) return;
    const userIsSuperAdmin = isSuperAdmin(ctx.user);
    const userIsAdmin = hasAccess(ctx.user, ['admin']);

    // Top-level Tiers: hr, preferences, security, modules
    const topTab = ctx.url.searchParams.get('tab') || 'hr';
    // Sub-modules for HR System Settings: employee (1), leave (2), payroll (3), tams (4), company (5)
    const subTab = ctx.url.searchParams.get('sub') || 'employee';

    if (topTab === 'modules' && !userIsSuperAdmin) {
      return redirect(ctx.res, '/settings?tab=hr&error=' + encodeURIComponent('Module Subscriptions are restricted to SaaS Vendor / Super Admin.'));
    }

    // Render Top Navigation Bar (4 Main Tiers)
    const topNav = `
      <div class="flex items-center gap-6 border-b border-slate-200 dark:border-slate-800 pb-3 mb-6 overflow-x-auto text-sm font-medium">
        <a href="/settings?tab=hr&sub=${subTab}" class="pb-2 -mb-3 border-b-2 ${topTab === 'hr' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}">
          HR System Settings (Head of HR & Admin)
        </a>
        <a href="/settings?tab=preferences" class="pb-2 -mb-3 border-b-2 ${topTab === 'preferences' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}">
          System Preferences (All Users)
        </a>
        <a href="/settings?tab=security" class="pb-2 -mb-3 border-b-2 ${topTab === 'security' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}">
          Security Settings (RBAC)
        </a>
        ${userIsSuperAdmin ? `
        <a href="/settings?tab=modules" class="pb-2 -mb-3 border-b-2 ${topTab === 'modules' ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400'}">
          Module Subscriptions (SaaS Vendor Staff Only)
        </a>` : ''}
      </div>
    `;

    let bodyContent = '';

    if (topTab === 'hr') {
      // 5 Numbered Sub-Modules Bar inside a pill container matching Mockup 1
      const subNav = `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-2 mb-6 shadow-sm flex flex-wrap items-center gap-1.5 text-xs font-medium">
          <a href="/settings?tab=hr&sub=employee" class="px-4 py-2 rounded-xl flex items-center gap-2 transition ${subTab === 'employee' ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}">
            1. Employee Module
          </a>
          <a href="/settings?tab=hr&sub=leave" class="px-4 py-2 rounded-xl flex items-center gap-2 transition ${subTab === 'leave' ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}">
            2. Leave Module
          </a>
          <a href="/settings?tab=hr&sub=payroll" class="px-4 py-2 rounded-xl flex items-center gap-2 transition ${subTab === 'payroll' ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}">
            3. Payroll & Statutory
          </a>
          <a href="/settings?tab=hr&sub=tams" class="px-4 py-2 rounded-xl flex items-center gap-2 transition ${subTab === 'tams' ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}">
            4. Attendance & Claims
          </a>
          <a href="/settings?tab=hr&sub=company" class="px-4 py-2 rounded-xl flex items-center gap-2 transition ${subTab === 'company' ? 'bg-indigo-600 text-white font-semibold shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}">
            5. Company Profile
          </a>
        </div>
      `;

      let subContent = '';
      if (subTab === 'employee') {
        subContent = renderProfileSettingTab(ctx);
      } else if (subTab === 'leave') {
        subContent = renderLeaveSettingTab(ctx);
      } else if (subTab === 'payroll') {
        subContent = renderHRSettingTab(ctx);
      } else if (subTab === 'tams') {
        subContent = renderTamsSettingTab(ctx);
      } else if (subTab === 'company') {
        subContent = renderClaimSettingTab(ctx);
      } else {
        subContent = renderProfileSettingTab(ctx);
      }

      bodyContent = subNav + subContent;

    } else if (topTab === 'preferences') {
      // Mockup 2: System Preferences (All Users)
      bodyContent = `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-6">
          <!-- Internationalization & Language -->
          <div>
            <h3 class="text-sm font-bold text-slate-800 dark:text-slate-100 mb-3">
              Internationalization & Language
            </h3>
            <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Preferred System Language</label>
            <div class="inline-flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl border border-slate-200 dark:border-slate-700">
              <button onclick="window.setHrmsLang('EN')" class="px-5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white shadow-sm transition">
                English (EN)
              </button>
              <button onclick="window.setHrmsLang('BM')" class="px-5 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 transition">
                Bahasa Malaysia (BM)
              </button>
            </div>
          </div>

          <hr class="border-slate-100 dark:border-slate-800" />

          <!-- Notification Center -->
          <div>
            <h3 class="text-sm font-bold text-slate-800 dark:text-slate-100 mb-3">
              Notification Center
            </h3>
            <div class="space-y-3 max-w-lg">
              <div class="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
                <div>
                  <div class="text-xs font-semibold text-slate-800 dark:text-slate-200">Email Notifications</div>
                  <div class="text-[11px] text-slate-400">Receive approval status alerts and payslips via email</div>
                </div>
                <input type="checkbox" checked class="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" />
              </div>
              <div class="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
                <div>
                  <div class="text-xs font-semibold text-slate-800 dark:text-slate-200">Push Alerts</div>
                  <div class="text-[11px] text-slate-400">Real-time alerts for clock-ins and announcements</div>
                </div>
                <input type="checkbox" class="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" />
              </div>
            </div>
          </div>

          <hr class="border-slate-100 dark:border-slate-800" />

          <!-- Display Theme & Email Server Setting -->
          <div>
            <h3 class="text-sm font-bold text-slate-800 dark:text-slate-100 mb-3">
              Display Theme
            </h3>
            <div class="inline-flex gap-3">
              <button onclick="window.toggleHrmsTheme()" class="px-4 py-2 rounded-xl text-xs font-medium border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50 transition flex items-center gap-2">
                Executive Dark Mode
              </button>
              <button onclick="window.toggleHrmsTheme()" class="px-4 py-2 rounded-xl text-xs font-semibold border-2 border-indigo-600 bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300 transition flex items-center gap-2">
                Crisp Light Mode
              </button>
            </div>
          </div>

          <hr class="border-slate-100 dark:border-slate-800" />

          <!-- Server Setting: Email Server -->
          <div>
            ${renderEmailSettingTab(ctx)}
          </div>
        </div>
      `;

    } else if (topTab === 'security') {
      // Mockup 3: Security Settings (RBAC)
      bodyContent = `
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-sm space-y-6">
          <div>
            <h3 class="text-sm font-bold text-slate-800 dark:text-slate-100 mb-4">
              Credential Policies & Security Control (Admin View)
            </h3>
            <div class="space-y-3 max-w-lg mb-4">
              <div class="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
                <div>
                  <div class="text-xs font-semibold text-slate-800 dark:text-slate-200">Two-Factor Authentication (2FA)</div>
                  <div class="text-[11px] text-slate-400">Require authenticator codes alongside login credentials</div>
                </div>
                <input type="checkbox" class="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" />
              </div>
              <div class="flex items-center justify-between p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-800/40">
                <div>
                  <div class="text-xs font-semibold text-slate-800 dark:text-slate-200">Self-Service Password Reset</div>
                  <div class="text-[11px] text-slate-400">Allow Employees and Managers to initiate password resets</div>
                </div>
                <input type="checkbox" checked class="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" />
              </div>
            </div>

            <div class="max-w-xs">
              <label class="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Session Inactivity Timeout</label>
              <select class="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-3 py-2 text-xs font-medium">
                <option value="30">30 Minutes</option>
                <option value="60">60 Minutes</option>
                <option value="120">2 Hours</option>
              </select>
            </div>
          </div>

          <hr class="border-slate-100 dark:border-slate-800" />

          <div>
            ${renderAuditTab(ctx)}
          </div>
        </div>
      `;

    } else if (topTab === 'modules') {
      // Mockup 4: Module Subscriptions (SaaS Vendor Staff Only) with Master Security Gate
      const isUnlocked = isSystemUnlocked(ctx);
      if (!isUnlocked) {
        bodyContent = `
          <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-12 shadow-sm flex flex-col items-center justify-center">
            <div class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl p-8 max-w-md w-full shadow-lg text-center">
              <div class="w-12 h-12 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 flex items-center justify-center text-xl mx-auto mb-4 border border-indigo-200 dark:border-indigo-800">
                🔒
              </div>
              <h3 class="text-base font-bold text-slate-800 dark:text-slate-100 mb-1">SaaS Master Security Gate</h3>
              <p class="text-xs text-slate-500 dark:text-slate-400 mb-6 leading-relaxed">
                Module Subscription and SaaS Feature Gating is protected by vendor access control. Please enter the master password to unlock.
              </p>
              <form method="post" action="/settings/system/unlock" class="space-y-4">
                <input type="hidden" name="redirect_tab" value="modules" />
                <div>
                  <label class="block text-[11px] font-bold uppercase tracking-wider text-slate-400 text-left mb-1">Vendor Master Password</label>
                  <input name="password" type="password" required autofocus placeholder="Enter SaaS Vendor Password..." class="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-3 py-2.5 text-xs text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                </div>
                <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl py-2.5 text-xs shadow-sm transition flex items-center justify-center gap-2">
                  <span>🛡️</span> Unlock Subscription Manager
                </button>
              </form>
            </div>
          </div>
        `;
      } else {
        bodyContent = renderLicenseTab(ctx);
      }
    }

    const body = `
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-slate-800 dark:text-slate-100">Settings</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">Manage module configurations, company rules, user preferences, and security policies</p>
      </div>
      ${topNav}
      ${bodyContent}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Settings', user: ctx.user, activePath: '/settings', url: ctx.url, body }));
  });

  router.post('/settings/system/unlock', async (ctx) => {
    if (!requireSuperAdmin(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!row || !verifyPassword(b.password || '', row.password_hash)) {
      return redirect(ctx.res, '/settings?tab=system&error=' + encodeURIComponent('Incorrect password.'));
    }
    const token = sessionToken(ctx);
    db.prepare(`UPDATE sessions SET system_unlocked_at = datetime('now') WHERE token = ?`).run(token);
    logAudit(ctx.user.id, 'unlock_system_settings', {});
    redirect(ctx.res, '/settings?tab=system&ok=' + encodeURIComponent('System Settings unlocked.'));
  });

  router.post('/settings/tams', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    
    if (b.late_cutoff && /^\d{2}:\d{2}$/.test(b.late_cutoff)) {
      setSetting('late_cutoff', b.late_cutoff);
    }
    setSetting('ot_monthly_hours_basis', Math.max(1, parseInt(b.ot_monthly_hours_basis, 10) || 104).toString());
    setSetting('ot_rate_normal', Math.max(1.0, parseFloat(b.ot_rate_normal) || 1.5).toString());
    setSetting('ot_rate_restday', Math.max(1.0, parseFloat(b.ot_rate_restday) || 2.0).toString());
    setSetting('ot_rate_public_holiday', Math.max(1.0, parseFloat(b.ot_rate_public_holiday) || 3.0).toString());
    if (b.ot_custom_formula) {
      setSetting('ot_custom_formula', b.ot_custom_formula.trim());
    }

    logAudit(ctx.user.id, 'update_tams_settings', { ot_custom_formula: b.ot_custom_formula });
    redirect(ctx.res, '/settings?tab=tams&ok=' + encodeURIComponent('TAMS & Overtime (OT) settings updated successfully.'));
  });

  router.post('/settings/system', async (ctx) => {
    if (!requireSystemUnlocked(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    if (!b.company_name) return redirect(ctx.res, '/settings?tab=system&error=' + encodeURIComponent('Company name is required.'));

    setSetting('company_name', b.company_name);
    setSetting('mileage_rate', Math.max(0, parseFloat(b.mileage_rate) || 0));
    setSetting('late_cutoff', /^\d{2}:\d{2}$/.test(b.late_cutoff || '') ? b.late_cutoff : '09:15');
    setSetting('default_outpatient_limit', Math.max(0, parseFloat(b.default_outpatient_limit) || 0));
    setSetting('default_dental_limit', Math.max(0, parseFloat(b.default_dental_limit) || 0));
    setSetting('default_optical_limit', Math.max(0, parseFloat(b.default_optical_limit) || 0));
    setSetting('default_hospitalization_limit', Math.max(0, parseFloat(b.default_hospitalization_limit) || 0));

    logAudit(ctx.user.id, 'update_system_defaults', { company_name: b.company_name });
    redirect(ctx.res, '/settings?tab=system&ok=' + encodeURIComponent('Settings updated.'));
  });

  router.post('/settings/system/modules', async (ctx) => {
    if (!requireSystemUnlocked(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    MODULES.forEach((m) => setModuleEnabled(m.key, b[`module_${m.key}`] === '1'));
    logAudit(ctx.user.id, 'update_modules', {});
    redirect(ctx.res, '/settings?tab=license&ok=' + encodeURIComponent('Modules updated.'));
  });

  router.post('/settings/license/apply', async (ctx) => {
    if (!requireSystemUnlocked(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    if (!b.license_key) return redirect(ctx.res, '/settings?tab=license&error=' + encodeURIComponent('License key is required.'));

    const result = applyLicenseKey(b.license_key);
    if (!result.success) {
      return redirect(ctx.res, '/settings?tab=license&error=' + encodeURIComponent(result.error));
    }

    logAudit(ctx.user.id, 'apply_license_key', result.details || {});
    redirect(ctx.res, '/settings?tab=license&ok=' + encodeURIComponent(result.message));
  });

  router.post('/settings/leave-types', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    if (!b.name) return redirect(ctx.res, '/settings?tab=leave&error=' + encodeURIComponent('Leave type name is required.'));
    const existing = db.prepare('SELECT id FROM leave_types WHERE name = ?').get(b.name);
    if (existing) return redirect(ctx.res, '/settings?tab=leave&error=' + encodeURIComponent('A leave type with this name already exists.'));

    db.prepare('INSERT INTO leave_types (name, default_days_per_year, requires_mc) VALUES (?, ?, ?)')
      .run(b.name, Math.max(0, parseFloat(b.default_days_per_year) || 0), b.requires_mc === '1' ? 1 : 0);

    logAudit(ctx.user.id, 'add_leave_type', { name: b.name });
    redirect(ctx.res, '/settings?tab=leave&ok=' + encodeURIComponent('Leave type added.'));
  });

  router.post('/settings/leave-types/:id', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const id = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    if (!b.name) return redirect(ctx.res, '/settings?tab=leave&error=' + encodeURIComponent('Leave type name is required.'));

    db.prepare('UPDATE leave_types SET name = ?, default_days_per_year = ?, requires_mc = ? WHERE id = ?')
      .run(b.name, Math.max(0, parseFloat(b.default_days_per_year) || 0), b.requires_mc === '1' ? 1 : 0, id);

    logAudit(ctx.user.id, 'update_leave_type', { leave_type_id: id, name: b.name });
    redirect(ctx.res, '/settings?tab=leave&ok=' + encodeURIComponent('Leave type updated.'));
  });

  router.post('/settings/holidays', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    if (!b.holiday_date || !b.name) return redirect(ctx.res, '/settings?tab=leave&error=' + encodeURIComponent('Please provide both a date and a name.'));
    const existing = db.prepare('SELECT id FROM public_holidays WHERE holiday_date = ?').get(b.holiday_date);
    if (existing) return redirect(ctx.res, '/settings?tab=leave&error=' + encodeURIComponent('A holiday is already set for that date.'));

    db.prepare('INSERT INTO public_holidays (holiday_date, name) VALUES (?, ?)').run(b.holiday_date, b.name);
    logAudit(ctx.user.id, 'add_public_holiday', { date: b.holiday_date, name: b.name });
    redirect(ctx.res, '/settings?tab=leave&ok=' + encodeURIComponent('Public holiday added.'));
  });

  router.post('/settings/holidays/:id/delete', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const id = Number(ctx.params.id);
    db.prepare('DELETE FROM public_holidays WHERE id = ?').run(id);
    logAudit(ctx.user.id, 'delete_public_holiday', { holiday_id: id });
    redirect(ctx.res, '/settings?tab=leave&ok=' + encodeURIComponent('Public holiday removed.'));
  });

  // ---------------- Dropdown lists (Employee Profile Setting) ----------------

  router.get('/settings/lists/:key', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const key = ctx.params.key;
    if (!isValidListKey(key)) return redirect(ctx.res, '/settings?error=' + encodeURIComponent('Unknown dropdown list.'));
    const body = renderListPage(ctx, key);
    sendHtml(ctx.res, 200, layout({ title: listDef(key).label, user: ctx.user, activePath: '/settings', url: ctx.url, body }));
  });

  router.post('/settings/lists/:key', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const key = ctx.params.key;
    if (!isValidListKey(key)) return redirect(ctx.res, '/settings?error=' + encodeURIComponent('Unknown dropdown list.'));
    const b = await parseBodyAuto(ctx.req);
    const result = addListOption(key, b.value);
    logAudit(ctx.user.id, 'add_list_option', { key, value: b.value });
    redirect(ctx.res, `/settings/lists/${key}?` + (result.ok ? 'ok=' + encodeURIComponent('Option added.') : 'error=' + encodeURIComponent(result.error)));
  });

  router.post('/settings/lists/:key/:id', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const key = ctx.params.key;
    if (!isValidListKey(key)) return redirect(ctx.res, '/settings?error=' + encodeURIComponent('Unknown dropdown list.'));
    const b = await parseBodyAuto(ctx.req);
    const result = renameListOption(Number(ctx.params.id), b.value);
    logAudit(ctx.user.id, 'update_list_option', { key, option_id: ctx.params.id, value: b.value });
    redirect(ctx.res, `/settings/lists/${key}?` + (result.ok ? 'ok=' + encodeURIComponent('Option updated.') : 'error=' + encodeURIComponent(result.error)));
  });

  router.post('/settings/lists/:key/:id/delete', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const key = ctx.params.key;
    if (!isValidListKey(key)) return redirect(ctx.res, '/settings?error=' + encodeURIComponent('Unknown dropdown list.'));
    deleteListOption(Number(ctx.params.id));
    logAudit(ctx.user.id, 'delete_list_option', { key, option_id: ctx.params.id });
    redirect(ctx.res, `/settings/lists/${key}?ok=` + encodeURIComponent('Option removed.'));
  });

  // ---------------- Roles (System Settings, Super Admin + password-gated) ----------------

  router.post('/settings/roles', async (ctx) => {
    if (!requireSystemUnlocked(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    const result = addRole(b.name, b.permission_tier);
    logAudit(ctx.user.id, 'add_role', { name: b.name, permission_tier: b.permission_tier });
    redirect(ctx.res, '/settings?tab=system&' + (result.ok ? 'ok=' + encodeURIComponent('Role added.') : 'error=' + encodeURIComponent(result.error)));
  });

  router.post('/settings/roles/:id', async (ctx) => {
    if (!requireSystemUnlocked(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    const result = updateRole(Number(ctx.params.id), b.name, b.permission_tier);
    logAudit(ctx.user.id, 'update_role', { role_id: ctx.params.id, name: b.name, permission_tier: b.permission_tier });
    redirect(ctx.res, '/settings?tab=system&' + (result.ok ? 'ok=' + encodeURIComponent('Role updated.') : 'error=' + encodeURIComponent(result.error)));
  });

  router.post('/settings/roles/:id/delete', async (ctx) => {
    if (!requireSystemUnlocked(ctx)) return;
    const result = deleteRole(Number(ctx.params.id));
    logAudit(ctx.user.id, 'delete_role', { role_id: ctx.params.id });
    redirect(ctx.res, '/settings?tab=system&' + (result.ok ? 'ok=' + encodeURIComponent('Role deleted.') : 'error=' + encodeURIComponent(result.error)));
  });

  router.post('/settings/email', async (ctx) => {
    if (!requireSettingAccess(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    setSetting('smtp_host', b.smtp_host || '');
    setSetting('smtp_port', b.smtp_port || '587');
    setSetting('smtp_security', b.smtp_security || 'tls');
    setSetting('smtp_username', b.smtp_username || '');
    setSetting('smtp_password', b.smtp_password || '');
    setSetting('smtp_sender_email', b.smtp_sender_email || 'noreply@staffhub.my');
    setSetting('smtp_sender_name', b.smtp_sender_name || 'StaffHub HRMS');
    logAudit(ctx.user.id, 'update_email_settings', { smtp_host: b.smtp_host });
    redirect(ctx.res, '/settings?tab=email&ok=' + encodeURIComponent('Email server settings updated.'));
  });

  // ---------------- Custom Profile Tabs & Fields (HR Admin) ----------------

  router.post('/settings/custom-tabs', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const b = await parseBodyAuto(ctx.req);
    const targetRedirect = b.redirect_to || '/settings?tab=hr';
    if (!b.label) return redirect(ctx.res, targetRedirect + (targetRedirect.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Tab name is required.'));

    try {
      createCustomTab(b.label, b.description);
      logAudit(ctx.user.id, 'create_custom_profile_tab', { label: b.label });
      redirect(ctx.res, targetRedirect + (targetRedirect.includes('?') ? '&' : '?') + 'ok=' + encodeURIComponent(`Custom tab '${b.label}' created.`));
    } catch (err) {
      redirect(ctx.res, targetRedirect + (targetRedirect.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.message));
    }
  });

  router.post('/settings/custom-tabs/:id/delete', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const id = Number(ctx.params.id);
    deleteCustomTab(id);
    logAudit(ctx.user.id, 'delete_custom_profile_tab', { tab_id: id });
    redirect(ctx.res, '/settings?tab=hr&ok=' + encodeURIComponent('Custom profile tab removed.'));
  });

  router.post('/settings/custom-tabs/:id/fields', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const tabId = Number(ctx.params.id);
    const b = await parseBodyAuto(ctx.req);
    const targetRedirect = b.redirect_to || '/settings?tab=hr';
    if (!b.label) return redirect(ctx.res, targetRedirect + (targetRedirect.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent('Field label is required.'));

    const optionsArr = (b.options || '').split(',').map(s => s.trim()).filter(Boolean);

    try {
      addCustomField(tabId, b.label, b.field_type || 'text', optionsArr, b.is_required === '1');
      logAudit(ctx.user.id, 'add_custom_profile_field', { tab_id: tabId, label: b.label });
      redirect(ctx.res, targetRedirect + (targetRedirect.includes('?') ? '&' : '?') + 'ok=' + encodeURIComponent(`Custom field '${b.label}' added.`));
    } catch (err) {
      redirect(ctx.res, targetRedirect + (targetRedirect.includes('?') ? '&' : '?') + 'error=' + encodeURIComponent(err.message));
    }
  });

  router.post('/settings/custom-fields/:id/delete', async (ctx) => {
    if (!requireHrAdmin(ctx)) return;
    const fieldId = Number(ctx.params.id);
    deleteCustomField(fieldId);
    logAudit(ctx.user.id, 'delete_custom_profile_field', { field_id: fieldId });
    redirect(ctx.res, '/settings?tab=hr&ok=' + encodeURIComponent('Custom field removed.'));
  });
};
