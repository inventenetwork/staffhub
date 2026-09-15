'use strict';
const db = require('../db');

function createRequest(userId, category, payloadObj, targetId = null) {
  const payloadJson = JSON.stringify(payloadObj || {});
  
  // Check if there is already a pending request for the same user, category, and targetId
  let existing;
  if (targetId) {
    existing = db.prepare('SELECT id FROM profile_change_requests WHERE user_id = ? AND category = ? AND target_id = ? AND status = \'pending\'').get(userId, category, targetId);
  } else {
    existing = db.prepare('SELECT id FROM profile_change_requests WHERE user_id = ? AND category = ? AND target_id IS NULL AND status = \'pending\'').get(userId, category);
  }

  if (existing) {
    db.prepare('UPDATE profile_change_requests SET payload = ?, requested_at = datetime(\'now\') WHERE id = ?').run(payloadJson, existing.id);
    return existing.id;
  }

  const res = db.prepare('INSERT INTO profile_change_requests (user_id, category, target_id, payload, status) VALUES (?, ?, ?, ?, \'pending\')')
    .run(userId, category, targetId, payloadJson);
  return res.lastInsertRowid;
}

function getPendingRequestsForUser(userId) {
  return db.prepare('SELECT * FROM profile_change_requests WHERE user_id = ? AND status = \'pending\' ORDER BY id DESC').all(userId);
}

function getAllPendingRequests() {
  return db.prepare(`
    SELECT r.*, u.name as user_name, u.employee_no, u.department, u.position
    FROM profile_change_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending'
    ORDER BY r.id DESC
  `).all();
}

function getPendingCount() {
  const row = db.prepare('SELECT COUNT(*) c FROM profile_change_requests WHERE status = \'pending\'').get();
  return row ? row.c : 0;
}

function withdrawRequest(requestId, userId) {
  const req = db.prepare('SELECT * FROM profile_change_requests WHERE id = ? AND user_id = ?').get(requestId, userId);
  if (!req || req.status !== 'pending') return false;
  db.prepare('UPDATE profile_change_requests SET status = \'withdrawn\', decided_at = datetime(\'now\') WHERE id = ?').run(requestId);
  return true;
}

function approveRequest(requestId, reviewerId) {
  const req = db.prepare('SELECT * FROM profile_change_requests WHERE id = ?').get(requestId);
  if (!req || req.status !== 'pending') return { ok: false, error: 'Request not found or already processed.' };

  let payload;
  try {
    payload = JSON.parse(req.payload);
  } catch {
    return { ok: false, error: 'Invalid payload in request.' };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    if (req.category === 'details') {
      db.prepare(`
        UPDATE users SET
          phone=?, ic_number=?, passport_no=?, nationality=?, gender=?, address=?, bank_name=?, bank_account=?, marital_status=?, num_children=?, date_of_birth=?
        WHERE id = ?
      `).run(
        payload.phone || null, payload.ic_number || null, payload.passport_no || null,
        payload.nationality || null, payload.gender || null, payload.address || null,
        payload.bank_name || null, payload.bank_account || null, payload.marital_status || 'single',
        Number(payload.num_children || 0), payload.date_of_birth || null, req.user_id,
      );
    } else if (req.category === 'family_add') {
      db.prepare(`
        INSERT INTO family_members (user_id, name, relationship, ic_or_passport, date_of_birth, gender, occupation, spouse_working, child_studying_fulltime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.user_id, payload.name, payload.relationship, payload.ic_or_passport || null,
        payload.date_of_birth || null, payload.gender || null, payload.occupation || null,
        payload.spouse_working !== undefined ? payload.spouse_working : null,
        payload.child_studying_fulltime !== undefined ? payload.child_studying_fulltime : null,
      );
    } else if (req.category === 'family_delete') {
      if (req.target_id) {
        db.prepare('DELETE FROM family_members WHERE id = ? AND user_id = ?').run(req.target_id, req.user_id);
      }
    } else if (req.category === 'emergency_add') {
      db.prepare('INSERT INTO emergency_contacts (user_id, name, relationship, phone) VALUES (?, ?, ?, ?)').run(
        req.user_id, payload.name, payload.relationship || null, payload.phone || null,
      );
    } else if (req.category === 'emergency_delete') {
      if (req.target_id) {
        db.prepare('DELETE FROM emergency_contacts WHERE id = ? AND user_id = ?').run(req.target_id, req.user_id);
      }
    }

    db.prepare('UPDATE profile_change_requests SET status = \'approved\', reviewer_id = ?, decided_at = datetime(\'now\') WHERE id = ?')
      .run(reviewerId, requestId);
    db.exec('COMMIT');
    return { ok: true };
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, error: err.message };
  }
}

function rejectRequest(requestId, reviewerId, note = null) {
  const req = db.prepare('SELECT * FROM profile_change_requests WHERE id = ?').get(requestId);
  if (!req || req.status !== 'pending') return { ok: false, error: 'Request not found or already processed.' };

  db.prepare('UPDATE profile_change_requests SET status = \'rejected\', reviewer_id = ?, decision_note = ?, decided_at = datetime(\'now\') WHERE id = ?')
    .run(reviewerId, note || null, requestId);
  return { ok: true };
}

module.exports = {
  createRequest,
  getPendingRequestsForUser,
  getAllPendingRequests,
  getPendingCount,
  withdrawRequest,
  approveRequest,
  rejectRequest,
};
