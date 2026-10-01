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
const { parseEmail, isAvailabilityCheck, classifyEmail, replyAnswer, extractLinks, parseCallTime, londonCheck, CALL_TIME_SUBJECT, isFromCastingAgency, htmlToText } = require("../parser.js");

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

// read the key file. TextEdit sometimes turns " into “smart quotes” when you copy,
// so put normal quotes back and ignore anything before the first { or after the last }.
let serviceAccount;
try {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/[“”„‟″]/g, '"').replace(/[‘’]/g, "'");
  raw = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  serviceAccount = JSON.parse(raw);
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
// "Apple Pie 2" and "APPLE PIE 2 (Feature)" count as the same production
function sameProject(a, b) {
  const x = String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const y = String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return x.length >= 3 && y.length >= 3 && (x === y || x.includes(y) || y.includes(x));
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
    existingCalls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
  return existingCalls;
}

// Agency names you already have in your schedule (from the spreadsheet or added by you).
// Calls the robot added and you haven't touched yet don't count, so a wrong one can't teach it bad habits.
let knownAgencies = [];
function trustedAgencies(calls) {
  const names = new Set();
  calls.forEach(c => {
    const byRobot = String(c.source || "").startsWith("email");
    if (c.agency && (!byRobot || c.status !== "pending")) names.add(c.agency);
  });
  return [...names];
}

// The agency names are kept in one small database document ("meta/agencies") and
// rebuilt from your schedule at most once a day. Reading the whole schedule on every
// 5-minute check would use up Firebase's free daily allowance.
async function getKnownAgencies() {
  const ref = db.collection("meta").doc("agencies");
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;
  const dayOld = !data || Date.now() - new Date(data.updatedAt).getTime() > 24 * 60 * 60 * 1000;
  if (!dayOld && process.env.CLEANUP !== "true") return data.names || [];
  await loadExistingCalls();
  const names = trustedAgencies(existingCalls);
  await ref.set({ names: names, updatedAt: new Date().toISOString() });
  return names;
}

// ---------- phone notification (free ntfy app) ----------
// Sends the new call to your phone. The topic name works like a password: keep it private.
async function notifyPhone(call) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const days = (call.dates || []).map(d => {
    const t = new Date(d.d + "T12:00:00");
    return (d.kind === "fit" ? "Fitting " : "") + t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }).join(", ");
  const lines = [
    call.agency || "",
    call.role ? "Role: " + call.role : "",
    days ? "Dates: " + days : "Dates: see the email",
    call.location ? "Where: " + call.location : "",
    call.respondBy ? "Reply by: " + call.respondBy.replace("T", " ") : "",
    londonCheck(call.location || call.filmLocation || call.fitLocation) === "outside" ? "⚠ Outside London" : "",
  ].filter(Boolean);
  try {
    await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: topic,
        title: "New AV check: " + (call.project || call.emailSubject || "availability check"),
        message: lines.join("\n"),
        tags: ["clapper"],
        priority: 4,
        click: "https://cassiomariano.github.io/filming-schedule/",
      }),
    });
  } catch (e) {
    report("warning", "Phone", "Could not send the phone notification (" + (e.code || e.name) + ").");
  }
}

// Booking confirmation / release email: find the ONE matching open call (same production,
// same agency) and mark it Confirmed or Released. Returns the call's id, or null if no single match.
async function applyStatusEmail(kind, r, subject, received, skipId) {
  await loadExistingCalls();
  const matches = existingCalls.filter(c => c.id && c.id !== skipId && c.project && r.project && sameProject(c.project, r.project) &&
                                             (!r.agency || sameName(c.agency, r.agency)) &&
                                             ["pending", "available", "confirmed"].includes(c.status));
  if (matches.length !== 1) return null;
  const c = matches[0];
  const status = kind === "booked" ? "confirmed" : "released";
  const note = (kind === "booked" ? "Booked" : "Released") + " by email on " + received + ": " + String(subject).slice(0, 120);
  const changes = { status: status, updatedAt: new Date().toISOString(), notes: (c.notes ? c.notes + " • " : "") + note };
  // A booking email that lists dates: those days are confirmed (green). Shoot days it does NOT
  // list are marked released (grey). Fittings are only touched if the email lists fitting days.
  if (kind === "booked" && (r.dates || []).length) {
    const listed = new Set(r.dates.map(x => x.d));
    const listsFit = r.dates.some(x => x.kind === "fit"), listsFilm = r.dates.some(x => x.kind === "film");
    const dates = (c.dates || []).map(e => ({ ...e }));
    dates.forEach(e => {
      if (listed.has(e.d)) { if (e.state === "released" || e.state === "canceled") delete e.state; }
      else if (!e.state && ((e.kind === "film" && listsFilm) || (e.kind === "fit" && listsFit))) e.state = "released";
    });
    r.dates.forEach(x => { if (!dates.some(e => e.d === x.d)) dates.push({ ...x }); });
    dates.sort((a, b) => a.d.localeCompare(b.d));
    changes.dates = dates;
    c.dates = dates;
  }
  await db.collection("calls").doc(c.id).update(changes);
  c.status = status;
  await notifyPhone({ ...c, project: (kind === "booked" ? "BOOKED: " : "Released: ") + c.project });
  return c.id;
}

