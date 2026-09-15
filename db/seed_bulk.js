'use strict';
const db = require('./index');
const { hashPassword } = require('../lib/auth');
const { computePayslip } = require('../lib/statutory');
const PW = hashPassword('password123');
const FIRST=['Ahmad','Nurul','Farah','Hafiz','Zulaikha','Danial','Amirah','Syafiq','Nadia','Razif','Mei','Wei','Hui','Jun','Kavitha','Priya','Vikram','Suresh','Anitha','Muhammad','Nur','Wan','Siti','Mohd','Fatin','Jasmine','Khairul','Liana','Yasmin','Zahra'];
const LAST=['Hassan','Rahman','Zulkifli','Abdullah','Ismail','Yusof','Bakar','Ibrahim','Lim','Tan','Wong','Ng','Muthu','Krishnan','Nair','Raj','Hussain','Kamaruddin','Mansor','Nordin','Osman','Ramli','Samad','Yazid','Ong','Foo','Chew','Patel','Kumar','Singh'];
const DEPTS=['Engineering','Human Resources','Finance','Sales','Operations','Product and Design','Information Technology','Marketing','Legal','Customer Success'];
const POSITIONS={'Engineering':['Software Engineer','Senior Software Engineer','DevOps Engineer','QA Engineer','Tech Lead'],'Human Resources':['HR Executive','HR Officer','Payroll Executive','Recruitment Specialist'],'Finance':['Finance Executive','Senior Accountant','Accounts Payable','Finance Manager'],'Sales':['Sales Executive','Account Manager','Sales Manager','Business Dev Executive'],'Operations':['Operations Executive','Operations Coordinator','Process Analyst'],'Product and Design':['Product Manager','UX Designer','UI Designer','Product Analyst'],'Information Technology':['IT Support','System Administrator','Network Engineer','IT Manager'],'Marketing':['Marketing Executive','Digital Marketer','Content Creator','SEO Specialist'],'Legal':['Legal Counsel','Paralegal','Compliance Officer'],'Customer Success':['Customer Success Manager','Support Specialist','Account Executive']};
const BANKS=['Maybank','CIMB Bank','Public Bank','RHB Bank','Hong Leong Bank','Bank Islam','AmBank','Alliance Bank'];
const MARITAL=['single','married','married','married'];
const GENDERS=['Male','Female'];
const NATS=['Malaysian','Malaysian','Malaysian','Malaysian','Singaporean','Indonesian'];
const STATES=['Kuala Lumpur','Petaling Jaya','Shah Alam','Subang Jaya','Ampang','Bangsar','Damansara','Puchong'];
const SALARY={'Engineering':[5000,12000],'Human Resources':[4000,9000],'Finance':[4500,10000],'Sales':[4000,9000],'Operations':[3800,8000],'Product and Design':[5500,11000],'Information Technology':[5000,10000],'Marketing':[4000,8500],'Legal':[6000,13000],'Customer Success':[3800,7500]};
const INSTS=['Universiti Malaya','UTM','UPM','UiTM','Monash University Malaysia','Taylors University','Sunway University'];
const QUALS=['Bachelor Degree','Master Degree','Diploma'];
const FIELDS=['Computer Science','Business Administration','Engineering','Finance','Marketing','Law','Design'];
const CERTS=['AWS Certified Solutions Architect','PMP Certification','ACCA','Google Analytics Certified','HRDF Approved Trainer','ISO 9001 Internal Auditor'];
const CERTB=['AWS','PMI','ACCA','Google','HRDF','ISO'];
const ASSETS=['MacBook Pro 14','Dell XPS 15','Lenovo ThinkPad X1','HP EliteBook 840','iPhone 14 Pro','Samsung Galaxy S24','iPad Air','Dell UltraSharp 27'];
function rnd(a){return a[Math.floor(Math.random()*a.length)];}
function ri(lo,hi){return lo+Math.floor(Math.random()*(hi-lo+1));}
function zp(n,l){return String(n).padStart(l,'0');}
function ds(y,m,d){return y+'-'+zp(m,2)+'-'+zp(d,2);}
const PH=new Set(db.prepare('SELECT holiday_date FROM public_holidays').all().map(r=>r.holiday_date));
function isWD(s){const d=new Date(s+'T00:00:00');return d.getDay()!==0&&d.getDay()!==6&&!PH.has(s);}
const WDAYS=(function(){const r=[];let c=new Date('2026-01-01T00:00:00');const e=new Date('2026-09-09T00:00:00');while(c<=e){const s=c.toISOString().slice(0,10);if(isWD(s))r.push(s);c.setDate(c.getDate()+1);}return r;}());
function begin(){db.exec('BEGIN');}
function commit(){db.exec('COMMIT');}
function rollback(){try{db.exec('ROLLBACK');}catch(_){}}
function run(){
  console.log('Bulk seed starting... ('+WDAYS.length+' working days)');
  const essRole=db.prepare('SELECT id FROM roles WHERE is_system=1 AND permission_tier=?').get('ess');
  if(!essRole){console.error('Run seed.js first');process.exit(1);}
  const lts=db.prepare('SELECT id,name FROM leave_types').all();
  const annualId=(lts.find(l=>l.name==='Annual Leave')||{id:null}).id;
  const medicalId=(lts.find(l=>l.name==='Medical Leave')||{id:null}).id;
  const emergencyId=(lts.find(l=>l.name==='Emergency Leave')||{id:null}).id;
  const hrAdm=db.prepare('SELECT id FROM users WHERE email=?').get('hradmin@staffhub.my');
  const hrAdminId=hrAdm?hrAdm.id:1;
  const deptMgr={};
  db.prepare('SELECT id,department FROM users WHERE status=?').all('active').forEach(u=>{if(u.department&&!deptMgr[u.department])deptMgr[u.department]=u.id;});
  let maxEmp=0;
  db.prepare('SELECT employee_no FROM users WHERE employee_no LIKE ?').all('EMP%').forEach(r=>{const n=parseInt(r.employee_no.replace(/[^0-9]/g,''),10);if(!isNaN(n)&&n>maxEmp)maxEmp=n;});
  const empIds=[];
  const usedEmails=new Set();
  console.log('Creating 100 employees...');
  begin();
  try{
    for(let i=0;i<100;i++){
      const dept=DEPTS[i%DEPTS.length];
      const fn=rnd(FIRST),ln=rnd(LAST),name=fn+' '+ln;
      maxEmp++;
      const empNo='EMP'+zp(maxEmp,4);
      let email=(fn+'.'+ln+i).toLowerCase().replace(/[^a-z0-9.]/g,'')+'@staffhub.my';
      while(usedEmails.has(email)){email=(fn+'.'+ln+ri(100,9999)).toLowerCase().replace(/[^a-z0-9.]/g,'')+'@staffhub.my';}
      usedEmails.add(email);
      const dobY=ri(1975,2000),dobM=ri(1,12),dobD=ri(1,28);
      let ic = String(dobY).slice(2)+zp(dobM,2)+zp(dobD,2)+'-'+zp(ri(1,16),2)+'-'+zp(ri(1000,9999),4);
      while(usedEmails.has(ic)){ ic = String(dobY).slice(2)+zp(dobM,2)+zp(dobD,2)+'-'+zp(ri(1,16),2)+'-'+zp(ri(1000,9999),4); }
      usedEmails.add(ic);
      const gender=rnd(GENDERS),marital=rnd(MARITAL),numCh=marital==='married'?ri(0,3):0;
      const joinDate=ds(ri(2021,2025),ri(1,12),ri(1,28));
      const sr=SALARY[dept]||[4000,8000],salary=ri(sr[0],sr[1]);
      const posArr=POSITIONS[dept]||['Executive'],pos=posArr[ri(0,posArr.length-1)];
      const dSup=deptMgr[dept]||hrAdminId;
      const phone='01'+ri(0,9)+'-'+zp(ri(1000000,9999999),7);
      const ex=db.prepare('SELECT id FROM users WHERE email=?').get(email);
      let uid;
      if(ex){uid=ex.id;}
      else{
        const info=db.prepare('INSERT INTO users (employee_no,name,email,password_hash,role_id,department,position,nationality,gender,join_date,phone,ic_number,address,bank_name,bank_account,marital_status,num_children,date_of_birth,direct_superior_id,indirect_superior_id,basic_salary,employment_type,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(empNo,name,email,PW,essRole.id,dept,pos,rnd(NATS),gender,joinDate,phone,ic,rnd(STATES)+', Malaysia',rnd(BANKS),zp(ri(1000000000,9999999999),10),marital,numCh,ds(dobY,dobM,dobD),dSup,hrAdminId,salary,rnd(['Permanent','Contract','Part-time']),'active');
        uid=info.lastInsertRowid;
        if(!deptMgr[dept])deptMgr[dept]=uid;
      }
      empIds.push(uid);
      if(!db.prepare('SELECT id FROM emergency_contacts WHERE user_id=?').get(uid))db.prepare('INSERT INTO emergency_contacts (user_id,name,relationship,phone) VALUES (?,?,?,?)').run(uid,'Emergency Contact',rnd(['Spouse','Parent','Sibling']),'012-'+zp(ri(1000000,9999999),7));
      if(marital==='married'&&!db.prepare('SELECT id FROM family_members WHERE user_id=?').get(uid)){db.prepare('INSERT INTO family_members (user_id,name,relationship,date_of_birth,gender,occupation,spouse_working) VALUES (?,?,?,?,?,?,?)').run(uid,'Spouse','spouse','1985-06-01',gender==='Male'?'Female':'Male','Professional',1);for(let c=0;c<numCh;c++)db.prepare('INSERT INTO family_members (user_id,name,relationship,date_of_birth,gender,child_studying_fulltime) VALUES (?,?,?,?,?,?)').run(uid,'Child '+(c+1),'child','2015-01-01',rnd(GENDERS),1);}
      if(!db.prepare('SELECT id FROM education_background WHERE user_id=?').get(uid))db.prepare('INSERT INTO education_background (user_id,institution,qualification,field_of_study,start_year,end_year,grade) VALUES (?,?,?,?,?,?,?)').run(uid,rnd(INSTS),rnd(QUALS),rnd(FIELDS),ri(2010,2018),ri(2013,2022),rnd(['First Class','Second Upper','Second Lower','Pass']));
      if(!db.prepare('SELECT id FROM certifications_skills WHERE user_id=?').get(uid)){const ci=ri(0,CERTS.length-1);db.prepare('INSERT INTO certifications_skills (user_id,name,issuing_body,issue_date,expiry_date) VALUES (?,?,?,?,?)').run(uid,CERTS[ci],CERTB[ci%CERTB.length],'2023-'+zp(ri(1,12),2)+'-01','2026-'+zp(ri(1,12),2)+'-01');}
      for(const[ltId,days]of[[annualId,14],[medicalId,14],[emergencyId,3]]){if(!ltId)continue;if(!db.prepare('SELECT id FROM leave_balances WHERE user_id=? AND leave_type_id=? AND year=2026').get(uid,ltId))db.prepare('INSERT INTO leave_balances (user_id,leave_type_id,year,entitled_days,used_days) VALUES (?,?,2026,?,0)').run(uid,ltId,days);}
    }
    commit();
  }catch(e){rollback();throw e;}
  console.log('Employees: '+empIds.length);

  console.log('Attendance logs ('+WDAYS.length+' days x '+empIds.length+')...');
  const attS=db.prepare('INSERT OR IGNORE INTO attendance_logs (user_id,work_date,clock_in,clock_out,status) VALUES (?,?,?,?,?)');
  for(const uid of empIds){
    begin();
    try{
      for(const wd of WDAYS){
        const r=Math.random();
        let st,ci,co;
        if(r<0.04){st='absent';ci=null;co=null;}
        else if(r<0.15){st='late';ci='09:'+zp(ri(16,55),2);co='18:'+zp(ri(0,30),2);}
        else{st='present';ci='08:'+zp(ri(45,59),2);co='18:'+zp(ri(0,30),2);}
        attS.run(uid,wd,ci,co,st);
      }
      commit();
    }catch(e){rollback();throw e;}
  }
  console.log('Attendance done.');

  console.log('Leave applications...');
  if(annualId&&medicalId){
    const lvS=db.prepare('INSERT INTO leave_applications (user_id,leave_type_id,start_date,end_date,days,reason,approver_id,status) VALUES (?,?,?,?,?,?,?,?)');
    begin();
    try{
      for(const uid of empIds){
        const sup=(db.prepare('SELECT direct_superior_id FROM users WHERE id=?').get(uid)||{}).direct_superior_id||hrAdminId;
        const months=[1,3,5,7];
        for(let a=0;a<ri(2,3);a++){
          const mth=months[a];
          const sd=ds(2026,mth,ri(1,20)),nd=ri(1,3);
          lvS.run(uid,annualId,sd,ds(2026,mth,Math.min(ri(1,20)+nd,28)),nd,rnd(['Family trip','Personal matter','Rest day','Appointment']),sup,a===0?'pending':'approved');
        }
        lvS.run(uid,medicalId,ds(2026,ri(1,8),ri(1,25)),ds(2026,ri(1,8),ri(1,25)),1,'Medical consultation',sup,'approved');
      }
      commit();
    }catch(e){rollback();throw e;}
  }
  console.log('Leave done.');

  console.log('Claims...');
  const clS=db.prepare('INSERT INTO claims (user_id,category,subcategory,claim_date,description,amount,status,approver_id) VALUES (?,?,?,?,?,?,?,?)');
  begin();
  try{
    for(const uid of empIds){
      const sup=(db.prepare('SELECT direct_superior_id FROM users WHERE id=?').get(uid)||{}).direct_superior_id||hrAdminId;
      if(!db.prepare('SELECT id FROM medical_limits WHERE user_id=? AND year=2026').get(uid))db.prepare('INSERT INTO medical_limits (user_id,year) VALUES (?,2026)').run(uid);
      for(const mth of[1,4,7]){
        const d=ds(2026,mth,ri(1,25)),r=Math.random();
        if(r<0.35)clS.run(uid,'travel','mileage',d,'Client visit',Math.round(ri(20,80)*0.6*100)/100,rnd(['approved','approved','pending']),sup);
        else if(r<0.65)clS.run(uid,'medical','outpatient',d,'Medical consultation',ri(50,300),rnd(['approved','approved','pending']),sup);
        else clS.run(uid,'general','entertainment',d,'Team lunch',ri(20,80),rnd(['approved','pending']),sup);
      }
    }
    commit();
  }catch(e){rollback();throw e;}
  console.log('Claims done.');

  console.log('Payroll runs Jan-Aug 2026...');
  const allU=db.prepare('SELECT u.*,r.permission_tier FROM users u JOIN roles r ON r.id=u.role_id WHERE u.status=?').all('active');
  const pS=db.prepare('INSERT INTO payslips (payroll_run_id,user_id,basic_salary,allowances,overtime,gross_pay,epf_employee,epf_employer,socso_employee,socso_employer,eis_employee,eis_employer,pcb,other_deductions,net_pay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for(let month=1;month<=8;month++){
    if(db.prepare('SELECT id FROM payroll_runs WHERE month=? AND year=2026').get(month)){console.log('  '+month+'/2026 exists');continue;}
    const runId=db.prepare('INSERT INTO payroll_runs (month,year,status,finalized_at) VALUES (?,2026,?,datetime(?))').run(month,'finalized','now').lastInsertRowid;
    begin();
    try{
      for(const emp of allU){
        const al=['admin','super_admin'].includes(emp.permission_tier)?500:ri(0,300);
        const ot=Math.random()<0.3?ri(100,500):0;
        const c=computePayslip({basic_salary:emp.basic_salary,allowances:al,overtime:ot,other_deductions:0,date_of_birth:emp.date_of_birth,marital_status:emp.marital_status,num_children:emp.num_children});
        pS.run(runId,emp.id,c.basic_salary,c.allowances,c.overtime,c.gross_pay,c.epf_employee,c.epf_employer,c.socso_employee,c.socso_employer,c.eis_employee,c.eis_employer,c.pcb,c.other_deductions,c.net_pay);
      }
      commit();
    }catch(e){rollback();throw e;}
    console.log('  '+month+'/2026 done ('+allU.length+' payslips)');
  }

  console.log('Assets...');
  const aS=db.prepare('INSERT OR IGNORE INTO company_assets (asset_tag,name,category,serial_number,purchase_cost,purchase_date,status,assigned_user_id,issued_date) VALUES (?,?,?,?,?,?,?,?,?)');
  begin();
  try{
    for(let idx=0;idx<Math.min(empIds.length,80);idx++){
      const uid=empIds[idx];
      const tag='ABKL-'+zp(2000+idx,4);
      const an=ASSETS[idx%ASSETS.length];
      const isPh=an.includes('iPhone')||an.includes('Samsung');
      aS.run(tag,an,isPh?'Mobile Phone':'Laptop/Hardware','SN'+zp(10000+idx,5),ri(3000,12000),'2025-'+zp(ri(1,12),2)+'-01','issued',uid,'2025-'+zp(ri(1,12),2)+'-15');
    }
    commit();
  }catch(e){rollback();throw e;}
  console.log('Assets done.');

  const cycle=db.prepare('SELECT id FROM appraisal_cycles LIMIT 1').get();
  if(cycle){
    const gS=db.prepare('INSERT OR IGNORE INTO performance_goals (cycle_id,user_id,title,weight,status) VALUES (?,?,?,?,?)');
    begin();
    try{
      for(let i=0;i<Math.min(empIds.length,40);i++){
        gS.run(cycle.id,empIds[i],rnd(['Achieve quarterly KPIs','Improve team metrics','Complete certifications','Lead project delivery']),ri(20,40),'approved');
      }
      commit();
    }catch(e){rollback();throw e;}
    console.log('Performance goals done.');
  }

  console.log('\n=== BULK SEED COMPLETE ===');
  console.log('  Employees: '+empIds.length);
  console.log('  Working days: '+WDAYS.length);
  console.log('  Payroll runs: 8 (Jan-Aug 2026), '+allU.length+' payslips each');
}
run();