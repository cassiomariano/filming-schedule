# Setting up your Filming Schedule

This takes about 30 minutes, once. You need:

- this GitHub repository
- a Google account (for Firebase)
- your two Yahoo accounts

Everything used here is free.

| Part | What it does |
|---|---|
| **GitHub Pages** | Hosts the app at `https://cassiomariano.github.io/filming-schedule/` |
| **Firebase** | Your private database. It keeps your PC and phone in sync, and only you can open it. |
| **GitHub Actions** | The "robot" that checks your Yahoo inboxes every 30 minutes and adds new availability checks |

---

## 1. Create the Firebase project

1. Go to **https://console.firebase.google.com** and sign in with a Google account.
2. Click **Create a project**. Call it `filming-schedule`, then click Continue.
3. Google Analytics is not needed: switch it **off**, then click **Create project**.

## 2. Connect the app to Firebase

1. On the project home page, click the **`</>`** (Web) icon.
2. App nickname: `Filming Schedule`. Leave "Firebase Hosting" unticked. Click **Register app**.
3. Firebase shows a block of code containing `const firebaseConfig = { apiKey: ... }`. Copy the part from `{` to `}`.
4. In this GitHub repository:
   - open **`firebase-config.js`** and click the ✏️ pencil
   - replace everything between `window.FIREBASE_CONFIG =` and the final `;` with what you copied
   - click **Commit changes**

   You can also just paste the block to Claude and ask it to do this step.

## 3. Turn on sign-in

1. In Firebase, open **Build → Authentication → Get started**.
2. Under **Sign-in method**, choose **Email/Password**, switch it **on**, and click **Save**.
3. Open the **Users** tab and click **Add user**. Enter your email and a password. This is the login for the app.
4. Open the **Settings** tab, then **Authorized domains**, then **Add domain**. Enter `cassiomariano.github.io`.

## 4. Create the database

1. Open **Build → Firestore Database → Create database**.
2. Location: **europe-west2 (London)**. Click Next.
3. Choose **Start in production mode**, then click **Create**.
4. Open the **Rules** tab. Delete what's there and paste the contents of **`firestore.rules`** from this repository.
5. Change `YOUR_EMAIL@example.com` to the email you used in step 3, then click **Publish**.

## 5. Give the robot a key to the database

1. In Firebase, click the ⚙️ gear, then **Project settings → Service accounts**.
2. Click **Generate new private key**, then **Generate key**. A `.json` file downloads.
3. Copy the file's contents exactly. On a Mac, open Terminal, type `pbcopy < ` (with a space at the end), drag the file into the window and press Enter. TextEdit can change the quote marks and break the key.
4. In GitHub, open this repository's **Settings → Secrets and variables → Actions → New repository secret**:
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: paste the whole file
   - Click **Add secret**
5. Delete the downloaded `.json` file from your computer. It's a master key.
6. Give that key permission to use the database. Open `https://console.cloud.google.com/iam-admin/iam?project=YOUR-PROJECT-ID`, click the ✏️ next to the `firebase-adminsdk-…` account, choose **Add another role → Cloud Datastore User**, and click **Save**. Without this the robot gets "permission denied".

## 6. Let the robot read your Yahoo inboxes

Yahoo needs a separate **app password** for this. Your normal password is never used.

For **each** Yahoo account:

1. Sign in at **https://login.yahoo.com/account/security**.
2. Click **Generate app password** (it may be under "App passwords" or "Other ways to sign in"). If you don't see it, turn on **2-step verification** first.
3. Name it `Filming schedule` and click **Generate**. Copy the password Yahoo shows you.

Then add these GitHub secrets, the same way as in step 5:

| Name | Value |
|---|---|
| `YAHOO_EMAIL_1` | your first Yahoo address |
| `YAHOO_APP_PASSWORD_1` | its app password |
| `YAHOO_EMAIL_2` | your second Yahoo address (the .com.br one) |
| `YAHOO_APP_PASSWORD_2` | its app password |

The robot only **reads** emails. It never deletes them, moves them or marks them as read. To stop it at any time, delete the app password in Yahoo.

## 7. Publish the app

1. In GitHub, open **Settings → Pages**.
2. Under **Build and deployment**: Source **Deploy from a branch**, Branch **main**, folder **/ (root)**. Click **Save**.
3. After a minute or two, your app is live at **https://cassiomariano.github.io/filming-schedule/**.

## 8. First run

