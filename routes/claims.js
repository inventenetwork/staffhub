'use strict';
const db = require('../db');
const { redirect, sendHtml, sendJson, parseBodyAuto, formatMoney, todayISO } = require('../lib/util');
const { layout, card, statusBadge, escapeHtml } = require('../lib/render');
const { hasAccess, isSuperAdmin, hasDirectOrIndirectReports } = require('../lib/auth');
const { getSettingNumber, isModuleEnabled } = require('../lib/settings');

// The Super Admin always keeps access to a disabled module (they're the only
// one who can re-enable it under Settings > System Settings); everyone else
// is bounced back to the dashboard.
function moduleGate(ctx) {
  return isSuperAdmin(ctx.user) || isModuleEnabled('claims');
}

// Dynamic replacement for the old fixed Approver role tier: Admin/Super Admin
// see every pending claim, and anyone listed as a Direct or Indirect Superior
// sees their own reports' — see lib/auth.js hasDirectOrIndirectReports().
function canApprove(user) {
  return hasAccess(user, ['admin']) || hasDirectOrIndirectReports(user.id);
}
const {
  CLAIM_CATEGORIES,
  CATEGORY_KEYS,
  isValidCategory,
  isValidSubcategory,
  subcategoryLabel,
  categoryLabel,
  MEDICAL_LIMIT_FIELDS,
} = require('../lib/claimTypes');

