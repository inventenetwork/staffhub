const db = require('./index');

// Rich multicultural name pool
const NAMES = [
  // Malay
  'Izzatul Hakim','Khairunnas Johari','Asyraf Wajdi','Noor Hidayah','Zulhilmi Rashid',
  'Sazali Wahab','Roslinda Hamid','Fadzillah Aziz','Hairuddin Mustafa','Norhayati Bahari',
  'Shahril Azwan','Nik Azlan Nik Yusoff','Roslan Taib','Mazlina Mokhtar','Haszrul Ariffin',
  'Norzahra Kadir','Amirulhadi Nasir','Aznita Ahmad','Suhaila Hashim','Muhd Syazwan',
  // Chinese
  'Wei Liang Tan','Mei Shan Lim','Kok Wai Chong','Pei Yin Ng','Jia Xin Wong',
  'Boon Heng Ong','Shu Fen Chew','Chin Hock Foo','Li Ting Koh','Chee Keong Yap',
  'Hui Lin Leong','Zhen Wei Chen','Xiao Min Liu','Qing Yang Zhou','Rui Xia Zhang',
  'Fang Fang He','Yan Ping Wu','Jing Yi Ma','Hao Ren Huang','Siu Wah Kwok',
  'Wai Keng Cheah','Beng Huat Teo','Sook Ling Chan','Kah Wei Goh','Poh Leng Sim',
  // Indian
  'Subramaniam Pillai','Kavitha Krishnaswamy','Rajan Murugesan','Thilaga Selvam',
  'Ganesh Balakrishnan','Preethi Ramasamy','Dinesh Kandasamy','Saranya Venkatesh',
  'Karthikeyan Nadarajan','Logaswari Suppiah','Vijayakumar Arumugam','Deepa Narayanan',
  'Senthilnathan Gopal','Malathi Rajan','Anand Kumar Sharma','Nithya Suresh',
  // Iban / Dayak
  'Jirom Anak Bulan','Sylvester Anak Jeli','Sonia Anak Penghulu','Edgar Anak Bandi',
  'Magdalene Anak Jinggut','Reuben Anak Bujang','Dinah Anak Gayan','Anthony Anak Langit',
  'Lenny Anak Banyang','Veronica Anak Mandau','Francis Anak Rentap','Audrey Anak Bilong',
  'Nelson Anak Sangking','Stella Anak Bayai','Christopher Anak Mawan',
  // Kadazan / Sabah
  'Rosalia Majuwin','Cleophas Gandolou','Benedick Gamit','Florentina Dingal',
  'Anastasia Kimis','Dominic Pandikar','Josephine Antaim','Clement Ambrose',
  // American / Western
  'Tyler Brooks','Madison Hayes','Caleb Foster','Savannah Mitchell','Elijah Carter',
  'Abigail Parker','Logan Bennett','Chloe Richardson','Mason Cooper','Avery Collins',
  'Jackson Murphy','Olivia Stewart','Liam Sanders','Emma Hughes','Ethan Peterson',
  'Sophia Bailey','Noah Ward','Isabella Price','Lucas Powell','Mia Russell',
  // African
  'Amara Diallo','Kofi Mensah','Fatima Traore','Kwame Asante','Adaeze Okonkwo',
  'Seun Adeyemi','Chidinma Obi','Emeka Nwosu','Yewande Balogun','Tunde Fashola',
  'Zola Dlamini','Sipho Ndlovu','Nomsa Khumalo','Thabo Molefe','Lerato Sithole',
  'Ama Owusu','Efua Barimah','Kojo Antwi','Akosua Acheampong','Nana Boateng',
  // Spanish / Latin
  'Carlos Mendoza','Sofia Ramirez','Diego Herrera','Valentina Torres','Alejandro Vega',
  'Isabella Morales','Mateo Gutierrez','Camila Jimenez','Sebastian Flores','Lucia Reyes',
  'Fernando Castillo','Gabriela Romero','Andres Medina','Daniela Cruz','Ricardo Ortiz',
  // Middle Eastern
  'Khalid Al-Rashidi','Layla Al-Farsi','Omar Al-Sayed','Nadia Al-Hassan','Tariq Mahmoud',
  'Yasmin Saleh','Bilal Karimi','Rania Aziz','Faisal Qureshi','Zainab Hussaini',
  // Filipino
  'Jose Rizalino Santos','Maria Corazon Reyes','Eduardo Dela Cruz','Ana Bautista',
  'Mark Anthony Villanueva','Rosario Fernandez','Emmanuel Aguilar','Liezel Garcia',
  // Japanese / Korean / Vietnamese
  'Kenji Tanaka','Yuki Matsumoto','Hana Suzuki','Ryo Yamamoto','Sora Nakamura',
  'Ji-Ho Kim','Soo-Yeon Park','Min-Jun Lee','Jae-Won Choi','Yuna Jung',
  'Linh Nguyen','Minh Tran','Huong Pham','Duc Bui','Thuy Le',
  // Additional unique Malay/Muslim names
  'Izzat Firdaus','Nurul Huda Yahya','Hazwan Afiq','Qistina Mardhiah','Syahir Zulkipli',
  'Farhana Mustaffa','Luqmanul Hakim','Afifah Zainal','Irfan Danial','Nabilah Sabri',
  'Ameenah Ghazali','Haziq Zarif','Atiqah Shamsul','Afiq Hakimi','Dalila Rashidi',
];