// Call time email: find the booked job (by production name, else by date) and store
// the call time + place on that day. Adds the day if the job didn't have it yet.
async function applyCallTime(r, ct, subject) {
  await loadExistingCalls();
  const booked = existingCalls.filter(c => c.id && ["confirmed", "available"].includes(c.status));
  let match = r.project ? booked.filter(c => c.project && sameProject(c.project, r.project)) : [];
  const day = ct.dates.length ? ct.dates[0].d : null;
  if (match.length !== 1 && day) match = booked.filter(c => c.status === "confirmed" && (c.dates || []).some(e => e.d === day));
  if (match.length !== 1) return null;
  const c = match[0];
  const dates = (c.dates || []).map(e => ({ ...e }));
  const d = day || (dates.filter(e => e.d >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.d.localeCompare(b.d))[0] || {}).d;
  if (!d) return null;
  let entry = dates.find(e => e.d === d && e.kind === "film") || dates.find(e => e.d === d);
  if (!entry) { entry = { d: d, kind: "film" }; dates.push(entry); dates.sort((a, b) => a.d.localeCompare(b.d)); }
  entry.callTime = ct.time;
  if (ct.place) entry.callPlace = ct.place.slice(0, 120);
  await db.collection("calls").doc(c.id).update({ dates: dates, updatedAt: new Date().toISOString() });
  c.dates = dates;
  const t = new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  await notifyPhone({ ...c, project: "Call time: " + c.project, role: t + " — call " + ct.time + (ct.place ? " @ " + ct.place : ""), dates: [] , location: ct.place || c.location });
  return c.id;
}

