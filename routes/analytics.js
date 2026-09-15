'use strict';
const db = require('../db');
const { sendHtml, redirect } = require('../lib/util');
const { layout, card, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin } = require('../lib/auth');
const { isModuleEnabled } = require('../lib/settings');

function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('analytics');
}

const COLORS = ['#6366f1','#10b981','#f59e0b','#ef4444','#3b82f6','#8b5cf6','#ec4899','#14b8a6'];

function svgBarChart(data, opts) {
  const o = opts || {};
  const width = o.width || 520; const height = o.height || 180;
  const labelKey = o.labelKey || 'label'; const valueKey = o.valueKey || 'value';
  const color = o.color || '#6366f1'; const suffix = o.suffix || '';
  if (!data.length) return '<p class=\"text-slate-400 text-sm italic\">No data</p>';
  const max = Math.max.apply(null, data.map(function(d){return d[valueKey];}));
  const barW = Math.floor((width - 40) / data.length) - 6;
  const chartH = height - 50;
  const bars = data.map(function(d, i) {
    const bh = Math.max(4, Math.round((d[valueKey] / (max||1)) * chartH));
    const x = 20 + i * (barW + 6); const y = chartH - bh + 10;
    const lbl = String(d[labelKey]).length > 8 ? String(d[labelKey]).slice(0,7)+'...' : String(d[labelKey]);
    return '<rect x=\"'+x+'\" y=\"'+y+'\" width=\"'+barW+'\" height=\"'+bh+'\" rx=\"3\" fill=\"'+color+'\" opacity=\"0.85\"/>'+
      '<text x=\"'+(x+barW/2)+'\" y=\"'+(y-4)+'\" text-anchor=\"middle\" font-size=\"9\" fill=\"#64748b\">'+d[valueKey]+suffix+'</text>'+
      '<text x=\"'+(x+barW/2)+'\" y=\"'+(chartH+24)+'\" text-anchor=\"middle\" font-size=\"9\" fill=\"#94a3b8\">'+lbl+'</text>';
  }).join('');
  return '<svg viewBox=\"0 0 '+width+' '+height+'\" style=\"width:100%;height:'+height+'px;overflow:visible\">'+
    '<line x1=\"20\" y1=\"'+(chartH+10)+'\" x2=\"'+(width-10)+'\" y2=\"'+(chartH+10)+'\" stroke=\"#e2e8f0\" stroke-width=\"1\"/>'+bars+'</svg>';
}

function svgLineChart(data, opts) {
  const o = opts || {};
  const width = o.width || 520; const height = o.height || 160;
  const labelKey = o.labelKey || 'label'; const valueKey = o.valueKey || 'value';
  const color = o.color || '#6366f1'; const suffix = o.suffix || '';
  if (!data || data.length < 2) return svgBarChart(data||[], o);
  const max = Math.max.apply(null, data.map(function(d){return d[valueKey];}));
  const min = Math.min.apply(null, data.map(function(d){return d[valueKey];}));
  const range = (max - min) || 1;
  const chartH = height - 50; const chartW = width - 40;
  const step = chartW / (data.length - 1);
  const pts = data.map(function(d,i){
    return {x: 20+i*step, y: 10+chartH-Math.round(((d[valueKey]-min)/range)*chartH), d:d};
  });
  const poly = pts.map(function(p){return p.x+','+p.y;}).join(' ');
  const area = 'M'+pts[0].x+','+(chartH+10)+' '+pts.map(function(p){return 'L'+p.x+','+p.y;}).join(' ')+' L'+pts[pts.length-1].x+','+(chartH+10)+' Z';
  const dots = pts.map(function(p){
    return '<circle cx=\"'+p.x+'\" cy=\"'+p.y+'\" r=\"3\" fill=\"'+color+'\"/>'+
      '<text x=\"'+p.x+'\" y=\"'+(p.y-6)+'\" text-anchor=\"middle\" font-size=\"9\" fill=\"#64748b\">'+p.d[valueKey]+suffix+'</text>'+
      '<text x=\"'+p.x+'\" y=\"'+(chartH+24)+'\" text-anchor=\"middle\" font-size=\"9\" fill=\"#94a3b8\">'+p.d[labelKey]+'</text>';
  }).join('');
  return '<svg viewBox=\"0 0 '+width+' '+height+'\" style=\"width:100%;height:'+height+'px;overflow:visible\">'+
    '<path d=\"'+area+'\" fill=\"'+color+'\" opacity=\"0.1\" />'+
    '<polyline points=\"'+poly+'\" fill=\"none\" stroke=\"'+color+'\" stroke-width=\"2\" stroke-linejoin=\"round\"/>'+
    dots+'<line x1=\"20\" y1=\"'+(chartH+10)+'\" x2=\"'+(width-10)+'\" y2=\"'+(chartH+10)+'\" stroke=\"#e2e8f0\" stroke-width=\"1\"/></svg>';
}

