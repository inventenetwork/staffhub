'use strict';
// Central database access. Uses Node's built-in node:sqlite (stable/experimental
// in Node 22.5+) so the app runs with zero `npm install`.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let DB_PATH = path.join(DATA_DIR, 'hrms.db');

// Handle Vercel serverless read-only filesystem environment
if (process.env.VERCEL || process.env.NOW_BUILDER) {
  const tmpDbPath = path.join('/tmp', 'hrms.db');
  if (!fs.existsSync(tmpDbPath) && fs.existsSync(DB_PATH)) {
    try {
      fs.copyFileSync(DB_PATH, tmpDbPath);
    } catch (_) {}
  }
  if (fs.existsSync(tmpDbPath)) {
    DB_PATH = tmpDbPath;
  }
}

const db = new DatabaseSync(DB_PATH);

// Apply schema (idempotent — CREATE TABLE IF NOT EXISTS). This only creates
// tables that don't exist yet; it never alters an existing table's columns or
// CHECK constraints, which is why the migration below exists.
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

function migrateSalaryUnlockedIfNeeded() {
  const existingCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
  if (!existingCols.includes('salary_unlocked_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN salary_unlocked_at TEXT');
  }
}
migrateSalaryUnlockedIfNeeded();

function migrateAttendanceLocationIfNeeded() {
  const existingCols = db.prepare('PRAGMA table_info(attendance_logs)').all().map((c) => c.name);
  if (!existingCols.includes('clock_in_lat')) {
    db.exec('ALTER TABLE attendance_logs ADD COLUMN clock_in_lat REAL');
    db.exec('ALTER TABLE attendance_logs ADD COLUMN clock_in_lng REAL');
    db.exec('ALTER TABLE attendance_logs ADD COLUMN clock_in_address TEXT');
    db.exec('ALTER TABLE attendance_logs ADD COLUMN clock_out_lat REAL');
    db.exec('ALTER TABLE attendance_logs ADD COLUMN clock_out_lng REAL');
    db.exec('ALTER TABLE attendance_logs ADD COLUMN clock_out_address TEXT');
  }
}
migrateAttendanceLocationIfNeeded();

function migrateOnboardingPicIfNeeded() {
  const existingCols = db.prepare('PRAGMA table_info(onboarding_checklists)').all().map((c) => c.name);
  if (!existingCols.includes('pic_id')) {
    db.exec('ALTER TABLE onboarding_checklists ADD COLUMN pic_id INTEGER');
  }
  if (!existingCols.includes('item_type')) {
    db.exec("ALTER TABLE onboarding_checklists ADD COLUMN item_type TEXT DEFAULT 'task'");
  }
}
migrateOnboardingPicIfNeeded();

/**
 * Migration: older databases (before the "approver" / "super_admin" roles were
 * introduced) have a `users` table whose CHECK constraint only allows
 * ('employee','manager','hr_admin'). SQLite can't ALTER a CHECK constraint in
 * place, so we rebuild the table when that's detected, mapping the old
 * 'manager' role to the new 'approver' role. No-op on a fresh or already
 * up-to-date database.
 */
