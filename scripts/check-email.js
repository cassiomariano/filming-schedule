/*
 * check-email.js — the robot that reads your Yahoo inboxes.
 *
 * GitHub runs this every 30 minutes (see .github/workflows/check-email.yml).
 * For each Yahoo account it:
 *   1. looks at the emails from the last few days
 *   2. skips anything it has already seen
 *   3. keeps only availability checks (parser.js decides)
 *   4. reads the job details and adds a new call to your schedule in Firebase
 *
 * It never deletes or changes your emails, and it never marks them as read.
 * It prints only counts — never email contents — because GitHub logs of a
 * public repository can be seen by anyone.
 */
const crypto = require("crypto");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const admin = require("firebase-admin");
const { parseEmail, isAvailabilityCheck, htmlToText } = require("../parser.js");

// ---------- settings (stored as GitHub secrets, never in the code) ----------
const DAYS_BACK = Number(process.env.DAYS_BACK || 3);
const accounts = [
  { email: process.env.YAHOO_EMAIL_1, password: process.env.YAHOO_APP_PASSWORD_1 },
  { email: process.env.YAHOO_EMAIL_2, password: process.env.YAHOO_APP_PASSWORD_2 },
].filter(a => a.email && a.password);

// "report" prints a short line that GitHub also shows as a note on the run's
// summary page (the ::notice:: / ::error:: prefix does that). Counts only, no email content.
function report(kind, title, text) {
  console.log(`::${kind} title=${title}::${text}`);
}

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  report("error", "Setup", "Missing the FIREBASE_SERVICE_ACCOUNT secret. See SETUP.md step 5.");
  process.exit(1);
}
if (!accounts.length) {
  report("error", "Setup", "No Yahoo account set. Add YAHOO_EMAIL_1 and YAHOO_APP_PASSWORD_1 secrets (SETUP.md step 6).");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  report("error", "Setup", "FIREBASE_SERVICE_ACCOUNT is not a complete key file. Copy the whole .json file, from the first { to the last }.");
  process.exit(1);
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// a short, stable ID for each email, so the same email is never added twice
function emailKey(messageId) {
  return crypto.createHash("sha1").update(String(messageId)).digest("hex").slice(0, 20);
}
// the date the email arrived, in UK time, as YYYY-MM-DD
function londonDate(date) {
  return new Date(date || Date.now()).toLocaleDateString("en-CA", { timeZone: "Europe/London" });
}
function sameName(a, b) {
  return String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "") === String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// your existing calls, loaded only when a new availability check turns up
// (keeps the number of database reads well inside Firebase's free allowance)
let existingCalls = null;
async function loadExistingCalls() {
  if (!existingCalls) {
    const snap = await db.collection("calls").get();
    existingCalls = snap.docs.map(d => d.data());
  }
  return existingCalls;
}

async function checkAccount(account) {
  const counts = { looked: 0, alreadySeen: 0, notACall: 0, added: 0 };
  const client = new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
    const uids = await client.search({ since: since }, { uid: true });
    for (const uid of uids || []) {
      counts.looked++;
      // read the whole message without marking it as read
      const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const id = msg.envelope.messageId || account.email + ":" + uid;
      const key = emailKey(id);
      const seenRef = db.collection("processed").doc(key);
      if ((await seenRef.get()).exists) { counts.alreadySeen++; continue; }

      const mail = await simpleParser(msg.source);
      const subject = mail.subject || "";
      const text = mail.html ? htmlToText(mail.html) : (mail.text || "");
      const from = (mail.from && mail.from.value && mail.from.value[0]) || {};
      const received = londonDate(mail.date);

      if (!isAvailabilityCheck(subject, text)) {
        await seenRef.set({ at: new Date().toISOString(), call: null });
        counts.notACall++;
        continue;
      }

      const r = parseEmail({ subject, fromName: from.name, fromEmail: from.address, text, received });
      const call = {
        project: r.project, agency: r.agency, role: r.role,
        location: r.location, fitLocation: r.fitLocation, filmLocation: r.filmLocation,
        rate: r.rate, notes: r.notes, dates: r.dates,
        respondBy: r.respondBy, received: received,
        status: "pending", attention: false,
        review: r.review, reviewReason: r.reviewReason,
        source: "email (" + account.email.split("@")[1] + ")",
        emailSubject: subject.slice(0, 300),
        emailFrom: ((from.name || "") + " <" + (from.address || "") + ">").slice(0, 200),
        rawEmail: (subject + "\n\n" + text).slice(0, 8000),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // the same job may arrive again (reminders, updates): flag it so you can merge or delete
      await loadExistingCalls();
      const twin = existingCalls.find(c => c.project && sameName(c.project, call.project) && sameName(c.agency, call.agency) &&
                                           ["pending", "available", "confirmed"].includes(c.status));
      if (twin) {
        call.review = true;
        call.reviewReason = (call.reviewReason ? call.reviewReason + ". " : "") + "You already have a call for this production from this agency";
      }
      const callId = "e" + key;
      await db.collection("calls").doc(callId).set(call);
      await seenRef.set({ at: new Date().toISOString(), call: callId });
      existingCalls.push(call);
      counts.added++;
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return counts;
}

(async () => {
  // check the database first, so a database problem is reported clearly
  try {
    await db.collection("processed").limit(1).get();
  } catch (err) {
    report("error", "Database", "Can't open the Firebase database (" + (err.code || err.name) + "): " + String(err.message || "").slice(0, 200));
    process.exit(1);
  }
  let failed = false;
  for (let i = 0; i < accounts.length; i++) {
    try {
      const c = await checkAccount(accounts[i]);
      report("notice", `Account ${i + 1}`, `Looked at ${c.looked} emails: ${c.alreadySeen} already seen, ${c.notACall} not availability checks, ${c.added} new calls added.`);
    } catch (err) {
      failed = true;
      // only the kind of error (the full message can contain the address)
      const why = err.authenticationFailed ? "Yahoo refused the login - check the email and app password secrets"
                : (err.code || err.name || "unknown error") + (err.responseText ? " - " + String(err.responseText).slice(0, 120) : "");
      report("error", `Account ${i + 1}`, "Could not check this inbox: " + why);
    }
  }
  process.exit(failed ? 1 : 0);
})();
