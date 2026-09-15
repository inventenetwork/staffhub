'use strict';
const { hasAccess, isSuperAdmin } = require('./auth');
const { getModuleStates } = require('./settings');

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// roles is the explicit set of constituencies (see lib/auth.js hasAccess() /
// CONSTITUENCIES) that can see this nav item — unlike the app's old ranked
// tiers, this is NOT "this rank or above": Super Admin is a universal
// override baked into hasAccess() itself, so it doesn't need to be listed.
// This mirrors the target module hierarchy (Employee Center / Setting /
// Report / Payroll / Leave / TAMS / Claims & Medical) but only wires pages
// that exist today — see the nav/permission restructure plan for the full
// mapping of what's still missing.
//
// Nav items are grouped into sidebar sections, but the sidebar itself only
// ever shows ONE link per group — the group's name (Employee Center, TAMS,
// Leave, ...), not its individual pages. Clicking it opens the first page the
// current user can see in that group; if the group has more than one page
// visible to them, that page renders its own tab bar (see groupTabs() below)
// so the sub-pages live on the content side, not the sidebar. A group with no
// `title` (just Dashboard) is the one exception — it renders as a plain
// top-level link with no group wrapper. A titled group whose items are all
// filtered out for the current user is skipped entirely.
//
// A group can carry a `moduleKey` (see lib/settings.js MODULES): when that
// module is disabled, its group is hidden from everyone except the Super
// Admin, who always keeps access so they can turn it back on under
// Settings > System Settings > Modules. Dashboard, Employee Center and
// Setting itself have no moduleKey — they're always available.
// ---------------------------------------------------------------------------
// NAV_GROUPS — the sidebar navigation structure.
//
// To keep the sidebar compact (no scrolling), related modules are consolidated
// into "mega-groups" with optional `children`.  A mega-group with `children`
// renders as a collapsible accordion:
//   ▸ People Ops          ← clicking toggles expand/collapse
//       Recruitment
//       Onboarding
//       Organization
//
// A mega-group WITHOUT `children` is just a plain single-link entry, the same
// as before.
//
// Each child has its own `moduleKey` so individual sub-modules can still be
// toggled on/off in System Settings.
//
// `groupTabs()` still works unchanged — it looks up groups by their `title`
// string, and every child carries the title it had before so nothing breaks.
// ---------------------------------------------------------------------------
const NAV_GROUPS = [
  // ── Dashboard (always-on, no group wrapper) ──
  {
    items: [
      { href: '/', label: 'Dashboard', icon: 'home', roles: ['ess', 'admin', 'it', 'manager', 'hiring_manager'] },
      { href: '/assistant', label: 'AI Assistant', icon: 'sun', roles: ['ess', 'admin', 'it', 'manager', 'hiring_manager'] },
    ],
  },
  // ── Employee Center ──
  {
    title: 'Employee Center',
    icon: 'user',
    items: [
      { href: '/profile', label: 'My Profile', roles: ['ess', 'admin', 'it', 'manager', 'hiring_manager'] },
      { href: '/directory', label: 'Staff Directory', roles: ['admin', 'manager'] },
      { href: '/directory/approvals', label: 'Pending Approvals', roles: ['admin', 'manager'] },
    ],
  },
  // ── People Ops (mega-group: Recruitment + Onboarding + Organization) ──
  {
    title: 'People Ops',
    icon: 'users',
    children: [
      { title: 'Recruitment',   href: '/recruitment', icon: 'users',     moduleKey: 'recruitment', roles: ['admin', 'manager', 'hiring_manager'] },
      { title: 'Onboarding',    href: '/onboarding',  icon: 'briefcase', moduleKey: 'onboarding',  roles: ['ess', 'admin', 'it', 'manager', 'hiring_manager'] },
      { title: 'Organization',  href: '/org',         icon: 'users',     moduleKey: 'org',         roles: ['ess', 'admin', 'manager', 'hiring_manager'] },
    ],
  },
  // ── Workforce (mega-group: Leave + TAMS + Claims) ──
  {
    title: 'Workforce',
    icon: 'calendar',
    children: [
      { title: 'Leave',            href: '/leave',      icon: 'calendar', moduleKey: 'leave',  roles: ['ess', 'admin', 'it', 'manager'] },
      { title: 'Attendance',       href: '/attendance', icon: 'clock',    moduleKey: 'tams',   roles: ['ess', 'admin', 'it', 'manager'] },
      { title: 'Claims & Medical', href: '/claims',     icon: 'receipt',  moduleKey: 'claims', roles: ['ess', 'admin', 'it', 'manager'] },
    ],
  },
  // ── Talent (mega-group: Performance + Training + Engagement) ──
  {
    title: 'Talent',
    icon: 'file',
    children: [
      { title: 'Performance',  href: '/performance', icon: 'file',      moduleKey: 'performance', roles: ['ess', 'admin', 'manager', 'hiring_manager'] },
      { title: 'Training',     href: '/training',    icon: 'briefcase', moduleKey: 'training',    roles: ['ess', 'admin', 'manager', 'hiring_manager'] },
      { title: 'Engagement',   href: '/engagement',  icon: 'users',     moduleKey: 'engagement',  roles: ['ess', 'admin', 'manager', 'hiring_manager'] },
    ],
  },
  // ── Admin (mega-group: Approvals + Announcements + Disciplinary + Assets) ──
  {
    title: 'Admin',
    icon: 'receipt',
    children: [
      { title: 'Approvals',        href: '/approvals',    icon: 'receipt', moduleKey: 'approvals',    roles: ['admin', 'manager', 'hiring_manager'] },
      { title: 'Announcements',    href: '/announcements', icon: 'file',   moduleKey: 'announcements', roles: ['ess', 'admin', 'it', 'manager', 'hiring_manager'] },
      { title: 'Disciplinary',     href: '/disciplinary', icon: 'file',    moduleKey: 'disciplinary',  roles: ['ess', 'admin', 'manager'] },
      { title: 'Assets',           href: '/assets',       icon: 'receipt', moduleKey: 'assets',        roles: ['ess', 'admin', 'it', 'manager', 'hiring_manager'] },
    ],
  },
  // ── Payroll (standalone) ──
  {
    title: 'Payroll',
    icon: 'cash',
    moduleKey: 'payroll',
    items: [
      { href: '/payroll', label: 'Payroll', roles: ['admin'] },
    ],
  },
  // ── Report (mega-group: Reports + HR Analytics) ──
  {
    title: 'Report',
    icon: 'file',
    children: [
      { title: 'Report',           href: '/reports',      icon: 'file',    moduleKey: 'reports',       roles: ['ess', 'admin', 'it', 'manager'] },
      { title: 'Analytics',        href: '/analytics',    icon: 'file',    moduleKey: 'analytics',     roles: ['admin', 'manager'] },
    ],
  },
  // ── Setting (standalone) ──
  {
    title: 'Setting',
    icon: 'settings',
    items: [
      { href: '/settings', label: 'Setting', roles: ['admin', 'it'] },
    ],
  },
];

