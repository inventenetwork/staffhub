'use strict';
const crypto = require('crypto');
const db = require('../db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// ---------------- Password hashing (scrypt, built into Node's crypto) ----------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, derivedHex] = stored.split(':');
  if (!salt || !derivedHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(derivedHex, 'hex');
  if (storedBuf.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

// ---------------- Sessions ----------------
const destroySessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const getUserFromTokenStmt = db.prepare(
  `SELECT s.expires_at, u.*, r.name as role_name, r.permission_tier, r.is_system as role_is_system
   FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
   WHERE s.token = ?`
);

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return { token, expiresAt };
}

function destroySession(token) {
  if (!token) return;
  destroySessionStmt.run(token);
}

function getUserFromToken(token) {
  if (!token) return null;
  const row = getUserFromTokenStmt.get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    destroySession(token);
    return null;
  }
  delete row.expires_at;
  delete row.password_hash;
  return row;
}

function parseCookies(req) {
  const header = (typeof req === 'string' ? req : (req && req.headers ? req.headers.cookie : '')) || '';
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

function currentUser(req) {
  const cookies = parseCookies(req);
  return getUserFromToken(cookies.hrms_session);
}

// The 4 constituencies are fixed — every access check in the app is keyed to
// exactly these 4 strings. Unlike the app's old ranked tiers (employee <
// approver < hr_admin < super_admin), these are NOT a hierarchy: each nav
// item / route declares the explicit set of constituencies allowed to see it
// (hasAccess(user, ['admin', 'it'])), and Super Admin is a universal override
// rather than "the top of the ladder" — it always passes regardless of what
// allowedRoles lists. Individual *roles* (see the `roles` table / lib/roles.js)
// are fully custom and each one just points at one of these 4 constituencies,
// so hasAccess() only ever needs to look at user.permission_tier (set by the
// roles JOIN in getUserFromToken above), never at the role's own name.
const CONSTITUENCIES = ['ess', 'admin', 'super_admin', 'it', 'manager', 'hiring_manager'];

function hasAccess(user, allowedRoles) {
  if (!user) return false;
  if (user.permission_tier === 'super_admin') return true; // universal override
  if (allowedRoles.includes('manager') && (user.permission_tier === 'manager' || user.permission_tier === 'hiring_manager')) return true;
  if (allowedRoles.includes('hiring_manager') && (user.permission_tier === 'manager' || user.permission_tier === 'hiring_manager')) return true;
  return allowedRoles.includes(user.permission_tier);
}

function isSuperAdmin(user) {
  return !!user && user.permission_tier === 'super_admin';
}

// Only a Super Admin may assign a role that sits at the super_admin
// constituency — this keeps Admins from being able to self-escalate or
// promote others to the top tier, no matter what that role happens to be
// named. Every other constituency (including the new IT tier) can be
// assigned by any Admin, or by the Super Admin via the override above.
function canAssignRole(actingUser, targetTier) {
  if (targetTier === 'super_admin') return isSuperAdmin(actingUser);
  return hasAccess(actingUser, ['admin']);
}

// Dynamic replacement for the old fixed 'approver' role tier: true if this
// user is listed as anyone's Direct or Indirect Superior. Used to decide who
// sees an Approvals section (leave/claims/team-attendance) now that approval
// visibility comes from the reporting line rather than from a role. This is
// today's single-decision-point equivalent of the old approver-tier gate —
// not yet the full 2-level sequential (Direct then Indirect, both required)
// approval workflow, which is a later-stage build.
const hasReportsStmt = db.prepare('SELECT 1 FROM users WHERE direct_superior_id = ? OR indirect_superior_id = ? LIMIT 1');

function hasDirectOrIndirectReports(userId) {
  if (!userId) return false;
  const row = hasReportsStmt.get(userId, userId);
  return !!row;
}

function isSalaryUnlocked(req) {
  const cookies = parseCookies(req);
  const token = cookies.hrms_session;
  if (!token) return false;
  const row = db.prepare('SELECT salary_unlocked_at FROM sessions WHERE token = ?').get(token);
  if (!row || !row.salary_unlocked_at) return false;
  const unlockedMs = new Date(row.salary_unlocked_at.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(unlockedMs)) return false;
  return Date.now() - unlockedMs < 15 * 60 * 1000;
}

function unlockSalary(req) {
  const cookies = parseCookies(req);
  const token = cookies.hrms_session;
  if (!token) return;
  db.prepare(`UPDATE sessions SET salary_unlocked_at = datetime('now') WHERE token = ?`).run(token);
}

const SITE_GATE_PASSWORD = process.env.SITE_PASSWORD || 'Qwe123$';

function isSiteGatePassed(req) {
  const cookies = parseCookies(req);
  return cookies.site_gate_pass === '1';
}

function verifySiteGatePassword(input) {
  return (input || '').trim() === SITE_GATE_PASSWORD;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  getUserFromToken,
  parseCookies,
  currentUser,
  hasAccess,
  isSuperAdmin,
  canAssignRole,
  hasDirectOrIndirectReports,
  isSalaryUnlocked,
  unlockSalary,
  isSiteGatePassed,
  verifySiteGatePassword,
  SITE_GATE_PASSWORD,
  CONSTITUENCIES,
  SESSION_TTL_MS,
};
