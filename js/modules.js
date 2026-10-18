// The AMS modules shown as cards on the dashboard.
// When a module is finished and moved in, set ready: true, path to its first screen (e.g. '#/rms') and entry to its
// main file (e.g. 'modules/rms/rms.js'). Its screens then open from the card.
const ICON = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  doc: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h8"/>',
  docClock: '<path d="M12 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v3"/><path d="M14 3v6h6M8 13h4"/><circle cx="17.5" cy="17.5" r="3.5"/><path d="M17.5 16v1.6l1 .9"/>',
  docSearch: '<path d="M11 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8l6 6v2"/><path d="M14 3v6h6"/><circle cx="16" cy="16" r="3"/><path d="M18.2 18.2L21 21"/>',
  docChart: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 18v-3M12 18v-6M16 18v-4"/>',
  house: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  people: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M15 14.5c.6-.3 1.3-.5 2-.5 2.8 0 5 2.2 5 5"/>'
};

export const MODULES = [
  { id: 'rms', title: 'Records Management', text: 'Manage audit records and reference files.', color: '#1f5fd1', icon: ICON.folder, ready: false, path: '' },
  { id: 'periodic', title: 'Periodic Reports', text: 'Prepare and manage required periodic reports.', color: '#d62839', icon: ICON.doc, ready: false, path: '' },
  { id: 'other', title: 'Other Reports', text: 'Reports needed by the Region and Central Office, filled up by the teams.', color: '#e9a800', icon: ICON.docClock, ready: false, path: '' },
  { id: 'cer', title: 'Cash Examination Report', text: 'Prepare and manage Cash Examination Reports (CER).', color: '#1e8a4c', icon: ICON.docSearch, ready: true, path: '#/cer', entry: 'modules/cer/cer.js' },
  { id: 'aar', title: 'Annual Audit Report', text: 'Prepare and manage the Annual Audit Report (AAR) for municipalities and the province.', color: '#7b3fe4', icon: ICON.docChart, ready: false, path: '' },
  { id: 'baar', title: 'Barangay Annual Audit Report', text: 'Prepare and manage the Barangay Annual Audit Report (BAAR).', color: '#1793b5', icon: ICON.house, ready: false, path: '' },
  { id: 'sksaor', title: 'SK SAOR', text: 'Manage the Sangguniang Kabataan Status of Audit Observations and Recommendations (SK SAOR).', color: '#c2207a', icon: ICON.people, ready: false, path: '' }
];

export const iconSvg = (paths, size = 26) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