function svgDonut(slices) {
  if (!slices || !slices.length) return '<p class=\"text-slate-400 text-sm italic\">No data</p>';
  const total = slices.reduce(function(s,x){return s+x.value;},0)||1;
  const r=50;const cx=75;const cy=75;let angle=-Math.PI/2;
  const paths = slices.map(function(s,i){
    const sweep=(s.value/total)*2*Math.PI;
    const x1=cx+r*Math.cos(angle);const y1=cy+r*Math.sin(angle);
    const x2=cx+r*Math.cos(angle+sweep);const y2=cy+r*Math.sin(angle+sweep);
    const large=sweep>Math.PI?1:0;
    const d='M '+cx+' '+cy+' L '+x1+' '+y1+' A '+r+' '+r+' 0 '+large+' 1 '+x2+' '+y2+' Z';
    angle+=sweep;
    return '<path d=\"'+d+'\" fill=\"'+COLORS[i%COLORS.length]+'\" opacity=\"0.85\"/>';
  }).join('');
  const legend=slices.map(function(s,i){
    return '<div class=\"flex items-center gap-2 text-xs\"><span class=\"w-3 h-3 rounded-sm shrink-0\" style=\"background:'+COLORS[i%COLORS.length]+'\"></span><span class=\"text-slate-600 dark:text-slate-300\">'+escapeHtml(s.label)+'</span><span class=\"ml-auto font-semibold\">'+s.value+'</span></div>';
  }).join('');
  return '<div class=\"flex items-center gap-4\"><svg viewBox=\"0 0 150 150\" style=\"width:120px;height:120px;shrink:0\">'+paths+'<circle cx=\"'+cx+'\" cy=\"'+cy+'\" r=\"28\" fill=\"white\"/></svg><div class=\"flex flex-col gap-1.5 flex-1\">'+legend+'</div></div>';
}

function statBox(label, value, sub, color, icon) {
  const c = color || 'indigo';
  const pal = {
    indigo: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 border-indigo-100',
    green: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 border-emerald-100',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300 border-amber-100',
    red: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300 border-red-100',
    blue: 'bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 border-blue-100'
  };
  return `<div class="rounded-2xl p-4 border shadow-sm ${pal[c] || pal.indigo} transition-transform hover:-translate-y-0.5">
    <div class="flex items-center justify-between">
      <div class="text-xs uppercase font-bold tracking-wider opacity-80">${label}</div>
      ${icon ? `<span class="text-lg opacity-80">${icon}</span>` : ''}
    </div>
    <div class="text-2xl font-extrabold mt-2">${value}</div>
    ${sub ? `<div class="text-xs mt-1 opacity-75 font-medium">${sub}</div>` : ''}
  </div>`;
}