function run() {
  // Find all names that appear more than once
  const allUsers = db.prepare("SELECT id, name, email FROM users ORDER BY id").all();

  // Build name -> [user_ids] map
  const nameMap = {};
  allUsers.forEach(u => {
    if (!nameMap[u.name]) nameMap[u.name] = [];
    nameMap[u.name].push(u.id);
  });

  // Get all currently used names to avoid re-introducing duplicates
  const usedNames = new Set(allUsers.map(u => u.name));

  // Build a pool of unused names
  const unusedPool = NAMES.filter(n => !usedNames.has(n));
  // Also generate extras if pool runs short
  const EXTRA_FIRST = ['Alicia','Brandon','Carmen','Derek','Elaine','Francis','Grace','Harold','Irene','Jerome','Kendra','Lance','Monique','Nathan','Ophelia','Percy','Queenie','Rupert','Selena','Terrence','Ursula','Victor','Wendy','Xavier','Yvonne','Zachary'];
  const EXTRA_LAST = ['Abreu','Baptiste','Carvalho','Dias','Esteves','Ferreira','Gomes','Henriques','Ito','Johansson','Kaur','Larsson','Moreira','Nakamura','Oliveira','Pereira','Queiroz','Rodrigues','Silveira','Takahashi','Unterberg','Vieira','Weber','Yilmaz','Zimmermann'];

  let poolIdx = 0;
  function nextUniqueName() {
    // First exhaust the curated pool
    while (poolIdx < unusedPool.length) {
      const n = unusedPool[poolIdx++];
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
    }
    // Generate extra names
    let attempts = 0;
    while (attempts < 1000) {
      const fn = EXTRA_FIRST[Math.floor(Math.random() * EXTRA_FIRST.length)];
      const ln = EXTRA_LAST[Math.floor(Math.random() * EXTRA_LAST.length)];
      const n = fn + ' ' + ln;
      if (!usedNames.has(n)) {
        usedNames.add(n);
        return n;
      }
      attempts++;
    }
    throw new Error('Could not generate unique name after 1000 attempts');
  }

  // Find duplicated groups and rename all but the first occurrence
  let renamed = 0;
  const dups = Object.entries(nameMap).filter(([name, ids]) => ids.length > 1);
  console.log('Duplicate groups to fix:', dups.length);

  db.exec('BEGIN');
  try {
    for (const [name, ids] of dups) {
      // Keep ids[0] as-is, rename ids[1..n]
      for (let i = 1; i < ids.length; i++) {
        const newName = nextUniqueName();
        db.prepare('UPDATE users SET name = ? WHERE id = ?').run(newName, ids[i]);
        console.log('  Renamed id=' + ids[i] + ': "' + name + '" -> "' + newName + '"');
        renamed++;
      }
    }
    db.exec('COMMIT');
    console.log('\nDone! Renamed ' + renamed + ' employees.');

    // Verify no more duplicates
    const remaining = db.prepare("SELECT name, COUNT(*) c FROM users GROUP BY name HAVING c > 1").all();
    if (remaining.length === 0) {
      console.log('Verification: No duplicate names remaining. ✓');
    } else {
      console.log('WARNING: Still ' + remaining.length + ' duplicate groups!');
      remaining.forEach(r => console.log('  ' + r.c + 'x ' + r.name));
    }
  } catch(e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

run();