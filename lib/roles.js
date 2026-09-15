'use strict';
// Custom roles, each pinned to one of the 4 fixed permission constituencies
// (see lib/auth.js hasAccess() / CONSTITUENCIES). Managed under Settings >
// System Settings > Roles (Super Admin only, password-gated — creating a
// role at the super_admin tier is a real privilege-escalation lever, so this
// stays out of HR Settings unlike the plain dropdown lists in lib/lists.js).
const db = require('../db');

const TIERS = [
  { key: 'ess', label: 'ESS' },
  { key: 'admin', label: 'Admin' },
  { key: 'super_admin', label: 'Super Admin' },
  { key: 'it', label: 'IT' },
];
const TIER_KEYS = TIERS.map((t) => t.key);

function isValidTier(tier) {
  return TIER_KEYS.includes(tier);
}

function getAllRoles() {
  return db.prepare('SELECT * FROM roles ORDER BY sort_order, id').all();
}

function getRole(id) {
  return db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
}

function addRole(name, tier) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { ok: false, error: 'Please enter a role name.' };
  if (!isValidTier(tier)) return { ok: false, error: 'Please choose a valid permission tier.' };
  const existing = db.prepare('SELECT id FROM roles WHERE name = ?').get(trimmed);
  if (existing) return { ok: false, error: 'A role with this name already exists.' };
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM roles').get().m;
  const info = db.prepare('INSERT INTO roles (name, permission_tier, is_system, sort_order) VALUES (?, ?, 0, ?)').run(trimmed, tier, maxOrder + 1);
  return { ok: true, id: info.lastInsertRowid };
}

// A role's name can always change (even system roles — "Approver" can become
// "Team Lead"), but its permission tier can only change on a non-system role.
// Retiering a system role would silently change what "Employee"/"Super
// Admin" means everywhere else in the app, which is never what's intended.
function updateRole(id, name, tier) {
  const role = getRole(id);
  if (!role) return { ok: false, error: 'Role not found.' };
  const trimmed = String(name || '').trim();
  if (!trimmed) return { ok: false, error: 'Please enter a role name.' };
  const dup = db.prepare('SELECT id FROM roles WHERE name = ? AND id != ?').get(trimmed, id);
  if (dup) return { ok: false, error: 'A role with this name already exists.' };
  const nextTier = role.is_system ? role.permission_tier : (isValidTier(tier) ? tier : role.permission_tier);
  db.prepare('UPDATE roles SET name = ?, permission_tier = ? WHERE id = ?').run(trimmed, nextTier, id);
  return { ok: true };
}

function deleteRole(id) {
  const role = getRole(id);
  if (!role) return { ok: false, error: 'Role not found.' };
  if (role.is_system) return { ok: false, error: 'This role is built into the app and can’t be deleted (you can still rename it).' };
  const inUse = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(id).c;
  if (inUse > 0) return { ok: false, error: `${inUse} employee(s) still have this role — reassign them first.` };
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  return { ok: true };
}

module.exports = { TIERS, TIER_KEYS, isValidTier, getAllRoles, getRole, addRole, updateRole, deleteRole };
