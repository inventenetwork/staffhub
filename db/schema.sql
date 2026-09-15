-- StaffHub — SQLite schema
-- Uses Node's built-in node:sqlite (DatabaseSync). No external DB driver required.
--
-- Permission constituencies: ess, admin, super_admin, it. Unlike the app's old
-- ranked tiers (employee < approver < hr_admin < super_admin), these are NOT a
-- hierarchy — each nav item / route declares the explicit set of constituencies
-- allowed to see it (see lib/auth.js hasAccess()), and Super Admin is a
-- universal override rather than "the top of the ladder". What IS fully custom
-- is the `roles` table below: a Super Admin can create any number of named
-- roles (e.g. "Team Lead", "Regional Manager"), each one assigned to one of
-- the 4 constituencies. A role with is_system=1 is one seeded on install and
-- can be renamed but never deleted (Approver used to be one of these — it's
-- been retired as a fixed tier now that leave/claims approval comes from the
-- Direct/Indirect Superior fields below rather than a role, so it's now an
-- ordinary is_system=0 role like any custom one).

PRAGMA foreign_keys = ON;

-- ==================== ROLES & CONFIGURABLE DROPDOWNS ====================

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  permission_tier TEXT NOT NULL CHECK (permission_tier IN ('ess','admin','super_admin','it','manager','hiring_manager')),
  is_system INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Generic option lists for every dropdown on the employee form that isn't
-- security-sensitive (Department, Position, Division, Team, ...). Managed
-- under Settings > HR Settings > Dropdown Lists (lib/lists.js has the catalog
-- of list_key values and their labels + seed defaults).
CREATE TABLE IF NOT EXISTS list_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_key TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(list_key, value)
);

-- ==================== CORE HR ====================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_no TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  department TEXT,
  position TEXT,
  division TEXT,
  team TEXT,
  employment_type TEXT,
  employee_status TEXT,
  occupation_level TEXT,
  location TEXT,
  job_group TEXT,
  job_grade TEXT,
  job_band TEXT,
  authorization_level TEXT,
  nationality TEXT,
  gender TEXT,
  join_date TEXT,
  group_join_date TEXT,
  confirmation_date TEXT,
  last_working_date TEXT,
  probation_period_months INTEGER,
  resignation_date TEXT,
  rejoin_date TEXT,
  deceased_date TEXT,
  phone TEXT,
  ic_number TEXT, -- NRIC No. (Malaysian, format xxxxxx-xx-xxxx) when nationality = Malaysian
  passport_no TEXT, -- Passport No. when nationality is anything else
  address TEXT,
  bank_name TEXT,
  bank_account TEXT,
  marital_status TEXT DEFAULT 'single' CHECK (marital_status IN ('single','married')),
  num_children INTEGER DEFAULT 0,
  date_of_birth TEXT,
  -- Reporting line, used for dynamic leave/claims approval visibility (see
  -- lib/auth.js hasDirectOrIndirectReports()) now that approval rights come
  -- from being listed here rather than from a fixed Approver role tier.
  direct_superior_id INTEGER REFERENCES users(id),
  indirect_superior_id INTEGER REFERENCES users(id),
  basic_salary REAL DEFAULT 0,
  -- Malaysia statutory registration numbers + contribution settings, shown on
  -- the Profile's "Salary & Malaysia Statutory" tab. These are records only —
  -- lib/statutory.js's payslip calculation is unaffected by them, so changing
  -- epf_voluntary_rate/socso_category/tax_exemption_category here does not
  -- change what payroll actually computes; a HR Admin/Super Admin note on the
  -- Statutory tab explains this.
  epf_no TEXT,
  socso_no TEXT,
  income_tax_no TEXT,
  epf_voluntary_rate REAL,
  socso_category TEXT,
  tax_exemption_category TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT,
  phone TEXT,
  address TEXT
);

CREATE TABLE IF NOT EXISTS employment_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  department TEXT,
  start_date TEXT NOT NULL,
  end_date TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS education_background (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  institution TEXT NOT NULL,
  qualification TEXT NOT NULL,
  field_of_study TEXT,
  start_year INTEGER,
  end_year INTEGER,
  grade TEXT
);

CREATE TABLE IF NOT EXISTS employee_contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  renewal_status TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS company_belongings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  serial_no TEXT,
  issued_date TEXT NOT NULL,
  returned_date TEXT,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','returned','lost','damaged'))
);

