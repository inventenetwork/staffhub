'use strict';
const crypto = require('crypto');
const { setSetting, setModuleEnabled, MODULES } = require('./settings');

const LICENSE_SECRET = process.env.STAFFHUB_LICENSE_SECRET || 'staffhub_secret_license_signature_key_2026';

function generateLicenseKey(options = {}) {
  const payload = {
    h: Number(options.max_headcount ?? 0),
    m: Array.isArray(options.modules) ? options.modules : [],
    c: options.company_name || 'StaffHub Customer',
    v: options.valid_until || '2099-12-31',
    ts: Date.now(),
  };
  const payloadString = JSON.stringify(payload);
  const hmac = crypto.createHmac('sha256', LICENSE_SECRET).update(payloadString).digest('hex');
  const fullEnvelope = JSON.stringify({ p: payloadString, s: hmac });
  return Buffer.from(fullEnvelope, 'utf8').toString('base64');
}

function parseAndVerifyLicenseKey(licenseKeyBase64) {
  try {
    if (!licenseKeyBase64 || typeof licenseKeyBase64 !== 'string') return { valid: false, error: 'Invalid key format.' };
    const cleanKey = licenseKeyBase64.trim();
    const rawEnvelope = Buffer.from(cleanKey, 'base64').toString('utf8');
    const envelope = JSON.parse(rawEnvelope);
    if (!envelope.p || !envelope.s) return { valid: false, error: 'Malformed license key envelope.' };
    const expectedHmac = crypto.createHmac('sha256', LICENSE_SECRET).update(envelope.p).digest('hex');
    if (expectedHmac !== envelope.s) return { valid: false, error: 'License key signature verification failed. Key is invalid or tampered.' };
    const payload = JSON.parse(envelope.p);
    if (payload.v && payload.v !== '2099-12-31') {
      const expiryTime = new Date(payload.v + 'T23:59:59Z').getTime();
      if (!isNaN(expiryTime) && Date.now() > expiryTime) return { valid: false, error: 'License key expired on ' + payload.v };
    }
    return { valid: true, payload };
  } catch (err) { return { valid: false, error: 'Failed to parse license key: ' + err.message }; }
}

function applyLicenseKey(licenseKeyBase64) {
  const result = parseAndVerifyLicenseKey(licenseKeyBase64);
  if (!result.valid) return { success: false, error: result.error };
  const { payload } = result;
  setSetting('max_headcount_limit', String(payload.h));
  if (Array.isArray(payload.m)) {
    const licensedModules = new Set(payload.m);
    MODULES.forEach((m) => { setModuleEnabled(m.key, licensedModules.has(m.key)); });
  }
  setSetting('active_license_key', licenseKeyBase64.trim());
  setSetting('active_license_company', payload.c);
  setSetting('active_license_valid_until', payload.v);
  setSetting('active_license_applied_at', new Date().toISOString());
  return {
    success: true,
    message: 'License key applied successfully! Headcount capacity updated to ' + (payload.h === 0 ? 'Unlimited' : payload.h) + ' seats. ' + (payload.m ? payload.m.length : 0) + ' modules unlocked.',
    details: { headcount: payload.h, modules: payload.m, company: payload.c, validUntil: payload.v }
  };
}

module.exports = { generateLicenseKey, parseAndVerifyLicenseKey, applyLicenseKey };