1. Open the app and sign in with the email and password from step 3.
2. Click **Backup → Restore or import a backup** and choose `filming-schedule-backup.json`. That's your spreadsheet history, which Claude sent you.
3. In GitHub, open the **Actions** tab. If asked, click **"I understand my workflows, go ahead and enable them"**.
4. Click **Check email → Run workflow**, type `14` for "How many days of email", and click **Run workflow**. After about a minute, new calls from the last two weeks appear in the app.

## 9. Put it on your phone

- **iPhone:** open the app in Safari, tap **Share → Add to Home Screen**.
- **Android:** open it in Chrome, tap **⋮ → Add to Home screen**.

---

## Faster checks (every 5 minutes) and phone alerts

GitHub's own timer is unreliable: it often runs late or skips. A free online timer at cron-job.org starts the check every 5 minutes instead.

**A. Make a GitHub key that can only start the check**
1. Open **https://github.com/settings/personal-access-tokens/new**.
2. Token name: `cron-job filming`. Expiration: **1 year** (set a reminder to renew it).
3. Repository access: **Only select repositories**, then choose **filming-schedule**.
4. Permissions → Repository permissions → **Actions: Read and write**. Leave everything else as it is.
5. Click **Generate token** and copy it. It starts with `github_pat_`.

**B. Set up the timer**
1. Create a free account at **https://cron-job.org** and click **Create cronjob**.
2. Title: `Filming schedule check`.
   URL: `https://api.github.com/repos/cassiomariano/filming-schedule/actions/workflows/check-email.yml/dispatches`
3. Execution schedule: **Every 5 minutes**.
4. Open the **Advanced** tab:
   - Request method: **POST**
   - Headers (add three):
     - `Authorization` = `Bearer ` followed by your token
     - `Accept` = `application/vnd.github+json`
     - `Content-Type` = `application/json`
   - Request body: `{"ref":"main"}`
5. Click **Create**. Use **Test run**: a reply of **204** means it worked.

**C. Phone alerts**
1. Install the free **ntfy** app (App Store or Google Play).
2. In the app, tap **+** and subscribe to your private topic name. Claude gave you this name; it starts with `filming-`. Keep it private, because anyone who knows it can read the alerts.
3. Add a GitHub secret named `NTFY_TOPIC` with the same topic name.

## Good to know

- **How the robot works:** every agency email is saved as a record, with what the robot decided and why. Each job is worked out from all of its emails plus your own changes, so the same emails always give the same result. The rules live in `core.js` (matching and jobs) and `parser.js` (reading an email).
- **Check list:** when the robot isn't sure which job an email belongs to, it doesn't guess. The email appears under **Needs your check** at the top of the Calendar. One tap files it, and the robot remembers the name next time. Jobs that look like copies of each other are offered there too (**Merge them…** / **Not the same**).
- **Your changes always win:** a day you tap, a status you pick or a detail you edit is saved as *your change*. Later emails never undo it. **Undo my changes** on a job removes them, and the job is worked out again from its emails.
- **Email on the wrong job?** Open the job → *Emails about this job* → open the email → **Move this email to…**.
- **Self-check:** once a day (after 08:00) the robot re-reads the last 7 days of mail and adds anything missing. It also rebuilds every job from scratch to confirm nothing drifted. The result is in your morning phone summary.
- **Run modes** (Actions → Check email → Run workflow → *mode*):
  - `normal`: read new mail.
  - `rescan`: read the last N days again (only missing emails are added).
  - `rederive`: rebuild every job from its emails.
  - `test_alert`: send a test phone alert.
  - `export`: make a sealed private copy.
  - `backup` / `restore`: make or restore a sealed backup.
- **Tests:** `npm test` runs the parser tests and the replay tests (sequences of emails and the job they must give). The robot runs them before every check and refuses to work with rules that fail. A sealed replay of your real emails (`tests/real.sealed.json`) also runs on every change.
- **Robot status:** the chip in the app's header says when the robot last checked (green: under 15 minutes).
- **Backups:** every Sunday the robot saves a sealed copy of all your jobs and email records on the `backups` branch (the last 8 are kept).
- **Money:** the Money tab lists every day you worked with the rate and what has been paid. Use **Export CSV** for your tax records.
- **Free database limits:** the robot reads one small index per run instead of your whole schedule, so normal use stays far below Firebase's 50,000 free reads a day.
- **If the robot stops:** GitHub pauses scheduled robots in repositories with no activity for 60 days. You'll get an email; open **Actions → Check email → Enable workflow**.
- **Costs:** Firebase's free plan and GitHub Actions for public repositories are both free at this size.
- **Privacy:** the code is public, but your jobs and emails are not. They live in your Firebase database, which only your login can open. The robot's logs show only counts, never email contents.
