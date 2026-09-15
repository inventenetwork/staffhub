const db = require('../db');
const { logAudit } = require('./audit');
const { calculateDrivingDistance } = require('./googleMaps');
const { getSettingNumber } = require('./settings');

const TOOLS = [
  {
    name: 'check_leave_balance',
    label: 'Check Leave Balance',
    description: 'Get remaining annual, medical, and emergency leave balances for the logged-in user.',
    type: 'read',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const year = new Date().getFullYear();
      const rows = db.prepare(`
        SELECT lt.name as leave_type, lb.entitled_days, lb.used_days, (lb.entitled_days - lb.used_days) as balance_days
        FROM leave_balances lb
        JOIN leave_types lt ON lt.id = lb.leave_type_id
        WHERE lb.user_id = ? AND lb.year = ?
      `).all(ctx.user.id, year);

      return {
        year,
        balances: rows
      };
    }
  },
  {
    name: 'get_payslip_summary',
    label: 'Get Payslip Summary',
    description: 'Get salary and deduction summary for the latest or specified payroll period.',
    type: 'read',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: { type: 'object', properties: { period: { type: 'string' } } },
    async execute(ctx, args = {}) {
      let row;
      if (args.period) {
        // period format: YYYY-MM
        const [yearStr, monthStr] = (args.period || '').split('-');
        if (yearStr && monthStr) {
          row = db.prepare(`
            SELECT p.*, pr.month, pr.year, pr.status as run_status
            FROM payslips p
            JOIN payroll_runs pr ON pr.id = p.payroll_run_id
            WHERE p.user_id = ? AND pr.year = ? AND pr.month = ?
          `).get(ctx.user.id, parseInt(yearStr, 10), parseInt(monthStr, 10));
        }
      }
      if (!row) {
        row = db.prepare(`
          SELECT p.*, pr.month, pr.year, pr.status as run_status
          FROM payslips p
          JOIN payroll_runs pr ON pr.id = p.payroll_run_id
          WHERE p.user_id = ?
          ORDER BY pr.year DESC, pr.month DESC
          LIMIT 1
        `).get(ctx.user.id);
      }

      if (!row) {
        return { found: false, message: 'No payslip record found.' };
      }

      const period = `${row.year}-${String(row.month).padStart(2, '0')}`;
      return {
        found: true,
        period,
        basic_salary: row.basic_salary,
        allowances: row.allowances,
        overtime: row.overtime,
        gross_pay: row.gross_pay,
        epf_employee: row.epf_employee,
        socso_employee: row.socso_employee,
        eis_employee: row.eis_employee,
        pcb: row.pcb,
        other_deductions: row.other_deductions,
        net_salary: row.net_pay
      };
    }
  },
  {
    name: 'check_claim_entitlement',
    label: 'Check Claim Entitlement',
    description: 'Use ONLY when the user specifically asks about their remaining claim balance or limit per category. Do NOT use when the user wants to submit, file, or apply for a new claim.',
    type: 'read',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const year = new Date().getFullYear();
      const claims = db.prepare(`
        SELECT category, SUM(amount) as total_claimed
        FROM claims
        WHERE user_id = ? AND strftime('%Y', claim_date) = ? AND status != 'rejected'
        GROUP BY category
      `).all(ctx.user.id, String(year));

      const claimedMap = new Map();
      claims.forEach(c => claimedMap.set(c.category, c.total_claimed));

      const categories = [
        { category: 'medical', limit: 1000 },
        { category: 'travel', limit: 500 },
        { category: 'general', limit: 300 }
      ].map(cat => {
        const used = claimedMap.get(cat.category) || 0;
        return {
          category: cat.category,
          entitlement: cat.limit,
          used,
          remaining: Math.max(0, cat.limit - used)
        };
      });

      return { year, categories };
    }
  },
  {
    name: 'get_team_absence_today',
    label: 'Get Team Absence & Leave',
    description: 'View list of direct and indirect report team members absent or on leave for today or a specific date/month.',
    type: 'read',
    allowedTiers: ['manager', 'hiring_manager', 'admin', 'super_admin'],
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'Target date in YYYY-MM-DD format (defaults to today)' } } },
    async execute(ctx, args = {}) {
      const targetDate = args.date || new Date().toISOString().slice(0, 10);
      let teamQuery = "SELECT id, name, department FROM users WHERE status = 'active'";
      const params = [];

      if (ctx.user.permission_tier === 'manager' || ctx.user.permission_tier === 'hiring_manager') {
        teamQuery += ' AND (direct_superior_id = ? OR indirect_superior_id = ? OR department = ?)';
        params.push(ctx.user.id, ctx.user.id, ctx.user.department || '');
      }

      const teamMembers = db.prepare(teamQuery).all(...params);
      if (!teamMembers.length) {
        return { targetDate, total_team_members: 0, absent_count: 0, absent_list: [] };
      }

      const teamIds = teamMembers.map(m => m.id);
      const placeholders = teamIds.map(() => '?').join(',');

      const leaves = db.prepare(`
        SELECT la.user_id, lt.name as leave_type, la.start_date, la.end_date
        FROM leave_applications la
        JOIN leave_types lt ON lt.id = la.leave_type_id
        WHERE la.user_id IN (${placeholders})
          AND la.status = 'approved'
          AND ? BETWEEN la.start_date AND la.end_date
      `).all(...teamIds, targetDate);

      const memberMap = new Map();
      teamMembers.forEach(m => memberMap.set(m.id, m));

      const absentList = leaves.map(l => {
        const m = memberMap.get(l.user_id);
        return {
          name: m ? m.name : 'Employee',
          department: m ? m.department : '',
          reason: l.leave_type,
          period: `${l.start_date} to ${l.end_date}`
        };
      });

      return {
        targetDate,
        total_team_members: teamMembers.length,
        absent_count: absentList.length,
        absent_list: absentList
      };
    }
  },
  {
    name: 'get_team_late_today',
    label: 'Get Team Late Arrivals',
    description: 'View list of direct and indirect report team members who clocked in late on a specific date or today.',
    type: 'read',
    allowedTiers: ['manager', 'hiring_manager', 'admin', 'super_admin'],
    parameters: { type: 'object', properties: { date: { type: 'string', description: 'Target date in YYYY-MM-DD format (defaults to today)' } } },
    async execute(ctx, args = {}) {
      const targetDate = args.date || new Date().toISOString().slice(0, 10);
      let teamQuery = "SELECT id, name, department FROM users WHERE status = 'active'";
      const params = [];

      if (ctx.user.permission_tier === 'manager' || ctx.user.permission_tier === 'hiring_manager') {
        teamQuery += ' AND (direct_superior_id = ? OR indirect_superior_id = ? OR department = ?)';
        params.push(ctx.user.id, ctx.user.id, ctx.user.department || '');
      }

      const teamMembers = db.prepare(teamQuery).all(...params);
      if (!teamMembers.length) {
        return { targetDate, total_team_members: 0, late_count: 0, late_list: [] };
      }

      const teamIds = teamMembers.map(m => m.id);
      const placeholders = teamIds.map(() => '?').join(',');

      const attendances = db.prepare(`SELECT user_id, clock_in, status FROM attendance_logs WHERE user_id IN (${placeholders}) AND work_date = ? AND status = 'late'`).all(...teamIds, targetDate);

      const memberMap = new Map();
      teamMembers.forEach(m => memberMap.set(m.id, m));

      const lateList = attendances.map(a => {
        const m = memberMap.get(a.user_id);
        return {
          name: m ? m.name : 'Employee',
          department: m ? m.department : '',
          clock_in: a.clock_in
        };
      });

      return {
        targetDate,
        total_team_members: teamMembers.length,
        late_count: lateList.length,
        late_list: lateList
      };
    }
  },
  {
    name: 'get_team_leave_calendar',
    label: 'Get Team Leave Calendar',
    description: 'Get upcoming, historical, or specified range approved/pending leave applications for team members.',
    type: 'read',
    allowedTiers: ['manager', 'hiring_manager', 'admin', 'super_admin'],
    parameters: { type: 'object', properties: { start_date: { type: 'string' }, end_date: { type: 'string' } } },
    async execute(ctx, args = {}) {
      const startDate = args.start_date || new Date().toISOString().slice(0, 10);
      const endD = new Date(startDate);
      endD.setDate(endD.getDate() + 30);
      const endDate = args.end_date || endD.toISOString().slice(0, 10);

      let teamQuery = "SELECT id FROM users WHERE status = 'active'";
      const params = [];
      if (ctx.user.permission_tier === 'manager' || ctx.user.permission_tier === 'hiring_manager') {
        teamQuery += ' AND (direct_superior_id = ? OR indirect_superior_id = ? OR department = ?)';
        params.push(ctx.user.id, ctx.user.id, ctx.user.department || '');
      }

      const teamIds = db.prepare(teamQuery).all(...params).map(u => u.id);
      if (!teamIds.length) return { items: [] };

      const placeholders = teamIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT la.id, u.name as employee_name, lt.name as leave_type, la.start_date, la.end_date, la.days, la.status
        FROM leave_applications la
        JOIN users u ON u.id = la.user_id
        JOIN leave_types lt ON lt.id = la.leave_type_id
        WHERE la.user_id IN (${placeholders}) AND la.end_date >= ? AND la.start_date <= ?
        ORDER BY la.start_date ASC
      `).all(...teamIds, startDate, endDate);

      return { start_date: startDate, end_date: endDate, count: rows.length, items: rows };
    }
  },
  {
    name: 'apply_leave',
    label: 'Apply Leave',
    description: 'Submit a new leave application (Annual Leave, Medical Leave, Emergency Leave).',
    type: 'write',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: {
      type: 'object',
      required: ['leave_type', 'start_date', 'end_date'],
      properties: {
        leave_type: { type: 'string' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        reason: { type: 'string' }
      }
    },
    async execute(ctx, args) {
      const lt = db.prepare('SELECT id, name FROM leave_types WHERE LOWER(name) LIKE LOWER(?)').get('%' + args.leave_type + '%');
      if (!lt) throw new Error(`Invalid leave type "${args.leave_type}". Valid types: Annual Leave, Medical Leave, Emergency Leave.`);

      const start = new Date(args.start_date);
      const end = new Date(args.end_date);
      if (isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) throw new Error('Invalid date range.');

      let days = 0;
      let cur = new Date(start);
      while (cur <= end) {
        if (cur.getDay() !== 0 && cur.getDay() !== 6) days++;
        cur.setDate(cur.getDate() + 1);
      }
      if (days <= 0) days = 1;

      const yr = start.getFullYear();
      const bal = db.prepare('SELECT entitled_days, used_days FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?').get(ctx.user.id, lt.id, yr);
      if (bal && (bal.entitled_days - bal.used_days) < days) {
        throw new Error(`Insufficient leave balance. Remaining: ${bal.entitled_days - bal.used_days} days, requested: ${days} days.`);
      }

      const approverId = ctx.user.direct_superior_id || 1;
      const info = db.prepare(`
        INSERT INTO leave_applications (user_id, leave_type_id, start_date, end_date, days, reason, approver_id, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(ctx.user.id, lt.id, args.start_date, args.end_date, days, args.reason || 'Requested via AI Assistant', approverId);

      logAudit(ctx.user.id, 'CREATE_LEAVE', { application_id: info.lastInsertRowid, leave_type: lt.name, days, start_date: args.start_date, via: 'AI Assistant' });

      return {
        success: true,
        application_id: info.lastInsertRowid,
        leave_type: lt.name,
        days,
        start_date: args.start_date,
        end_date: args.end_date,
        status: 'pending',
        message: `Leave application for ${days} day(s) of ${lt.name} (${args.start_date} to ${args.end_date}) submitted successfully!`
      };
    }
  },
  {
    name: 'cancel_leave',
    label: 'Cancel Leave Application',
    description: 'Cancel a pending or approved leave application.',
    type: 'write',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: {
      type: 'object',
      required: ['leave_application_id'],
      properties: { leave_application_id: { type: 'number' } }
    },
    async execute(ctx, args) {
      const app = db.prepare('SELECT * FROM leave_applications WHERE id = ? AND user_id = ?').get(args.leave_application_id, ctx.user.id);
      if (!app) throw new Error(`Leave application #${args.leave_application_id} not found or not owned by you.`);
      if (app.status === 'rejected' || app.status === 'cancelled') throw new Error(`Leave application #${app.id} is already ${app.status}.`);

      db.prepare("UPDATE leave_applications SET status = 'cancelled' WHERE id = ?").run(app.id);
      logAudit(ctx.user.id, 'CANCEL_LEAVE', { application_id: app.id, via: 'AI Assistant' });

      return {
        success: true,
        application_id: app.id,
        message: `Leave application #${app.id} has been cancelled successfully.`
      };
    }
  },
  {
    name: 'calculate_travel_mileage',
    label: 'Calculate Driving Mileage',
    description: 'Calculate driving distance (in KM) and claim amount between an origin and destination location using Google Maps / map routing. Rate is based on company policy (default RM0.60/km).',
    type: 'read',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: {
      type: 'object',
      required: ['origin', 'destination'],
      properties: {
        origin: { type: 'string', description: 'Starting location or address' },
        destination: { type: 'string', description: 'Destination location or address' },
        is_round_trip: { type: 'boolean', description: 'Whether this is a round trip (defaults to false)' }
      }
    },
    async execute(ctx, args = {}) {
      const { origin, destination, is_round_trip = false } = args;
      const calc = await calculateDrivingDistance(origin, destination);
      const rate = getSettingNumber('mileage_rate', 0.60);

      if (!calc) {
        return {
          success: false,
          message: `Could not calculate driving distance between "${origin}" and "${destination}". Please specify distance manually.`
        };
      }

      const oneWayKm = calc.distance_km;
      const totalKm = is_round_trip ? Math.round(oneWayKm * 2 * 10) / 10 : oneWayKm;
      const amount = Math.round(totalKm * rate * 100) / 100;

      return {
        success: true,
        origin,
        destination,
        is_round_trip,
        one_way_km: oneWayKm,
        total_distance_km: totalKm,
        mileage_rate: rate,
        calculated_amount: amount,
        formatted_amount: `RM ${amount.toFixed(2)}`,
        source: calc.source
      };
    }
  },
  {
    name: 'submit_claim',
    label: 'Submit Claim',
    description: 'Use when the user wants to submit, file, or claim an expense. For general/medical claims, required arguments are category and amount. For travel/mileage claims, pass origin, destination, is_round_trip, and optional distance_km — distance & amount will be automatically calculated if omitted.',
    type: 'write',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: {
      type: 'object',
      required: ['category'],
      properties: {
        category: { type: 'string', description: 'travel, medical, general, or benefits' },
        subcategory: { type: 'string', description: 'mileage, accommodation, outpatient, dental, etc.' },
        amount: { type: 'number', description: 'Claim amount in RM (required for non-mileage claims)' },
        origin: { type: 'string', description: 'Starting location (for travel/mileage claims)' },
        destination: { type: 'string', description: 'Destination location (for travel/mileage claims)' },
        is_round_trip: { type: 'boolean', description: 'Whether travel is round-trip' },
        distance_km: { type: 'number', description: 'Distance in KM (auto-calculated if origin and destination provided)' },
        description: { type: 'string', description: 'Optional description or trip details' }
      }
    },
    async execute(ctx, args) {
      const validCat = ['travel', 'medical', 'general', 'benefits'];
      const cat = (args.category || '').toLowerCase();
      if (!validCat.includes(cat)) throw new Error(`Invalid claim category "${args.category}". Valid: travel, medical, general, benefits.`);

      let subcat = (args.subcategory || (cat === 'travel' && (args.origin || args.destination) ? 'mileage' : cat)).toLowerCase();
      let amount = Number(args.amount);
      let origin = args.origin || null;
      let destination = args.destination || null;
      let isRoundTrip = args.is_round_trip ? 1 : 0;
      let distanceKm = args.distance_km ? Number(args.distance_km) : null;
      let mileageRate = null;

      // Handle travel mileage claims: compute distance & amount if origin/destination provided
      if (subcat === 'mileage' || (cat === 'travel' && (origin || destination))) {
        subcat = 'mileage';
        mileageRate = getSettingNumber('mileage_rate', 0.60);

        if (origin && destination && !distanceKm) {
          const calc = await calculateDrivingDistance(origin, destination);
          if (calc) {
            const oneWay = calc.distance_km;
            distanceKm = isRoundTrip ? Math.round(oneWay * 2 * 10) / 10 : oneWay;
          }
        }

        if (distanceKm) {
          amount = Math.round(distanceKm * mileageRate * 100) / 100;
        }
      }

      if (isNaN(amount) || amount <= 0) {
        throw new Error('Please provide a valid claim amount or origin and destination for distance calculation.');
      }

      const approverId = ctx.user.direct_superior_id || 1;
      const today = new Date().toISOString().slice(0, 10);
      const desc = args.description || (origin && destination ? `Travel from ${origin} to ${destination}${isRoundTrip ? ' (Round Trip)' : ''}` : 'Submitted via AI Assistant');

      const info = db.prepare(`
        INSERT INTO claims (user_id, category, subcategory, claim_date, description, amount, origin, destination, is_round_trip, distance_km, mileage_rate, status, approver_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(ctx.user.id, cat, subcat, today, desc, amount, origin, destination, isRoundTrip, distanceKm, mileageRate, approverId);

      logAudit(ctx.user.id, 'CREATE_CLAIM', { claim_id: info.lastInsertRowid, category: cat, subcategory: subcat, amount, origin, destination, distanceKm, via: 'AI Assistant' });

      return {
        success: true,
        claim_id: info.lastInsertRowid,
        category: cat,
        subcategory: subcat,
        origin,
        destination,
        distance_km: distanceKm,
        amount,
        status: 'pending',
        message: `Claim of RM ${amount.toFixed(2)} under ${cat.toUpperCase()} (${subcat}) submitted successfully!`
      };
    }
  },
  {
    name: 'approve_leave_request',
    label: 'Approve or Reject Leave Request',
    description: 'Approve or reject a team member leave application.',
    type: 'write',
    allowedTiers: ['manager', 'hiring_manager', 'admin', 'super_admin'],
    parameters: {
      type: 'object',
      required: ['leave_application_id', 'decision'],
      properties: { leave_application_id: { type: 'number' }, decision: { type: 'string' } }
    },
    async execute(ctx, args) {
      const app = db.prepare(`
        SELECT la.*, u.name as employee_name, lt.name as leave_type
        FROM leave_applications la
        JOIN users u ON u.id = la.user_id
        JOIN leave_types lt ON lt.id = la.leave_type_id
        WHERE la.id = ?
      `).get(args.leave_application_id);

      if (!app) throw new Error(`Leave application #${args.leave_application_id} not found.`);
      if (app.status !== 'pending') throw new Error(`Leave application #${app.id} is already ${app.status}.`);

      const decision = args.decision.toLowerCase();
      if (decision !== 'approved' && decision !== 'rejected') throw new Error('Decision must be "approved" or "rejected".');

      db.prepare('UPDATE leave_applications SET status = ?, approver_id = ? WHERE id = ?').run(decision, ctx.user.id, app.id);
      if (decision === 'approved') {
        const yr = new Date(app.start_date).getFullYear();
        db.prepare('UPDATE leave_balances SET used_days = used_days + ? WHERE user_id = ? AND leave_type_id = ? AND year = ?').run(app.days, app.user_id, app.leave_type_id, yr);
      }

      logAudit(ctx.user.id, 'APPROVE_LEAVE', { application_id: app.id, decision, employee: app.employee_name, via: 'AI Assistant' });

      return {
        success: true,
        application_id: app.id,
        decision,
        employee_name: app.employee_name,
        message: `Leave application #${app.id} for ${app.employee_name} has been ${decision}!`
      };
    }
  },
  {
    name: 'submit_ot_planning',
    label: 'Submit Overtime Pre-Approval',
    description: 'Submit overtime planning for pre-approval.',
    type: 'write',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: {
      type: 'object',
      required: ['date', 'hours'],
      properties: { date: { type: 'string' }, hours: { type: 'number' }, reason: { type: 'string' } }
    },
    async execute(ctx, args) {
      const hours = Number(args.hours);
      if (isNaN(hours) || hours <= 0) throw new Error('Hours must be a positive number.');
      const approverId = ctx.user.direct_superior_id || 1;
      logAudit(ctx.user.id, 'CREATE_OT_PLANNING', { date: args.date, hours, reason: args.reason || 'Overtime pre-approval via AI Assistant', via: 'AI Assistant' });
      return {
        success: true,
        date: args.date,
        hours,
        message: `Overtime pre-approval for ${hours} hour(s) on ${args.date} submitted successfully for manager review!`
      };
    }
  },
  {
    name: 'submit_out_of_office',
    label: 'Submit Out of Office Notice',
    description: 'Log out-of-office / site visit notice for work trips or client meetings.',
    type: 'write',
    allowedTiers: ['ess', 'manager', 'hiring_manager', 'admin', 'super_admin', 'it'],
    parameters: {
      type: 'object',
      required: ['start_date', 'end_date'],
      properties: { start_date: { type: 'string' }, end_date: { type: 'string' }, reason: { type: 'string' } }
    },
    async execute(ctx, args) {
      logAudit(ctx.user.id, 'CREATE_OUT_OF_OFFICE', { start_date: args.start_date, end_date: args.end_date, reason: args.reason || 'Out of office notice via AI Assistant', via: 'AI Assistant' });
      return {
        success: true,
        start_date: args.start_date,
        end_date: args.end_date,
        message: `Out-of-office notice for ${args.start_date} to ${args.end_date} logged successfully!`
      };
    }
  },
  {
    name: 'get_company_payroll_summary',
    label: 'Get Company Payroll Summary',
    description: 'Get company total salary payout, gross pay, deductions, and statutory totals for a specific month/year or latest run.',
    type: 'read',
    allowedTiers: ['manager', 'hiring_manager', 'admin', 'super_admin'],
    parameters: {
      type: 'object',
      properties: { month: { type: 'number' }, year: { type: 'number' } }
    },
    async execute(ctx, args = {}) {
      let run;
      if (args.month && args.year) {
        run = db.prepare('SELECT * FROM payroll_runs WHERE year = ? AND month = ?').get(args.year, args.month);
      } else {
        run = db.prepare('SELECT * FROM payroll_runs ORDER BY year DESC, month DESC LIMIT 1').get();
      }

      if (!run) {
        return { found: false, message: 'No payroll run records found in the system.' };
      }

      const stats = db.prepare(`
        SELECT 
          COUNT(*) as total_employees,
          COALESCE(SUM(basic_salary), 0) as total_basic,
          COALESCE(SUM(allowances), 0) as total_allowances,
          COALESCE(SUM(overtime), 0) as total_overtime,
          COALESCE(SUM(gross_pay), 0) as total_gross_pay,
          COALESCE(SUM(epf_employee + epf_employer), 0) as total_epf,
          COALESCE(SUM(socso_employee + socso_employer), 0) as total_socso,
          COALESCE(SUM(eis_employee + eis_employer), 0) as total_eis,
          COALESCE(SUM(pcb), 0) as total_pcb,
          COALESCE(SUM(net_pay), 0) as total_net_payout
        FROM payslips
        WHERE payroll_run_id = ?
      `).get(run.id);

      return {
        found: true,
        period: `${run.year}-${String(run.month).padStart(2, '0')}`,
        status: run.status,
        ...stats
      };
    }
  }
];

function getToolsForUser(user) {
  if (!user || !user.permission_tier) return [];
  const tier = user.permission_tier;
  return TOOLS.filter(t => t.allowedTiers.includes(tier));
}

function getToolByName(name) {
  return TOOLS.find(t => t.name === name);
}

module.exports = {
  TOOLS,
  getToolsForUser,
  getToolByName
};