CREATE TABLE IF NOT EXISTS certifications_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  issuing_body TEXT,
  issue_date TEXT,
  expiry_date TEXT
);

CREATE TABLE IF NOT EXISTS occupation_supplementary (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('bik','job_desc','health','pip','service_progression')),
  title TEXT NOT NULL,
  details TEXT,
  effective_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Family member records, shown on the Profile's "Family" tab (self-service:
-- an employee manages their own). spouse_working / child_studying_fulltime
-- are only meaningful for relationship = 'spouse' / 'child' respectively —
-- Malaysia's LHDN PCB tax relief depends on both, so they're captured here
-- for HR/payroll reference even though (like the statutory fields above)
-- they don't automatically feed lib/statutory.js's calculation.
CREATE TABLE IF NOT EXISTS family_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL CHECK (relationship IN ('spouse','child','parent','sibling','other')),
  ic_or_passport TEXT,
  date_of_birth TEXT,
  gender TEXT,
  occupation TEXT,
  spouse_working INTEGER, -- 0/1/NULL (N/A unless relationship='spouse')
  child_studying_fulltime INTEGER -- 0/1/NULL (N/A unless relationship='child')
);

-- Pending profile edit requests submitted by ESS users awaiting Admin approval.
CREATE TABLE IF NOT EXISTS profile_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('details','family_add','family_delete','emergency_add','emergency_delete')),
  target_id INTEGER, -- For family_delete / emergency_delete, the ID of the record to remove
  payload TEXT NOT NULL, -- JSON object containing details of requested changes
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  reviewer_id INTEGER REFERENCES users(id),
  decision_note TEXT
);

-- ==================== COMPANY SETTINGS (Super Admin only) ====================
-- Simple key/value store for configurable company policies (mileage rate, late
-- cutoff, default medical limits, company name shown on payslips, etc).
-- See lib/settings.js for the typed helpers and defaults.
CREATE TABLE IF NOT EXISTS company_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  -- Set when a Super Admin re-confirms their password to step into System
  -- Settings (module toggles, company policy). Cleared implicitly by simply
  -- expiring — routes/settings.js treats it as valid for a short window only.
  system_unlocked_at TEXT,
  -- Set when an Admin re-confirms their password to view Salary information on
  -- employee profiles. Cleared implicitly by expiring after 15 minutes.
  salary_unlocked_at TEXT
);

-- ==================== ATTENDANCE ====================

CREATE TABLE IF NOT EXISTS attendance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present','late','half_day')),
  source TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','app')),
  clock_in_lat REAL,
  clock_in_lng REAL,
  clock_in_address TEXT,
  clock_out_lat REAL,
  clock_out_lng REAL,
  clock_out_address TEXT,
  UNIQUE(user_id, work_date)
);

CREATE TABLE IF NOT EXISTS attendance_punches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  punch_time TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('IN','OUT')),
  latitude REAL,
  longitude REAL,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== LEAVE ====================

CREATE TABLE IF NOT EXISTS leave_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  default_days_per_year REAL NOT NULL DEFAULT 0,
  requires_mc INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS leave_balances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  entitled_days REAL NOT NULL DEFAULT 0,
  used_days REAL NOT NULL DEFAULT 0,
  UNIQUE(user_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS leave_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  mc_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approver_id INTEGER REFERENCES users(id),
  applied_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS planned_leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Company public holiday calendar, managed by Super Admin under Company
-- Settings. Used to color/label holidays (alongside weekends) in the leave
-- application date pickers — see the day-picker widget in public/app.js.
CREATE TABLE IF NOT EXISTS public_holidays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holiday_date TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

-- ==================== CLAIMS ====================
-- One unified table across all 4 claim categories (see lib/claimTypes.js for
-- the category/subcategory catalog). `mileage`-subcategory claims use the
-- origin/destination/distance/rate columns with a server-computed, locked
-- amount; every other subcategory just uses the flat `amount` field.
-- `claim_for`/`dependent_name` only apply to the medical category.

CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('travel','medical','general','benefits')),
  subcategory TEXT NOT NULL,
  claim_date TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL DEFAULT 0,
  origin TEXT,
  destination TEXT,
  is_round_trip INTEGER NOT NULL DEFAULT 0,
  distance_km REAL,
  mileage_rate REAL,
  claim_for TEXT NOT NULL DEFAULT 'self' CHECK (claim_for IN ('self','dependent')),
  dependent_name TEXT,
  mc_linked INTEGER NOT NULL DEFAULT 0,
  mc_start_date TEXT,
  mc_end_date TEXT,
  receipt_data TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid')),
  approver_id INTEGER REFERENCES users(id),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS medical_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  outpatient_limit REAL NOT NULL DEFAULT 1000,
  outpatient_used REAL NOT NULL DEFAULT 0,
  dental_limit REAL NOT NULL DEFAULT 500,
  dental_used REAL NOT NULL DEFAULT 0,
  optical_limit REAL NOT NULL DEFAULT 300,
  optical_used REAL NOT NULL DEFAULT 0,
  hospitalization_limit REAL NOT NULL DEFAULT 5000,
  hospitalization_used REAL NOT NULL DEFAULT 0,
  UNIQUE(user_id, year)
);