// Flatten NAV_GROUPS mega-groups' children into the legacy "flat" lookup table
// so groupTabs() can still find a group by its original title. E.g.
// groupTabs('Recruitment', ...) still works because we build a virtual group
// with title 'Recruitment' from the mega-group child.
const _flatGroupLookup = {};
NAV_GROUPS.forEach((g) => {
  if (g.title && g.items) _flatGroupLookup[g.title] = g;
  if (g.children) {
    g.children.forEach((child) => {
      // Build a virtual NAV_GROUPS entry so groupTabs('Recruitment', ...) etc
      // keep working. Each child acts like a single-item group.
      _flatGroupLookup[child.title] = {
        title: child.title,
        icon: child.icon,
        moduleKey: child.moduleKey,
        items: [{ href: child.href, label: child.title, roles: child.roles }],
      };
    });
  }
});

// Which of a group's items the current user can actually see — same
// role + module-subscription rule the sidebar uses, factored out so a
// content page's tab bar (groupTabs) always agrees with the sidebar about
// what's visible.
function visibleGroupItems(group, user, moduleStates) {
  return group.items.filter((item) => {
    if (!hasAccess(user, item.roles)) return false;
    if (group.moduleKey && moduleStates[group.moduleKey] === false && !isSuperAdmin(user)) return false;
    return true;
  });
}