// ---------- Entertainment Partners message pages ----------
// The "Respond" link in an EP email opens a message page (no login needed) with the production
// name, every date, the deadline and, once you've replied, your answers. The robot only READS
// these pages (a normal page visit). It never opens Yes/No links, which could answer for you.
const portal = { read: 0, failed: 0, login: 0, answered: 0 };
function portalLink(c) {
  const l = (c.links || []).find(x => x.kind === "respond" && /^https:\/\/[a-z0-9.-]*epcastingportal\.com\//i.test(x.url));
  return l ? l.url : null;
}
async function fetchPortalPage(url) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20000),
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "Accept": "text/html" } });
    const html = await res.text();
    if (!res.ok) { portal.failed++; return null; }
    if (/type=["']?password/i.test(html) && !/availability|enquiry/i.test(html)) { portal.login++; return null; }
    portal.read++;
    return html;
  } catch (e) { portal.failed++; return null; }
}
function sameDay(a, b) { return a.d === b.d; }
// fills in what the page knows; keeps anything you changed yourself
async function enrichFromPortal(call) {
  const url = portalLink(call);
  if (!url) return false;
  const html = await fetchPortalPage(url);
  call.portalCheckedAt = new Date().toISOString();
  if (!html) return false;
  const text = htmlToText(html);
  const r = parseEmail({ subject: call.emailSubject || "", fromName: call.agency, html, text: "", received: call.received });
  if (r.project && (!call.project || call.review)) call.project = r.project;
  if (!call.role && r.role) call.role = r.role;
  if (!call.rate && r.rate) call.rate = r.rate;
  if (!call.respondBy && r.respondBy) call.respondBy = r.respondBy;
  if (!call.location) call.location = r.location || (r.dates.find(d => d.loc) || {}).loc || "";
  // dates: add the ones the page lists (keeps your own day changes)
  const dates = (call.dates || []).map(e => ({ ...e }));
  r.dates.forEach(x => {
    const have = dates.find(e => sameDay(e, x));
    if (!have) dates.push({ d: x.d, kind: x.kind, ...(x.loc ? { loc: x.loc } : {}), ...(x.night ? { night: true } : {}) });
    else { if (!have.loc && x.loc) have.loc = x.loc; if (x.kind === "reh" && have.kind === "film") have.kind = "reh"; }
  });
  dates.sort((a, b) => a.d.localeCompare(b.d));
  call.dates = dates;
  // your answers, once you've replied on the page
  if (/successfully recorded your response/i.test(text)) {
    call.replied = true;
    const yes = r.dates.some(d => d.answer === "yes"), no = r.dates.some(d => d.answer === "no");
    const answers = [];
    const L = text.split("\n").map(x => x.trim()).filter(Boolean);
    for (let i = 0; i < L.length; i++) {
      if (/\?$/.test(L[i]) && L[i].length < 140) {
        const picked = [];
        for (let j = i + 1; j < L.length && j < i + 12 && !/\?$/.test(L[j]); j++) {
          L[j].split("☒").slice(1).forEach(part => { const a = part.split("☐")[0].trim(); if (a) picked.push(a); });
          if (!/[☒☐]/.test(L[j]) && j === i + 1 && L[j].length < 60) picked.push(L[j]);   // typed answer
        }
        if (picked.length) answers.push(L[i].replace(/\?$/, "") + ": " + picked.join(", "));
      }
    }
    if (answers.length) call.answers = answers.slice(0, 12);
    if (call.status === "pending" && (yes || no)) { call.status = no && !yes ? "declined" : "available"; portal.answered++; }
  }
  if (call.project && call.dates.length) { call.review = false; call.reviewReason = ""; }
  return true;
}
// every 20 minutes, look again at EP pages of calls you haven't answered yet (max 6 per run)
async function refreshPendingPortalPages() {
  await loadExistingCalls();
  const due = existingCalls.filter(c => c.id && ["pending"].includes(c.status) && portalLink(c) &&
    (!c.portalCheckedAt || Date.now() - new Date(c.portalCheckedAt).getTime() > 20 * 60 * 1000)).slice(0, 6);
  for (const c of due) {
    const before = JSON.stringify([c.status, c.project, c.dates, c.answers]);
    const copy = { ...c };
    await enrichFromPortal(copy);
    const { id, ...body } = copy;
    const changed = JSON.stringify([copy.status, copy.project, copy.dates, copy.answers]) !== before;
    await db.collection("calls").doc(c.id).update(changed ? { ...body, updatedAt: new Date().toISOString() } : { portalCheckedAt: copy.portalCheckedAt });
    Object.assign(c, copy);
  }
}