-- ==================== PAYROLL ====================

CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','finalized')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT,
  UNIQUE(month, year)
);

CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  basic_salary REAL NOT NULL DEFAULT 0,
  allowances REAL NOT NULL DEFAULT 0,
  overtime REAL NOT NULL DEFAULT 0,
  gross_pay REAL NOT NULL DEFAULT 0,
  epf_employee REAL NOT NULL DEFAULT 0,
  epf_employer REAL NOT NULL DEFAULT 0,
  socso_employee REAL NOT NULL DEFAULT 0,
  socso_employer REAL NOT NULL DEFAULT 0,
  eis_employee REAL NOT NULL DEFAULT 0,
  eis_employer REAL NOT NULL DEFAULT 0,
  pcb REAL NOT NULL DEFAULT 0,
  other_deductions REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL DEFAULT 0,
  UNIQUE(payroll_run_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== RECRUITMENT ====================

CREATE TABLE IF NOT EXISTS job_requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  headcount INTEGER NOT NULL DEFAULT 1,
  hiring_manager_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','closed')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL REFERENCES job_requisitions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  stage TEXT NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied','screening','interview','offer','hired','rejected')),
  resume_url TEXT,
  converted_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  interviewer_id INTEGER NOT NULL REFERENCES users(id),
  scheduled_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS interview_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  evaluator_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  feedback TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== ONBOARDING & OFFBOARDING ====================

CREATE TABLE IF NOT EXISTS onboarding_checklist_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_name TEXT NOT NULL,
  task_name TEXT NOT NULL,
  assigned_role TEXT NOT NULL CHECK (assigned_role IN ('ess','admin','it')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS onboarding_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_name TEXT NOT NULL,
  assigned_role TEXT NOT NULL CHECK (assigned_role IN ('ess','admin','it','manager')),
  pic_id INTEGER REFERENCES users(id),
  item_type TEXT NOT NULL DEFAULT 'task' CHECK (item_type IN ('task','asset','document')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed')),
  due_date TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS offboarding_checklists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resignation_date TEXT NOT NULL,
  last_working_date TEXT NOT NULL,
  clearance_it TEXT NOT NULL DEFAULT 'pending' CHECK (clearance_it IN ('pending','approved','rejected')),
  clearance_finance TEXT NOT NULL DEFAULT 'pending' CHECK (clearance_finance IN ('pending','approved','rejected')),
  clearance_admin TEXT NOT NULL DEFAULT 'pending' CHECK (clearance_admin IN ('pending','approved','rejected')),
  exit_interview_status TEXT NOT NULL DEFAULT 'pending' CHECK (exit_interview_status IN ('pending','completed')),
  exit_interview_notes TEXT,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','in_progress','cleared','completed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS offboarding_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offboarding_id INTEGER NOT NULL REFERENCES offboarding_checklists(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Admin' CHECK (category IN ('IT','Finance','Admin','Asset')),
  pic_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','returned','waived')),
  verified_at TEXT
);

-- ==================== ORGANIZATION MANAGEMENT ====================

CREATE TABLE IF NOT EXISTS headcount_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department TEXT NOT NULL,
  year INTEGER NOT NULL,
  budgeted_headcount INTEGER NOT NULL DEFAULT 0,
  actual_headcount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== APPROVAL CENTER ====================

CREATE TABLE IF NOT EXISTS approval_delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delegator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delegate_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== ANNOUNCEMENTS & POLICY ====================

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  target_audience TEXT NOT NULL DEFAULT 'all' CHECK (target_audience IN ('all','department','role')),
  target_value TEXT,
  is_mandatory INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS announcement_acknowledgements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(announcement_id, user_id)
);

CREATE TABLE IF NOT EXISTS policy_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'Company Policy',
  file_url TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== EMPLOYEE ENGAGEMENT ====================

CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
  target_audience TEXT DEFAULT 'all',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS survey_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  question_type TEXT NOT NULL DEFAULT 'rating' CHECK (question_type IN ('rating','choice','text')),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES survey_questions(id) ON DELETE CASCADE,
  rating_value INTEGER,
  text_value TEXT,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== PERFORMANCE MANAGEMENT ====================

CREATE TABLE IF NOT EXISTS appraisal_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','closed'))
);