function migrateRolesIfNeeded() {
  const tableDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get();
  if (!tableDef) return;
  const existingCols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  // A fresh install (or a database already migrated past this point to
  // role_id — see migrateRoleIdIfNeeded below) has no `role` column at all
  // any more, so there's nothing here for this legacy migration to do.
  if (!existingCols.includes('role')) return;
  if (tableDef.sql.includes('super_admin')) return; // has role, but already migrated past the old 'manager' role

  console.log('Migrating users table to support approver/super_admin roles...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_no TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('employee','approver','hr_admin','super_admin')),
        department TEXT,
        position TEXT,
        join_date TEXT,
        phone TEXT,
        ic_number TEXT,
        address TEXT,
        bank_name TEXT,
        bank_account TEXT,
        marital_status TEXT DEFAULT 'single' CHECK (marital_status IN ('single','married')),
        num_children INTEGER DEFAULT 0,
        date_of_birth TEXT,
        manager_id INTEGER REFERENCES users(id),
        basic_salary REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO users_new (id, employee_no, name, email, password_hash, role, department, position, join_date, phone, ic_number, address, bank_name, bank_account, marital_status, num_children, date_of_birth, manager_id, basic_salary, status, created_at)
      SELECT id, employee_no, name, email, password_hash,
        CASE WHEN role = 'manager' THEN 'approver' ELSE role END,
        department, position, join_date, phone, ic_number, address, bank_name, bank_account,
        marital_status, num_children, date_of_birth, manager_id, basic_salary, status, created_at
      FROM users
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
    console.log('Migration complete: existing "manager" accounts are now "approver".');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Migration: older databases have separate `travel_claims` and
 * `medical_claims` tables (2 claim categories). The claims module was
 * restructured into 4 categories (Travel / Medical / General Expenses /
 * Benefits) backed by one unified `claims` table (see db/schema.sql). If the
 * old tables are still around, fold their rows into `claims` and drop them.
 * No-op on a fresh or already-migrated database.
 *
 * An old travel_claims row bundled mileage + toll + parking into one record
 * with one total; the new model treats Mileage/Toll/Parking as separate
 * claim subcategories, so each old row is split into up to 3 new rows (one
 * per nonzero component) rather than collapsing them into a single lossy
 * total.
 */
function migrateClaimsIfNeeded() {
  const hasOldTravel = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='travel_claims'`).get();
  const hasOldMedical = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='medical_claims'`).get();
  if (!hasOldTravel && !hasOldMedical) return; // fresh install or already migrated

  console.log('Migrating claims into the unified 4-category claims table...');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (hasOldTravel) {
      const rows = db.prepare('SELECT * FROM travel_claims').all();
      const insert = db.prepare(`
        INSERT INTO claims (user_id, category, subcategory, claim_date, description, amount, origin, destination, is_round_trip, distance_km, mileage_rate, receipt_data, status, approver_id, submitted_at, decided_at, decision_note)
        VALUES (@user_id, 'travel', @subcategory, @claim_date, @description, @amount, @origin, @destination, @is_round_trip, @distance_km, @mileage_rate, @receipt_data, @status, @approver_id, @submitted_at, @decided_at, @decision_note)
      `);
      for (const r of rows) {
        insert.run({
          user_id: r.user_id, subcategory: 'mileage', claim_date: r.trip_date, description: null,
          amount: r.mileage_amount, origin: r.origin, destination: r.destination, is_round_trip: r.is_round_trip,
          distance_km: r.distance_km, mileage_rate: r.mileage_rate, receipt_data: r.toll_amount || r.parking_amount ? null : r.receipt_data,
          status: r.status, approver_id: r.approver_id, submitted_at: r.submitted_at, decided_at: r.decided_at, decision_note: r.decision_note,
        });
        if (r.toll_amount > 0) {
          insert.run({
            user_id: r.user_id, subcategory: 'toll', claim_date: r.trip_date, description: `${r.origin} → ${r.destination}`,
            amount: r.toll_amount, origin: null, destination: null, is_round_trip: 0, distance_km: null, mileage_rate: null,
            receipt_data: r.receipt_data, status: r.status, approver_id: r.approver_id, submitted_at: r.submitted_at, decided_at: r.decided_at, decision_note: r.decision_note,
          });
        }
        if (r.parking_amount > 0) {
          insert.run({
            user_id: r.user_id, subcategory: 'parking', claim_date: r.trip_date, description: `${r.origin} → ${r.destination}`,
            amount: r.parking_amount, origin: null, destination: null, is_round_trip: 0, distance_km: null, mileage_rate: null,
            receipt_data: null, status: r.status, approver_id: r.approver_id, submitted_at: r.submitted_at, decided_at: r.decided_at, decision_note: r.decision_note,
          });
        }
      }
      db.exec('DROP TABLE travel_claims');
    }

    if (hasOldMedical) {
      const rows = db.prepare('SELECT * FROM medical_claims').all();
      const insert = db.prepare(`
        INSERT INTO claims (user_id, category, subcategory, claim_date, description, amount, claim_for, mc_linked, mc_start_date, mc_end_date, receipt_data, status, approver_id, submitted_at, decided_at, decision_note)
        VALUES (@user_id, 'medical', @subcategory, @claim_date, @description, @amount, 'self', @mc_linked, @mc_start_date, @mc_end_date, @receipt_data, @status, @approver_id, @submitted_at, @decided_at, @decision_note)
      `);
      for (const r of rows) {
        insert.run({
          user_id: r.user_id, subcategory: r.category, claim_date: r.claim_date, description: r.description, amount: r.amount,
          mc_linked: r.mc_linked, mc_start_date: r.mc_start_date, mc_end_date: r.mc_end_date, receipt_data: r.receipt_data,
          status: r.status, approver_id: r.approver_id, submitted_at: r.submitted_at, decided_at: r.decided_at, decision_note: r.decision_note,
        });
      }
      db.exec('DROP TABLE medical_claims');
    }
    db.exec('COMMIT');
    console.log('Claims migration complete.');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Migration: medical_limits predates the Optical and Hospitalization claim
 * subcategories, so older databases are missing those limit columns. Adding
 * columns (unlike changing a CHECK constraint) doesn't require a table
 * rebuild — a plain ALTER TABLE is enough.
 */
function migrateMedicalLimitColumnsIfNeeded() {
  const cols = db.prepare(`PRAGMA table_info(medical_limits)`).all().map((c) => c.name);
  if (cols.length === 0) return; // table doesn't exist yet (fresh install creates it via schema.sql already)
  if (!cols.includes('optical_limit')) db.exec(`ALTER TABLE medical_limits ADD COLUMN optical_limit REAL NOT NULL DEFAULT 300`);
  if (!cols.includes('optical_used')) db.exec(`ALTER TABLE medical_limits ADD COLUMN optical_used REAL NOT NULL DEFAULT 0`);
  if (!cols.includes('hospitalization_limit')) db.exec(`ALTER TABLE medical_limits ADD COLUMN hospitalization_limit REAL NOT NULL DEFAULT 5000`);
  if (!cols.includes('hospitalization_used')) db.exec(`ALTER TABLE medical_limits ADD COLUMN hospitalization_used REAL NOT NULL DEFAULT 0`);
}

/**
 * Ensures the 4 fixed permission tiers each have a system role backing them.
 * Idempotent, but ONLY relevant while the roles table still has the old
 * ranked-tier CHECK constraint — it exists purely as a prerequisite for the
 * ancient role_id migration below (which looks these rows up by old tier
 * string). A fresh install's schema.sql creates the roles table with the new
 * constituency CHECK directly, and migrateRoleConstituencyIfNeeded() rebuilds
 * an existing database onto it — either way, once that's happened this
 * function has nothing left to do (its own INSERT would violate the new
 * CHECK, since it only knows the old tier strings), so it skips entirely.
 * ensureConstituencySystemRoles() below is what backfills roles under the
 * new tier set.
 */
function ensureSystemRoles() {
  const tableDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roles'`).get();
  if (tableDef && !tableDef.sql.includes(`'employee'`)) return; // already on the new constituency model
  const SYSTEM_ROLES = [
    { name: 'Employee', tier: 'employee', order: 1 },
    { name: 'Approver', tier: 'approver', order: 2 },
    { name: 'HR Admin', tier: 'hr_admin', order: 3 },
    { name: 'Super Admin', tier: 'super_admin', order: 4 },
  ];
  for (const r of SYSTEM_ROLES) {
    const existing = db.prepare(`SELECT id FROM roles WHERE is_system = 1 AND permission_tier = ?`).get(r.tier);
    if (!existing) {
      db.prepare(`INSERT INTO roles (name, permission_tier, is_system, sort_order) VALUES (?, ?, 1, ?)`).run(r.name, r.tier, r.order);
    }
  }
}

/**
 * Migration: older databases have a `users.role` TEXT column CHECK-constrained
 * to the 4 permission-tier strings. Roles are now fully custom (see
 * lib/roles.js) — each one just points at one of those 4 tiers — so `role`
 * becomes `role_id`, a FK into the new `roles` table. Every existing value of
 * the old `role` column is guaranteed to be one of the 4 tier strings (that's
 * what its CHECK enforced), so each old row maps directly onto the matching
 * system role created by ensureSystemRoles() above. No-op on a fresh or
 * already-migrated database.
 */
function migrateRoleIdIfNeeded() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (!cols.includes('role')) return; // fresh install or already migrated

  console.log('Migrating users table from role (string) to role_id (FK to roles)...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_no TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role_id INTEGER NOT NULL REFERENCES roles(id),
        department TEXT,
        position TEXT,
        join_date TEXT,
        phone TEXT,
        ic_number TEXT,
        address TEXT,
        bank_name TEXT,
        bank_account TEXT,
        marital_status TEXT DEFAULT 'single' CHECK (marital_status IN ('single','married')),
        num_children INTEGER DEFAULT 0,
        date_of_birth TEXT,
        manager_id INTEGER REFERENCES users(id),
        basic_salary REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO users_new (id, employee_no, name, email, password_hash, role_id, department, position, join_date, phone, ic_number, address, bank_name, bank_account, marital_status, num_children, date_of_birth, manager_id, basic_salary, status, created_at)
      SELECT u.id, u.employee_no, u.name, u.email, u.password_hash,
        (SELECT r.id FROM roles r WHERE r.is_system = 1 AND r.permission_tier = u.role),
        u.department, u.position, u.join_date, u.phone, u.ic_number, u.address, u.bank_name, u.bank_account,
        u.marital_status, u.num_children, u.date_of_birth, u.manager_id, u.basic_salary, u.status, u.created_at
      FROM users u
    `);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
    db.exec('COMMIT');
    console.log('Migration complete: users.role_id now references roles.');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Migration: the Employee form grew a batch of new HR fields (Division,
 * Team, Type of Employment, Employee Status, Occupation Level, Location, Job
 * Group/Grade/Band, Authorization Level, Nationality, Gender, Passport No.,
 * and several employment dates). All additive TEXT/INTEGER columns, so a
 * plain ALTER TABLE is enough — no table rebuild needed.
 */
function migrateProfileColumnsIfNeeded() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (cols.length === 0) return; // table doesn't exist yet (fresh install creates it via schema.sql already)
  const textColumns = [
    'division', 'team', 'employment_type', 'employee_status', 'occupation_level', 'location',
    'job_group', 'job_grade', 'job_band', 'authorization_level', 'nationality', 'gender',
    'passport_no', 'group_join_date', 'confirmation_date', 'last_working_date',
    'resignation_date', 'rejoin_date', 'deceased_date',
  ];
  for (const col of textColumns) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  }
  if (!cols.includes('probation_period_months')) db.exec(`ALTER TABLE users ADD COLUMN probation_period_months INTEGER`);
}

/**
 * Department and Position turn from free-text inputs into dropdowns backed
 * by list_options (see lib/lists.js). Seeds that list from whatever values
 * already exist on real employee records, so nothing already in use
 * disappears from the dropdown after the upgrade. Idempotent (insert-if-
 * missing) and safe to run on every start, including a fresh install with no
 * users yet (a no-op).
 */
function migrateExistingDepartmentPositionIntoLists() {
  function insertIfMissing(key, value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const existing = db.prepare('SELECT id FROM list_options WHERE list_key = ? AND value = ?').get(key, trimmed);
    if (existing) return;
    const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM list_options WHERE list_key = ?').get(key).m;
    db.prepare('INSERT INTO list_options (list_key, value, sort_order) VALUES (?, ?, ?)').run(key, trimmed, maxOrder + 1);
  }
  const depts = db.prepare(`SELECT DISTINCT department FROM users WHERE department IS NOT NULL AND TRIM(department) != ''`).all();
  depts.forEach((d) => insertIfMissing('department', d.department));
  const positions = db.prepare(`SELECT DISTINCT position FROM users WHERE position IS NOT NULL AND TRIM(position) != ''`).all();
  positions.forEach((p) => insertIfMissing('position', p.position));
}

/**
 * Migration: the Profile page's new "Salary & Malaysia Statutory" tab adds a
 * handful of statutory registration/contribution-setting fields. All additive
 * TEXT/REAL columns, so a plain ALTER TABLE is enough — no table rebuild.
 * (family_members is a brand-new table, created automatically by schema.sql's
 * CREATE TABLE IF NOT EXISTS on every start, so it needs no migration here.)
 */
function migrateStatutoryColumnsIfNeeded() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (cols.length === 0) return; // table doesn't exist yet (fresh install creates it via schema.sql already)
  const textColumns = ['epf_no', 'socso_no', 'income_tax_no', 'socso_category', 'tax_exemption_category'];
  for (const col of textColumns) {
    if (!cols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  }
  if (!cols.includes('epf_voluntary_rate')) db.exec(`ALTER TABLE users ADD COLUMN epf_voluntary_rate REAL`);
}

/**
 * Migration: sessions predates the System Settings password step-up gate,
 * which needs somewhere to remember that a Super Admin recently re-confirmed
 * their password. Additive column, so a plain ALTER TABLE is enough.
 */
function migrateSessionsColumnIfNeeded() {
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
  if (cols.length === 0) return; // table doesn't exist yet (fresh install creates it via schema.sql already)
  if (!cols.includes('system_unlocked_at')) db.exec(`ALTER TABLE sessions ADD COLUMN system_unlocked_at TEXT`);
}

/**
 * Migration: roles.permission_tier was a ranked hierarchy (employee < approver
 * < hr_admin < super_admin). The nav/permission restructure replaces that with
 * 4 unranked constituencies (ess / admin / super_admin / it) — see lib/auth.js
 * hasAccess(). SQLite can't ALTER a CHECK constraint in place, so the table is
 * rebuilt when the old constraint is detected. Existing roles remap as:
 *   employee -> ess, hr_admin -> admin, super_admin unchanged.
 *   approver -> ess, and demoted from is_system (it's no longer a required
 *     system tier now that leave/claims approval comes from the Direct/
 *     Indirect Superior fields instead of a role) so it becomes an ordinary
 *     renameable/deletable custom role; anyone still assigned it keeps their
 *     role_id, just re-tiered to ess.
 * No-op on a fresh install (schema.sql already creates the new CHECK) or an
 * already-migrated database.
 */
function migrateRoleConstituencyIfNeeded() {
  const tableDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roles'`).get();
  if (!tableDef) return;
  if (!tableDef.sql.includes(`'employee'`)) return; // already migrated (or fresh install)

  console.log('Migrating roles table from ranked tiers to unranked constituencies...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE roles_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        permission_tier TEXT NOT NULL CHECK (permission_tier IN ('ess','admin','super_admin','it')),
        is_system INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`
      INSERT INTO roles_new (id, name, permission_tier, is_system, sort_order)
      SELECT id, name,
        CASE permission_tier
          WHEN 'employee' THEN 'ess'
          WHEN 'approver' THEN 'ess'
          WHEN 'hr_admin' THEN 'admin'
          ELSE 'super_admin'
        END,
        CASE WHEN permission_tier = 'approver' THEN 0 ELSE is_system END,
        sort_order
      FROM roles
    `);
    db.exec('DROP TABLE roles');
    db.exec('ALTER TABLE roles_new RENAME TO roles');
    db.exec('COMMIT');
    console.log('Migration complete: roles now use ess/admin/super_admin/it constituencies (the old Approver role is no longer a fixed system tier).');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Ensures each of the 4 constituencies (ess/admin/super_admin/it) has at
 * least one system role backing it — same idea as ensureSystemRoles above,
 * but for the new tier set. Must run AFTER migrateRoleConstituencyIfNeeded
 * (which is what makes the roles table's CHECK constraint accept these
 * values in the first place). Runs unconditionally (idempotent); this is
 * what adds the "IT" role the first time a database reaches this point,
 * since no old tier maps onto it. On an existing database the ess/admin/
 * super_admin slots are already filled by the renamed-in-place Employee/HR
 * Admin/Super Admin rows, so only IT actually gets inserted there — a Super
 * Admin can rename any of these later under Settings > System Settings > Roles.
 */
function migrateHiringManagerConstituencyIfNeeded() {
  const tableDef = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roles'`).get();
  if (!tableDef) return;
  if (tableDef.sql.includes(`'manager'`)) return; // already updated

  console.log('Migrating roles table to include manager constituency...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE roles_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        permission_tier TEXT NOT NULL CHECK (permission_tier IN ('ess','admin','super_admin','it','manager','hiring_manager')),
        is_system INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`
      INSERT INTO roles_new (id, name, permission_tier, is_system, sort_order)
      SELECT id, name, permission_tier, is_system, sort_order FROM roles
    `);
    db.exec('DROP TABLE roles');
    db.exec('ALTER TABLE roles_new RENAME TO roles');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function ensureConstituencySystemRoles() {
  const NEW_SYSTEM_ROLES = [
    { name: 'ESS', tier: 'ess', order: 1 },
    { name: 'Admin', tier: 'admin', order: 2 },
    { name: 'Super Admin', tier: 'super_admin', order: 3 },
    { name: 'Manager', tier: 'manager', order: 4 },
    { name: 'IT', tier: 'it', order: 5 },
    { name: 'Hiring Manager', tier: 'hiring_manager', order: 6 },
  ];
  for (const r of NEW_SYSTEM_ROLES) {
    const existing = db.prepare(`SELECT id FROM roles WHERE is_system = 1 AND permission_tier = ?`).get(r.tier);
    if (!existing) {
      db.prepare(`INSERT INTO roles (name, permission_tier, is_system, sort_order) VALUES (?, ?, 1, ?)`).run(r.name, r.tier, r.order);
    }
  }
}

/**
 * Migration: manager_id is renamed to direct_superior_id (matching the new
 * nav/permission spec's terminology), and a second reporting-line field,
 * indirect_superior_id, is added alongside it. For now these are plain
 * fields — see lib/auth.js hasDirectOrIndirectReports() for the (single-
 * level-equivalent) approval-visibility logic that reads both today; the
 * full 2-level sequential approval workflow they're meant to support is a
 * later-stage build, not implemented yet. Both are plain ALTER TABLE
 * statements (a rename + an add), so no table rebuild is needed.
 */
function migrateSuperiorColumnsIfNeeded() {
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (cols.length === 0) return; // table doesn't exist yet (fresh install creates it via schema.sql already)
  if (cols.includes('manager_id') && !cols.includes('direct_superior_id')) {
    db.exec(`ALTER TABLE users RENAME COLUMN manager_id TO direct_superior_id`);
  }
  const colsAfterRename = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (!colsAfterRename.includes('indirect_superior_id')) {
    db.exec(`ALTER TABLE users ADD COLUMN indirect_superior_id INTEGER REFERENCES users(id)`);
  }
}

migrateRolesIfNeeded();
ensureSystemRoles();
migrateRoleIdIfNeeded();
migrateRoleConstituencyIfNeeded();
migrateHiringManagerConstituencyIfNeeded();
ensureConstituencySystemRoles();
migrateProfileColumnsIfNeeded();
migrateExistingDepartmentPositionIntoLists();
migrateClaimsIfNeeded();
migrateMedicalLimitColumnsIfNeeded();
migrateStatutoryColumnsIfNeeded();
migrateSuperiorColumnsIfNeeded();
migrateSessionsColumnIfNeeded();

function autoSeedIfNeeded() {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
    if (!row || row.c === 0) {
      console.log('Database empty on startup. Running seed...');
      require('./seed');
    }
  } catch (err) {
    console.error('Auto-seed failed:', err);
  }
}
autoSeedIfNeeded();

module.exports = db;
