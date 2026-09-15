# StaffHub

A full-stack Human Resource Management System covering Employee Profiles, Attendance,
Leave Management, Claims (Travel & Medical), Payroll, and Reports (Payslips & EA Forms).

## Why this isn't Next.js / Prisma / NextAuth

The project brief calls for Next.js + Prisma + NextAuth, but this app was built in an
environment with **no access to the npm package registry** (neither in the build
sandbox nor in the bridge to your computer), so `npm install` could not be run or
verified for any framework. To deliver something that actually runs and was actually
tested end-to-end, this app uses **only Node.js's own built-in modules**:

- `node:http` — the web server and a small hand-rolled router
- `node:sqlite` (built into Node 22.5+) — the database, no driver install needed
- `node:crypto` — password hashing (scrypt) and signed session tokens
- Tailwind CSS is loaded from its CDN **in your browser** (not during the build), so
  styling works normally once the page is open — no build step required

**Result: zero `npm install` required.** You only need Node.js 22.5 or newer.

If you'd rather have the Next.js/Prisma/NextAuth stack as originally specified, ask and
it can be hand-written for you — you'd then run `npm install` yourself in a normal
terminal (which has real internet access, unlike this build sandbox) and report back
any errors to fix.

## Running it

```bash
cd path/to/this/folder
node db/seed.js   # first time only — creates data/hrms.db with demo data
node server.js    # starts the app at http://localhost:3000
```

Open http://localhost:3000 in your browser.

### Demo accounts (password: `password123`)

| Role        | Email                       |
|-------------|------------------------------|
| Super Admin | superadmin@staffhub.my      |
| HR Admin    | hradmin@staffhub.my         |
| Approver    | approver@staffhub.my        |
| Employee    | employee@staffhub.my        |
| Employee    | kevin.tan@staffhub.my       |

## Roles

Four roles, each ranking at or above the one before it (`lib/auth.js` `ROLE_RANK` / `hasRole()`) — a higher role automatically gets everything a lower one can do:

1. **Employee** — self-service: profile, attendance, leave, claims, own payslips/EA forms.
2. **Approver** — everything an Employee can do, plus approving leave/claims for their direct reports and viewing their team's attendance. This is the "manager" role from earlier versions, just renamed.
3. **HR Admin** — everything an Approver can do, plus the full Employee Directory (add/edit any employee), Payroll, and sees company-wide (not just their own team's) approvals and attendance.
4. **Super Admin** — everything HR Admin can do, plus **Company Settings**: company name (shown on payslips/EA forms), default mileage rate, late-attendance cutoff time, default annual medical limits, and leave type/entitlement management. Only a Super Admin can grant the Super Admin role to someone else — HR Admins can't self-escalate or promote others to it.

If your existing `data/hrms.db` still has employees with the old `manager` role, the app migrates them to `approver` automatically the first time it starts against the new code — no manual steps needed.

## Modules

- **Employee Profile & Core HR** — employee directory, employment history, emergency
  contacts, role-based access (see Roles above). HR Admin/Super Admin can add/edit
  employees; employees self-manage their own contact details.
- **Company Settings (Super Admin only)** — configure the company name used on
  payslips/EA forms, default mileage rate, late-attendance cutoff, default annual
  medical limits, and leave types & entitlements. New employees are automatically
  provisioned with the current leave-type entitlements when added.
- **Attendance** — web clock in/out, personal history, and a team view for
  managers/HR (date queries are clamped to never go into the future).
- **Leave Management** — apply for annual/medical/emergency leave, automatic balance
  tracking, manager/HR approval workflow.
- **Claims** — itemized travel claims (mileage is server-computed and locked from
  distance × rate, editable toll/parking), and medical claims with annual
  outpatient/dental limits and MC linkage. Receipts attach as images/PDFs.
- **Payroll** — generates a draft payslip per active employee from their basic salary,
  computes EPF/SOCSO/EIS/PCB automatically, lets HR adjust allowances/overtime/other
  deductions, then finalize the run.
- **Reports** — employees can view/print their finalized payslips and generate an
  annual EA Form (Borang CP8A) from the year's finalized payroll runs. There's no PDF
  library available offline, so these are print-ready HTML pages — use your browser's
  "Print → Save as PDF".

## What's stubbed / not wired up yet

- **Google Places Autocomplete & Distance Matrix** — the travel claim form takes a
  plain-text origin/destination and a manually entered distance. Once you have a
  Google Maps API key, the distance field can be wired to the Distance Matrix/Routes
  API and the location fields to Places Autocomplete.
- **Receipt OCR** — receipts are stored as-is (base64) for manual HR review; no OCR
  parsing is wired up.
- **The natural-language AI agent layer** (Claude-powered tool calling for things like
  "book annual leave for next Tuesday") — deferred per your request, to be layered on
  top of these modules once they're solid. `api.anthropic.com` access does work from
  this build environment, so that layer is very buildable next.

## Statutory payroll rates — read before relying on this for real payroll

`lib/statutory.js` implements EPF (KWSP), SOCSO/EIS (PERKESO) and PCB/MTD (LHDN) using
simplified 2025/2026-era rates gathered via web search during this build (not fetched
directly from the official KWSP/PERKESO/LHDN portals). In particular:

- EPF/SOCSO are approximated as flat percentages, not the official wage-band tables.
- PCB is a flat annual-tax-÷-12 estimate, not LHDN's exact cumulative MTD formula.

**Verify all rates against the current official KWSP contribution table, PERKESO
contribution table, and LHDN's PCB Calculator / e-Data PCB before using this for real
payroll.**

## Project structure

```
server.js          entry point + router
db/schema.sql       SQLite schema (auto-applied on startup)
db/seed.js           demo data
lib/auth.js          sessions + password hashing
lib/statutory.js      EPF/SOCSO/EIS/PCB calculations
lib/render.js         HTML layout/components
lib/util.js            request/response helpers
routes/*.js             one file per module
public/                Tailwind config + small CSS/JS
```