const ICONS = {
  home: '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12l8.954-8.955a1.125 1.125 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75"/>',
  user: '<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/>',
  clock: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  calendar: '<path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/>',
  receipt: '<path stroke-linecap="round" stroke-linejoin="round" d="M9 14.25l6-6m4.5-3.493V21.75l-3.75-1.5-3.75 1.5-3.75-1.5-3.75 1.5V4.757c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0c1.101.128 1.907 1.077 1.907 2.185z"/>',
  file: '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m5.231 13.481L15 17.25m-1.519-3.75L12 12m1.481 1.5L15 12m-3-3.75h.008v.008H12V8.25zM8.25 21h7.5a2.25 2.25 0 002.25-2.25V6.621a4.5 4.5 0 00-1.318-3.182l-3.621-3.621A4.5 4.5 0 0010.379 0H8.25A2.25 2.25 0 006 2.25v16.5A2.25 2.25 0 008.25 21z"/>',
  users: '<path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"/>',
  cash: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  logout: '<path stroke-linecap="round" stroke-linejoin="round" d="M8.25 9V5.25A2.25 2.25 0 0110.5 3h6a2.25 2.25 0 012.25 2.25v13.5A2.25 2.25 0 0116.5 21h-6a2.25 2.25 0 01-2.25-2.25V15m-3 0l-3-3m0 0l3-3m-3 3H15"/>',
  settings: '<path stroke-linecap="round" stroke-linejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>',
  briefcase: '<path stroke-linecap="round" stroke-linejoin="round" d="M20.25 14.15v4.25c0 1.094-.787 2.036-1.872 2.18-2.087.277-4.216.42-6.378.42s-4.291-.143-6.378-.42c-1.085-.144-1.872-1.086-1.872-2.18v-4.25m16.5 0a2.18 2.18 0 00.75-1.661V8.706c0-1.081-.768-2.015-1.837-2.175a48.114 48.114 0 00-3.413-.387M3.75 14.15a2.18 2.18 0 01-.75-1.661V8.706c0-1.081.768-2.015 1.837-2.175a48.111 48.111 0 013.413-.387m10.5 0a48.455 48.455 0 00-6.75 0m6.75 0V4.5a2.25 2.25 0 00-2.25-2.25h-2.25A2.25 2.25 0 009 4.5v1.643m10.5 0c1.558.115 3.09.28 4.6.495M3.75 6.143C2.192 6.258.66 6.423-.85 6.638M9 4.5h6"/>',
  sun: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m0 13.5V21m8.955-9h-2.25M5.25 12H3m15.364-6.364l-1.591 1.591M6.955 17.045l-1.591 1.591m12.728 0l-1.591-1.591M6.955 6.955L5.364 5.364M12 8.25a3.75 3.75 0 100 7.5 3.75 3.75 0 000-7.5z"/>',
  moon: '<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"/>',
  globe: '<path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m-18.432-6A8.959 8.959 0 003 12c0 .778.099 1.533.284 2.253"/>',
  chevronDown: '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/>',
  chevronRight: '<path stroke-linecap="round" stroke-linejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/>',
};

function icon(name, cls = 'w-5 h-5') {
  return `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="${cls}">${ICONS[name] || ''}</svg>`;
}

function flashFromQuery(url) {
  const err = url.searchParams.get('error');
  const ok = url.searchParams.get('ok');
  let html = '';
  if (err) {
    html += `<div class="mb-4 rounded-lg border border-red-200 bg-red-50 text-red-700 dark:bg-red-950 dark:border-red-800 dark:text-red-300 px-4 py-3 text-sm">${escapeHtml(err)}</div>`;
  }
  if (ok) {
    html += `<div class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-300 px-4 py-3 text-sm">${escapeHtml(ok)}</div>`;
  }
  return html;
}

