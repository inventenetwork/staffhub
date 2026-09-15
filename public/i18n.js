(function() {
  'use strict';

  const DICTIONARY = {
    BM: {
      // Sidebar & Navigation
      'Dashboard': 'Papan Pemuka',
      'Employee Center': 'Pusat Pekerja',
      'My Profile': 'Profil Saya',
      'Staff Directory': 'Direktori Staf',
      'Pending Approvals': 'Kelulusan Belum Selesai',
      'Approval Center': 'Pusat Kelulusan',
      'Organization': 'Organisasi',
      'Organization Management': 'Pengurusan Organisasi',
      'Recruitment': 'Pengambilan Pekerja',
      'Onboarding & Offboarding': 'Kemasukan & Keluar Staf',
      'Announcements': 'Pengumuman',
      'Announcements & Policy': 'Pengumuman & Polisi',
      'Engagement': 'Penglibatan Pekerja',
      'Employee Engagement': 'Penglibatan Pekerja',
      'Performance': 'Prestasi',
      'Performance Management': 'Pengurusan Prestasi',
      'Training & Dev': 'Latihan & Pembangunan',
      'Training & Development': 'Latihan & Pembangunan',
      'Disciplinary & IR': 'Tindakan Disiplin & IR',
      'Asset Management': 'Pengurusan Aset',
      'TAMS': 'Kehadiran (TAMS)',
      'Attendance': 'Rekod Kehadiran',
      'Payroll': 'Gaji & Payroll',
      'Leave': 'Permohonan Cuti',
      'Claims & Medical': 'Tuntutan & Perubatan',
      'Report': 'Laporan',
      'Setting': 'Tetapan Sistem',
      'Settings': 'Tetapan Sistem',
      'HR Analytics': 'Analisis HR & Infografik',
      'Change password': 'Tukar Kata Laluan',
      'Sign out': 'Log Keluar',

      // Top Settings Tabs & Sub-Modules
      'HR System Settings (Head of HR & Admin)': 'Tetapan Sistem HR (Ketua HR & Pentadbir)',
      'System Preferences (All Users)': 'Keutamaan Sistem (Semua Pengguna)',
      'Security Settings (RBAC)': 'Tetapan Keselamatan (RBAC)',
      'Module Subscriptions (SaaS Vendor Staff Only)': 'Langganan Modul (Kakitangan Pembekal SaaS Sahaja)',
      '1. Employee Module': '1. Modul Pekerja',
      '2. Leave Module': '2. Modul Cuti',
      '3. Payroll & Statutory': '3. Gaji & Statutori',
      '4. Attendance & Claims': '4. Kehadiran & Tuntutan',
      '5. Company Profile': '5. Profil Syarikat',
      'Employee Module & Master Dropdown Options': 'Modul Pekerja & Pilihan Dropdown Induk',
      'Configure employee numbering rules and manage master dropdown lists': 'Konfigurasi peraturan nombor pekerja dan uruskan senarai dropdown induk',
      'Default Probation Period': 'Tempoh Percubaan Lalai',
      'Automatic Age Calculation': 'Pengiraan Umur Automatik',
      'Master Employee Dropdowns (Departments, Banks, Statuses)': 'Dropdown Induk Pekerja (Jabatan, Bank, Status)',
      'Employees Options': 'Pilihan Dropdown Pekerja',
      'Departments Configurator': 'Konfigurator Jabatan',
      'Manage available options for forms & dropdown selects': 'Urus pilihan yang ada untuk borang & pilihan dropdown',
      'Configured': 'Dikonfigurasikan',

      // System Preferences
      'Internationalization & Language': 'Pengantarabangsaan & Bahasa',
      'Preferred System Language': 'Bahasa Sistem Pilihan',
      'English (EN)': 'Bahasa Inggeris (EN)',
      'Bahasa Malaysia (BM)': 'Bahasa Malaysia (BM)',
      'Notification Center': 'Pusat Pemberitahuan',
      'Email Notifications': 'Pemberitahuan Emel',
      'Receive approval status alerts and payslips via email': 'Terima amaran status kelulusan dan penyata gaji melalui emel',
      'Push Alerts': 'Pemberitahuan Tolak',
      'Real-time alerts for clock-ins and announcements': 'Amaran masa nyata untuk rekod kehadiran dan pengumuman',
      'Display Theme': 'Tema Paparan',
      'Executive Dark Mode': 'Mod Gelap Eksekutif',
      'Crisp Light Mode': 'Mod Terang Jelas',
      'Server Setting: Email Server': 'Tetapan Pelayan: Pelayan Emel',

      // Security Settings
      'Credential Policies & Security Control (Admin View)': 'Polisi Kredensial & Kawalan Keselamatan (Pandangan Pentadbir)',
      'Two-Factor Authentication (2FA)': 'Pengesahan Dua Faktor (2FA)',
      'Require authenticator codes alongside login credentials': 'Perlukan kod pengesah bersama kredensial log masuk',
      'Self-Service Password Reset': 'Tetap Semula Kata Laluan Swaperkhidmatan',
      'Allow Employees and Managers to initiate password resets': 'Benarkan Pekerja dan Pengurus memulakan tetap semula kata laluan',
      'Session Inactivity Timeout': 'Masa Tamat Tidak Aktif Sesi',

      // General Buttons & Statuses
      'Save': 'Simpan',
      'Save Changes': 'Simpan Perubahan',
      'Cancel': 'Batal',
      'Delete': 'Padam',
      'Edit': 'Kemaskini',
      'Add Option': 'Tambah Pilihan',
      'Pending': 'Belum Selesai',
      'Approved': 'Diluluskan',
      'Rejected': 'Ditolak',
      'Completed': 'Selesai',
      'Active': 'Aktif',
      'Inactive': 'Tidak Aktif',
      'Actions': 'Tindakan',
      'Search': 'Cari',
      'Filter': 'Tapis',

      // HR Analytics & Infographics
      'HR Executive Analytics & Infographics': 'Analisis Eksekutif HR & Infografik',
      'Active Staff': 'Kakitangan Aktif',
      'Inactive / Exited': 'Tidak Aktif / Exited',
      'Avg. Tenure': 'Purata Tempoh Perkhidmatan',
      'Departments': 'Jabatan',
      'Headcount Overview': 'Gambaran Keseluruhan Bilangan Kakitangan',
      'Headcount Distribution & Growth': 'Taburan & Pertumbuhan Kakitangan',
      'Payroll Expenditure Analytics': 'Analisis Perbelanjaan Gaji',
      'Leave & Attendance Utilization': 'Penggunaan Cuti & Kehadiran',
      'Claims & Recruitment Pipeline': 'Saluran Tuntutan & Pengambilan Pekerja',
      'Print / Save Report': 'Cetak / Simpan Laporan',
    },
    CN: {
      // Sidebar & Navigation
      'Dashboard': '仪表板',
      'Employee Center': '员工中心',
      'My Profile': '个人资料',
      'Staff Directory': '员工名册',
      'Pending Approvals': '待办审批',
      'Approval Center': '统一审批中心',
      'Organization': '组织架构',
      'Organization Management': '组织架构管理',
      'Recruitment': '招聘管理',
      'Onboarding & Offboarding': '入职与离职',
      'Announcements': '公告栏',
      'Announcements & Policy': '公告与政策',
      'Engagement': '员工参与度',
      'Employee Engagement': '员工参与度与eNPS',
      'Performance': '绩效管理',
      'Performance Management': '绩效管理',
      'Training & Dev': '培训与发展',
      'Training & Development': '培训与发展',
      'Disciplinary & IR': '纪律与劳资关系',
      'Asset Management': '资产管理',
      'TAMS': '考勤管理',
      'Attendance': '考勤记录',
      'Payroll': '薪酬管理',
      'Leave': '请假管理',
      'Claims & Medical': '报销与医疗',
      'Report': '报表中心',
      'Setting': '系统设置',
      'Settings': '系统设置',
      'HR Analytics': '人力资源分析与图表',
      'Change password': '修改密码',
      'Sign out': '退出登录',

      // Top Settings Tabs & Sub-Modules
      'HR System Settings (Head of HR & Admin)': 'HR系统设置 (HR主管与管理员)',
      'System Preferences (All Users)': '系统偏好 (所有用户)',
      'Security Settings (RBAC)': '安全设置 (RBAC)',
      'Module Subscriptions (SaaS Vendor Staff Only)': '模块订阅 (仅限SaaS服务商)',
      '1. Employee Module': '1. 员工模块',
      '2. Leave Module': '2. 请假模块',
      '3. Payroll & Statutory': '3. 薪酬与法定扣缴',
      '4. Attendance & Claims': '4. 考勤与报销',
      '5. Company Profile': '5. 公司资料',

      // General Buttons & Statuses
      'Save': '保存',
      'Save Changes': '保存修改',
      'Cancel': '取消',
      'Delete': '删除',
      'Edit': '编辑',
      'Add Option': '添加选项',
      'Pending': '待处理',
      'Approved': '已批准',
      'Rejected': '已拒绝',
      'Completed': '已完成',
      'Active': '在职',
      'Inactive': '离职',
    }
  };

  function getLang() {
    var match = document.cookie.match(/hrms_lang=([^;]+)/);
    return match ? match[1] : (localStorage.getItem('hrms_lang') || 'EN');
  }

  function applyLanguage(lang) {
    if (lang === 'EN' || !DICTIONARY[lang]) return;
    const dict = DICTIONARY[lang];

    // Sort keys by length descending to match longest phrase matches first
    const keys = Object.keys(dict).sort(function(a, b) { return b.length - a.length; });

    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while ((node = walk.nextNode())) {
      let text = node.nodeValue;
      const trimmed = text.trim();
      if (!trimmed) continue;

      let modified = false;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (text.includes(k)) {
          text = text.replaceAll(k, dict[k]);
          modified = true;
        }
      }
      if (modified) {
        node.nodeValue = text;
      }
    }
  }

  window.setHrmsLang = function(lang) {
    localStorage.setItem('hrms_lang', lang);
    document.cookie = 'hrms_lang=' + lang + '; path=/; max-age=31536000';
    window.location.reload();
  };

  window.toggleHrmsTheme = function() {
    const isDark = document.documentElement.classList.toggle('dark');
    const theme = isDark ? 'dark' : 'light';
    localStorage.setItem('hrms_theme', theme);
    document.cookie = 'hrms_theme=' + theme + '; path=/; max-age=31536000';
  };

  document.addEventListener('DOMContentLoaded', function() {
    const lang = getLang();
    const selector = document.getElementById('langSelector');
    if (selector) selector.value = lang;
    applyLanguage(lang);
  });
})();

