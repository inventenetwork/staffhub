'use strict';
// Company-wide configurable policies, managed by Super Admin under /settings.
// Backed by a simple key/value table so new settings can be added without a
// schema migration.
const db = require('../db');

const DEFAULTS = {
  company_name: 'StaffHub Sdn Bhd',
  mileage_rate: '0.60',
  late_cutoff: '09:15',
  default_outpatient_limit: '1000',
  default_dental_limit: '500',
  default_optical_limit: '300',
  default_hospitalization_limit: '5000',
  max_headcount_limit: '0', // 0 = Unlimited
};

// Subscribable modules a Super Admin can turn on/off from System Settings.
// Disabling a module hides it from the sidebar (and blocks its routes) for
// everyone except the Super Admin, who always keeps access so they can turn
// it back on. Dashboard, Employee Centre and Settings are core and are never
// toggle-able.
const MODULES = [
  { key: 'org', label: 'Organization Management' },
  { key: 'approvals', label: 'Approval Center' },
  { key: 'recruitment', label: 'Recruitment' },
  { key: 'onboarding', label: 'Onboarding & Offboarding' },
  { key: 'announcements', label: 'Announcements & Policy' },
  { key: 'engagement', label: 'Employee Engagement' },
  { key: 'performance', label: 'Performance Management' },
  { key: 'training', label: 'Training & Development' },
  { key: 'disciplinary', label: 'Disciplinary & IR' },
  { key: 'assets', label: 'Asset Management' },
  { key: 'tams', label: 'TAMS (Attendance)' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'leave', label: 'Leave' },
  { key: 'claims', label: 'Claims' },
  { key: 'reports', label: 'Reports' },
  { key: 'analytics', label: 'HR Analytics' },
];
MODULES.forEach((m) => { DEFAULTS[`module_${m.key}_enabled`] = '1'; });

let settingsCache = null;

function invalidateSettingsCache() {
  settingsCache = null;
}

function loadCacheIfNeeded() {
  if (settingsCache) return;
  settingsCache = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM company_settings').all()) {
    settingsCache[row.key] = row.value;
  }
}

function ensureDefaults() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    const existing = db.prepare('SELECT 1 FROM company_settings WHERE key = ?').get(key);
    if (!existing) {
      db.prepare('INSERT INTO company_settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
  invalidateSettingsCache();
}

function getSetting(key, fallback = null) {
  loadCacheIfNeeded();
  return settingsCache.hasOwnProperty(key) ? settingsCache[key] : fallback;
}

function getSettingNumber(key, fallback = 0) {
  const raw = getSetting(key, null);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO company_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
  invalidateSettingsCache();
}

function getAllSettings() {
  loadCacheIfNeeded();
  return { ...settingsCache };
}

function isModuleEnabled(key) {
  return getSetting(`module_${key}_enabled`, '1') !== '0';
}

function setModuleEnabled(key, enabled) {
  setSetting(`module_${key}_enabled`, enabled ? '1' : '0');
}

function getModuleStates() {
  loadCacheIfNeeded();
  const out = {};
  MODULES.forEach((m) => { out[m.key] = isModuleEnabled(m.key); });
  return out;
}

function checkHeadcountLimit() {
  const limit = getSettingNumber('max_headcount_limit', 0);
  const currentActive = db.prepare("SELECT COUNT(*) c FROM users WHERE status = 'active'").get().c;
  if (limit > 0 && currentActive >= limit) {
    return {
      allowed: false,
      currentActive,
      limit,
      error: `Headcount license limit reached (${currentActive}/${limit} active employees). Please contact Super Admin to upgrade your headcount license capacity.`,
    };
  }
  return { allowed: true, currentActive, limit };
}

module.exports = {
  DEFAULTS,
  MODULES,
  ensureDefaults,
  getSetting,
  getSettingNumber,
  setSetting,
  getAllSettings,
  isModuleEnabled,
  setModuleEnabled,
  getModuleStates,
  checkHeadcountLimit,
};
