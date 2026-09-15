'use strict';
const db = require('../db');

function getAllCustomTabs() {
  const tabs = db.prepare('SELECT * FROM custom_profile_tabs ORDER BY sort_order ASC, id ASC').all();
  for (const tab of tabs) {
    tab.fields = db.prepare('SELECT * FROM custom_profile_fields WHERE tab_id = ? ORDER BY sort_order ASC, id ASC').all(tab.id);
  }
  return tabs;
}

function getCustomTab(tabIdOrKey) {
  const tab = typeof tabIdOrKey === 'number'
    ? db.prepare('SELECT * FROM custom_profile_tabs WHERE id = ?').get(tabIdOrKey)
    : db.prepare('SELECT * FROM custom_profile_tabs WHERE tab_key = ?').get(tabIdOrKey);

  if (!tab) return null;
  tab.fields = db.prepare('SELECT * FROM custom_profile_fields WHERE tab_id = ? ORDER BY sort_order ASC, id ASC').all(tab.id);
  return tab;
}

function createCustomTab(label, description = '') {
  const tabKey = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!tabKey) throw new Error('Invalid tab name.');
  
  const existing = db.prepare('SELECT id FROM custom_profile_tabs WHERE tab_key = ?').get(tabKey);
  if (existing) throw new Error('A custom tab with a similar key already exists.');

  const res = db.prepare(`
    INSERT INTO custom_profile_tabs (tab_key, label, description)
    VALUES (?, ?, ?)
  `).run(tabKey, label, description || null);

  return res.lastInsertRowid;
}

function deleteCustomTab(tabId) {
  db.prepare('DELETE FROM custom_profile_tabs WHERE id = ?').run(tabId);
}

function addCustomField(tabId, label, fieldType = 'text', optionsArr = [], isRequired = 0) {
  const fieldKey = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!fieldKey) throw new Error('Invalid field label.');

  const optionsJson = (fieldType === 'select' && Array.isArray(optionsArr) && optionsArr.length) 
    ? JSON.stringify(optionsArr) 
    : null;

  const res = db.prepare(`
    INSERT INTO custom_profile_fields (tab_id, field_key, label, field_type, options_json, is_required)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tabId, fieldKey, label, fieldType, optionsJson, isRequired ? 1 : 0);

  return res.lastInsertRowid;
}

function deleteCustomField(fieldId) {
  db.prepare('DELETE FROM custom_profile_fields WHERE id = ?').run(fieldId);
}

function getUserCustomValues(userId, tabId) {
  const rows = db.prepare(`
    SELECT f.id as field_id, f.field_key, f.label, f.field_type, f.options_json, f.is_required, d.field_value
    FROM custom_profile_fields f
    LEFT JOIN custom_profile_data d ON d.field_id = f.id AND d.user_id = ?
    WHERE f.tab_id = ?
    ORDER BY f.sort_order ASC, f.id ASC
  `).all(userId, tabId);
  return rows;
}

function saveUserCustomValues(userId, valuesMap) {
  const insertOrUpdate = db.prepare(`
    INSERT INTO custom_profile_data (user_id, field_id, field_value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, field_id) DO UPDATE SET field_value = excluded.field_value, updated_at = datetime('now')
  `);

  for (const [fieldId, val] of Object.entries(valuesMap)) {
    insertOrUpdate.run(userId, Number(fieldId), val !== undefined && val !== null ? String(val) : null);
  }
}

module.exports = {
  getAllCustomTabs,
  getCustomTab,
  createCustomTab,
  deleteCustomTab,
  addCustomField,
  deleteCustomField,
  getUserCustomValues,
  saveUserCustomValues,
};
