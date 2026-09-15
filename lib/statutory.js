'use strict';
/**
 * Malaysia statutory payroll calculations — EPF (KWSP), SOCSO/EIS (PERKESO), PCB/MTD (LHDN).
 *
 * IMPORTANT — READ BEFORE USING FOR REAL PAYROLL:
 * These rates/brackets are simplified approximations of the publicly documented
 * 2025/2026-era rules, implemented for a prototype HRMS. They are NOT sourced
 * directly from the official KWSP/PERKESO/LHDN portals in this session (no
 * network access to verify against the primary sources at build time), and:
 *   - EPF/SOCSO are normally computed off official wage-band ("Third Schedule")
 *     tables, not pure percentages — this engine uses percentage approximations,
 *     which can differ from the official table by a few sen per band.
 *   - PCB here is a flat annual-tax/12 estimate, not LHDN's exact cumulative
 *     MTD formula (which carries forward already-deducted PCB, zakat, and
 *     rebates month to month via the PCB/e-PCB formula).
 * Before running real payroll, HR must verify these against the current
 * official KWSP contribution table, PERKESO contribution table, and LHDN's
 * PCB Calculator / e-Data PCB, and update the constants below accordingly.
 */

// ---------------- EPF (KWSP) ----------------
const EPF = {
  employeeRateBelow60: 0.11,
  employeeRateAbove60: 0.055,
  employerRateBelow60Low: 0.13, // wages <= RM5,000
  employerRateBelow60High: 0.12, // wages > RM5,000
  employerRateAbove60Low: 0.065,
  employerRateAbove60High: 0.06,
  wageThreshold: 5000,
};

function calcEpf(wage, age) {
  const isSenior = age >= 60;
  const employeeRate = isSenior ? EPF.employeeRateAbove60 : EPF.employeeRateBelow60;
  const employerRate = isSenior
    ? (wage <= EPF.wageThreshold ? EPF.employerRateAbove60Low : EPF.employerRateAbove60High)
    : (wage <= EPF.wageThreshold ? EPF.employerRateBelow60Low : EPF.employerRateBelow60High);
  return {
    employee: round2(wage * employeeRate),
    employer: round2(wage * employerRate),
  };
}

// ---------------- SOCSO + EIS (PERKESO) ----------------
const SOCSO = {
  wageCeiling: 6000, // contributions computed on wage capped at this ceiling
  cat1EmployeeRate: 0.005,
  cat1EmployerRate: 0.0175,
  cat2EmployerRate: 0.0125, // employment injury only, age 60+
  eisEmployeeRate: 0.002,
  eisEmployerRate: 0.002,
  eisMaxAge: 60,
};

function calcSocsoEis(wage, age, opts = {}) {
  const cappedWage = Math.min(wage, SOCSO.wageCeiling);
  const isSenior = age >= 60;
  const eisExempt = !!opts.eisExempt; // e.g. foreign worker, not Malaysian/PR

  let socsoEmployee = 0;
  let socsoEmployer = 0;
  if (isSenior) {
    socsoEmployer = round2(cappedWage * SOCSO.cat2EmployerRate);
  } else {
    socsoEmployee = round2(cappedWage * SOCSO.cat1EmployeeRate);
    socsoEmployer = round2(cappedWage * SOCSO.cat1EmployerRate);
  }

  let eisEmployee = 0;
  let eisEmployer = 0;
  if (!isSenior && !eisExempt) {
    eisEmployee = round2(cappedWage * SOCSO.eisEmployeeRate);
    eisEmployer = round2(cappedWage * SOCSO.eisEmployerRate);
  }

  return { socsoEmployee, socsoEmployer, eisEmployee, eisEmployer };
}

// ---------------- PCB / MTD (LHDN) — simplified estimate ----------------
// Progressive annual chargeable-income brackets (resident individual, approx. YA2025/2026).
const TAX_BRACKETS = [
  { upTo: 5000, rate: 0 },
  { upTo: 20000, rate: 0.01 },
  { upTo: 35000, rate: 0.03 },
  { upTo: 50000, rate: 0.08 },
  { upTo: 70000, rate: 0.14 },
  { upTo: 100000, rate: 0.21 },
  { upTo: 250000, rate: 0.24 },
  { upTo: 400000, rate: 0.245 },
  { upTo: 600000, rate: 0.25 },
  { upTo: 2000000, rate: 0.28 },
  { upTo: Infinity, rate: 0.30 },
];

const RELIEF = {
  personal: 9000,
  spouse: 4000, // if married and spouse has no/low income — simplified: applied whenever marital_status = 'married'
  childUnder18: 2000,
  epfReliefCap: 4000,
};

function annualTaxOnChargeableIncome(chargeable) {
  if (chargeable <= 0) return 0;
  let tax = 0;
  let lastCap = 0;
  for (const bracket of TAX_BRACKETS) {
    if (chargeable > bracket.upTo) {
      tax += (bracket.upTo - lastCap) * bracket.rate;
      lastCap = bracket.upTo;
    } else {
      tax += (chargeable - lastCap) * bracket.rate;
      break;
    }
  }
  return tax;
}

function calcPcb(monthlyWage, employee) {
  const annualGross = monthlyWage * 12;
  const annualEpfEmployee = calcEpf(monthlyWage, ageFromDob(employee.date_of_birth)).employee * 12;
  const epfRelief = Math.min(annualEpfEmployee, RELIEF.epfReliefCap);

  let reliefs = RELIEF.personal + epfRelief;
  if (employee.marital_status === 'married') reliefs += RELIEF.spouse;
  const children = Number(employee.num_children || 0);
  reliefs += children * RELIEF.childUnder18;

  const chargeable = Math.max(0, annualGross - reliefs);
  const annualTax = annualTaxOnChargeableIncome(chargeable);
  const monthlyPcb = round2(annualTax / 12);
  return monthlyPcb;
}

function ageFromDob(dob) {
  if (!dob) return 30; // default assumption when not on file
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return 30;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Full gross-to-net computation for one employee for one payroll run.
 * @param {{basic_salary:number, allowances?:number, overtime?:number, other_deductions?:number, date_of_birth?:string, marital_status?:string, num_children?:number}} employee
 */
function computePayslip(employee) {
  const basic = Number(employee.basic_salary || 0);
  const allowances = Number(employee.allowances || 0);
  const overtime = Number(employee.overtime || 0);
  const otherDeductions = Number(employee.other_deductions || 0);
  const gross = round2(basic + allowances + overtime);
  const age = ageFromDob(employee.date_of_birth);

  const epf = calcEpf(gross, age);
  const { socsoEmployee, socsoEmployer, eisEmployee, eisEmployer } = calcSocsoEis(gross, age, {
    eisExempt: employee.eis_exempt,
  });
  const pcb = calcPcb(gross, employee);

  const totalDeductions = round2(epf.employee + socsoEmployee + eisEmployee + pcb + otherDeductions);
  const netPay = round2(gross - totalDeductions);

  return {
    basic_salary: basic,
    allowances,
    overtime,
    gross_pay: gross,
    epf_employee: epf.employee,
    epf_employer: epf.employer,
    socso_employee: socsoEmployee,
    socso_employer: socsoEmployer,
    eis_employee: eisEmployee,
    eis_employer: eisEmployer,
    pcb,
    other_deductions: otherDeductions,
    net_pay: netPay,
  };
}

module.exports = {
  calcEpf,
  calcSocsoEis,
  calcPcb,
  computePayslip,
  ageFromDob,
  round2,
  EPF,
  SOCSO,
  TAX_BRACKETS,
  RELIEF,
};
