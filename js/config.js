// AMS settings. Fill these after the database (Apps Script) and Google sign-in are set up under the AMS Gmail.
// While API_URL is empty, the app runs in Demo Mode: no Google account needed, nothing is saved online.
export const CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbwfiP2_O9i9U9cCkB9KuuPxA9DS2EZHsrzmeTUilqTBs2gYwDPLYwUEPRnm1YTwmzpW/exec',
  CLIENT_ID: '869592211599-236h90afenp4098m857c27ktnmqc5fq9.apps.googleusercontent.com',
  SYNC_EVERY_MS: 60000,
  // Label shown on the login card, e.g. 'Practice copy'. Leave empty for none.
  LABEL: 'Practice copy · Cash Examination Report'
};
export const DEMO = !CONFIG.API_URL || !CONFIG.CLIENT_ID;
