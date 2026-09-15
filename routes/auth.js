'use strict';
const db = require('../db');
const { verifyPassword, createSession, destroySession, parseCookies } = require('../lib/auth');
const { parseBodyAuto, redirect, sendHtml } = require('../lib/util');
const { layout, escapeHtml } = require('../lib/render');

module.exports = function (router) {
  router.get('/site-lock', async (ctx) => {
    const err = ctx.url.searchParams.get('error');
    const redirectUrl = ctx.url.searchParams.get('redirect') || '/login';
    const body = `
      <div class="w-full max-w-sm">
        <div class="text-center mb-8">
          <div class="w-12 h-12 rounded-2xl bg-slate-900 dark:bg-indigo-600 text-white flex items-center justify-center font-bold text-xl mx-auto mb-3 shadow-md">🔒</div>
          <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100">Site Security Gate</h1>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-1">Please enter the master site password to continue</p>
        </div>
        <div class="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-sm p-6">
          ${err ? `<div class="mb-4 rounded-lg border border-red-200 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 px-4 py-3 text-xs font-semibold">${escapeHtml(err)}</div>` : ''}
          <form method="post" action="/site-lock" class="space-y-4">
            <input type="hidden" name="redirect" value="${escapeHtml(redirectUrl)}"/>
            <div>
              <label class="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Master Site Password</label>
              <input name="site_password" type="password" required autofocus class="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 px-3.5 py-2.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Enter Site Password..."/>
            </div>
            <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-xl py-2.5 text-xs shadow-sm transition flex items-center justify-center gap-2">
              <span>🔓</span> Unlock Site Access
            </button>
          </form>
        </div>
      </div>
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Site Security Gate', user: null, activePath: '', url: ctx.url, body }));
  });

  router.post('/site-lock', async (ctx) => {
    const { site_password, redirect: redirectTo } = await parseBodyAuto(ctx.req);
    const { verifySiteGatePassword } = require('../lib/auth');
    if (!verifySiteGatePassword(site_password)) {
      return redirect(ctx.res, '/site-lock?error=' + encodeURIComponent('Incorrect Site Password.') + '&redirect=' + encodeURIComponent(redirectTo || '/login'));
    }
    const maxAge = 30 * 24 * 60 * 60;
    const cookie = `site_gate_pass=1; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
    redirect(ctx.res, redirectTo || '/login', { 'Set-Cookie': cookie });
  });

  router.get('/login', async (ctx) => {
    if (ctx.user) return redirect(ctx.res, '/');
    const err = ctx.url.searchParams.get('error');
    const body = `
      <div class="w-full max-w-sm">
        <div class="text-center mb-8">
          <div class="w-12 h-12 rounded-2xl bg-indigo-600 text-white flex items-center justify-center font-bold text-xl mx-auto mb-3">S</div>
          <h1 class="text-xl font-semibold">StaffHub</h1>
          <p class="text-sm text-slate-500 mt-1">Sign in to your account</p>
        </div>
        <div class="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          ${err ? `<div class="mb-4 rounded-lg border border-red-200 bg-red-50 text-red-700 px-4 py-3 text-sm">${escapeHtml(err)}</div>` : ''}
          <form method="post" action="/login" class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input name="email" type="email" required class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="you@company.com"/>
            </div>
            <div>
              <label class="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input name="password" type="password" required class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="••••••••"/>
            </div>
            <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg py-2.5 text-sm transition">Sign in</button>
          </form>
        </div>
        <div class="mt-6 text-xs text-slate-400 text-center leading-relaxed">
          Demo accounts (password <code class="bg-slate-100 px-1 rounded">password123</code>):<br/>
          superadmin@staffhub.my · hradmin@staffhub.my · approver@staffhub.my · it@staffhub.my · employee@staffhub.my
        </div>
      </div>
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Sign in', user: null, activePath: '', url: ctx.url, body }));
  });

  router.post('/login', async (ctx) => {
    const { email, password } = await parseBodyAuto(ctx.req);
    const row = db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get((email || '').toLowerCase().trim(), 'active');
    if (!row || !verifyPassword(password || '', row.password_hash)) {
      return redirect(ctx.res, '/login?error=' + encodeURIComponent('Invalid email or password.'));
    }
    const { token, expiresAt } = createSession(row.id);
    const cookie = `hrms_session=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}`;
    redirect(ctx.res, '/', { 'Set-Cookie': cookie });
  });

  router.post('/logout', async (ctx) => {
    const cookies = parseCookies(ctx.req);
    destroySession(cookies.hrms_session);
    redirect(ctx.res, '/login', { 'Set-Cookie': 'hrms_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' });
  });

  router.get('/change-password', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const body = `
      <div class="max-w-md mx-auto">
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-2xl font-semibold">Change Password</h1>
        </div>
        <div class="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <form method="post" action="/change-password" class="space-y-4 text-sm">
            <div>
              <label class="block font-medium text-slate-700 mb-1">Current password</label>
              <input name="current_password" type="password" required class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
            </div>
            <div>
              <label class="block font-medium text-slate-700 mb-1">New password</label>
              <input name="new_password" type="password" required minlength="6" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
            </div>
            <div>
              <label class="block font-medium text-slate-700 mb-1">Confirm new password</label>
              <input name="confirm_password" type="password" required minlength="6" class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"/>
            </div>
            <button class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg py-2.5 text-sm">Update password</button>
          </form>
        </div>
      </div>
    `;
    sendHtml(ctx.res, 200, layout({ title: 'Change Password', user: ctx.user, activePath: '', url: ctx.url, body }));
  });

  router.post('/change-password', async (ctx) => {
    if (!ctx.user) return redirect(ctx.res, '/login');
    const b = await parseBodyAuto(ctx.req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
    if (!row || !verifyPassword(b.current_password || '', row.password_hash)) {
      return redirect(ctx.res, '/change-password?error=' + encodeURIComponent('Current password is incorrect.'));
    }
    if (!b.new_password || b.new_password.length < 6) {
      return redirect(ctx.res, '/change-password?error=' + encodeURIComponent('New password must be at least 6 characters long.'));
    }
    if (b.new_password !== b.confirm_password) {
      return redirect(ctx.res, '/change-password?error=' + encodeURIComponent('New passwords do not match.'));
    }

    const { hashPassword } = require('../lib/auth');
    const newHash = hashPassword(b.new_password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, ctx.user.id);
    redirect(ctx.res, '/profile?ok=' + encodeURIComponent('Password updated successfully.'));
  });
};
