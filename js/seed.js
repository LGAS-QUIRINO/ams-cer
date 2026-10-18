// Starting data for AMS: roles, teams, and the LGU Master List (PSA names). Same IDs as the AAR System so it can move in later.
export const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const ROLE_NAMES = { member: 'Team Member', staff: 'Team Staff (JO)', atl: 'Audit Team Leader', sa: 'Supervising Auditor', osa: 'OSA Staff', admin: 'Admin' };
export const POSITIONS = ['State Auditor V', 'State Auditor IV', 'State Auditor III', 'State Auditor II', 'State Auditor I', 'State Auditing Examiner II', 'OSA Staff', 'Job Order'];

// Barangays per municipality, PSA Philippine Standard Geographic Code names.
export const OFFICIAL_BARANGAYS = {
  maddela: ['Abbag', 'Balligui', 'Buenavista', 'Cabaruan', 'Cabua-an', 'Cofcaville', 'Diduyon', 'Dipintin', 'Divisoria Norte', 'Divisoria Sur',
    'Dumabato Norte', 'Dumabato Sur', 'Jose Ancheta', 'Lusod', 'Manglad', 'Pedlisan', 'Poblacion Norte', 'Poblacion Sur', 'San Bernabe',
    'San Dionisio I', 'San Martin', 'San Pedro', 'San Salvador', 'Santa Maria', 'Santo Niño', 'Santo Tomas', 'Villa Agullana', 'Villa Gracia',
    'Villa Hermosa Norte', 'Villa Hermosa Sur', 'Villa Jose V Ylanan', 'Ysmael'],
  aglipay: ['Alicia', 'Cabugao', 'Dagupan', 'Diodol', 'Dumabel', 'Dungo', 'Guinalbin', 'Ligaya', 'Nagabgaban', 'Palacian', 'Pinaripad Norte', 'Pinaripad Sur',
    'Progreso', 'Ramos', 'Rang-ayan', 'San Antonio', 'San Benigno', 'San Francisco', 'San Leonardo', 'San Manuel', 'San Ramon', 'Victoria', 'Villa Pagaduan',
    'Villa Santiago', 'Villa Ventura'],
  cabarroguis: ['Banuar', 'Burgos', 'Calaocan', 'Del Pilar', 'Dibibi', 'Dingasan', 'Eden', 'Gomez', 'Gundaway', 'Mangandingay', 'San Marcos', 'Santo Domingo',
    'Tucod', 'Villa Peña', 'Villamor', 'Villarose', 'Zamora'],
  diffun: ['Aklan Village', 'Andres Bonifacio', 'Aurora East', 'Aurora West', 'Baguio Village', 'Balagbag', 'Bannawag', 'Cajel', 'Campamento', 'Diego Silang',
    'Don Faustino Pagaduan', 'Don Mariano Perez Sr.', 'Doña Imelda', 'Dumanisi', 'Gabriela Silang', 'Gregorio Pimentel', 'Gulac', 'Guribang', 'Ifugao Village',
    'Isidro Paredes', 'Liwayway', 'Luttuad', 'Magsaysay', 'Makate', 'Maria Clara', 'Rafael Palma', 'Ricarte Norte', 'Ricarte Sur', 'Rizal', 'San Antonio',
    'San Isidro', 'San Pascual', 'Villa Pascua'],
  nagtipunan: ['Anak', 'Asaklat', 'Dipantan', 'Dissimungal', 'Guino', 'La Conwap', 'Landingan', 'Mataddi', 'Matmad', 'Old Gumiad', 'Ponggo', 'San Dionisio II',
    'San Pugo', 'San Ramos', 'Sangbay', 'Wasid'],
  saguday: ['Cardenas', 'Dibul', 'Gamis', 'La Paz', 'Magsaysay', 'Rizal', 'Salvacion', 'Santo Tomas', 'Tres Reyes']
};
// Renamed barangays: documents carry the current name; the PSA name is kept only for matching. The ID stays the same.
const RENAMED = { nagtipunan: { 'Old Gumiad': 'Keat' } };

export function seedData() {
  const teams = [
    { id: 'team-1', name: 'Team 1', officeCode: '', atlUserId: '', saUserId: '', history: [] },
    { id: 'team-2', name: 'Team 2', officeCode: 'R2-02', atlUserId: '', saUserId: '', history: [] }
  ];
  const lgus = [{ id: 'lgu-quirino', kind: 'province', name: 'Quirino', parentId: '', teamId: 'team-1', active: true }];
  [['Aglipay', 'team-2'], ['Cabarroguis', 'team-2'], ['Diffun', 'team-1'], ['Maddela', 'team-2'], ['Nagtipunan', 'team-2'], ['Saguday', 'team-2']].forEach(([n, t]) => {
    const m = slug(n), mid = 'lgu-' + m;
    lgus.push({ id: mid, kind: 'municipality', name: n, parentId: 'lgu-quirino', teamId: t, active: true });
    OFFICIAL_BARANGAYS[m].forEach((psa, i) => {
      const now = (RENAMED[m] || {})[psa];
      lgus.push({ id: 'brgy-' + m + '-' + slug(psa), kind: 'barangay', name: now || psa, formerName: now ? psa : '', parentId: mid, teamId: t,
        code: 'BRGY-' + String(i + 1).padStart(3, '0'), hasSk: true, active: true });
    });
  });
  return { teams, lgus };
}

// Demo Mode only: the one user you sign in as.
// Demo Mode only: a sample Job Order account, to see what the JO sees.
export const DEMO_JO = { id: 'user-demo-jo', email: 'jo@demo.ams', name: 'MARIA B. SANTOS', nickname: '', position: 'Job Order', designation: '',
  roles: ['staff'], teamIds: ['team-2'], munIds: [], status: 'active' };
export const DEMO_ADMIN = { id: 'user-demo-admin', email: 'admin@demo.ams', name: 'DEMO ADMIN', nickname: '', position: 'State Auditor I', designation: '',
  roles: ['member', 'admin'], teamIds: ['team-2'], munIds: [], status: 'active' };
