// Small progressive-enhancement helpers. No framework/build step needed.
(function () {
  // Clock in/out buttons: Acquire HTML5 Geolocation, POST via fetch, then reload to show updated status.
  document.querySelectorAll('[data-clock-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const action = btn.getAttribute('data-clock-action');

      let latitude = null;
      let longitude = null;

      // Acquire browser geolocation if available
      if ('geolocation' in navigator) {
        try {
          const pos = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
              enableHighAccuracy: true,
              timeout: 8000,
              maximumAge: 0
            });
          });
          latitude = pos.coords.latitude;
          longitude = pos.coords.longitude;
        } catch (geoErr) {
          console.warn('Geolocation acquisition skipped or denied:', geoErr.message);
        }
      }

      try {
        const res = await fetch('/api/attendance/clock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, latitude, longitude }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to clock ' + action);
        window.location.reload();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  // Convert a file input to a base64 data URL and stash it in a hidden field,
  // so receipts can be submitted as plain form fields (no multipart parser needed).
  document.querySelectorAll('[data-receipt-input]').forEach((input) => {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      const hiddenId = input.getAttribute('data-receipt-input');
      const hidden = document.getElementById(hiddenId);
      const preview = document.getElementById(hiddenId + '-name');
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        alert('Please attach a receipt smaller than 4MB.');
        input.value = '';
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        hidden.value = reader.result;
        if (preview) preview.textContent = file.name;
      };
      reader.readAsDataURL(file);
    });
  });

  // Live mileage calc for travel claims (mileage subcategory only — every
  // other claim subcategory just takes a flat amount).
  const distanceEl = document.getElementById('distance_km');
  const rateEl = document.getElementById('mileage_rate');
  const roundTripEl = document.getElementById('is_round_trip');
  const mileageOut = document.getElementById('mileage_amount_display');
  const originEl = document.getElementById('origin');
  const destinationEl = document.getElementById('destination');
  const spinnerEl = document.getElementById('distance_calc_spinner');
  const sourceInfoEl = document.getElementById('distance_source_info');

  function recalcMileage() {
    if (!distanceEl || !mileageOut) return;
    const distance = (parseFloat(distanceEl.value) || 0) * (roundTripEl && roundTripEl.checked ? 2 : 1);
    const rate = parseFloat(rateEl.value) || 0;
    const mileage = Math.round(distance * rate * 100) / 100;
    mileageOut.textContent = 'RM ' + mileage.toFixed(2);
  }
  [distanceEl, rateEl, roundTripEl].forEach((el) => el && el.addEventListener('input', recalcMileage));
  recalcMileage();

  // Location autocomplete helper function
  function setupAutocomplete(inputEl, containerId) {
    if (!inputEl) return;
    const container = document.getElementById(containerId);
    let debounceTimer = null;

    inputEl.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const val = inputEl.value.trim();
      if (val.length < 2) {
        if (container) container.classList.add('hidden');
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const res = await fetch('/api/claims/location-autocomplete?q=' + encodeURIComponent(val));
          const list = await res.json();
          if (!container) return;

          if (!list || list.length === 0) {
            container.classList.add('hidden');
            return;
          }

          container.innerHTML = list.map((item) => `
            <div class="px-3 py-2 hover:bg-indigo-50 dark:hover:bg-slate-800 cursor-pointer border-b border-slate-100 dark:border-slate-800 last:border-0" data-name="${item.name.replace(/"/g, '&quot;')}">
              <div class="font-medium text-slate-800 dark:text-slate-200">${item.name}</div>
              <div class="text-[10px] text-slate-400 truncate">${item.display_name}</div>
            </div>
          `).join('');

          container.classList.remove('hidden');

          container.querySelectorAll('[data-name]').forEach((el) => {
            el.addEventListener('click', () => {
              inputEl.value = el.getAttribute('data-name');
              container.classList.add('hidden');
              triggerAutoDistance();
            });
          });
        } catch (e) {
          if (container) container.classList.add('hidden');
        }
      }, 300);
    });

    document.addEventListener('click', (e) => {
      if (container && !inputEl.contains(e.target) && !container.contains(e.target)) {
        container.classList.add('hidden');
      }
    });
  }

  setupAutocomplete(originEl, 'origin_suggestions');
  setupAutocomplete(destinationEl, 'destination_suggestions');

  // Auto-calculate driving distance via Google Maps / OSRM API
  let calcDebounce = null;
  async function triggerAutoDistance() {
    if (!originEl || !destinationEl || !distanceEl) return;
    const orig = originEl.value.trim();
    const dest = destinationEl.value.trim();
    if (!orig || !dest) return;

    clearTimeout(calcDebounce);
    calcDebounce = setTimeout(async () => {
      if (spinnerEl) spinnerEl.classList.remove('hidden');
      try {
        const res = await fetch(`/api/claims/calculate-distance?origin=${encodeURIComponent(orig)}&destination=${encodeURIComponent(dest)}`);
        const data = await res.json();
        if (res.ok && data.distance_km) {
          distanceEl.value = data.distance_km;
          if (sourceInfoEl) sourceInfoEl.textContent = `Via ${data.source}: ${data.distance_km} km`;
          recalcMileage();
        }
      } catch (err) {
        console.warn('Auto-distance lookup error:', err);
      } finally {
        if (spinnerEl) spinnerEl.classList.add('hidden');
      }
    }, 400);
  }

  if (originEl) originEl.addEventListener('change', triggerAutoDistance);
  if (destinationEl) destinationEl.addEventListener('change', triggerAutoDistance);

  // Claims form: rebuild the Subcategory dropdown to match the selected
  // Category, and show/hide the mileage / flat-amount / medical-only field
  // groups accordingly. window.CLAIM_CATEGORIES is embedded as JSON by
  // routes/claims.js (see lib/claimTypes.js for the catalog).
  const claimCategoryEl = document.getElementById('claim_category');
  const claimSubcategoryEl = document.getElementById('claim_subcategory');
  if (claimCategoryEl && claimSubcategoryEl && window.CLAIM_CATEGORIES) {
    const updateFieldVisibility = () => {
      const isMileage = claimSubcategoryEl.value === 'mileage';
      const isMedical = claimCategoryEl.value === 'medical';
      document.querySelectorAll('.mileage-fields').forEach((el) => { el.hidden = !isMileage; });
      document.querySelectorAll('.amount-field').forEach((el) => { el.hidden = isMileage; });
      document.querySelectorAll('.medical-fields').forEach((el) => { el.hidden = !isMedical; });
      recalcMileage();
    };
    const rebuildSubcategories = () => {
      const cat = window.CLAIM_CATEGORIES[claimCategoryEl.value];
      claimSubcategoryEl.innerHTML = '';
      if (!cat) return;
      Object.keys(cat.subcategories).forEach((key) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = cat.subcategories[key].label;
        claimSubcategoryEl.appendChild(opt);
      });
      updateFieldVisibility();
    };
    claimCategoryEl.addEventListener('change', rebuildSubcategories);
    claimSubcategoryEl.addEventListener('change', updateFieldVisibility);
    updateFieldVisibility();
  }

  // Live days calc + balance check for leave applications.
  const startEl = document.getElementById('start_date');
  const endEl = document.getElementById('end_date');
  const daysOut = document.getElementById('leave_days_display');
  function recalcLeaveDays() {
    if (!startEl || !endEl || !daysOut) return;
    const start = new Date(startEl.value);
    const end = new Date(endEl.value);
    if (isNaN(start) || isNaN(end) || end < start) {
      daysOut.textContent = '—';
      return;
    }
    const days = Math.round((end - start) / 86400000) + 1;
    daysOut.textContent = days + (days === 1 ? ' day' : ' days');
  }
  [startEl, endEl].forEach((el) => el && el.addEventListener('input', recalcLeaveDays));
  recalcLeaveDays();

  // Leave date pickers: a small calendar panel toggled per date field,
  // coloring weekends and public holidays so it's clear at a glance which
  // days are off-days before applying for leave. window.PUBLIC_HOLIDAYS is
  // embedded as JSON by routes/leave.js: [{date: 'YYYY-MM-DD', name}, ...].
  (function initDaypickers() {
    const toggles = document.querySelectorAll('[data-daypicker-toggle]');
    if (!toggles.length) return;

    const holidayMap = {};
    const loadHolidays = () => {
      (window.PUBLIC_HOLIDAYS || []).forEach((h) => { holidayMap[h.date] = h.name; });
    };
    loadHolidays();
    if (!window.PUBLIC_HOLIDAYS) {
      fetch('/api/public-holidays').then(r => r.json()).then(data => {
        window.PUBLIC_HOLIDAYS = data;
        loadHolidays();
      }).catch(() => {});
    }

    function pad(n) { return String(n).padStart(2, '0'); }
    function toISO(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
    function escAttr(s) { return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
    function otherInputId(id) { return id === 'start_date' ? 'end_date' : id === 'end_date' ? 'start_date' : null; }

    const panels = {}; // inputId -> { panelEl, viewYear, viewMonth }

    function renderPanel(inputId) {
      const state = panels[inputId];
      const input = document.getElementById(inputId);
      if (!state || !input) return;
      const { panelEl } = state;
      const y = state.viewYear, m = state.viewMonth;
      const firstDow = new Date(y, m, 1).getDay();
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const monthLabel = new Date(y, m, 1).toLocaleDateString('en-MY', { month: 'long', year: 'numeric' });

      const startInput = document.getElementById('start_date');
      const endInput = document.getElementById('end_date');
      const startVal = startInput ? startInput.value : '';
      const endVal = endInput ? endInput.value : '';

      let cells = '';
      for (let i = 0; i < firstDow; i++) cells += '<div></div>';
      for (let d = 1; d <= daysInMonth; d++) {
        const iso = toISO(y, m, d);
        const dow = new Date(y, m, d).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const holidayName = holidayMap[iso];
        const isSelected = input.value === iso;
        const inRange = startVal && endVal && iso >= startVal && iso <= endVal;
        let cls = 'w-full aspect-square rounded-md text-xs flex items-center justify-center cursor-pointer ';
        if (isSelected) cls += 'bg-indigo-600 text-white font-semibold ';
        else if (holidayName) cls += 'bg-rose-200 text-rose-800 font-medium ';
        else if (isWeekend) cls += 'bg-amber-100 text-amber-800 ';
        else if (inRange) cls += 'bg-indigo-50 text-indigo-700 ';
        else cls += 'text-slate-700 hover:bg-slate-100 ';
        cells += '<button type="button" class="' + cls + '" data-day="' + iso + '" title="' + escAttr(holidayName || '') + '">' + d + '</button>';
      }

      panelEl.innerHTML =
        '<div class="flex items-center justify-between mb-2 px-1">' +
          '<button type="button" class="text-slate-400 hover:text-slate-700 px-1" data-nav="prev">&lsaquo;</button>' +
          '<div class="text-xs font-medium dark:text-slate-200">' + monthLabel + '</div>' +
          '<button type="button" class="text-slate-400 hover:text-slate-700 px-1" data-nav="next">&rsaquo;</button>' +
        '</div>' +
        '<div class="grid grid-cols-7 gap-0.5 text-center text-[10px] text-slate-400 mb-1">' +
          '<div>S</div><div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div>' +
        '</div>' +
        '<div class="grid grid-cols-7 gap-0.5 mb-2">' + cells + '</div>' +
        '<div class="border-t border-slate-100 dark:border-slate-800 pt-2 px-1 flex items-center justify-around text-[10px] text-slate-500 dark:text-slate-400">' +
          '<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-amber-100 border border-amber-300 inline-block"></span> Weekend</span>' +
          '<span class="flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded bg-rose-200 border border-rose-300 inline-block"></span> Public holiday</span>' +
        '</div>';

      panelEl.querySelector('[data-nav="prev"]').addEventListener('click', () => {
        state.viewMonth -= 1;
        if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear -= 1; }
        renderPanel(inputId);
      });
      panelEl.querySelector('[data-nav="next"]').addEventListener('click', () => {
        state.viewMonth += 1;
        if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear += 1; }
        renderPanel(inputId);
      });
      panelEl.querySelectorAll('[data-day]').forEach((btn) => {
        btn.addEventListener('click', () => {
          input.value = btn.getAttribute('data-day');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          panelEl.hidden = true;
          const other = otherInputId(inputId);
          if (other && panels[other]) renderPanel(other);
        });
      });
    }

    toggles.forEach((toggle) => {
      const inputId = toggle.getAttribute('data-daypicker-toggle');
      const panelEl = document.querySelector('[data-daypicker-panel="' + inputId + '"]');
      const input = document.getElementById(inputId);
      if (!panelEl || !input) return;

      const initial = input.value ? new Date(input.value + 'T00:00:00') : new Date();
      panels[inputId] = { panelEl, viewYear: initial.getFullYear(), viewMonth: initial.getMonth() };

      const showPanel = (e) => {
        if (e) e.stopPropagation();
        const wasHidden = panelEl.hidden;
        document.querySelectorAll('.daypicker-panel').forEach((p) => { p.hidden = true; });
        if (wasHidden) {
          const cur = input.value ? new Date(input.value + 'T00:00:00') : new Date();
          panels[inputId].viewYear = cur.getFullYear();
          panels[inputId].viewMonth = cur.getMonth();
          renderPanel(inputId);
          panelEl.hidden = false;
        }
      };

      toggle.addEventListener('click', showPanel);
      input.addEventListener('click', showPanel);
      input.addEventListener('focus', showPanel);
      panelEl.addEventListener('click', (e) => e.stopPropagation());
    });

    document.addEventListener('click', () => {
      document.querySelectorAll('.daypicker-panel').forEach((p) => { p.hidden = true; });
    });
  })();

  // Nationality-driven NRIC/Passport toggle (Profile and Add/Edit Employee
  // forms). When Nationality is "Malaysian", show the NRIC field (auto-
  // formatted as xxxxxx-xx-xxxx, with the first 6 digits auto-filled from
  // Date of birth as YYMMDD) and hide Passport No.; otherwise the reverse.
  (function initNricPassportToggle() {
    const nationalityEl = document.querySelector('[data-nationality-input]');
    const nricWrap = document.querySelector('[data-nric-wrap]');
    const passportWrap = document.querySelector('[data-passport-wrap]');
    const nricInput = document.querySelector('[data-nric-input]');
    const dobEl = document.querySelector('[data-dob-input]');
    if (!nationalityEl || (!nricWrap && !passportWrap)) return;

    function isMalaysian() { return nationalityEl.value === 'Malaysian'; }

    function updateVisibility() {
      if (nricWrap) nricWrap.hidden = !isMalaysian();
      if (passportWrap) passportWrap.hidden = isMalaysian();
    }
    nationalityEl.addEventListener('change', updateVisibility);
    updateVisibility();

    function formatNric(digits) {
      let out = digits.slice(0, 6);
      if (digits.length > 6) out += '-' + digits.slice(6, 8);
      if (digits.length > 8) out += '-' + digits.slice(8, 12);
      return out;
    }

    if (nricInput) {
      nricInput.addEventListener('input', () => {
        const digits = nricInput.value.replace(/\D/g, '').slice(0, 12);
        nricInput.value = formatNric(digits);
      });
    }

    if (dobEl && nricInput) {
      dobEl.addEventListener('change', () => {
        if (!isMalaysian() || !dobEl.value) return;
        const [y, m, d] = dobEl.value.split('-');
        if (!y || !m || !d) return;
        const yymmdd = y.slice(2) + m + d;
        const existingDigits = nricInput.value.replace(/\D/g, '');
        const rest = existingDigits.slice(6);
        nricInput.value = formatNric((yymmdd + rest).slice(0, 12));
      });
    }
  })();
})();
