'use strict';
// Generic configurable dropdown lists for the Employee form. Every list here
// is fully add/edit/delete-able by HR Admin or Super Admin under
// Settings > HR Settings > Dropdown Lists — see routes/settings.js. Options
// are stored in the `list_options` table, one row per (list_key, value).
const db = require('../db');

// key: matches both the list_options.list_key value AND the users.<key>
// column that stores an employee's chosen option (all are plain TEXT columns,
// so nothing here is a foreign key — deleting an option never touches
// existing employee records, it just stops showing up for new selections).
const LIST_DEFS = [
  { key: 'department', label: 'Department' },
  { key: 'position', label: 'Position' },
  { key: 'division', label: 'Division' },
  { key: 'team', label: 'Team' },
  { key: 'employment_type', label: 'Type of Employment' },
  { key: 'employee_status', label: 'Employee Status' },
  { key: 'occupation_level', label: 'Occupation Level' },
  { key: 'location', label: 'Location' },
  { key: 'job_group', label: 'Job Group' },
  { key: 'job_grade', label: 'Job Grade' },
  { key: 'job_band', label: 'Job Band' },
  { key: 'authorization_level', label: 'Authorization Level' },
  { key: 'nationality', label: 'Nationality' },
  { key: 'gender', label: 'Gender' },
];

// Modest, generic starting points so no dropdown is empty on a fresh
// install — Super Admin / HR Admin can rename or remove any of these.
// Department and Position are deliberately absent here: they're seeded from
// whatever values already exist on real employee records instead (see
// migrateExistingDepartmentPositionIntoLists in db/index.js).
const SEED_DEFAULTS = {
  division: ['Corporate'],
  team: ['General'],
  employment_type: ['Permanent', 'Contract', 'Probation', 'Part-Time', 'Intern'],
  employee_status: ['Confirmed', 'Probation', 'Notice Period', 'Suspended', 'Resigned', 'Terminated', 'Retired', 'Deceased'],
  occupation_level: ['Entry Level', 'Junior', 'Senior', 'Lead', 'Manager', 'Senior Manager', 'Director', 'C-Level'],
  location: ['Head Office'],
  job_group: ['Group A', 'Group B', 'Group C'],
  job_grade: ['Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5'],
  job_band: ['Band 1', 'Band 2', 'Band 3', 'Band 4'],
  authorization_level: ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'],
  nationality: ['Malaysian', 'Singaporean', 'Indonesian', 'Indian', 'Chinese', 'Other'],
  gender: ['Male', 'Female'],
};

function listDef(key) {
  return LIST_DEFS.find((d) => d.key === key);
}

function isValidListKey(key) {
  return !!listDef(key);
}

function getListOptions(key) {
  return db.prepare('SELECT * FROM list_options WHERE list_key = ? ORDER BY sort_order, value').all(key);
}

function getListValues(key) {
  return getListOptions(key).map((o) => o.value);
}

function addListOption(key, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { ok: false, error: 'Please enter a value.' };
  const existing = db.prepare('SELECT id FROM list_options WHERE list_key = ? AND value = ?').get(key, trimmed);
  if (existing) return { ok: false, error: 'That option already exists.' };
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM list_options WHERE list_key = ?').get(key).m;
  db.prepare('INSERT INTO list_options (list_key, value, sort_order) VALUES (?, ?, ?)').run(key, trimmed, maxOrder + 1);
  return { ok: true };
}

function renameListOption(id, newValue) {
  const trimmed = String(newValue || '').trim();
  if (!trimmed) return { ok: false, error: 'Please enter a value.' };
  const row = db.prepare('SELECT * FROM list_options WHERE id = ?').get(id);
  if (!row) return { ok: false, error: 'Option not found.' };
  const dup = db.prepare('SELECT id FROM list_options WHERE list_key = ? AND value = ? AND id != ?').get(row.list_key, trimmed, id);
  if (dup) return { ok: false, error: 'That option already exists.' };
  db.prepare('UPDATE list_options SET value = ? WHERE id = ?').run(trimmed, id);
  return { ok: true };
}

function deleteListOption(id) {
  db.prepare('DELETE FROM list_options WHERE id = ?').run(id);
}

function insertIfMissing(key, value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return;
  const existing = db.prepare('SELECT id FROM list_options WHERE list_key = ? AND value = ?').get(key, trimmed);
  if (existing) return;
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM list_options WHERE list_key = ?').get(key).m;
  db.prepare('INSERT INTO list_options (list_key, value, sort_order) VALUES (?, ?, ?)').run(key, trimmed, maxOrder + 1);
}

// Idempotent: run on every server start (see server.js). Only inserts a
// default when that list has zero options yet, so it never fights with
// values an admin has already customized or removed.
function ensureListDefaults() {
  for (const [key, values] of Object.entries(SEED_DEFAULTS)) {
    const count = db.prepare('SELECT COUNT(*) c FROM list_options WHERE list_key = ?').get(key).c;
    if (count === 0) values.forEach((v) => insertIfMissing(key, v));
  }
}

module.exports = {
  LIST_DEFS,
  listDef,
  isValidListKey,
  getListOptions,
  getListValues,
  addListOption,
  renameListOption,
  deleteListOption,
  insertIfMissing,
  ensureListDefaults,
};