function layout({ title, user, activePath, body, url }) {
  const moduleStates = user ? getModuleStates() : {};

  // Helper: check if a child is visible to the current user
  const childVisible = (child) => {
    if (!hasAccess(user, child.roles)) return false;
    if (child.moduleKey && moduleStates[child.moduleKey] === false && !isSuperAdmin(user)) return false;
    return true;
  };

  const navLink = (href, label, iconName, active) => `<a href="${href}" class="flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
    active ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
  }">${icon(iconName)}<span>${escapeHtml(label)}</span></a>`;

  const nav = user
    ? NAV_GROUPS.map((group) => {
        // ── Ungrouped (Dashboard) ──
        if (!group.title) {
          const items = visibleGroupItems(group, user, moduleStates);
          return items.map((item) => navLink(item.href, item.label, item.icon, activePath === item.href)).join('');
        }

        // ── Mega-group with children (accordion) ──
        if (group.children) {
          const visibleChildren = group.children.filter(childVisible);
          if (visibleChildren.length === 0) return '';
          // Auto-expand if any child matches the current activePath
          const anyChildActive = visibleChildren.some((c) => c.href === activePath);
          const expandedClass = anyChildActive ? '' : 'hidden';
          const chevronRotate = anyChildActive ? 'rotate-90' : '';

          const childLinks = visibleChildren.map((child) => {
            const isActive = child.href === activePath;
            return `<a href="${child.href}" class="flex items-center gap-2 pl-10 pr-3 py-1.5 rounded-lg text-xs font-medium transition ${
              isActive ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
            }"><span>${escapeHtml(child.title)}</span></a>`;
          }).join('');

          return `<div class="nav-mega-group">
            <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden');this.querySelector('.chevron-icon').classList.toggle('rotate-90')" class="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition ${
              anyChildActive ? 'text-indigo-700 dark:text-indigo-300 bg-indigo-50/50 dark:bg-indigo-950/30' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
            }">
              ${icon(group.icon)}
              <span class="flex-1 text-left">${escapeHtml(group.title)}</span>
              <span class="chevron-icon w-4 h-4 transition-transform ${chevronRotate}">${icon('chevronRight', 'w-3.5 h-3.5')}</span>
            </button>
            <div class="mt-0.5 space-y-0.5 ${expandedClass}">${childLinks}</div>
          </div>`;
        }

        // ── Regular group (single link, same as before) ──
        const items = visibleGroupItems(group, user, moduleStates);
        if (items.length === 0) return '';
        const isActive = group.items.some((item) => item.href === activePath);
        return navLink(items[0].href, group.title, group.icon, isActive);
      }).join('')
    : '';

  return `<!doctype html>
<html lang="en" class="light">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(title)} · StaffHub</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
<script>
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        fontFamily: {
          sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif']
        },
        colors: { brand: { 50:'#eef2ff',100:'#e0e7ff',500:'#6366f1',600:'#4f46e5',700:'#4338ca' } }
      }
    }
  }
</script>
<script>
  // Apply saved theme immediately to avoid flash
  (function() {
    var theme = localStorage.getItem('hrms_theme') || (document.cookie.match(/hrms_theme=([^;]+)/) || [])[1] || 'light';
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  })();
</script>
<link rel="stylesheet" href="/public/styles.css"/>
</head>
<body class="bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100 min-h-screen">
${user ? `
<div class="flex h-screen overflow-hidden">
  <aside class="w-64 shrink-0 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col h-screen sticky top-0 overflow-y-auto">
    <div class="px-5 py-4 border-b border-slate-100 dark:border-slate-800">
      <div class="flex items-center gap-2">
        <div class="w-9 h-9 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold">S</div>
        <div>
          <div class="font-semibold leading-tight dark:text-white">StaffHub</div>
          <div class="text-xs text-slate-500 dark:text-slate-400 leading-tight">HRMS</div>
        </div>
      </div>
    </div>
    <nav class="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">${nav}</nav>
    <div class="px-3 py-3 border-t border-slate-100 dark:border-slate-800 shrink-0">
      <div class="flex items-center gap-3 px-2 mb-2">
        <div class="w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-xs font-semibold text-slate-600 dark:text-slate-200">${escapeHtml((user.name || '?').slice(0,1).toUpperCase())}</div>
        <div class="min-w-0">
          <div class="text-sm font-medium truncate dark:text-white">${escapeHtml(user.name)}</div>
          <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(user.role_name || user.permission_tier)}</div>
        </div>
      </div>
      <a href="/change-password" class="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 mb-1">${icon('settings', 'w-4 h-4')} Change password</a>
      <form action="/logout" method="post">
        <button class="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">${icon('logout', 'w-4 h-4')} Sign out</button>
      </form>
    </div>
  </aside>
  <main class="flex-1 min-w-0 flex flex-col overflow-y-auto">
    <!-- Top Bar for Language & Theme Toggles (Sticky Header) -->
    <header class="sticky top-0 z-10 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800 px-6 py-3 flex justify-between items-center shrink-0">
      <div class="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
        <span class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(user.department || 'StaffHub')}</span>
        <span>•</span>
        <span>${escapeHtml(user.email)}</span>
      </div>
      <div class="flex items-center gap-4">
        <!-- Language Selector -->
        <div class="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          ${icon('globe', 'w-4 h-4')}
          <select id="langSelector" onchange="window.setHrmsLang(this.value)" class="bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded px-2 py-1 text-xs text-slate-700 dark:text-slate-200 focus:outline-none">
            <option value="EN">English (EN)</option>
            <option value="BM">Bahasa Melayu (BM)</option>
            <option value="CN">中文 (CN)</option>
          </select>
        </div>

        <!-- Light / Dark Mode Toggle Button -->
        <button onclick="window.toggleHrmsTheme()" type="button" class="p-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition" title="Toggle Light / Dark Mode">
          <span class="dark:hidden">${icon('moon', 'w-4 h-4')}</span>
          <span class="hidden dark:inline">${icon('sun', 'w-4 h-4')}</span>
        </button>
      </div>
    </header>

    <div class="max-w-6xl mx-auto px-6 py-8 w-full flex-1">
      ${url ? flashFromQuery(url) : ''}
      ${body}
    </div>
  </main>