module.exports = function(router) {
  router.get('/analytics', async function(ctx) {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!hasAccess(ctx.user, ['admin','manager'])) return redirect(ctx.res, '/?error=Access+denied');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=Analytics+not+enabled');
    const user = ctx.user;
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // 1. Headcount
    const totalActive = db.prepare('SELECT COUNT(*) c FROM users WHERE status=\'active\'').get().c;
    const totalInactive = db.prepare('SELECT COUNT(*) c FROM users WHERE status=\'inactive\'').get().c;
    const byDept = db.prepare('SELECT department, COUNT(*) c FROM users WHERE status=\'active\' AND department IS NOT NULL GROUP BY department ORDER BY c DESC LIMIT 10').all();
    const byType = db.prepare('SELECT COALESCE(employment_type,\'Unspecified\') t, COUNT(*) c FROM users WHERE status=\'active\' GROUP BY t ORDER BY c DESC').all();
    const byGender = db.prepare('SELECT COALESCE(gender,\'Unspecified\') g, COUNT(*) c FROM users WHERE status=\'active\' GROUP BY g ORDER BY c DESC').all();
    const avgTenure = db.prepare('SELECT AVG((julianday(\'now\')-julianday(join_date))/365.25) v FROM users WHERE status=\'active\' AND join_date IS NOT NULL').get().v;

    // 2. Leave
    const leaveByType = db.prepare('SELECT lt.name, COUNT(*) c FROM leave_applications la JOIN leave_types lt ON lt.id=la.leave_type_id WHERE la.status=\'approved\' GROUP BY lt.name ORDER BY c DESC').all();
    const leaveByDept = db.prepare('SELECT u.department, COUNT(*) c FROM leave_applications la JOIN users u ON u.id=la.user_id WHERE la.status=\'approved\' AND u.department IS NOT NULL GROUP BY u.department ORDER BY c DESC LIMIT 8').all();
    const leaveStatus = db.prepare('SELECT status, COUNT(*) c FROM leave_applications GROUP BY status').all();
    const leaveTrend = db.prepare('SELECT substr(start_date,1,7) ym, COUNT(*) c FROM leave_applications WHERE status=\'approved\' AND start_date >= \'2026-01-01\' GROUP BY ym ORDER BY ym').all();

    // 3. Payroll
    const payrollMonths = db.prepare('SELECT r.month, r.year, ROUND(SUM(p.gross_pay),0) gross, ROUND(SUM(p.net_pay),0) net, ROUND(SUM(p.epf_employee+p.epf_employer),0) epf, COUNT(p.id) hc FROM payroll_runs r JOIN payslips p ON p.payroll_run_id=r.id WHERE r.status=\'finalized\' GROUP BY r.year,r.month ORDER BY r.year,r.month').all();
    const latest = payrollMonths.length ? payrollMonths[payrollMonths.length-1] : null;
    const avgByDept = db.prepare('SELECT department, ROUND(AVG(basic_salary),0) avg FROM users WHERE status=\'active\' AND department IS NOT NULL AND basic_salary>0 GROUP BY department ORDER BY avg DESC LIMIT 10').all();

    // 4. Attendance
    const attPresent = db.prepare('SELECT COUNT(*) c FROM attendance_logs WHERE status=\'present\'').get().c;
    const attLate = db.prepare('SELECT COUNT(*) c FROM attendance_logs WHERE status=\'late\'').get().c;
    const attAbsent = db.prepare('SELECT COUNT(*) c FROM attendance_logs WHERE status=\'absent\'').get().c;
    const attTrend = db.prepare('SELECT substr(work_date,1,7) ym, ROUND(100.0*SUM(CASE WHEN status IN (\'present\',\'late\') THEN 1 ELSE 0 END)/COUNT(*),1) rate FROM attendance_logs WHERE work_date >= \'2026-01-01\' GROUP BY ym ORDER BY ym').all();
    const lateByDept = db.prepare('SELECT u.department, COUNT(*) c FROM attendance_logs al JOIN users u ON u.id=al.user_id WHERE al.status=\'late\' AND u.department IS NOT NULL GROUP BY u.department ORDER BY c DESC LIMIT 8').all();

    // 5. Claims
    const claimsByCat = db.prepare('SELECT category, COUNT(*) c, ROUND(SUM(amount),0) total FROM claims GROUP BY category ORDER BY total DESC').all();
    const claimsPending = db.prepare('SELECT COUNT(*) c FROM claims WHERE status=\'pending\'').get().c;
    const claimsApproved = db.prepare('SELECT COUNT(*) c FROM claims WHERE status=\'approved\'').get().c;
    const claimsTrend = db.prepare('SELECT substr(claim_date,1,7) ym, ROUND(SUM(amount),0) total FROM claims WHERE claim_date >= \'2026-01-01\' GROUP BY ym ORDER BY ym').all();

    // 6. Recruitment
    const reqByStatus = db.prepare('SELECT status, COUNT(*) c FROM job_requisitions GROUP BY status').all();
    const candByStage = db.prepare('SELECT stage, COUNT(*) c FROM candidates GROUP BY stage ORDER BY c DESC').all();
    const openReqs = db.prepare('SELECT COUNT(*) c FROM job_requisitions WHERE status=\'approved\'').get().c;
    const hiredCount = db.prepare('SELECT COUNT(*) c FROM candidates WHERE stage=\'hired\'').get().c;

    const lv = function(arr,k){const r=arr.find(function(s){return s.status===k;});return r?r.c:0;};

    // YoY Comparison (2025 vs 2026)
    const yoyJoins2025 = db.prepare("SELECT COUNT(*) c FROM users WHERE join_date >= '2025-01-01' AND join_date <= '2025-12-31'").get().c;
    const yoyJoins2026 = db.prepare("SELECT COUNT(*) c FROM users WHERE join_date >= '2026-01-01' AND join_date <= '2026-12-31'").get().c;
    const yoyResig2025 = db.prepare("SELECT COUNT(*) c FROM users WHERE resignation_date >= '2025-01-01' AND resignation_date <= '2025-12-31'").get().c;
    const yoyResig2026 = db.prepare("SELECT COUNT(*) c FROM users WHERE resignation_date >= '2026-01-01' AND resignation_date <= '2026-12-31'").get().c;
    const yoyPayroll2025 = db.prepare("SELECT ROUND(SUM(p.gross_pay),0) total FROM payroll_runs r JOIN payslips p ON p.payroll_run_id=r.id WHERE r.year=2025 AND r.status='finalized'").get().total || 0;
    const yoyPayroll2026 = db.prepare("SELECT ROUND(SUM(p.gross_pay),0) total FROM payroll_runs r JOIN payslips p ON p.payroll_run_id=r.id WHERE r.year=2026 AND r.status='finalized'").get().total || 0;
    const yoyClaims2025 = db.prepare("SELECT ROUND(SUM(amount),0) total FROM claims WHERE claim_date >= '2025-01-01' AND claim_date <= '2025-12-31' AND status='approved'").get().total || 0;
    const yoyClaims2026 = db.prepare("SELECT ROUND(SUM(amount),0) total FROM claims WHERE claim_date >= '2026-01-01' AND claim_date <= '2026-12-31' AND status='approved'").get().total || 0;

    const joinGrowth = yoyJoins2025 > 0 ? (((yoyJoins2026 - yoyJoins2025) / yoyJoins2025) * 100).toFixed(1) : '—';
    const resigGrowth = yoyResig2025 > 0 ? (((yoyResig2026 - yoyResig2025) / yoyResig2025) * 100).toFixed(1) : '—';
    const payrollGrowth = yoyPayroll2025 > 0 ? (((yoyPayroll2026 - yoyPayroll2025) / yoyPayroll2025) * 100).toFixed(1) : '—';
    const claimsGrowth = yoyClaims2025 > 0 ? (((yoyClaims2026 - yoyClaims2025) / yoyClaims2025) * 100).toFixed(1) : '—';

    // JSON chart data definitions
    const chartDataJson = JSON.stringify({
      byDept: { labels: byDept.map(r => r.department), data: byDept.map(r => r.c) },
      yoyHires: { labels: ['2025 Total Hires', '2026 YTD Hires'], data: [yoyJoins2025, yoyJoins2026] },
      byType: { labels: byType.map(r => r.t), data: byType.map(r => r.c) },
      byGender: { labels: byGender.map(r => r.g), data: byGender.map(r => r.c) },
      leaveByType: { labels: leaveByType.map(r => r.name), data: leaveByType.map(r => r.c) },
      leaveByDept: { labels: leaveByDept.map(r => r.department), data: leaveByDept.map(r => r.c) },
      leaveTrend: { labels: leaveTrend.map(r => r.ym.slice(5)), data: leaveTrend.map(r => r.c) },
      payrollGross: { labels: payrollMonths.map(r => MONTHS[r.month-1]), data: payrollMonths.map(r => Math.round(r.gross/1000)) },
      avgByDept: { labels: avgByDept.map(r => r.department), data: avgByDept.map(r => r.avg) },
      attTrend: { labels: attTrend.map(r => r.ym.slice(5)), data: attTrend.map(r => parseFloat(r.rate)||0) },
      lateByDept: { labels: lateByDept.map(r => r.department), data: lateByDept.map(r => r.c) },
      claimsByCat: { labels: claimsByCat.map(r => r.category), data: claimsByCat.map(r => r.total) },
      claimsTrend: { labels: claimsTrend.map(r => r.ym.slice(5)), data: claimsTrend.map(r => r.total) },
      candByStage: { labels: candByStage.map(r => r.stage), data: candByStage.map(r => r.c) },
      reqByStatus: { labels: reqByStatus.map(r => r.status), data: reqByStatus.map(r => r.c) },
    });

    const body = `
      <!-- Load Chart.js CDN for responsive HTML5 Canvas charts -->
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-4">
        <div>
          <h1 class="text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            📊 HR Executive Analytics & Infographics
          </h1>
          <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Visualized interactive workforce metrics, trends, breakdown charts & Year-over-Year (YoY) benchmarking
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="window.print()" class="px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-slate-700 dark:text-slate-200 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition">
            🖨️ Print / Save Report
          </button>
        </div>
      </div>

      <!-- Year-over-Year Summary Cards -->
      <div class="mb-8 p-5 bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-2xl shadow-md border border-indigo-900">
        <h2 class="text-base font-semibold mb-3 flex items-center gap-2 text-indigo-200">
          📈 Executive Summary: 2025 vs 2026 Year-over-Year Benchmarks
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          ${statBox('New Hires (YoY)', yoyJoins2026 + ' vs ' + yoyJoins2025, (joinGrowth >= 0 ? '+' : '') + joinGrowth + '% vs 2025', 'indigo', '👥')}
          ${statBox('Resignations (YoY)', yoyResig2026 + ' vs ' + yoyResig2025, (resigGrowth >= 0 ? '+' : '') + resigGrowth + '% vs 2025', 'amber', '🚪')}
          ${statBox('Annual Payroll (YoY)', 'RM ' + Math.round(yoyPayroll2026/1000) + 'k vs ' + Math.round(yoyPayroll2025/1000) + 'k', (payrollGrowth >= 0 ? '+' : '') + payrollGrowth + '% vs 2025', 'green', '💰')}
          ${statBox('Total Claims (YoY)', 'RM ' + yoyClaims2026.toLocaleString() + ' vs ' + yoyClaims2025.toLocaleString(), (claimsGrowth >= 0 ? '+' : '') + claimsGrowth + '% vs 2025', 'blue', '🧾')}
        </div>
      </div>

      <!-- Headcount Section -->
      <div class="mb-8">
        <h2 class="text-lg font-semibold mb-4 text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <span>👥</span> Headcount Distribution & Growth
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          ${statBox('Active Staff', totalActive, 'Current workforce', 'green', '✅')}
          ${statBox('Inactive / Exited', totalInactive, 'Historical exits', 'red', '❌')}
          ${statBox('Avg. Tenure', (avgTenure||0).toFixed(1)+' Yrs', 'Active employees', 'blue', '⏳')}
          ${statBox('Departments', byDept.length, 'Active business units', 'indigo', '🏢')}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          ${card('Headcount by Department (Top 10)', `
            <div style="position: relative; height: 260px; width: 100%;">
              <canvas id="chartDeptBar"></canvas>
            </div>
          `)}
          ${card('YoY Recruitment Hiring Velocity', `
            <div style="position: relative; height: 260px; width: 100%;">
              <canvas id="chartYoyHiresBar"></canvas>
            </div>
          `)}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          ${card('Workforce by Employment Type', `
            <div style="position: relative; height: 240px; width: 100%;">
              <canvas id="chartEmploymentTypeDonut"></canvas>
            </div>
          `)}
          ${card('Gender Diversity Demographics', `
            <div style="position: relative; height: 240px; width: 100%;">
              <canvas id="chartGenderDonut"></canvas>
            </div>
          `)}
        </div>
      </div>

      <!-- Payroll Analytics -->
      <div class="mb-8">
        <h2 class="text-lg font-semibold mb-4 text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <span>💵</span> Payroll Expenditure Analytics
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          ${statBox('Latest Gross Payroll', latest ? 'RM ' + Number(latest.gross).toLocaleString('en-MY') : '—', latest ? MONTHS[latest.month-1]+' '+latest.year : 'No runs', 'green', '💳')}
          ${statBox('Latest Net Payout', latest ? 'RM ' + Number(latest.net).toLocaleString('en-MY') : '—', 'Take-home total', 'indigo', '🏦')}
          ${statBox('Statutory EPF Total', latest ? 'RM ' + Number(latest.epf).toLocaleString('en-MY') : '—', 'Employer + Employee', 'blue', '📊')}
          ${statBox('Processed Employees', latest ? latest.hc : '—', 'In active payslip run', 'amber', '📋')}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          ${card('Monthly Gross Payroll Trend 2026 (RM in Thousands)', `
            <div style="position: relative; height: 260px; width: 100%;">
              <canvas id="chartPayrollTrendLine"></canvas>
            </div>
          `)}
          ${card('Average Basic Salary by Department (RM)', `
            <div style="position: relative; height: 260px; width: 100%;">
              <canvas id="chartAvgSalaryBar"></canvas>
            </div>
          `)}
        </div>
      </div>

      <!-- Leave & Attendance Section -->
      <div class="mb-8">
        <h2 class="text-lg font-semibold mb-4 text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <span>🏖️</span> Leave & Attendance Utilization
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          ${statBox('Approved Leave', lv(leaveStatus,'approved'), 'Total approved requests', 'green', '✔️')}
          ${statBox('Pending Requests', lv(leaveStatus,'pending'), 'Awaiting manager action', 'amber', '⏳')}
          ${statBox('Attendance Rate', (attTrend.length ? attTrend[attTrend.length-1].rate : 0) + '%', 'Latest monthly average', 'indigo', '🎯')}
          ${statBox('Late Arrivals', attLate.toLocaleString(), 'Cumulative records', 'red', '⏰')}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          ${card('Leave Distribution by Leave Type', `
            <div style="position: relative; height: 250px; width: 100%;">
              <canvas id="chartLeaveTypeDonut"></canvas>
            </div>
          `)}
          ${card('Leave Application Volume by Department', `
            <div style="position: relative; height: 250px; width: 100%;">
              <canvas id="chartLeaveDeptBar"></canvas>
            </div>
          `)}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          ${card('Monthly Attendance Punctuality Rate Trend (%)', `
            <div style="position: relative; height: 250px; width: 100%;">
              <canvas id="chartAttTrendLine"></canvas>
            </div>
          `)}
          ${card('Late Arrival Frequency by Department', `
            <div style="position: relative; height: 250px; width: 100%;">
              <canvas id="chartLateDeptBar"></canvas>
            </div>
          `)}
        </div>
      </div>

      <!-- Claims & Recruitment -->
      <div class="mb-8">
        <h2 class="text-lg font-semibold mb-4 text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <span>🧾</span> Claims & Recruitment Pipeline
        </h2>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
          ${statBox('Pending Claims', claimsPending, 'Awaiting approval', 'amber', '⏳')}
          ${statBox('Approved Claims Total', 'RM ' + yoyClaims2026.toLocaleString(), 'YTD 2026', 'green', '💰')}
          ${statBox('Open Requisitions', openReqs, 'Active openings', 'indigo', '📣')}
          ${statBox('Candidates Hired', hiredCount, 'Converted employees', 'blue', '🌟')}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          ${card('Claims Disbursement by Category (RM)', `
            <div style="position: relative; height: 260px; width: 100%;">
              <canvas id="chartClaimsCatBar"></canvas>
            </div>
          `)}
          ${card('Monthly Claims Outflow Trend (RM)', `
            <div style="position: relative; height: 260px; width: 100%;">
              <canvas id="chartClaimsTrendLine"></canvas>
            </div>
          `)}
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-5">
          ${card('Recruitment Candidate Funnel Stages', `
            <div style="position: relative; height: 250px; width: 100%;">
              <canvas id="chartCandStageDonut"></canvas>
            </div>
          `)}
          ${card('Job Requisitions Status Breakdown', `
            <div style="position: relative; height: 250px; width: 100%;">
              <canvas id="chartReqStatusDonut"></canvas>
            </div>
          `)}
        </div>
      </div>

      <script>
        const rawData = ${chartDataJson};
        const PALETTE = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];

        Chart.defaults.font.family = 'Inter, system-ui, -apple-system, sans-serif';
        Chart.defaults.color = '#64748b';

        // Helper functions for easy chart initialization
        function createBarChart(ctxId, labels, data, labelName, color, isHorizontal = false) {
          const ctx = document.getElementById(ctxId);
          if (!ctx) return;
          new Chart(ctx, {
            type: 'bar',
            data: {
              labels: labels,
              datasets: [{
                label: labelName,
                data: data,
                backgroundColor: color || '#6366f1',
                borderRadius: 6,
                maxBarThickness: 32
              }]
            },
            options: {
              indexAxis: isHorizontal ? 'y' : 'x',
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { grid: { display: false } },
                y: { grid: { color: '#f1f5f9' }, beginAtZero: true }
              }
            }
          });
        }

        function createLineChart(ctxId, labels, data, labelName, color, suffix = '') {
          const ctx = document.getElementById(ctxId);
          if (!ctx) return;
          new Chart(ctx, {
            type: 'line',
            data: {
              labels: labels,
              datasets: [{
                label: labelName,
                data: data,
                borderColor: color || '#10b981',
                backgroundColor: color ? color + '1a' : '#10b9811a',
                fill: true,
                tension: 0.35,
                borderWidth: 3,
                pointRadius: 4,
                pointBackgroundColor: color || '#10b981'
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                tooltip: {
                  callbacks: {
                    label: function(ctx) { return ctx.dataset.label + ': ' + ctx.parsed.y + suffix; }
                  }
                }
              },
              scales: {
                x: { grid: { display: false } },
                y: { grid: { color: '#f1f5f9' }, beginAtZero: false }
              }
            }
          });
        }

        function createDonutChart(ctxId, labels, data) {
          const ctx = document.getElementById(ctxId);
          if (!ctx) return;
          new Chart(ctx, {
            type: 'doughnut',
            data: {
              labels: labels,
              datasets: [{
                data: data,
                backgroundColor: PALETTE.slice(0, labels.length),
                borderWidth: 2,
                borderColor: '#ffffff'
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: {
                legend: { position: 'right', labels: { boxWidth: 12, padding: 12, font: { size: 11 } } }
              },
              cutout: '65%'
            }
          });
        }

        // Initialize all charts after DOM loads
        document.addEventListener('DOMContentLoaded', function() {
          createBarChart('chartDeptBar', rawData.byDept.labels, rawData.byDept.data, 'Headcount', '#6366f1');
          createBarChart('chartYoyHiresBar', rawData.yoyHires.labels, rawData.yoyHires.data, 'Hires Count', '#10b981');
          createDonutChart('chartEmploymentTypeDonut', rawData.byType.labels, rawData.byType.data);
          createDonutChart('chartGenderDonut', rawData.byGender.labels, rawData.byGender.data);

          createLineChart('chartPayrollTrendLine', rawData.payrollGross.labels, rawData.payrollGross.data, 'Gross Payroll (RM k)', '#10b981', 'k');
          createBarChart('chartAvgSalaryBar', rawData.avgByDept.labels, rawData.avgByDept.data, 'Avg Salary (RM)', '#8b5cf6', true);

          createDonutChart('chartLeaveTypeDonut', rawData.leaveByType.labels, rawData.leaveByType.data);
          createBarChart('chartLeaveDeptBar', rawData.leaveByDept.labels, rawData.leaveByDept.data, 'Leave Days', '#f59e0b');
          createLineChart('chartAttTrendLine', rawData.attTrend.labels, rawData.attTrend.data, 'Attendance Rate', '#3b82f6', '%');
          createBarChart('chartLateDeptBar', rawData.lateByDept.labels, rawData.lateByDept.data, 'Late Occurrences', '#ef4444');

          createBarChart('chartClaimsCatBar', rawData.claimsByCat.labels, rawData.claimsByCat.data, 'Total Amount (RM)', '#ec4899');
          createLineChart('chartClaimsTrendLine', rawData.claimsTrend.labels, rawData.claimsTrend.data, 'Claims (RM)', '#ef4444', ' RM');

          createDonutChart('chartCandStageDonut', rawData.candByStage.labels, rawData.candByStage.data);
          createDonutChart('chartReqStatusDonut', rawData.reqByStatus.labels, rawData.reqByStatus.data);
        });
      </script>
    `;

    sendHtml(ctx.res, 200, layout({title:'HR Analytics & Infographics', user, activePath:'/analytics', url:ctx.url, body}));
  });
};