CREATE TABLE IF NOT EXISTS performance_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  weight INTEGER NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS performance_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id INTEGER REFERENCES appraisal_cycles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  evaluator_id INTEGER REFERENCES users(id),
  self_rating INTEGER CHECK (self_rating BETWEEN 1 AND 5),
  self_comments TEXT,
  manager_rating INTEGER CHECK (manager_rating BETWEEN 1 AND 5),
  manager_comments TEXT,
  overall_score REAL,
  status TEXT NOT NULL DEFAULT 'self_review' CHECK (status IN ('self_review','manager_review','completed')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS performance_360_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id INTEGER REFERENCES performance_reviews(id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  subject_user_id INTEGER NOT NULL REFERENCES users(id),
  feedback_text TEXT NOT NULL,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS performance_improvement_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager_id INTEGER REFERENCES users(id),
  reason TEXT NOT NULL,
  action_plan TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','successful','unsuccessful')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== TRAINING & DEVELOPMENT ====================

CREATE TABLE IF NOT EXISTS training_courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'Professional Skills',
  trainer TEXT,
  max_capacity INTEGER DEFAULT 20,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
  session_date TEXT NOT NULL,
  location TEXT,
  cost_per_pax REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled'))
);

CREATE TABLE IF NOT EXISTS training_enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nominated_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','attended','completed','cancelled')),
  certificate_url TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS training_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department TEXT NOT NULL,
  year INTEGER NOT NULL,
  allocated_budget REAL DEFAULT 0,
  spent_budget REAL DEFAULT 0,
  UNIQUE(department, year)
);

-- ==================== DISCIPLINARY & INDUSTRIAL RELATIONS ====================

CREATE TABLE IF NOT EXISTS disciplinary_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_number TEXT UNIQUE NOT NULL,
  incident_date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Misconduct',
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','under_inquiry','closed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disciplinary_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES disciplinary_cases(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  letter_type TEXT NOT NULL CHECK (letter_type IN ('warning','show_cause','termination')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS domestic_inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES disciplinary_cases(id) ON DELETE CASCADE,
  inquiry_date TEXT NOT NULL,
  panel_members TEXT,
  findings TEXT,
  outcome TEXT
);

-- ==================== ASSET MANAGEMENT ====================

CREATE TABLE IF NOT EXISTS company_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_tag TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Laptop/Hardware',
  serial_number TEXT,
  purchase_date TEXT,
  purchase_cost REAL DEFAULT 0,
  depreciation_rate_annual REAL DEFAULT 0.20,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','issued','under_repair','disposed')),
  assigned_user_id INTEGER REFERENCES users(id),
  issued_date TEXT
);

CREATE TABLE IF NOT EXISTS asset_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_category TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','fulfilled')),
  approver_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ==================== CUSTOM PROFILE TABS & FIELDS ====================

CREATE TABLE IF NOT EXISTS custom_profile_tabs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_key TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS custom_profile_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tab_id INTEGER NOT NULL REFERENCES custom_profile_tabs(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text' CHECK (field_type IN ('text','number','date','select','textarea')),
  options_json TEXT, -- For select dropdown type, e.g. ["Diploma","Bachelor","Master","PhD"]
  is_required INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(tab_id, field_key)
);

CREATE TABLE IF NOT EXISTS custom_profile_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_id INTEGER NOT NULL REFERENCES custom_profile_fields(id) ON DELETE CASCADE,
  field_value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, field_id)
);