</div>
` : `
<div class="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
  <div class="w-full max-w-md">
    ${url ? flashFromQuery(url) : ''}
    ${body}
  </div>
</div>
`}
${user ? `
<!-- Compact Floating AI Assistant Trigger Bubble (Bottom Right) -->
<div id="aiDrawerContainer" class="fixed bottom-5 right-5 z-40">
  <button id="aiDrawerBtn" onclick="toggleAiDrawer()" class="bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-lg px-3 py-2 flex items-center space-x-1.5 transition transform hover:scale-105 border border-indigo-400/40">
    <span class="text-base animate-pulse">✨</span>
    <span class="text-[11px] font-bold uppercase tracking-wider pr-0.5">AI</span>
  </button>
</div>

<!-- Sliding Drawer Panel (Fix overflow & scrolling so input is always visible) -->
<div id="aiDrawerPanel" class="fixed inset-y-0 right-0 w-80 sm:w-96 bg-white dark:bg-slate-900 shadow-2xl border-l border-slate-200 dark:border-slate-800 z-50 transform translate-x-full transition-transform duration-300 ease-in-out flex flex-col h-full">
  <!-- Header -->
  <div class="p-3 bg-indigo-600 text-white flex items-center justify-between shadow-sm shrink-0">
    <div class="flex items-center space-x-2">
      <span class="text-base">✨</span>
      <div>
        <h3 class="font-bold text-xs leading-tight">StaffHub AI Assistant</h3>
        <p class="text-[9px] text-indigo-200 uppercase tracking-wider">${escapeHtml(user.permission_tier)} Tier</p>
      </div>
    </div>
    <div class="flex items-center space-x-2">
      <a href="/assistant" class="text-[11px] text-indigo-100 hover:text-white underline mr-1">Full View</a>
      <button onclick="toggleAiDrawer()" class="text-indigo-200 hover:text-white text-lg font-bold px-1">&times;</button>
    </div>
  </div>

  <!-- Messages Scroll Area -->
  <div id="drawerChatHistory" class="flex-1 p-3 overflow-y-auto space-y-2.5 bg-slate-50 dark:bg-slate-950 text-xs">
    <div class="flex items-start space-x-2">
      <div class="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[9px] font-bold shrink-0">
        AI
      </div>
      <div class="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-2.5 text-slate-800 dark:text-slate-200 max-w-[85%] shadow-sm">
        Hi ${escapeHtml(user.name)}! Ask me about your leave balance, payslips, or request actions like applying for leave or submitting claims.
      </div>
    </div>
  </div>

  <!-- Dynamic Thinking / Loading Box with Rotating HR Facts -->
  <div id="drawerThinkingBox" class="hidden p-3 bg-indigo-50/90 dark:bg-indigo-950/80 border-t border-indigo-100 dark:border-indigo-900 shrink-0 text-xs transition">
    <div class="flex items-center space-x-2 text-indigo-700 dark:text-indigo-300 font-semibold mb-1">
      <svg class="animate-spin h-3.5 w-3.5 text-indigo-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span>AI is thinking & processing...</span>
    </div>
    <div id="drawerHrFact" class="text-[11px] text-indigo-900/80 dark:text-indigo-200/80 italic pl-5">
      Did you know? Flexible working arrangements improve employee retention by up to 25%!
    </div>
  </div>

  <!-- Sticky Bottom Input Form (Always visible without scrolling page) -->
  <div class="p-2.5 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800 flex items-center space-x-2 shrink-0">
    <input type="text" id="drawerChatInput" onkeydown="if(event.key==='Enter') sendDrawerMessage()" placeholder="Type a message or command..." class="flex-1 border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500">
    <button onclick="sendDrawerMessage()" id="drawerSendBtn" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition">
      Send
    </button>
  </div>
