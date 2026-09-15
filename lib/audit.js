'use strict';
const db = require('../db');

function logAudit(userId, action, details, ipAddress = null) {
  try {
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details || '');
    db.prepare(`
      INSERT INTO audit_logs (user_id, action, details, ip_address)
      VALUES (?, ?, ?, ?)
    `).run(userId || null, action, detailsStr, ipAddress || null);
  } catch (err) {
    console.error('Failed to log audit event:', err);
  }
}

function getAuditLogs(limit = 100) {
  return db.prepare(`
    SELECT a.*, u.name as user_name, u.email as user_email
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC LIMIT ?
  `).all(limit);
}

module.exports = { logAudit, getAuditLogs };