// every web address in an email (to recognise the same enquiry in a later email)
function allUrls(html) {
  const out = [];
  const re = /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) out.push({ url: m[1].replace(/&amp;/g, "&") });
  return out;
}
// long codes inside a link (e.g. ...epcastingportal.com/r/9821E119-6C4A...) that identify one enquiry
function linkCodes(links) {
  const codes = new Set();
  (links || []).forEach(l => String(l.url || "").split(/[\/?&=#.]+/).forEach(part => {
    if (part.length >= 10 && /\d/.test(part) && /[a-z]/i.test(part)) codes.add(part.toLowerCase());
  }));
  return codes;
}
// "Thank you for letting us know that you are available": find the call you answered.
// 1) same code in the links, 2) same production + agency, 3) the only unanswered call from that agency.
async function applyReply(r, links, answer) {
  await loadExistingCalls();
  const open = existingCalls.filter(c => c.id && ["pending", "available"].includes(c.status));
  const codes = linkCodes(links);
  let match = codes.size ? open.filter(c => [...linkCodes(c.links)].some(x => codes.has(x))) : [];
  if (match.length !== 1 && r.project) match = open.filter(c => c.project && sameProject(c.project, r.project) && (!r.agency || sameName(c.agency, r.agency)));
  if (match.length !== 1 && r.agency) {
    const recent = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    match = open.filter(c => c.status === "pending" && sameName(c.agency, r.agency) && (c.received || "") >= recent);
  }
  if (match.length !== 1) return null;
  const c = match[0];
  if (c.status === answer) return c.id;
  await db.collection("calls").doc(c.id).update({ status: answer, repliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  c.status = answer;
  return c.id;
}

// "Find an email": what happened to emails whose SUBJECT contains some words?
// Reports only yes/no facts, never names or contents (GitHub logs are public).
async function findEmails(words) {
  await loadExistingCalls();
  for (let i = 0; i < accounts.length; i++) {
    const client = new ImapFlow({ host: "imap.mail.yahoo.com", port: 993, secure: true, auth: { user: accounts[i].email, pass: accounts[i].password }, logger: false });
    await client.connect();
    for (const folder of ["INBOX", "Bulk"]) {
      let lock;
      try { lock = await client.getMailboxLock(folder); } catch (e) { continue; }
      try {
        const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
        const uids = await client.search({ since: since, subject: words }, { uid: true }) || [];
        if (!uids.length) { report("notice", `Find · account ${i + 1} · ${folder}`, "No email with those words in the subject (last 14 days)."); continue; }
        for (const uid of uids.slice(0, 5)) {
          const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
          const env = msg.envelope || {}; const from = (env.from && env.from[0]) || {};
          const mail = await simpleParser(msg.source);
          const text = mail.html ? htmlToText(mail.html) : (mail.text || "");
          const key = emailKey(env.messageId || accounts[i].email + ":" + uid);
          const seen = await db.collection("processed").doc(key).get();
          const callId = seen.exists ? seen.data().call : null;
          const inApp = callId ? (await db.collection("calls").doc(callId).get()).exists : false;
          const r = parseEmail({ subject: env.subject || "", fromName: from.name, fromEmail: from.address, text, received: londonDate(mail.date) });
          report("notice", `Find · account ${i + 1} · ${folder}`, [
            "arrived " + londonDate(mail.date),
            "sender is a known agency: " + (isFromCastingAgency(from.name, from.address, knownAgencies) ? "yes" : "NO"),
            "type: " + (classifyEmail(env.subject || "", text) || "not a call"),
            "robot has seen it: " + (seen.exists ? "yes" : "no"),
            "call in the app: " + (inApp ? "yes" : (callId ? "it was deleted" : "no")),
            "production name found: " + (r.project ? "yes" : "no"),
            "dates found: " + r.dates.length,
            "reply link: " + (extractLinks(mail.html || "").some(l => /epcastingportal/i.test(l.url)) ? "EP page" : "none"),
          ].join(" · "));
        }
      } finally { lock.release(); }
    }
    await client.logout();
  }
}

async function checkAccount(account) {
  const counts = { looked: 0, alreadySeen: 0, notACall: 0, added: 0, updated: 0 };
  const client = new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
    socketTimeout: 120000,
  });
  await client.connect();
  try {
    for (const folder of ["INBOX", "Bulk"]) {          // agency emails sometimes land in Spam ("Bulk")
      let lock;
      try { lock = await client.getMailboxLock(folder); } catch (e) { continue; }
      try { await checkFolder(client, account, counts); } finally { lock.release(); }
    }
  } finally {
    await client.logout();
  }
  return counts;
}

