'use strict';
const crypto = require('crypto');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

module.exports = function runSeed(db) {
  if (!db) return;

  function upsertLeaveType(name, days, requiresMc = 0) {
    const existing = db.prepare('SELECT id FROM leave_types WHERE name = ?').get(name);
    if (existing) return existing.id;
    const info = db.prepare('INSERT INTO leave_types (name, default_days_per_year, requires_mc) VALUES (?, ?, ?)').run(name, days, requiresMc);
    return info.lastInsertRowid;
  }

function upsertPublicHoliday(date, name) {
  const existing = db.prepare('SELECT id FROM public_holidays WHERE holiday_date = ?').get(date);
  if (existing) return existing.id;
  const info = db.prepare('INSERT INTO public_holidays (holiday_date, name) VALUES (?, ?)').run(date, name);
  return info.lastInsertRowid;
}

function nextFreeEmployeeNo() {
  // Scans existing EMP#### numbers and returns one past the highest, so this
  // never collides even if the table already has employees numbered
  // differently than this script's hardcoded literals (e.g. a live database
  // that was seeded before, or patched by hand).
  const rows = db.prepare(`SELECT employee_no FROM users WHERE employee_no LIKE 'EMP%'`).all();
  let max = 0;
  for (const r of rows) {
    const n = parseInt(String(r.employee_no).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return 'EMP' + String(max + 1).padStart(4, '0');
}

// Resolves a fixed permission tier (e.g. 'super_admin') to the id of the
// matching *system* role, seeded by db/index.js's ensureSystemRoles() before
// this script runs. Used only for the demo users below, which are defined by
// tier, not by a custom role name.
function roleIdForTier(tier) {
  const row = db.prepare('SELECT id FROM roles WHERE is_system = 1 AND permission_tier = ?').get(tier);
  if (!row) throw new Error(`No system role found for permission tier "${tier}" — did migrations run?`);
  return row.id;
}

function upsertUser(u) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(u.password_hash, existing.id);
    return existing.id;
  }
  // If the requested employee_no is already taken by a *different* email
  // (e.g. re-running this script against a database that was previously
  // seeded/patched with different numbering), assign a fresh one instead of
  // crashing on a UNIQUE constraint violation.
  const clash = db.prepare('SELECT id FROM users WHERE employee_no = ?').get(u.employee_no);
  const employeeNo = clash ? nextFreeEmployeeNo() : u.employee_no;
  const roleId = roleIdForTier(u.role);
  const { role, ...rest } = u; // drop `role` (tier string) — resolved to role_id above; node:sqlite rejects extra named params it can't bind
  const info = db.prepare(`
    INSERT INTO users (employee_no, name, email, password_hash, role_id, department, position, nationality, join_date, phone, ic_number, address, bank_name, bank_account, marital_status, num_children, date_of_birth, direct_superior_id, indirect_superior_id, basic_salary, status)
    VALUES (@employee_no, @name, @email, @password_hash, @role_id, @department, @position, @nationality, @join_date, @phone, @ic_number, @address, @bank_name, @bank_account, @marital_status, @num_children, @date_of_birth, @direct_superior_id, @indirect_superior_id, @basic_salary, 'active')
  `).run({ indirect_superior_id: null, ...rest, employee_no: employeeNo, role_id: roleId });
  return info.lastInsertRowid;
}

function run() {
  console.log('Seeding StaffHub demo data...');

  // ---- Leave types ----
  const annualId = upsertLeaveType('Annual Leave', 14);
  const medicalId = upsertLeaveType('Medical Leave', 14, 1);
  const emergencyId = upsertLeaveType('Emergency Leave', 3);

  // ---- Public holidays (Malaysia, national) ----
  // Gathered via web search (officeholidays.com), not fetched from the
  // official JPA/national calendar — Super Admin should verify these under
  // Company Settings > Public Holidays before relying on them, and state
  // holidays aren't included at all. Editable there (add/delete) at any time.
  upsertPublicHoliday('2026-01-01', "New Year's Day");
  upsertPublicHoliday('2026-02-17', 'Chinese New Year');
  upsertPublicHoliday('2026-02-18', 'Chinese New Year (Day 2)');
  upsertPublicHoliday('2026-03-20', 'Hari Raya Aidilfitri');
  upsertPublicHoliday('2026-03-21', 'Hari Raya Aidilfitri (Day 2)');
  upsertPublicHoliday('2026-03-22', 'Hari Raya Aidilfitri (Day 3)');
  upsertPublicHoliday('2026-03-23', 'Hari Raya Aidilfitri (Day 4)');
  upsertPublicHoliday('2026-05-01', 'Labour Day');
  upsertPublicHoliday('2026-05-27', 'Hari Raya Haji');
  upsertPublicHoliday('2026-05-31', 'Wesak Day');
  upsertPublicHoliday('2026-06-01', 'Birthday of SPB Yang di-Pertuan Agong');
  upsertPublicHoliday('2026-06-17', 'Awal Muharram');
  upsertPublicHoliday('2026-08-25', 'Maulidur Rasul');
  upsertPublicHoliday('2026-08-31', 'National Day (Merdeka Day)');
  upsertPublicHoliday('2026-09-16', 'Malaysia Day');
  upsertPublicHoliday('2026-12-25', 'Christmas Day');

  // ---- Users ----
  // Permission constituencies (unranked): ess, admin, super_admin, it. See
  // lib/auth.js hasAccess() — Super Admin is a universal override, not the
  // top of a ladder, and each of the other 3 is an explicit named set rather
  // than a rank. Farhan (below) is 'ess' tier but still a manager: approval
  // rights now come from being listed as someone's Direct/Indirect Superior,
  // not from a role tier.
  const passwordHash = hashPassword('password123');

  const superAdminId = upsertUser({
    employee_no: 'EMP0001', name: 'Amir Hassan', email: 'superadmin@staffhub.my', password_hash: passwordHash,
    role: 'super_admin', department: 'Executive', position: 'Chief Operating Officer', nationality: 'Malaysian', join_date: '2018-01-15',
    phone: '012-1112223', ic_number: '800115-14-7788', address: 'Kuala Lumpur, Malaysia',
    bank_name: 'Maybank', bank_account: '9988776655', marital_status: 'married', num_children: 2,
    date_of_birth: '1980-01-15', direct_superior_id: null, indirect_superior_id: null, basic_salary: 12000,
  });

  const hrAdminId = upsertUser({
    employee_no: 'EMP0002', name: 'Aisyah Rahman', email: 'hradmin@staffhub.my', password_hash: passwordHash,
    role: 'admin', department: 'Human Resources', position: 'HR Director', nationality: 'Malaysian', join_date: '2019-03-01',
    phone: '012-3456789', ic_number: '850101-14-5566', address: 'Kuala Lumpur, Malaysia',
    bank_name: 'Maybank', bank_account: '1234567890', marital_status: 'married', num_children: 2,
    date_of_birth: '1985-01-01', direct_superior_id: superAdminId, indirect_superior_id: null, basic_salary: 9500,
  });

  const managerId = upsertUser({
    employee_no: 'EMP0003', name: 'Farhan Zulkifli', email: 'approver@staffhub.my', password_hash: passwordHash,
    role: 'ess', department: 'Engineering', position: 'Engineering Manager', nationality: 'Malaysian', join_date: '2020-06-15',
    phone: '012-9876543', ic_number: '880512-10-1122', address: 'Petaling Jaya, Malaysia',
    bank_name: 'CIMB Bank', bank_account: '2233445566', marital_status: 'married', num_children: 1,
    date_of_birth: '1988-05-12', direct_superior_id: hrAdminId, indirect_superior_id: superAdminId, basic_salary: 8200,
  });

  const employeeId = upsertUser({
    employee_no: 'EMP0004', name: 'Nurul Aina', email: 'employee@staffhub.my', password_hash: passwordHash,
    role: 'ess', department: 'Engineering', position: 'Software Engineer', nationality: 'Malaysian', join_date: '2022-01-10',
    phone: '013-1122334', ic_number: '950721-08-3344', address: 'Shah Alam, Malaysia',
    bank_name: 'Public Bank', bank_account: '3344556677', marital_status: 'single', num_children: 0,
    date_of_birth: '1995-07-21', direct_superior_id: managerId, indirect_superior_id: hrAdminId, basic_salary: 5200,
  });

  const employee2Id = upsertUser({
    employee_no: 'EMP0005', name: 'Kevin Tan', email: 'kevin.tan@staffhub.my', password_hash: passwordHash,
    role: 'ess', department: 'Engineering', position: 'QA Engineer', nationality: 'Malaysian', join_date: '2023-02-20',
    phone: '019-2233445', ic_number: '970310-14-9988', address: 'Subang Jaya, Malaysia',
    bank_name: 'RHB Bank', bank_account: '4455667788', marital_status: 'single', num_children: 0,
    date_of_birth: '1997-03-10', direct_superior_id: managerId, indirect_superior_id: hrAdminId, basic_salary: 4800,
  });

  const itStaffId = upsertUser({
    employee_no: 'EMP0006', name: 'Ravi Kumar', email: 'it@staffhub.my', password_hash: passwordHash,
    role: 'it', department: 'Information Technology', position: 'IT Administrator', nationality: 'Malaysian', join_date: '2021-04-01',
    phone: '017-4455667', ic_number: '900215-14-2233', address: 'Kuala Lumpur, Malaysia',
    bank_name: 'Maybank', bank_account: '5566778899', marital_status: 'single', num_children: 0,
    date_of_birth: '1990-02-15', direct_superior_id: hrAdminId, indirect_superior_id: null, basic_salary: 6500,
  });

  const hiringManagerId = upsertUser({
    employee_no: 'EMP0007', name: 'Siti Sarah', email: 'hiringmanager@staffhub.my', password_hash: passwordHash,
    role: 'hiring_manager', department: 'Product & Design', position: 'Product Lead', nationality: 'Malaysian', join_date: '2021-08-01',
    phone: '018-9988776', ic_number: '910909-14-5544', address: 'Bangsar, Kuala Lumpur',
    bank_name: 'CIMB Bank', bank_account: '7788990011', marital_status: 'single', num_children: 0,
    date_of_birth: '1991-09-09', direct_superior_id: hrAdminId, indirect_superior_id: superAdminId, basic_salary: 8500,
  });

  const year = new Date().getFullYear();
  for (const uid of [superAdminId, hrAdminId, managerId, employeeId, employee2Id, itStaffId]) {
    for (const [ltId, days] of [[annualId, 14], [medicalId, 14], [emergencyId, 3]]) {
      const existing = db.prepare('SELECT id FROM leave_balances WHERE user_id=? AND leave_type_id=? AND year=?').get(uid, ltId, year);
      if (!existing) db.prepare('INSERT INTO leave_balances (user_id, leave_type_id, year, entitled_days, used_days) VALUES (?, ?, ?, ?, 0)').run(uid, ltId, year, days);
    }
  }

  // ---- Emergency contact sample ----
  const hasContact = db.prepare('SELECT id FROM emergency_contacts WHERE user_id = ?').get(employeeId);
  if (!hasContact) {
    db.prepare('INSERT INTO emergency_contacts (user_id, name, relationship, phone) VALUES (?, ?, ?, ?)').run(employeeId, 'Siti Aina', 'Mother', '012-3344556');
  }

  // ---- Employment history sample ----
  const hasHistory = db.prepare('SELECT id FROM employment_history WHERE user_id = ?').get(employeeId);
  if (!hasHistory) {
    db.prepare('INSERT INTO employment_history (user_id, title, department, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(employeeId, 'Junior Software Engineer', 'Engineering', '2022-01-10', '2023-06-30', 'Joined as fresh graduate');
    db.prepare('INSERT INTO employment_history (user_id, title, department, start_date, end_date, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(employeeId, 'Software Engineer', 'Engineering', '2023-07-01', null, 'Promoted');
  }

  // ---- Sample leave application (pending, for manager to approve) ----
  const hasLeaveApp = db.prepare('SELECT id FROM leave_applications WHERE user_id = ?').get(employee2Id);
  if (!hasLeaveApp) {
    db.prepare(`
      INSERT INTO leave_applications (user_id, leave_type_id, start_date, end_date, days, reason, approver_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(employee2Id, annualId, addDays(3), addDays(5), 3, 'Family trip', managerId);
  }

  // ---- Sample claims (pending) across a few of the 4 categories ----
  const hasMileage = db.prepare(`SELECT id FROM claims WHERE user_id = ? AND subcategory = 'mileage'`).get(employeeId);
  if (!hasMileage) {
    const distance = 42;
    const rate = 0.6;
    const mileage = Math.round(distance * rate * 100) / 100;
    db.prepare(`
      INSERT INTO claims (user_id, category, subcategory, claim_date, origin, destination, is_round_trip, distance_km, mileage_rate, amount, status, approver_id)
      VALUES (?, 'travel', 'mileage', ?, 'Office, KL', 'Client HQ, Cyberjaya', 1, ?, ?, ?, 'pending', ?)
    `).run(employeeId, addDays(-2), distance, rate, mileage, managerId);
  }
  const hasToll = db.prepare(`SELECT id FROM claims WHERE user_id = ? AND subcategory = 'toll'`).get(employeeId);
  if (!hasToll) {
    db.prepare(`
      INSERT INTO claims (user_id, category, subcategory, claim_date, description, amount, status, approver_id)
      VALUES (?, 'travel', 'toll', ?, 'Office, KL -> Client HQ, Cyberjaya', 15.5, 'pending', ?)
    `).run(employeeId, addDays(-2), managerId);
  }

  getOrCreateMedicalLimit(employeeId, year);
  const hasMedical = db.prepare(`SELECT id FROM claims WHERE user_id = ? AND category = 'medical'`).get(employeeId);
  if (!hasMedical) {
    db.prepare(`
      INSERT INTO claims (user_id, category, subcategory, claim_date, amount, description, claim_for, status, approver_id)
      VALUES (?, 'medical', 'outpatient', ?, 120, 'General checkup', 'self', 'pending', ?)
    `).run(employeeId, addDays(-1), managerId);
  }

  // ---- Sample attendance for the last 5 working days ----
  for (let i = 1; i <= 5; i++) {
    const date = addDays(-i);
    for (const uid of [employeeId, employee2Id, managerId]) {
      const existing = db.prepare('SELECT id FROM attendance_logs WHERE user_id=? AND work_date=?').get(uid, date);
      if (!existing) {
        const late = Math.random() < 0.2;
        db.prepare('INSERT INTO attendance_logs (user_id, work_date, clock_in, clock_out, status) VALUES (?, ?, ?, ?, ?)')
          .run(uid, date, late ? '09:32' : '08:55', '18:05', late ? 'late' : 'present');
      }
    }
  }

  // ---- Sample finalized payroll run for last month ----
  const now = new Date();
  let lastMonth = now.getMonth(); // 0-indexed current month -> previous month number (1-indexed)
  let lastMonthYear = now.getFullYear();
  if (lastMonth === 0) { lastMonth = 12; lastMonthYear -= 1; }

  let run = db.prepare('SELECT * FROM payroll_runs WHERE month = ? AND year = ?').get(lastMonth, lastMonthYear);
  if (!run) {
    const info = db.prepare(`INSERT INTO payroll_runs (month, year, status, finalized_at) VALUES (?, ?, 'finalized', datetime('now'))`).run(lastMonth, lastMonthYear);
    const runId = info.lastInsertRowid;
    const users = db.prepare(`
      SELECT u.*, r.permission_tier FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status = 'active'
    `).all();
    for (const emp of users) {
      const calc = computePayslip({
        basic_salary: emp.basic_salary,
        allowances: ['admin','super_admin'].includes(emp.permission_tier) ? 500 : 0,
        overtime: 0,
        other_deductions: 0,
        date_of_birth: emp.date_of_birth,
        marital_status: emp.marital_status,
        num_children: emp.num_children,
      });
      db.prepare(`
        INSERT INTO payslips (payroll_run_id, user_id, basic_salary, allowances, overtime, gross_pay, epf_employee, epf_employer, socso_employee, socso_employer, eis_employee, eis_employer, pcb, other_deductions, net_pay)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(runId, emp.id, calc.basic_salary, calc.allowances, calc.overtime, calc.gross_pay, calc.epf_employee, calc.epf_employer, calc.socso_employee, calc.socso_employer, calc.eis_employee, calc.eis_employer, calc.pcb, calc.other_deductions, calc.net_pay);
    }
    console.log(`Created finalized payroll run for ${lastMonth}/${lastMonthYear}.`);
  }

  // ---- Sample Recruitment Requisitions & Candidates ----
  const hasReqs = db.prepare('SELECT COUNT(*) c FROM job_requisitions').get().c;
  if (hasReqs === 0) {
    const req1 = db.prepare(`
      INSERT INTO job_requisitions (title, department, headcount, hiring_manager_id, status, notes)
      VALUES ('Senior Frontend Engineer', 'Engineering', 2, ?, 'approved', 'React / TypeScript experience required')
    `).run(managerId).lastInsertRowid;

    const req2 = db.prepare(`
      INSERT INTO job_requisitions (title, department, headcount, hiring_manager_id, status, notes)
      VALUES ('UI/UX Designer', 'Product & Design', 1, ?, 'approved', 'Portfolio required')
    `).run(hiringManagerId).lastInsertRowid;

    db.prepare(`
      INSERT INTO candidates (requisition_id, name, email, phone, stage)
      VALUES (?, 'Alice Tan', 'alice.tan@example.com', '012-3344556', 'interview')
    `).run(Number(req1));

    db.prepare(`
      INSERT INTO candidates (requisition_id, name, email, phone, stage)
      VALUES (?, 'Bob Lee', 'bob.lee@example.com', '016-7788990', 'offer')
    `).run(Number(req2));

    console.log('Seeded sample job requisitions and candidates.');
  }

  // ---- Sample Onboarding Templates & Checklist Items ----
  const hasTemplates = db.prepare('SELECT COUNT(*) c FROM onboarding_checklist_templates').get().c;
  if (hasTemplates === 0) {
    db.prepare(`INSERT INTO onboarding_checklist_templates (template_name, task_name, assigned_role, sort_order) VALUES ('Standard Onboarding', 'Submit Personal & Bank Details', 'ess', 1)`).run();
    db.prepare(`INSERT INTO onboarding_checklist_templates (template_name, task_name, assigned_role, sort_order) VALUES ('Standard Onboarding', 'Submit IC & Educational Certificates', 'ess', 2)`).run();
    db.prepare(`INSERT INTO onboarding_checklist_templates (template_name, task_name, assigned_role, sort_order) VALUES ('Standard Onboarding', 'Verify Tax & EPF Information', 'admin', 3)`).run();
    db.prepare(`INSERT INTO onboarding_checklist_templates (template_name, task_name, assigned_role, sort_order) VALUES ('Standard Onboarding', 'Provision Laptop & Network Credentials', 'it', 4)`).run();
    console.log('Seeded onboarding checklist templates.');
  }

  // ---- Sample Org Headcount Plans ----
  if (db.prepare('SELECT COUNT(*) c FROM headcount_plans').get().c === 0) {
    db.prepare(`INSERT INTO headcount_plans (department, year, budgeted_headcount, actual_headcount, status) VALUES ('Engineering', 2026, 12, 4, 'approved')`).run();
    db.prepare(`INSERT INTO headcount_plans (department, year, budgeted_headcount, actual_headcount, status) VALUES ('Product & Design', 2026, 5, 2, 'approved')`).run();
  }

  // ---- Sample Announcements & Policy ----
  if (db.prepare('SELECT COUNT(*) c FROM announcements').get().c === 0) {
    db.prepare(`INSERT INTO announcements (title, content, category, is_mandatory, author_id) VALUES ('Welcome to Q3 2026 Town Hall', 'All hands town hall on Friday at 3 PM in Main Auditorium.', 'General', 1, ${hrAdminId})`).run();
    db.prepare(`INSERT INTO policy_documents (title, description, category) VALUES ('Employee Code of Conduct 2026', 'Standard working guidelines and ethics policy.', 'Company Policy')`).run();
  }

  // ---- Sample Assets ----
  if (db.prepare('SELECT COUNT(*) c FROM company_assets').get().c === 0) {
    db.prepare(`INSERT INTO company_assets (asset_tag, name, category, serial_number, purchase_cost, purchase_date, status, assigned_user_id, issued_date) VALUES ('AST-1001', 'MacBook Pro 16"', 'Laptop/Hardware', 'C02GX001', 11500, '2025-01-10', 'issued', ${employeeId}, '2025-01-15')`).run();
    db.prepare(`INSERT INTO company_assets (asset_tag, name, category, serial_number, purchase_cost, purchase_date, status) VALUES ('AST-1002', 'Dell XPS 15', 'Laptop/Hardware', 'DLX0022', 8500, '2025-03-01', 'available')`).run();
  }

  // ---- Sample Engagement Surveys ----
  if (db.prepare('SELECT COUNT(*) c FROM surveys').get().c === 0) {
    const sId = db.prepare(`INSERT INTO surveys (title, description, status) VALUES ('Q3 2026 eNPS & Pulse Survey', 'Anonymous quarterly pulse check.', 'active')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO survey_questions (survey_id, question_text, question_type, sort_order) VALUES (${Number(sId)}, 'How likely are you to recommend StaffHub as a great place to work?', 'rating', 1)`).run();
  }

  // ---- Sample Performance Appraisal & PIP ----
  if (db.prepare('SELECT COUNT(*) c FROM appraisal_cycles').get().c === 0) {
    const cId = db.prepare(`INSERT INTO appraisal_cycles (title, start_date, end_date, status) VALUES ('Annual Review 2026', '2026-01-01', '2026-12-31', 'active')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO performance_goals (cycle_id, user_id, title, weight, status) VALUES (${Number(cId)}, ${employeeId}, 'Deliver Module Architecture Refactor', 30, 'approved')`).run();
    db.prepare(`INSERT INTO performance_reviews (cycle_id, user_id, evaluator_id, self_rating, self_comments, status) VALUES (${Number(cId)}, ${employeeId}, ${managerId}, 4, 'Achieved core KPIs for Q1/Q2', 'manager_review')`).run();
  }

  // ---- Sample Training Courses ----
  if (db.prepare('SELECT COUNT(*) c FROM training_courses').get().c === 0) {
    const crsId = db.prepare(`INSERT INTO training_courses (title, category, trainer) VALUES ('Advanced Node.js & SQLite Systems', 'Technical Certification', 'StaffHub L&D Team')`).run().lastInsertRowid;
    const sessId = db.prepare(`INSERT INTO training_sessions (course_id, session_date, location, cost_per_pax, status) VALUES (${Number(crsId)}, '2026-10-15', 'Kuala Lumpur HQ / Remote', 500, 'scheduled')`).run().lastInsertRowid;
    db.prepare(`INSERT INTO training_enrollments (session_id, user_id, nominated_by, status) VALUES (${Number(sessId)}, ${employeeId}, ${managerId}, 'enrolled')`).run();
    db.prepare(`INSERT INTO training_budgets (department, year, allocated_budget, spent_budget) VALUES ('Engineering', 2026, 25000, 5000)`).run();
  }

  console.log('Seed complete.');
  console.log('');
  console.log('Demo logins (password: password123):');
  console.log('  Super Admin    -> superadmin@staffhub.my');
  console.log('  Admin          -> hradmin@staffhub.my');
  console.log('  ESS manager    -> approver@staffhub.my (Engineering Manager, still ESS tier — a Direct/Indirect Superior to others below)');
  console.log('  Hiring Manager -> hiringmanager@staffhub.my (Product Lead, hiring_manager tier)');
  console.log('  IT             -> it@staffhub.my');
  console.log('  ESS            -> employee@staffhub.my (also kevin.tan@staffhub.my)');
  }

  function getOrCreateMedicalLimit(userId, year) {
    const existing = db.prepare('SELECT id FROM medical_limits WHERE user_id = ? AND year = ?').get(userId, year);
    if (!existing) db.prepare('INSERT INTO medical_limits (user_id, year) VALUES (?, ?)').run(userId, year);
  }

  function addDays(delta) {
    const d = new Date();
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  run();
};

if (require.main === module) {
  const defaultDb = require('./index');
  module.exports(defaultDb);
}
