# AMS – Connecting the Database and Google Sign-In

Do all of these while signed in to the **dedicated AMS Gmail** (the free Gmail that owns the AMS database).
Use a private/incognito window if other Google accounts are signed in on the browser.

## Part A – Google sign-in (Client ID)
1. Open **console.cloud.google.com** → top bar → project list → **New Project** → name it `AMS` → **Create**. Make sure `AMS` is the selected project.
2. Left menu → **APIs & Services** → **OAuth consent screen** (may show as **Google Auth Platform**) → **Get started**.
   - App name: `Audit Management System – COA Quirino`
   - User support email: the AMS Gmail
   - Audience: **External**
   - Contact email: the AMS Gmail → agree → **Create**.
3. Under **Audience**, click **Publish app** → **Confirm**. (Sign-in only asks for name and email, so Google needs no review.)
4. Left menu → **Clients** (or **Credentials** → **Create credentials**) → **Create OAuth client**
   - Application type: **Web application**
   - Name: `AMS website`
   - Authorized JavaScript origins → **Add URI**: `https://lgas-quirino.github.io`
   - **Create**. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).

## Part B – The database (Google Sheet + Apps Script)
5. Open **sheets.google.com** → **Blank** spreadsheet → name it `AMS Database`.
6. **Extensions** → **Apps Script**. Delete everything in `Code.gs`.
7. Open `backend/Code.gs` from the AMS repo, copy all of it, and paste it in.
8. At the top, fill in the two lines:
   - `CLIENT_ID` = the Client ID from step 4
   - `FIRST_ADMIN_EMAIL` = the Gmail that will be the first Admin
9. Click **Save** (disk icon). In the function box beside **Run**, choose **setup** → **Run**.
   - Google asks for permission: **Review permissions** → choose the AMS Gmail → **Advanced** → **Go to … (unsafe)** → **Allow**. (It says "unsafe" only because the script is your own and not reviewed by Google.)
   - The log should say `AMS setup done: 2 teams, 139 LGUs, first Admin …`. The Sheet now has tabs `users`, `teams`, `lgus`, `log`.
10. **Deploy** → **New deployment** → gear icon → **Web app**
    - Description: `AMS v1`
    - Execute as: **Me**
    - Who has access: **Anyone**
    - **Deploy** → copy the **Web app URL** (ends in `/exec`).

## Part C – Send these two to Claude
- The **Client ID** (step 4)
- The **Web app URL** (step 10)

Claude puts them in `js/config.js`. From then on, the site signs in with real Gmail accounts and saves to the AMS Database.

## Later updates to the database script
When `backend/Code.gs` changes: paste the new code (keep your two lines at the top), **Save**, then
**Deploy** → **Manage deployments** → pencil icon → Version: **New version** → **Deploy**. The Web app URL stays the same.

## Good to know
- The first Admin's name shows as `ADMIN` until it is edited in **Users & Roles**.
- Rows can be read in the Sheet, but make changes through the app so every device gets them.