async function checkFolder(client, account, counts) {
  {
    const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

    // 1) read only the envelopes (sender, subject, ID) of recent emails: small and fast
    const candidates = [];
    for await (const msg of client.fetch({ since: since }, { envelope: true, uid: true })) {
      counts.looked++;
      const env = msg.envelope || {};
      const from = (env.from && env.from[0]) || {};
      // only emails sent by a casting / extras agency (never Spotlight, shops, apps...)
      if (isFromCastingAgency(from.name, from.address, knownAgencies) || CALL_TIME_SUBJECT.test(env.subject || "")) {
        candidates.push({ uid: msg.uid, id: env.messageId || account.email + ":" + msg.uid });
      } else {
        counts.notACall++;
      }
    }

    // 2) download in full only the possible casting emails we haven't seen before
    for (const cand of candidates) {
      const key = emailKey(cand.id);
      const seenRef = db.collection("processed").doc(key);
      const seenDoc = await seenRef.get();
      if (seenDoc.exists) {
        counts.alreadySeen++;
        // older calls were saved without the agency's reply link: add it now, then read the EP page
        const oldId = seenDoc.data().call;
        if (oldId) {
          await loadExistingCalls();
          const c = existingCalls.find(x => x.id === oldId);
          if (c && !c.links) {
            const m2 = await client.fetchOne(cand.uid, { source: true }, { uid: true });
            const mail2 = m2 && m2.source ? await simpleParser(m2.source) : null;
            const copy = { ...c, links: extractLinks((mail2 && mail2.html) || "") };
            if (["pending", "available"].includes(c.status) && !(c.dates || []).some(e => e.state || e.callTime)) await enrichFromPortal(copy);
            const { id, ...body } = copy;
            await db.collection("calls").doc(c.id).set({ ...body, updatedAt: new Date().toISOString() });
            Object.assign(c, copy);
            counts.updated++;
          }
        }
        continue;
      }
      // read the whole message without marking it as read
      const msg = await client.fetchOne(cand.uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;

      const mail = await simpleParser(msg.source);
      const subject = mail.subject || "";
      const text = mail.html ? htmlToText(mail.html) : (mail.text || "");
      const from = (mail.from && mail.from.value && mail.from.value[0]) || {};
      const received = londonDate(mail.date);

      const kind = classifyEmail(subject, text);
      if (!kind) {
        await seenRef.set({ at: new Date().toISOString(), call: null });
        counts.notACall++;
        continue;
      }

      const r = parseEmail({ subject, fromName: from.name, fromEmail: from.address, text, received });

      // Call time / call sheet: add the time and place to that day of your booked job
      if (kind === "calltime") {
        const ct = parseCallTime({ subject, text, received });
        const callId = ct.time ? await applyCallTime(r, ct, subject) : null;
        if (callId) counts.updated++;
        await seenRef.set({ at: new Date().toISOString(), call: callId });
        continue;
      }

      // The agency confirming your answer: mark the call Available or Declined
      if (kind === "replied") {
        const callId = await applyReply(r, extractLinks(mail.html || "").concat(allUrls(mail.html || "")), replyAnswer(subject, text));
        if (callId) counts.updated++;
        await seenRef.set({ at: new Date().toISOString(), call: callId });
        continue;
      }

      // A booking confirmation or a release: update the matching call, never add a new one
      if (kind === "booked" || kind === "released") {
        const callId = await applyStatusEmail(kind, r, subject, received, null);
        if (callId) counts.updated++;
        await seenRef.set({ at: new Date().toISOString(), call: callId });
        continue;
      }

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
        links: extractLinks(mail.html || ""),
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
      await enrichFromPortal(call);                   // EP message page: real name, all dates, your answers
      await db.collection("calls").doc(callId).set(call);
      await seenRef.set({ at: new Date().toISOString(), call: callId });
      existingCalls.push({ id: callId, ...call });
      counts.added++;
      await notifyPhone(call);
    }
  }
}

(async () => {
  // check the database first, so a database problem is reported clearly
  try {
    await db.collection("processed").limit(1).get();
  } catch (err) {
    const who = String(serviceAccount.client_email || "").split("@")[0].replace(/-[a-z0-9]{5}$/, "-…");
    report("error", "Database", "Can't open the Firebase database (" + (err.code || err.name) + "): " + String(err.message || "").slice(0, 160) +
      " | key is for project '" + serviceAccount.project_id + "', account type '" + who + "'");
    process.exit(1);
  }
  knownAgencies = await getKnownAgencies();

  // "Send a test alert" (ticked by hand when running the workflow)
  if (process.env.TEST_ALERT === "true") {
    if (!process.env.NTFY_TOPIC) report("error", "Phone", "No NTFY_TOPIC secret yet, so no alert was sent (SETUP.md, Faster checks, step C).");
    else {
      await notifyPhone({ project: "Test alert", agency: "Filming Schedule", role: "If you can read this, phone alerts work",
                          dates: [{ d: new Date().toISOString().slice(0, 10), kind: "film" }] });
      report("notice", "Phone", "Test alert sent.");
    }
  }

  // Clean-up (run by hand with "clean up" ticked): remove calls the robot added from
  // senders that are not casting agencies, if you haven't changed them yet.
  if (process.env.CLEANUP === "true") {
    const snap = await db.collection("calls").get();
    let removed = 0;
    let flagged = 0, repaired = 0;
    for (const doc of snap.docs) {
      const c = doc.data();
      if (!String(c.source || "").startsWith("email")) continue;          // never touch your own entries
      const m = String(c.emailFrom || "").match(/^(.*?)\s*<([^>]*)>/) || [];
      // made from a booking or release email by mistake: apply it to the real call, then remove it
      const kind = classifyEmail(c.emailSubject, c.rawEmail);
      if (kind === "booked" || kind === "released") {
        const r = parseEmail({ subject: c.emailSubject, fromName: m[1], fromEmail: m[2], text: c.rawEmail || "", received: c.received });
        const matched = await applyStatusEmail(kind, r, c.emailSubject, c.received, doc.id);
        await doc.ref.delete();
        if (matched) repaired++; else removed++;
        continue;
      }
      const ok = isFromCastingAgency(m[1], m[2], knownAgencies) && isAvailabilityCheck(c.emailSubject, c.rawEmail);
      if (ok) continue;
      if (["confirmed", "done"].includes(c.status)) {
        // you marked it booked or worked, so keep it but ask you to check it
        await doc.ref.update({ review: true, reviewReason: "This may not be an availability check. Check it, or delete it" });
        flagged++;
      } else {
        await doc.ref.delete();
        removed++;
      }
    }
    // Re-read calls the robot made earlier with today's better reader + the EP message page,
    // as long as you haven't changed them (no day marked done/canceled, not booked yet).
    existingCalls = null;
    await loadExistingCalls();
    let reread = 0;
    for (const c of existingCalls) {
      if (!String(c.source || "").startsWith("email") || !["pending", "available"].includes(c.status)) continue;
      if ((c.dates || []).some(e => e.state || e.callTime)) continue;
      const m = String(c.emailFrom || "").match(/^(.*?)\s*<([^>]*)>/) || [];
      const body = String(c.rawEmail || "").split("\n").slice(2).join("\n");
      const r = parseEmail({ subject: c.emailSubject || "", fromName: m[1], fromEmail: m[2], text: body, received: c.received });
      const copy = { ...c, project: r.project || "", dates: r.dates, respondBy: r.respondBy || c.respondBy || null,
                     role: c.role || r.role, rate: c.rate || r.rate, location: c.location || r.location };
      if (!r.project) copy.review = true;
      await enrichFromPortal(copy);
      if (!copy.project) copy.project = c.project && !/please (reply|view)|asap/i.test(c.project) ? c.project : "";
      const { id, ...body2 } = copy;
      await db.collection("calls").doc(c.id).set({ ...body2, updatedAt: new Date().toISOString() });
      reread++;
    }
    existingCalls = null;
    await loadExistingCalls();
    report("notice", "Re-read", `Re-read ${reread} calls with the improved reader.`);
    report("notice", "Clean-up", `Removed ${removed} emails that were not availability checks; ${repaired} booking/release emails applied to their calls; ${flagged} marked "check details" because you had booked them.`);
  }

  if (process.env.FIND) { await findEmails(process.env.FIND); process.exit(0); }

  let failed = false;
  for (let i = 0; i < accounts.length; i++) {
    try {
      let c;
      try {
        c = await checkAccount(accounts[i]);
      } catch (first) {
        if (first.authenticationFailed) throw first;
        await new Promise(r => setTimeout(r, 15000));   // Yahoo sometimes drops the first connection: wait and try once more
        c = await checkAccount(accounts[i]);
      }
      report("notice", `Account ${i + 1}`, `Looked at ${c.looked} emails: ${c.alreadySeen} already seen, ${c.notACall} not availability checks, ${c.added} new calls added, ${c.updated} calls updated (booked/released).`);
    } catch (err) {
      failed = true;
      // only the kind of error (the full message can contain the address)
      const why = err.authenticationFailed ? "Yahoo refused the login - check the email and app password secrets"
                : (err.code || err.name || "unknown error") + (err.responseText ? " - " + String(err.responseText).slice(0, 120) : "");
      report("error", `Account ${i + 1}`, "Could not check this inbox: " + why);
    }
  }
  try { await refreshPendingPortalPages(); } catch (e) { report("warning", "EP pages", "Could not refresh EP pages (" + (e.code || e.name) + ")."); }
  if (portal.read + portal.failed + portal.login) {
    report("notice", "EP pages", `Read ${portal.read} EP message pages, ${portal.answered} answers picked up` +
      (portal.failed ? `, ${portal.failed} could not be opened` : "") + (portal.login ? `, ${portal.login} asked for a login` : "") + ".");
  }
  process.exit(failed ? 1 : 0);
})();