</div>

<script>
  let drawerState = null;
  let factInterval = null;
  const HR_FACTS = [
    "💡 Did you know? Regular continuous learning initiatives boost employee performance by 18%.",
    "💡 HR Fact: Malaysian Employment Act mandates a minimum of 60 days maternity leave & 7 days paternity leave.",
    "💡 Did you know? Clear feedback loops increase team engagement and satisfaction by 30%.",
    "💡 HR Fact: Automated payslip generation reduces payroll calculation errors by over 90%.",
    "💡 Did you know? Promoting wellness in the workplace reduces unscheduled absenteeism by 28%!"
  ];

  function toggleAiDrawer() {
    const panel = document.getElementById('aiDrawerPanel');
    if (!panel) return;
    if (panel.classList.contains('translate-x-full')) {
      panel.classList.remove('translate-x-full');
      setTimeout(() => document.getElementById('drawerChatInput')?.focus(), 300);
    } else {
      panel.classList.add('translate-x-full');
    }
  }

  function startHrFacts() {
    const box = document.getElementById('drawerThinkingBox');
    const factElem = document.getElementById('drawerHrFact');
    if (!box || !factElem) return;
    box.classList.remove('hidden');
    let idx = 0;
    factElem.innerText = HR_FACTS[0];
    factInterval = setInterval(() => {
      idx = (idx + 1) % HR_FACTS.length;
      factElem.innerText = HR_FACTS[idx];
    }, 2800);
  }

  function stopHrFacts() {
    const box = document.getElementById('drawerThinkingBox');
    if (box) box.classList.add('hidden');
    if (factInterval) clearInterval(factInterval);
  }

  function appendDrawerMsg(sender, text, confirmation) {
    const history = document.getElementById('drawerChatHistory');
    if (!history) return;
    const isUser = sender === 'user';
    let contentHtml = (typeof marked !== 'undefined') ? marked.parse(text) : text.replace(/\\n/g, '<br>');
    
    if (confirmation) {
      contentHtml += '<div class="mt-2 pt-2 border-t border-indigo-200 dark:border-indigo-800 flex space-x-2">' +
        '<button onclick="confirmDrawerAction(true)" class="bg-indigo-600 hover:bg-indigo-700 text-white px-2 py-1 rounded text-[10px] font-semibold">Confirm</button>' +
        '<button onclick="confirmDrawerAction(false)" class="bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200 px-2 py-1 rounded text-[10px] font-semibold">Cancel</button>' +
        '</div>';
    }

    const msgHtml = isUser ? 
      '<div class="flex items-start justify-end space-x-2">' +
        '<div class="bg-indigo-600 text-white rounded-xl p-2.5 text-xs max-w-[85%] shadow-sm">' +
          contentHtml +
        '</div>' +
      '</div>' : 
      '<div class="flex items-start space-x-2">' +
        '<div class="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-[9px] font-bold shrink-0">' +
          'AI' +
        '</div>' +
        '<div class="chat-bubble bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-2.5 text-slate-800 dark:text-slate-200 max-w-[85%] shadow-sm overflow-x-auto">' +
          contentHtml +
        '</div>' +
      '</div>';

    history.insertAdjacentHTML('beforeend', msgHtml);
    history.scrollTop = history.scrollHeight;
  }

  async function sendDrawerMessage() {
    const input = document.getElementById('drawerChatInput');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;

    appendDrawerMsg('user', msg);
    input.value = '';
    startHrFacts();

    try {
      const res = await fetch('/api/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, state: drawerState })
      });
      const data = await res.json();
      stopHrFacts();
      drawerState = data.state;
      appendDrawerMsg('assistant', data.text || data.error || 'Done.', data.confirmation);
    } catch (e) {
      stopHrFacts();
      appendDrawerMsg('assistant', 'An error occurred while processing your request.');
    }
  }

  function confirmDrawerAction(isYes) {
    const input = document.getElementById('drawerChatInput');
    if (input) {
      input.value = isYes ? 'yes' : 'no';
      sendDrawerMessage();
    }
  }