function getOrCreateMedicalLimit(userId, year) {
  let row = db.prepare('SELECT * FROM medical_limits WHERE user_id = ? AND year = ?').get(userId, year);
  if (!row) {
    // New limit rows pick up whatever the company policy default is right now
    // (Super Admin > Company Settings). Existing rows keep whatever they were
    // created with — this doesn't retroactively change past years.
    db.prepare(`
      INSERT INTO medical_limits (user_id, year, outpatient_limit, dental_limit, optical_limit, hospitalization_limit)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId, year,
      getSettingNumber('default_outpatient_limit', 1000),
      getSettingNumber('default_dental_limit', 500),
      getSettingNumber('default_optical_limit', 300),
      getSettingNumber('default_hospitalization_limit', 5000),
    );
    row = db.prepare('SELECT * FROM medical_limits WHERE user_id = ? AND year = ?').get(userId, year);
  }
  return row;
}

function claimDetails(c) {
  if (c.subcategory === 'mileage') {
    return `${escapeHtml(c.origin || '')} → ${escapeHtml(c.destination || '')}${c.is_round_trip ? ' (round trip)' : ''} · ${c.distance_km ?? 0} km`;
  }
  if (c.category === 'medical' && c.claim_for === 'dependent') {
    return `For dependent: ${escapeHtml(c.dependent_name || '—')}`;
  }
  return c.description ? escapeHtml(c.description) : '—';
}

module.exports = function (router) {
  // API Endpoint: Autocomplete location suggestions via OpenStreetMap Nominatim
  router.get('/api/claims/location-autocomplete', async (ctx) => {
    if (!ctx.user) return sendJson(ctx.res, 401, { error: 'Unauthorized' });
    const query = ctx.url.searchParams.get('q') || '';
    if (!query || query.length < 2) return sendJson(ctx.res, 200, []);

    try {
      const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=my,sg,id`;
      const response = await fetch(geoUrl, { headers: { 'User-Agent': 'StaffHub-HRMS/1.0' } });
      const data = await response.json();
      const suggestions = (data || []).map(item => ({
        display_name: item.display_name,
        name: item.name || item.display_name.split(',')[0],
        lat: item.lat,
        lon: item.lon
      }));
      return sendJson(ctx.res, 200, suggestions);
    } catch (err) {
      return sendJson(ctx.res, 200, []);
    }
  });

  // API Endpoint: Compute driving distance between origin and destination
  router.get('/api/claims/calculate-distance', async (ctx) => {
    if (!ctx.user) return sendJson(ctx.res, 401, { error: 'Unauthorized' });
    const origin = ctx.url.searchParams.get('origin');
    const destination = ctx.url.searchParams.get('destination');
    if (!origin || !destination) return sendJson(ctx.res, 400, { error: 'Origin and destination are required.' });

    const { calculateDrivingDistance } = require('../lib/googleMaps');
    const calc = await calculateDrivingDistance(origin, destination);
    if (!calc) return sendJson(ctx.res, 404, { error: 'Could not calculate driving distance between specified locations.' });

    return sendJson(ctx.res, 200, calc);
  });

  router.get('/claims', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Claims is not enabled for your company.'));
    const user = ctx.user;
    const year = new Date().getFullYear();
    const userCanApprove = canApprove(user);
    const tab = ctx.url.searchParams.get('tab') === 'approvals' && userCanApprove ? 'approvals' : 'my';

    const myClaims = db.prepare('SELECT * FROM claims WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 50').all(user.id);
    const medLimit = getOrCreateMedicalLimit(user.id, year);
    const mileageRate = getSettingNumber('mileage_rate', 0.60);

    let approvalsHtml = '';
    if (userCanApprove) {
      const seeAll = hasAccess(user, ['admin']) ? 1 : 0; // Admin and Super Admin see every pending claim
      const pending = db.prepare(`
        SELECT c.*, u.name as employee_name FROM claims c JOIN users u ON u.id = c.user_id
        WHERE c.status = 'pending' AND (u.direct_superior_id = ? OR u.indirect_superior_id = ? OR ? = 1) ORDER BY c.submitted_at ASC
      `).all(user.id, user.id, seeAll);

      approvalsHtml = card(`
        <h2 class="font-semibold mb-4">Pending claims</h2>
        <div class="overflow-x-auto">
          <table class="data-table w-full">
            <thead><tr><th>Employee</th><th>Category</th><th>Subcategory</th><th>Date</th><th>Details</th><th>Amount</th><th></th></tr></thead>
            <tbody>
              ${pending.map((c) => `
                <tr>
                  <td class="font-medium">${escapeHtml(c.employee_name)}</td>
                  <td>${escapeHtml(categoryLabel(c.category))}</td>
                  <td>${escapeHtml(subcategoryLabel(c.category, c.subcategory))}</td>
                  <td>${escapeHtml(c.claim_date)}</td>
                  <td class="text-slate-500">${claimDetails(c)}</td>
                  <td class="font-medium">${formatMoney(c.amount)}</td>
                  <td class="whitespace-nowrap">
                    <form method="post" action="/claims/${c.id}/approve" class="inline"><button class="text-emerald-600 font-medium text-xs mr-3">Approve</button></form>
                    <form method="post" action="/claims/${c.id}/reject" class="inline"><button class="text-red-600 font-medium text-xs">Reject</button></form>
                  </td>
                </tr>
              `).join('') || `<tr><td colspan="7" class="text-center text-slate-400 py-6">Nothing pending.</td></tr>`}
            </tbody>
          </table>
        </div>
      `);
    }

    const tabs = `
      <div class="flex gap-2 mb-6 text-sm">
        <a href="/claims" class="px-3 py-1.5 rounded-lg font-medium ${tab === 'my' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}">My Claims</a>
        ${userCanApprove ? `<a href="/claims?tab=approvals" class="px-3 py-1.5 rounded-lg font-medium ${tab === 'approvals' ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}">Approvals</a>` : ''}
      </div>
    `;

    const medicalLimitsSummary = MEDICAL_LIMIT_FIELDS.map(({ field, label }) => {
      const remaining = medLimit[`${field}_limit`] - medLimit[`${field}_used`];
      return `${escapeHtml(label)} ${formatMoney(remaining)} of ${formatMoney(medLimit[`${field}_limit`])} left`;
    }).join(' · ');

    const categoryOptions = CATEGORY_KEYS.map((key) => `<option value="${key}">${escapeHtml(categoryLabel(key))}</option>`).join('');
    const defaultSubOptions = Object.entries(CLAIM_CATEGORIES.travel.subcategories)
      .map(([key, sub]) => `<option value="${key}">${escapeHtml(sub.label)}</option>`).join('');

    const myTabBody = `
      <div class="mb-6">
        ${card(`
          <h2 class="font-semibold mb-1">Submit a claim</h2>
          <p class="text-xs text-slate-400 mb-4">Mileage is calculated automatically from Google Maps distance × rate. Type origin and destination to get suggestions and instant driving distance.</p>
          <form method="post" action="/claims" class="space-y-3 text-sm">
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-slate-600 mb-1">Category</label>
                <select name="category" id="claim_category" class="w-full rounded-lg border border-slate-300 px-3 py-2">${categoryOptions}</select>
              </div>
              <div>
                <label class="block text-slate-600 mb-1">Subcategory</label>
                <select name="subcategory" id="claim_subcategory" class="w-full rounded-lg border border-slate-300 px-3 py-2">${defaultSubOptions}</select>
              </div>
              <div><label class="block text-slate-600 mb-1">Claim date</label><input name="claim_date" type="date" value="${todayISO()}" required class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
            </div>

            <div class="mileage-fields grid grid-cols-2 gap-3" hidden>
              <div class="relative">
                <label class="block text-slate-600 mb-1">Origin</label>
                <input name="origin" id="origin" placeholder="e.g. KLCC, Kuala Lumpur" autocomplete="off" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
                <div id="origin_suggestions" class="absolute z-20 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto hidden text-xs"></div>
              </div>
              <div class="relative">
                <label class="block text-slate-600 mb-1">Destination</label>
                <input name="destination" id="destination" placeholder="e.g. Penang Airport" autocomplete="off" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
                <div id="destination_suggestions" class="absolute z-20 w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-lg mt-1 max-h-48 overflow-y-auto hidden text-xs"></div>
              </div>
              <div class="flex items-end pb-2"><label class="flex items-center gap-2 text-slate-600"><input type="checkbox" name="is_round_trip" id="is_round_trip" value="1"/> Round trip</label></div>
              <div>
                <label class="block text-slate-600 mb-1">Distance (km, one-way)</label>
                <div class="relative flex items-center">
                  <input id="distance_km" name="distance_km" type="number" step="0.1" min="0" readonly placeholder="Auto-calculated" class="w-full rounded-lg border border-slate-300 bg-slate-100 dark:bg-slate-800 dark:border-slate-700 text-slate-600 dark:text-slate-300 px-3 py-2 pr-24 cursor-not-allowed"/>
                  <span id="distance_calc_spinner" class="absolute right-2 text-xs text-indigo-600 font-medium hidden">Calculating...</span>
                </div>
              </div>
              <div><label class="block text-slate-600 mb-1">Rate (RM/km)</label><input id="mileage_rate" name="mileage_rate" type="number" step="0.01" value="${mileageRate}" readonly class="w-full rounded-lg border border-slate-300 bg-slate-100 dark:bg-slate-800 dark:border-slate-700 text-slate-600 dark:text-slate-300 px-3 py-2 cursor-not-allowed"/></div>
              <div class="col-span-2 flex justify-between items-center text-xs text-slate-500 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-3 py-2 border border-slate-200 dark:border-slate-700">
                <span id="distance_source_info" class="text-slate-400">Type origin & destination for auto-distance</span>
                <span>Computed amount: <strong id="mileage_amount_display" class="text-indigo-600 dark:text-indigo-400 font-bold">RM 0.00</strong></span>
              </div>
            </div>

            <div class="amount-field">
              <label class="block text-slate-600 mb-1">Amount (RM)</label>
              <input name="amount" id="amount" type="number" step="0.01" min="0" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
            </div>

            <div class="medical-fields space-y-3" hidden>
              <div class="text-xs text-slate-500 bg-slate-50 rounded-lg px-3 py-2">Annual limits ${year}: ${medicalLimitsSummary}</div>
              <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-slate-600"><input type="radio" name="claim_for" value="self" checked onclick="document.getElementById('dependent-name-block').hidden=true"/> Self</label>
                <label class="flex items-center gap-2 text-slate-600"><input type="radio" name="claim_for" value="dependent" onclick="document.getElementById('dependent-name-block').hidden=false"/> Dependent</label>
              </div>
              <div id="dependent-name-block" hidden>
                <label class="block text-slate-600 mb-1">Dependent name</label>
                <input name="dependent_name" class="w-full rounded-lg border border-slate-300 px-3 py-2"/>
              </div>
              <label class="flex items-center gap-2 text-slate-600"><input type="checkbox" name="mc_linked" value="1" onclick="document.getElementById('mc-dates').hidden=!this.checked"/> Linked to MC</label>
              <div id="mc-dates" class="grid grid-cols-2 gap-3" hidden>
                <div><label class="block text-slate-600 mb-1">MC start</label><input name="mc_start_date" type="date" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
                <div><label class="block text-slate-600 mb-1">MC end</label><input name="mc_end_date" type="date" class="w-full rounded-lg border border-slate-300 px-3 py-2"/></div>
              </div>
            </div>

            <div><label class="block text-slate-600 mb-1">Description</label><textarea name="description" rows="2" class="w-full rounded-lg border border-slate-300 px-3 py-2"></textarea></div>
            <div>
              <label class="block text-slate-600 mb-1">Receipt</label>
              <input type="file" accept="image/*,.pdf" data-receipt-input="claim_receipt" class="text-xs"/>
              <input type="hidden" name="receipt_data" id="claim_receipt"/>
              <div id="claim_receipt-name" class="text-xs text-slate-400 mt-1"></div>
            </div>
            <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg py-2.5">Submit claim</button>
          </form>
        `)}
      </div>

      ${card(`
        <h2 class="font-semibold mb-4">My claims</h2>
        <div class="overflow-x-auto">
          <table class="data-table w-full">
            <thead><tr><th>Category</th><th>Subcategory</th><th>Date</th><th>Details</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              ${myClaims.map((c) => `
                <tr>
                  <td>${escapeHtml(categoryLabel(c.category))}</td>
                  <td>${escapeHtml(subcategoryLabel(c.category, c.subcategory))}</td>
                  <td>${escapeHtml(c.claim_date)}</td>
                  <td class="text-slate-500">${claimDetails(c)}</td>
                  <td class="font-medium">${formatMoney(c.amount)}</td>
                  <td>${statusBadge(c.status)}</td>
                </tr>
              `).join('') || `<tr><td colspan="6" class="text-center text-slate-400 py-6">No claims yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      `)}

      <script>window.CLAIM_CATEGORIES = ${JSON.stringify(CLAIM_CATEGORIES)};</script>
    `;

    const body = `
      <div class="flex items-center justify-between mb-6"><h1 class="text-2xl font-semibold">Claims</h1></div>
      ${tabs}
      ${tab === 'approvals' ? approvalsHtml : myTabBody}
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Claims', user, activePath: '/claims', url: ctx.url, body }));
  });

  router.post('/claims', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Claims is not enabled for your company.'));
    const b = await parseBodyAuto(ctx.req);
    const category = b.category;
    const subcategory = b.subcategory;

    if (!isValidCategory(category) || !isValidSubcategory(category, subcategory)) {
      return redirect(ctx.res, '/claims?error=' + encodeURIComponent('Please choose a valid claim category.'));
    }
    if (!b.claim_date) {
      return redirect(ctx.res, '/claims?error=' + encodeURIComponent('Please provide a claim date.'));
    }

    let amount, origin = null, destination = null, isRoundTrip = 0, distance = null, rate = null;

    if (subcategory === 'mileage') {
      const oneWayDistance = Math.max(0, parseFloat(b.distance_km) || 0);
      rate = Math.max(0, parseFloat(b.mileage_rate) || getSettingNumber('mileage_rate', 0.60));
      isRoundTrip = b.is_round_trip === '1';
      distance = isRoundTrip ? oneWayDistance * 2 : oneWayDistance;
      amount = Math.round(distance * rate * 100) / 100; // server-computed & locked — never trust a client-supplied amount
      origin = b.origin || null;
      destination = b.destination || null;
      if (!origin || !destination || !distance) {
        return redirect(ctx.res, '/claims?error=' + encodeURIComponent('Please fill in origin, destination and distance for a mileage claim.'));
      }
    } else {
      amount = Math.max(0, parseFloat(b.amount) || 0);
      if (!amount) {
        return redirect(ctx.res, '/claims?error=' + encodeURIComponent('Please enter a valid claim amount.'));
      }
    }

    let claimFor = 'self', dependentName = null, mcLinked = 0, mcStart = null, mcEnd = null;
    if (category === 'medical') {
      claimFor = b.claim_for === 'dependent' ? 'dependent' : 'self';
      dependentName = claimFor === 'dependent' ? (b.dependent_name || null) : null;
      mcLinked = b.mc_linked === '1';
      mcStart = mcLinked ? b.mc_start_date || null : null;
      mcEnd = mcLinked ? b.mc_end_date || null : null;

      const limitField = CLAIM_CATEGORIES.medical.subcategories[subcategory].medicalLimitField;
      if (limitField) {
        const year = new Date(b.claim_date).getFullYear();
        const limit = getOrCreateMedicalLimit(ctx.user.id, year);
        const pendingSum = db.prepare(`
          SELECT COALESCE(SUM(amount),0) s FROM claims WHERE user_id = ? AND category = 'medical' AND subcategory = ? AND status = 'pending'
        `).get(ctx.user.id, subcategory).s;
        const remaining = limit[`${limitField}_limit`] - limit[`${limitField}_used`] - pendingSum;
        if (amount > remaining) {
          return redirect(ctx.res, '/claims?error=' + encodeURIComponent(
            `This exceeds your remaining ${subcategoryLabel('medical', subcategory)} limit of RM ${remaining.toFixed(2)} for ${year}.`
          ));
        }
      }
    }

    db.prepare(`
      INSERT INTO claims (user_id, category, subcategory, claim_date, description, amount, origin, destination, is_round_trip, distance_km, mileage_rate, claim_for, dependent_name, mc_linked, mc_start_date, mc_end_date, receipt_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ctx.user.id, category, subcategory, b.claim_date, b.description || null, amount,
      origin, destination, isRoundTrip ? 1 : 0, distance, rate,
      claimFor, dependentName, mcLinked ? 1 : 0, mcStart, mcEnd, b.receipt_data || null,
    );

    redirect(ctx.res, '/claims?ok=' + encodeURIComponent(`${categoryLabel(category)} claim submitted.`));
  });

  function decideClaim(status) {
    return async (ctx) => {
      if (!canApprove(ctx.user)) return redirect(ctx.res, '/claims?error=' + encodeURIComponent('Not authorized.'));
      if (!moduleGate(ctx)) return redirect(ctx.res, '/?error=' + encodeURIComponent('Claims is not enabled for your company.'));
      const id = Number(ctx.params.id);
      const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
      if (!claim || claim.status !== 'pending') {
        return redirect(ctx.res, '/claims?tab=approvals&error=' + encodeURIComponent('Claim not found or already decided.'));
      }
      db.prepare(`UPDATE claims SET status = ?, approver_id = ?, decided_at = datetime('now') WHERE id = ?`).run(status, ctx.user.id, id);

      if (status === 'approved' && claim.category === 'medical') {
        const sub = CLAIM_CATEGORIES.medical.subcategories[claim.subcategory];
        const limitField = sub && sub.medicalLimitField;
        if (limitField) {
          const year = new Date(claim.claim_date).getFullYear();
          getOrCreateMedicalLimit(claim.user_id, year);
          db.prepare(`UPDATE medical_limits SET ${limitField}_used = ${limitField}_used + ? WHERE user_id = ? AND year = ?`).run(claim.amount, claim.user_id, year);
        }
      }
      redirect(ctx.res, '/claims?tab=approvals&ok=' + encodeURIComponent(`Claim ${status}.`));
    };
  }
  router.post('/claims/:id/approve', decideClaim('approved'));
  router.post('/claims/:id/reject', decideClaim('rejected'));
};
