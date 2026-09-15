'use strict';

function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function parseFormBody(req) {
  const raw = await readBody(req);
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function parseBodyAuto(req) {
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) return parseJsonBody(req);
  return parseFormBody(req);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, status, html, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(html);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { Location: location, ...extraHeaders });
  res.end();
}

function formatMoney(n) {
  const num = Number(n || 0);
  return 'RM ' + num.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetweenInclusive(startISO, endISO) {
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  const diff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
  return diff >= 0 ? diff + 1 : 0;
}

function monthName(m) {
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return names[(m - 1 + 12) % 12];
}

// NRIC No. only applies to Malaysian nationals (format xxxxxx-xx-xxxx, see
// the auto-formatting + birthdate-prefill in public/app.js); anyone else
// gets a plain Passport No. instead. Shared by the self-service profile form
// (routes/profile.js) and the HR Add/Edit Employee form (routes/directory.js)
// so both validate identically. Nationality is a free-text value from the
// configurable `nationality` dropdown (lib/lists.js) — this only recognizes
// the literal seeded value "Malaysian"; if that option gets renamed, update
// this check to match.
function normalizeNricOrPassport(nationality, nricRaw, passportRaw) {
  if (nationality === 'Malaysian') {
    const nric = String(nricRaw || '').trim();
    if (nric && !/^\d{6}-\d{2}-\d{4}$/.test(nric)) {
      return { error: 'NRIC number must be in the format xxxxxx-xx-xxxx.' };
    }
    return { ic_number: nric || null, passport_no: null };
  }
  return { ic_number: null, passport_no: String(passportRaw || '').trim() || null };
}

function sendFile(res, status, buffer, filename, contentType = 'application/octet-stream') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  res.end(buffer);
}

module.exports = {
  readBody,
  parseJsonBody,
  parseFormBody,
  parseBodyAuto,
  sendJson,
  sendHtml,
  sendFile,
  redirect,
  formatMoney,
  todayISO,
  daysBetweenInclusive,
  monthName,
  normalizeNricOrPassport,
};