</script>
` : ''}
<script src="/public/i18n.js"></script>
<script src="/public/app.js"></script>
</body>
</html>`;
}

function card(titleOrContent, bodyOrCls = '', optionalCls = '') {
  if (bodyOrCls && (bodyOrCls.includes('<') || bodyOrCls.includes('\n'))) {
    const titleHtml = titleOrContent ? `<h3 class="text-base font-semibold text-slate-900 dark:text-slate-100 mb-4">${escapeHtml(titleOrContent)}</h3>` : '';
    return `<div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-6 ${optionalCls}">${titleHtml}${bodyOrCls}</div>`;
  }
  return `<div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm p-6 ${bodyOrCls}">${titleOrContent}</div>`;
}

function badge(text, color = 'slate') {
  const map = {
    slate: 'bg-slate-100 text-slate-700',
    green: 'bg-emerald-100 text-emerald-700',
    red: 'bg-red-100 text-red-700',
    yellow: 'bg-amber-100 text-amber-700',
    blue: 'bg-blue-100 text-blue-700',
  };
  return `<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${map[color] || map.slate}">${escapeHtml(text)}</span>`;
}

// Renders the content-side tab bar for a NAV_GROUPS group whose sidebar link
// is a single entry point into more than one page (e.g. Employee Center:
// My Profile / Employee Directory). Call this from each of that group's page
// routes, passing that page's own href as activeHref. Returns '' when the
// current user can only see one page in the group — nothing to switch
// between, so no tab bar is shown.
//
// Since the sidebar consolidation, some former top-level groups (e.g.
// 'Recruitment') are now children of mega-groups (e.g. 'People Ops').
// _flatGroupLookup lets groupTabs('Recruitment', ...) still work.
function groupTabs(groupTitle, user, activeHref) {
  const group = _flatGroupLookup[groupTitle] || NAV_GROUPS.find((g) => g.title === groupTitle);
  if (!group) return '';
  const items = visibleGroupItems(group, user, getModuleStates());
  if (items.length <= 1) return '';
  return `<div class="flex gap-2 mb-6 text-sm">${items.map((item) => `<a href="${item.href}" class="px-3 py-1.5 rounded-lg font-medium ${
    activeHref === item.href ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
  }">${escapeHtml(item.label)}</a>`).join('')}</div>`;
}

// Renders a lightweight query-param ("?tab=key") tab bar for switching
// sub-sections within a single page — used by the Profile page's 4 tabs
// (Employee Details / Employee Occupation / Family / Employment History).
// Salary lives inside Employee Details (Admin-only card) and Malaysian
// Statutory inside Employee Occupation, rather than as their own tabs — see
// Q2 in the nav/permission restructure plan. Unlike groupTabs (which switches between
// different routes for a sidebar group), all of these tabs live on the same
// route, so baseHref should be that route's own path (e.g. '/profile' or
// '/profile/12') and each link just changes the tab query param.
function subTabs(tabs, activeKey, baseHref) {
  return `<div class="flex gap-2 mb-6 text-sm flex-wrap">${tabs.map((t) => `<a href="${baseHref}?tab=${t.key}" class="px-3 py-1.5 rounded-lg font-medium ${
    activeKey === t.key ? 'bg-indigo-600 text-white' : 'bg-white border border-slate-200 text-slate-600'
  }">${escapeHtml(t.label)}</a>`).join('')}</div>`;
}

function statusBadge(status) {
  const colors = { pending: 'yellow', approved: 'green', rejected: 'red', cancelled: 'slate', paid: 'blue', draft: 'slate', finalized: 'green', present: 'green', late: 'yellow', half_day: 'blue', active: 'green', inactive: 'slate' };
  return badge(status.replace('_', ' '), colors[status] || 'slate');
}

module.exports = { layout, escapeHtml, card, badge, statusBadge, icon, groupTabs, subTabs };
