'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');

// ── Load .env file (no external package needed) ───────────────────────────
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch (_) { /* .env is optional */ }
})();

const { currentUser } = require('./lib/auth');
const { sendHtml, sendJson, redirect } = require('./lib/util');
const { layout } = require('./lib/render');

// Populate default company_settings rows before anything reads them. Required
// here (rather than inside db/index.js) to avoid a circular require, since
// lib/settings.js itself requires the db module.
require('./lib/settings').ensureDefaults();
require('./lib/lists').ensureListDefaults();

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const profileRoutes = require('./routes/profile');
const attendanceRoutes = require('./routes/attendance');
const leaveRoutes = require('./routes/leave');
const claimsRoutes = require('./routes/claims');
const payrollRoutes = require('./routes/payroll');
const reportsRoutes = require('./routes/reports');
const directoryRoutes = require('./routes/directory');
const settingsRoutes = require('./routes/settings');
const recruitmentRoutes = require('./routes/recruitment');
const onboardingRoutes = require('./routes/onboarding');
const approvalsRoutes = require('./routes/approvals');
const orgRoutes = require('./routes/org');
const announcementsRoutes = require('./routes/announcements');
const assetsRoutes = require('./routes/assets');
const engagementRoutes = require('./routes/engagement');
const performanceRoutes = require('./routes/performance');
const trainingRoutes = require('./routes/training');
const disciplinaryRoutes = require('./routes/disciplinary');
const analyticsRoutes = require('./routes/analytics');
const assistantRoutes = require('./routes/assistant');

const PORT = process.env.PORT || 3000;

// ---------------- Simple router ----------------
const routes = []; // { method, pattern: RegExp, keys: string[], handler }

function toPattern(routePath) {
  const keys = [];
  const regexStr = routePath
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        keys.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexStr}/?$`), keys };
}

function route(method, routePath, handler) {
  const { regex, keys } = toPattern(routePath);
  routes.push({ method, regex, keys, handler });
}

const router = { get: (p, h) => route('GET', p, h), post: (p, h) => route('POST', p, h) };

authRoutes(router);
dashboardRoutes(router);
profileRoutes(router);
attendanceRoutes(router);
leaveRoutes(router);
claimsRoutes(router);
payrollRoutes(router);
reportsRoutes(router);
directoryRoutes(router);
settingsRoutes(router);
recruitmentRoutes(router);
onboardingRoutes(router);
approvalsRoutes(router);
orgRoutes(router);
announcementsRoutes(router);
assetsRoutes(router);
engagementRoutes(router);
performanceRoutes(router);
trainingRoutes(router);
disciplinaryRoutes(router);
analyticsRoutes(router);
assistantRoutes(router);

// ---------------- Static files ----------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = { '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const rel = pathname.replace(/^\/public\//, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end();
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// ---------------- Request handler ----------------
async function handleRequest(req, res) {
  try {
    const rawUrl = req.headers['x-invoke-path'] || req.headers['x-forwarded-uri'] || req.headers['x-matched-path'] || req.url || '';
    const url = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
    let pathname = url.pathname;

    const vPath = url.searchParams.get('__path');
    if (vPath !== null) {
      pathname = '/' + vPath.replace(/^\//, '');
    } else if (pathname === '/api' || pathname === '/api/') {
      pathname = '/';
    }

    if (pathname.startsWith('/public/')) {
      if (serveStatic(req, res, pathname)) return;
    }

    const user = currentUser(req);
    const ctx = { req, res, url, user, params: {} };

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const match = r.regex.exec(pathname);
      if (!match) continue;
      const params = {};
      r.keys.forEach((key, i) => (params[key] = decodeURIComponent(match[i + 1])));
      ctx.params = params;
      await r.handler(ctx);
      return;
    }

    // 404
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    sendHtml(res, 404, layout({
      title: 'Not found',
      user,
      activePath: '',
      url,
      body: `<div class="text-center py-24"><h1 class="text-2xl font-semibold mb-2">404 — Page not found</h1><p class="text-slate-500 mb-6">That page doesn't exist.</p><a href="/" class="text-indigo-600 font-medium">Go back home</a></div>`,
    }));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      // Zero Silent Failures: always return a clear, human-readable message.
      sendHtml(res, 500, layout({
        title: 'Something went wrong',
        user: null,
        activePath: '',
        url: null,
        body: `<div class="max-w-lg mx-auto text-center py-24"><h1 class="text-2xl font-semibold mb-2">Something went wrong</h1><p class="text-slate-500 mb-6">${(err && err.message) || 'Unexpected error.'}</p><a href="/" class="text-indigo-600 font-medium">Go back home</a></div>`,
      }));
    }
  }
}

const server = http.createServer(handleRequest);

function lanAddresses() {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  return addrs;
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`StaffHub running at http://localhost:${PORT}`);
    const lan = lanAddresses();
    if (lan.length) {
      console.log(`Reachable from other devices on this network at:`);
      lan.forEach((ip) => console.log(`  http://${ip}:${PORT}`));
    }
  });
}

module.exports = handleRequest;
