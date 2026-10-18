// AMS settings. Fill these after the database (Apps Script) and Google sign-in are set up under the AMS Gmail.
// While API_URL is empty, the app runs in Demo Mode: no Google account needed, nothing is saved online.
export const CONFIG = {
  API_URL: '',
  CLIENT_ID: '',
  SYNC_EVERY_MS: 60000,
  // Label shown on the login card, e.g. 'Practice copy'. Leave empty for none.
  LABEL: 'Practice copy · Cash Examination Report'
};
export const DEMO = !CONFIG.API_URL || !CONFIG.CLIENT_ID;
