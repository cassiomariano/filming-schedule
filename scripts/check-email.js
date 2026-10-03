/*
 * check-email.js — the robot that reads your Yahoo inboxes (every 5 minutes).
 *
 *   1. New mail is read by message number (never "the last 2 days"), so nothing is missed after a pause.
 *   2. Every agency email is saved as a RECORD (collection "records"), with what the robot decided and why.
 *   3. Each record is filed on a job with ONE rule (core.js matchRecord). When the robot isn't sure,
 *      the record goes to your Check list in the app — it is never guessed.
 *   4. A job is worked out from scratch from its records + your own changes (core.js deriveJob),
 *      so the same emails always give the same result, and the robot never overwrites what you changed.
 *   5. Once a day it checks itself: every agency email of the last 7 days must have a record, and
 *      every job must come out the same when rebuilt from scratch. The result is in your morning summary.
 *
 * It never deletes, moves or marks your emails as read, and never opens agency Yes/No links.
 * Logs show only counts — never email contents — because GitHub logs of a public repository are public.
 *
 * Run modes (Actions → Check email → Run workflow): normal · rescan (re-read N days, adds only what's
 * missing) · rederive (rebuild every job from its records) · export · backup / restore · migrate (one-off).
 */
const crypto = require("crypto");
const fs = require("fs");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const admin = require("firebase-admin");
const P = require("../parser.js");
const Core = require("../core.js");

const MODE = process.env.MODE || "normal";               // normal | rescan | rederive | export | backup | restore | migrate | test_alert
const DAYS = Number(process.env.DAYS_BACK || 7);          // rescan window (days)
const accounts = [
  { email: process.env.YAHOO_EMAIL_1, password: process.env.YAHOO_APP_PASSWORD_1 },
  { email: process.env.YAHOO_EMAIL_2, password: process.env.YAHOO_APP_PASSWORD_2 },
].filter(a => a.email && a.password);

function report(kind, title, text) { console.log(`::${kind} title=${title}::${text}`); }
function londonDate(d) { return new Date(d || Date.now()).toLocaleDateString("en-CA", { timeZone: "Europe/London" }); }
function londonHour() { return Number(new Date().toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false })); }
function emailKey(id) { return crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 20); }
const nowIso = () => new Date().toISOString();

// ---------- setup ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { report("error", "Setup", "Missing the FIREBASE_SERVICE_ACCOUNT secret (SETUP.md step 5)."); process.exit(1); }
let serviceAccount;
try {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT.replace(/[“”„‟″]/g, '"').replace(/[‘’]/g, "'");
  serviceAccount = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
} catch (e) { report("error", "Setup", "FIREBASE_SERVICE_ACCOUNT is not a complete key file."); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ---------- the small shared documents ----------
// meta/index: one compact line per job (name forms, agency, days, EP pages) → matching costs ONE read
// meta/mail:  the last message number read in each folder of each inbox
let INDEX = {}, MAIL = {}, HEALTH = {}, indexDirty = false, mailDirty = false, INDEX_V = 0;
async function loadMeta() {
  const [i, m, h] = await Promise.all(["index", "mail", "health"].map(k => db.collection("meta").doc(k).get()));
  INDEX = (i.exists && i.data().jobs) || {};
  INDEX_V = (i.exists && i.data().v) || 0;
  MAIL = (m.exists && m.data().folders) || {};
  HEALTH = h.exists ? h.data() : {};
}
function indexLine(id, job) {
  const e = Core.indexEntry(job);
  e.an = job.agency || "";
  const pages = Object.values(job.pages || {}).filter(p => p && p.url && p.url !== "legacy");
  const urls = (job.links || []).map(l => l.url).filter(u => Core.pageCode(u));
  e.pu = (pages.length ? pages[pages.length - 1].url : urls[urls.length - 1]) || "";   // newest EP page
  e.pa = job.pagesAt || "";
  return e;
}
function setIndex(id, job) { INDEX[id] = indexLine(id, job); indexDirty = true; }
async function saveMeta() {
  if (indexDirty) await db.collection("meta").doc("index").set({ jobs: INDEX, at: nowIso(), v: Core.VERSION });
  if (mailDirty) await db.collection("meta").doc("mail").set({ folders: MAIL, at: nowIso() });
}
function knownAgencyNames() { return [...new Set(Object.values(INDEX).map(e => e.an).filter(Boolean))]; }

// ---------- phone (free ntfy app) ----------
const pushes = [];
async function push(title, lines, tags) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic || MODE === "rescan" || MODE === "migrate" || MODE === "rederive") return;
  try {
    await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message: lines.filter(Boolean).join("\n"), tags: tags || ["clapper"], priority: 4, click: "https://cassiomariano.github.io/filming-schedule/" }) });
  } catch (e) { report("warning", "Phone", "Could not send a phone alert (" + (e.code || e.name) + ")."); }
}
function dayWords(dates) {
  return (dates || []).map(d => (d.kind === "fit" ? "Fitting " : d.kind === "reh" ? "Rehearsal " : "") +
    new Date(d.d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })).join(", ");
}

// ---------- EP message pages (view only: the same link as the email's Respond button) ----------
const portal = { read: 0, failed: 0, login: 0 };
async function fetchPage(url) {
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
async function pageFactsFor(url, received) {
  const html = await fetchPage(url);
  if (!html) return null;
  const f = Core.pageFacts(url, html, received);
  f.at = nowIso();
  return f;
}

// ---------- reading the inboxes ----------
async function connect(account) {
  const client = new ImapFlow({ host: "imap.mail.yahoo.com", port: 993, secure: true, auth: { user: account.email, pass: account.password }, logger: false, socketTimeout: 120000 });
  client.on("error", () => {});
  await client.connect();
  return client;
}
async function mailFolders(client) {
  const list = await client.list();
  return list.filter(f => !(f.flags && f.flags.has("\\Noselect")) && !["\\Sent", "\\Drafts"].includes(f.specialUse) && !/^(sent|drafts?|outbox|templates)$/i.test(f.name))
    .map(f => ({ path: f.path, trash: f.specialUse === "\\Trash" || /^(trash|deleted)/i.test(f.name) }))
    .sort((a, b) => (b.path === "INBOX") - (a.path === "INBOX"));
}
// a subject a production office or new agency might use (their emails are read even from unknown senders)
const LOOKS_LIKE_JOB = /availab|\bav\b|av ?check|booking|booked|release|call ?time|call ?sheet|casting|supporting artist|\bSA\b|extras?\b|fitting|wardrobe|shoot/i;
const allUrls = html => { const out = [], re = /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi; let m; while ((m = re.exec(html || ""))) out.push({ url: m[1].replace(/&amp;/g, "&") }); return out; };
async function pdfText(pdfs) {
  let out = "";
  try {
    const parse = require("pdf-parse/lib/pdf-parse.js");
    for (const p of pdfs) {
      const r = await Promise.race([parse(p.content), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 20000))]);
      out += "\n" + String(r.text || "").slice(0, 20000);
    }
  } catch (e) { /* a call sheet that can't be read: the email itself still counts */ }
  return out;
}
// Reads one folder. windowDays = null → only messages after the last one read (normal);
// a number → every message of the last N days (rescan / daily self-check; already-saved ones are skipped).
async function readFolder(client, account, ai, folder, windowDays, found, counts) {
  const box = client.mailbox || {};
  const wkey = ai + "|" + folder.path;
  const w = MAIL[wkey];
  const validity = String(box.uidValidity || "");
  let uids;
  if (windowDays == null && w && w.v === validity) {
    uids = ((await client.search({ uid: `${w.last + 1}:*` }, { uid: true })) || []).filter(u => u > w.last);
  } else {
    uids = (await client.search({ since: new Date(Date.now() - (windowDays || 3) * 864e5) }, { uid: true })) || [];
  }
  let maxUid = w && w.v === validity ? w.last : 0;
  for (let i = 0; i < uids.length; i += 200) {
    const batch = uids.slice(i, i + 200);
    for await (const msg of client.fetch(batch.join(","), { envelope: true, uid: true }, { uid: true })) {
      counts.looked++;
      if (msg.uid > maxUid) maxUid = msg.uid;
      const env = msg.envelope || {}, from = (env.from && env.from[0]) || {};
      const agency = P.isFromCastingAgency(from.name, from.address, knownAgencyNames());
      if (!agency && !LOOKS_LIKE_JOB.test(env.subject || "") && !P.CALL_TIME_SUBJECT.test(env.subject || "")) continue;
      const key = emailKey(env.messageId || account.email + ":" + msg.uid);
      found.push({ key, uid: msg.uid, folder, agency, ai, date: env.date ? new Date(env.date).toISOString() : nowIso() });
    }
  }
  // the folder is only marked as read up to here once all of it was looked at (a failed run reads it again)
  if (windowDays == null || !w) { MAIL[wkey] = { v: validity, last: maxUid, at: nowIso() }; mailDirty = true; }
}
// downloads the found emails that have no record yet and turns them into records
async function download(client, account, ai, list, counts) {
  if (!list.length) return [];
  const refs = list.map(x => db.collection("records").doc(x.key));
  const have = new Set();
  for (let i = 0; i < refs.length; i += 100) (await db.getAll(...refs.slice(i, i + 100))).forEach(s => { if (s.exists) have.add(s.id); });
  const out = [];
  for (const x of list) {
    if (have.has(x.key) || seenThisRun.has(x.key)) { counts.known++; continue; }
    seenThisRun.add(x.key);
    const lock = await client.getMailboxLock(x.folder.path);
    let mail;
    try {
      const msg = await client.fetchOne(x.uid, { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      mail = await simpleParser(msg.source);
    } finally { lock.release(); }
    const html = mail.html || "";
    let text = html ? P.htmlToText(html) : (mail.text || "");
    const from = (mail.from && mail.from.value && mail.from.value[0]) || {};
    const at = mail.date ? new Date(mail.date).toISOString() : x.date;
    const pdfs = (mail.attachments || []).filter(a => /pdf/i.test(a.contentType || "") && (a.size || 0) < 4e6).slice(0, 3).map(a => ({ name: a.filename || "", content: a.content }));
    const base = { key: x.key, at, account: "account " + (ai + 1), folder: x.folder.path, trash: x.folder.trash, from, subject: mail.subject || "",
      messageId: mail.messageId || "", inReplyTo: mail.inReplyTo || "", references: [].concat(mail.references || []),
      links: P.extractLinks(html), allUrls: allUrls(html), knownAgencies: knownAgencyNames() };
    let rec = Core.recordFromEmail({ ...base, text });
    // call sheets usually come as a PDF
    if (pdfs.length && (rec.kind === "calltime" || rec.kind === "booked" || pdfs.some(p => /call ?sheet|callsheet|schedule|movement|unit ?base/i.test(p.name)))) {
      const extra = await pdfText(pdfs);
      if (extra.trim()) {
        rec = Core.recordFromEmail({ ...base, text: text + "\n\n" + extra });
        if (!rec.kind && pdfs.some(p => /call ?sheet|callsheet/i.test(p.name))) rec.kind = "calltime";
      }
    }
    // from a sender that isn't an agency, only call sheets and availability requests are kept
    // (a hotel or flight "booking confirmation" is not a job)
    if (!x.agency && !["calltime", "call"].includes(rec.kind)) continue;
    out.push(rec);
    counts.newRecords++;
  }
  return out;
}
const seenThisRun = new Set();
async function readInboxes(windowDays) {
  const all = [];
  let failed = 0;
  for (let ai = 0; ai < accounts.length; ai++) {
    const account = accounts[ai];
    const counts = { looked: 0, known: 0, newRecords: 0, folders: 0, skipped: 0 };
    try {
      let client = await connect(account);
      for (const folder of await mailFolders(client)) {
        let ok = false;
        for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
          try {
            if (!client.usable) client = await connect(account);
            const found = [];
            const lock = await client.getMailboxLock(folder.path);
            try { await readFolder(client, account, ai, folder, windowDays, found, counts); } finally { lock.release(); }
            all.push(...await download(client, account, ai, found, counts));
            counts.folders++; ok = true;
          } catch (e) {
            if (e.authenticationFailed) throw e;
            try { await client.logout(); } catch (_) {}
            client = { usable: false };
            await new Promise(r => setTimeout(r, 4000));
          }
        }
        if (!ok) counts.skipped++;
      }
      try { if (client.usable) await client.logout(); } catch (_) {}
      report("notice", `Inbox ${ai + 1}`, `Looked at ${counts.looked} emails in ${counts.folders} folders` + (counts.skipped ? ` (${counts.skipped} folders will be read next time)` : "") +
        `: ${counts.newRecords} new agency emails, ${counts.known} already saved.`);
    } catch (err) {
      failed++;
      report("error", `Inbox ${ai + 1}`, "Could not check this inbox: " + (err.authenticationFailed ? "Yahoo refused the login - check the app password secret" : (err.code || err.name || "error")));
    }
  }
  return { records: all.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0), failed };
}

// ---------- filing records on jobs ----------
const dirty = new Map();          // job id → { reasons: [record], isNew }
function markDirty(id, rec, isNew) { const d = dirty.get(id) || { recs: [], isNew: false }; if (rec) d.recs.push(rec); if (isNew) d.isNew = true; dirty.set(id, d); }
const stats = { filed: 0, newJobs: 0, check: 0, ignored: 0, other: 0 };
async function fileRecord(rec, fresh) {
  const ref = db.collection("records").doc(rec.key);
  // "You have booking updates": the EP page says what changed
  if (rec.kind === "epupdate") {
    const url = (rec.links || []).concat(rec.allUrls || []).map(l => l.url).find(u => Core.pageCode(u));
    const f = url ? await pageFactsFor(url, String(rec.at).slice(0, 10)) : null;
    if (f && f.update) {
      rec.kind = f.update; rec.via = "EP page";
      rec.parsed.dates = f.dates.map(x => ({ d: x.d, kind: x.kind }));
      if (f.project) rec.parsed.names = [f.project].concat(rec.parsed.names || []);
      rec.pages = [Core.pageCode(url)];
    }
  }
  if (!rec.kind || rec.kind === "epupdate") {
    await ref.set({ ...clean(rec), job: null, state: "other", why: "Not a job email (newsletter, update or similar)", filedAt: nowIso() }, { merge: true });
    stats.other++;
    return;
  }
  // the same email a second time (e.g. a copy in the other inbox): listed on the same job, never applied twice
  if (!rec.copyOf) {
    const same = await db.collection("records").where("subject", "==", rec.subject).get();
    const orig = same.docs.map(d => d.data()).find(o => isCopy(o, rec) && String(o.seen || o.at) <= String(rec.seen || nowIso()));
    if (orig) {
      rec.copyOf = orig.key;
      await ref.set({ ...clean(rec), job: orig.job || null, state: orig.job ? "filed" : "other", how: "copy of an email already on file", why: "", candidates: [], filedAt: nowIso() }, { merge: true });
      if (orig.job) await db.collection("calls").doc(orig.job).update({ records: FieldValue.arrayUnion(rec.key) }).catch(() => {});
      stats.other++;
      return;
    }
  }
  // a new request: read its EP page first (the real name, every date and your ticks)
  let facts = null;
  if (rec.kind === "call" && rec.pages && rec.pages.length) {
    const url = (rec.links || []).map(l => l.url).find(u => Core.pageCode(u) === rec.pages[0]);
    if (url) facts = await pageFactsFor(url, String(rec.at).slice(0, 10));
    if (facts && facts.project && !rec.parsed.project) { rec.parsed.project = facts.project; rec.parsed.names = [facts.project].concat(rec.parsed.names || []); }
  }
  const m = Core.matchRecord(rec, INDEX);
  if (m.job && m.sure) {
    const ch = { records: FieldValue.arrayUnion(rec.key), needsDerive: true };
    if (rec.messageId) ch.threads = FieldValue.arrayUnion(rec.messageId);
    if (facts) ch["pages." + rec.pages[0]] = facts;
    // you filed it yourself: its names are remembered, so the next one is automatic
    const learn = [...new Set((rec.parsed.names || []).slice(0, 4).concat(rec.parsed.project ? [rec.parsed.project] : []).filter(Boolean))];
    if (m.how === "you" && learn.length) ch.names = FieldValue.arrayUnion(...learn);
    await db.collection("calls").doc(m.job).update(ch);
    await ref.set({ ...clean(rec), job: m.job, state: "filed", how: m.how, why: "", candidates: [], filedAt: nowIso() }, { merge: true });
    markDirty(m.job, fresh ? rec : null, false);
    stats.filed++;
    return;
  }
  // an email more than 30 days old (found late, e.g. moved into a folder) never starts a new job
  if (!m.job && m.sure && Date.now() - new Date(rec.at).getTime() > 30 * 864e5) {
    await ref.set({ ...clean(rec), job: null, state: "ignored", how: m.how, why: "An old email (more than 30 days) – not added as a new job", candidates: [], filedAt: nowIso() }, { merge: true });
    stats.ignored++;
    return;
  }
  if (!m.job && m.sure) {
    // a new job
    const id = "e" + rec.key;
    const job = { source: "email (" + String(rec.account) + ")", base: {}, pages: facts ? { [rec.pages[0]]: facts } : {}, mine: {}, names: [],
      records: [rec.key], threads: rec.messageId ? [rec.messageId] : [], createdAt: nowIso(), attention: false, needsDerive: true };
    await db.collection("calls").doc(id).set(job);
    await ref.set({ ...clean(rec), job: id, state: "filed", how: m.how, why: "", candidates: [], filedAt: nowIso() }, { merge: true });
    setIndex(id, { project: rec.parsed.project, agency: rec.parsed.agency, dates: rec.parsed.dates, received: String(rec.at).slice(0, 10), records: [rec.key], recordDates: [String(rec.at).slice(0, 10)], pageCodes: rec.pages, threads: job.threads, status: "pending" });
    markDirty(id, fresh ? rec : null, true);
    stats.newJobs++;
    return;
  }
  // not sure: your Check list (never guessed) — or ignored when there's nothing it could belong to
  const state = unsureState(rec, m);
  await ref.set({ ...clean(rec), job: null, state, how: m.how, why: m.why, candidates: m.candidates, filedAt: nowIso() }, { merge: true });
  if (state === "check") stats.check++; else stats.ignored++;
}
// where an email the robot isn't sure about goes: your Check list only when it would change something
function unsureState(rec, m) {
  if (rec.kind === "calltime" && !((rec.parsed || {}).call || {}).time) return "other";   // "call details to follow": nothing to file yet
  return m.candidates.length || rec.kind === "booked" || rec.kind === "calltime" ? "check" : "ignored";
}
// "seen": when the robot first saw the email (an email seen after a job was saved still counts, even if it is dated earlier)
// the same email twice: same subject, same text, sent within 4 days (two releases on different days differ in their text)
const textStart = r => String(r.text || "").replace(/\s+/g, " ").trim().slice(0, 400);
function isCopy(a, b) { return a.key !== b.key && a.subject === b.subject && textStart(a) === textStart(b) && Math.abs(new Date(a.at) - new Date(b.at)) <= 4 * 864e5; }
function clean(rec) { const { allUrls: _a, knownAgencies: _k, ...r } = rec; r.seen = r.seen || nowIso(); return JSON.parse(JSON.stringify(r)); }

// the Check list (and emails you moved in the app) is tried again on every run
async function retryChecks() {
  const snap = await db.collection("records").where("state", "==", "check").get();
  for (const d of snap.docs) {
    const rec = d.data();
    if (rec.userJob === "ignore") { await d.ref.update({ state: "ignored", why: "You chose to ignore it", job: null }); continue; }
    const before = rec.job || null;
    const m = Core.matchRecord(rec, INDEX);
    if (!m.sure && !rec.userJob && unsureState(rec, m) !== "check") { await d.ref.update({ state: unsureState(rec, m) }); continue; }
    if ((m.job && m.sure) || (!m.job && m.sure)) {
      if (before && before !== m.job) {
        await db.collection("calls").doc(before).update({ records: FieldValue.arrayRemove(rec.key), needsDerive: true }).catch(() => {});
        markDirty(before, null, false);
      }
      await fileRecord(rec, false);
    }
  }
}

// ---------- working out a job ----------
// fields only the robot writes; your own changes live in "mine", your notes/pay/rate fields are never touched
const DERIVED = ["status", "dates", "project", "agency", "agencyKey", "role", "location", "fitLocation", "filmLocation", "respondBy", "received",
  "answers", "links", "emails", "emailSubject", "emailFrom", "review", "reviewReason"];
async function recordsOf(id) {
  const snap = await db.collection("records").where("job", "==", id).get();
  return snap.docs.map(d => d.data());
}
async function deriveAndSave(id, info, quiet) {
  const ref = db.collection("calls").doc(id);
  const doc = await ref.get();
  if (!doc.exists) { delete INDEX[id]; indexDirty = true; return; }
  const job = doc.data();
  const recs = await recordsOf(id);
  const d = Core.deriveJob(job, recs);
  const ch = {};
  DERIVED.forEach(k => { const v = d[k] === undefined ? null : d[k]; if (JSON.stringify(v) !== JSON.stringify(job[k] === undefined ? null : job[k])) ch[k] = v; });
  ch.records = recs.map(r => r.key);
  ch.needsDerive = false;
  ch.derivedAt = nowIso();
  ch.coreV = Core.VERSION;
  // an older email found late (e.g. missed before): listed on the job and flagged for you, not applied
  const late = (d.lateEmails || []).filter(k => !(job.lateSeen || []).includes(k));
  if (late.length) { ch.lateSeen = (job.lateSeen || []).concat(late); ch.newInfo = true; ch.newInfoText = `${late.length} older email${late.length === 1 ? "" : "s"} found late – check this job's emails`; }
  const fresh = (info && info.recs) || [];
  const changedDays = "dates" in ch || "status" in ch;
  if (fresh.length && !quiet && (changedDays || info.isNew)) {
    const kinds = [...new Set(fresh.map(r => r.kind))];
    if (!info.isNew) { ch.newInfo = true; ch.newInfoText = "Updated by email: " + kinds.map(k => ({ call: "new request", replied: "your answer", booked: "booking", released: "release", calltime: "call time" }[k] || k)).join(", "); }
  }
  await ref.update(ch);
  const merged = { ...job, ...ch };
  setIndex(id, { ...merged, recordDates: recs.map(r => String(r.at).slice(0, 10)), pageCodes: recs.flatMap(r => r.pages || []), threads: job.threads || [] });
  // phone alerts for what just arrived
  if (fresh.length && !quiet) {
    const r = fresh[fresh.length - 1];
    const name = merged.project || r.subject || "a job";
    if (info.isNew) await push("New AV check: " + name, [merged.agency, merged.role ? "Role: " + merged.role : "", merged.dates && merged.dates.length ? "Dates: " + dayWords(merged.dates) : "Dates: see the email",
      merged.respondBy ? "Reply by: " + String(merged.respondBy).replace("T", " ") : "", P.londonCheck(merged.location) === "outside" ? "⚠ Outside London" : ""]);
    else if (changedDays && ["booked", "released", "calltime", "call"].includes(r.kind)) {
      const word = { booked: "BOOKED", released: "Released", calltime: "Call time", call: "Update" }[r.kind];
      await push(word + ": " + name, [merged.agency, r.kind === "calltime" ? dayWords((merged.dates || []).filter(e => e.callTime)).split(", ").slice(-1)[0] + " " + ((merged.dates || []).find(e => e.callTime) || {}).callTime : "", dayWords((merged.dates || []).filter(e => e.d >= londonDate()))]);
    }
  }
}

// ---------- open jobs: read their EP page again (your ticks, new days) ----------
async function refreshPages() {
  const today = londonDate();
  const every = { pending: 20, available: 360, declined: 360 };
  const due = Object.entries(INDEX).filter(([, e]) => every[e.s] && e.pu && e.l >= today && (!e.pa || Date.now() - new Date(e.pa).getTime() > every[e.s] * 60000))
    .sort((a, b) => String(a[1].pa).localeCompare(String(b[1].pa))).slice(0, 8);
  for (const [id, e] of due) {
    const code = Core.pageCode(e.pu);
    const f = await pageFactsFor(e.pu, today);
    const ch = { pagesAt: nowIso() };
    e.pa = ch.pagesAt; indexDirty = true;
    if (f) {
      const doc = await db.collection("calls").doc(id).get();
      const old = doc.exists && doc.data().pages ? doc.data().pages[code] : null;
      const same = old && JSON.stringify({ ...old, at: 0 }) === JSON.stringify({ ...f, at: 0 });
      if (!same) { ch["pages." + code] = f; ch.needsDerive = true; markDirty(id, null, false); }
    }
    await db.collection("calls").doc(id).update(ch).catch(() => {});
  }
}

// ---------- daily self-check ----------
async function dailyCheck() {
  const today = londonDate();
  if (MODE !== "rederive" && (londonHour() < 8 || HEALTH.checkDate === today)) return null;
  const out = { date: today, missing: 0, rebuiltDiffer: 0, check: 0, duplicates: 0 };
  // 1) every agency email of the last 7 days has a record (missing ones are read now)
  if (MODE === "normal") {
    const r = await readInboxes(7);
    out.missing = r.records.length;
    for (const rec of r.records) await fileRecord(rec, false);
  }
  // 2) upkeep: emails the robot read itself are read again when the rules improved; copies are marked;
  //    jobs made only from old emails (found late) are removed
  let calls = (await db.collection("calls").get()).docs;
  let recs = (await db.collection("records").get()).docs.map(d => d.data());
  out.upkeep = await upkeep(calls, recs);
  if (out.upkeep.changed) { calls = (await db.collection("calls").get()).docs; recs = (await db.collection("records").get()).docs.map(d => d.data()); }
  // 3) every job comes out the same when rebuilt from scratch (fixes any that don't)
  const byJob = {};
  recs.forEach(r => { if (r.job) (byJob[r.job] = byJob[r.job] || []).push(r); if (r.state === "check") out.check++; });
  INDEX = {};
  for (const doc of calls) {
    const job = doc.data();
    const d = Core.deriveJob(job, byJob[doc.id] || []);
    const differs = DERIVED.some(k => JSON.stringify(d[k] === undefined ? null : d[k]) !== JSON.stringify(job[k] === undefined ? null : job[k]));
    if (differs) { out.rebuiltDiffer++; await deriveAndSave(doc.id, null, true); }
    else setIndex(doc.id, { ...job, recordDates: (byJob[doc.id] || []).map(r => String(r.at).slice(0, 10)), pageCodes: (byJob[doc.id] || []).flatMap(r => r.pages || []) });
  }
  // 4) jobs that look like copies of each other (same production + agency + time): offered to you in the Check list
  const dismissed = new Set(((await db.collection("meta").doc("duplicates").get()).data() || {}).dismissed || []);
  const list = calls.map(d => ({ id: d.id, ...d.data() }));
  const pairs = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (!a.project || !b.project || Core.agencyKey(a.agency) !== Core.agencyKey(b.agency) || !Core.sameName(a.project, b.project)) continue;
    const da = (a.dates || []).map(e => e.d), dbs = (b.dates || []).map(e => e.d);
    const near = da.some(x => dbs.some(y => Math.abs(new Date(x) - new Date(y)) <= 21 * 864e5));
    const key = [a.id, b.id].sort().join("+");
    if (near && !dismissed.has(key)) pairs.push(key);
  }
  out.duplicates = pairs.length;
  await db.collection("meta").doc("duplicates").set({ pairs, dismissed: [...dismissed], at: nowIso() });
  return out;
}

async function upkeep(calls, recs) {
  const res = { reread: 0, copies: 0, removed: 0, changed: 0 };
  const touched = new Set();
  // a) read again with the current rules (only emails the robot read itself: their full text is stored)
  for (const r of recs.filter(r => r.account && (r.v || 1) < Core.VERSION)) {
    const again = Core.recordFromEmail({ key: r.key, at: r.at, account: r.account, folder: r.folder, from: r.from, subject: r.subject, text: r.text,
      links: r.links, messageId: r.messageId, knownAgencies: knownAgencyNames() });
    const ch = { v: Core.VERSION, parsed: JSON.parse(JSON.stringify(again.parsed)) };
    if (again.kind !== r.kind && r.via !== "EP page") ch.kind = again.kind;
    const kind = "kind" in ch ? ch.kind : r.kind;
    // not from an agency and not a call sheet / request (e.g. a hotel or flight booking): not a job email
    if (!again.fromAgency && !["calltime", "call"].includes(kind)) { ch.state = "ignored"; ch.why = "Not from an agency"; ch.job = null; if (r.job) touched.add(r.job); }
    else if (kind === null && r.job) { ch.state = "other"; ch.why = "Not a job email (read again with improved rules)"; ch.job = null; touched.add(r.job); }
    else if (r.job) touched.add(r.job);
    await db.collection("records").doc(r.key).update(ch);
    Object.assign(r, ch); res.reread++;
  }
  // b) copies: the later-seen one never counts
  const bySubject = {};
  recs.forEach(r => (bySubject[r.subject] = bySubject[r.subject] || []).push(r));
  for (const list of Object.values(bySubject)) {
    if (list.length < 2) continue;
    list.sort((a, b) => String(a.seen || a.at).localeCompare(String(b.seen || b.at)));
    for (let i = 1; i < list.length; i++) {
      const r = list[i];
      if (r.copyOf || !r.account) continue;
      const orig = list.slice(0, i).find(o => !o.copyOf && isCopy(o, r));
      if (!orig) continue;
      await db.collection("records").doc(r.key).update({ copyOf: orig.key, how: "copy of an email already on file" });
      r.copyOf = orig.key; res.copies++;
      if (r.job) touched.add(r.job);
    }
  }
  // c) a job the robot made only from emails that were already old when found (e.g. moved into a folder)
  for (const doc of calls) {
    const j = doc.data();
    if (j.base && j.base.at) continue;                       // your jobs and jobs saved at the switch are never removed this way
    if (j.mine && Object.keys(j.mine).length) continue;      // you changed it: it stays
    const mine = recs.filter(r => r.job === doc.id);
    if (!mine.length || !mine.every(r => new Date(r.seen || r.at) - new Date(r.at) > 30 * 864e5)) continue;
    for (const r of mine) await db.collection("records").doc(r.key).update({ job: null, state: "ignored", why: "An old email (more than 30 days) – not added as a new job" });
    await doc.ref.delete();
    delete INDEX[doc.id]; indexDirty = true; touched.delete(doc.id); res.removed++;
  }
  for (const id of touched) { await deriveAndSave(id, null, true); }
  res.changed = res.reread + res.copies + res.removed;
  return res;
}

// ---------- health (the chip in the app) + the morning summary ----------
async function writeHealth(failed, check) {
  const today = londonDate();
  const prev = HEALTH;
  const rolled = prev.day && prev.day.date !== today;
  const base = prev.day && !rolled ? prev.day : { date: today, newCalls: 0, updates: 0, unmatched: 0, errors: 0 };
  const day = { date: today, newCalls: base.newCalls + stats.newJobs, updates: base.updates + stats.filed, unmatched: base.unmatched + stats.check, errors: base.errors + (failed ? 1 : 0) };
  const out = { lastRun: nowIso(), lastNewCall: stats.newJobs ? nowIso() : (prev.lastNewCall || null), unmatched: day.unmatched, errors: day.errors,
    message: failed ? "An inbox couldn't be checked on the last run" : `Today: ${day.newCalls} new calls, ${day.updates} updates`,
    day, yesterday: rolled ? prev.day : (prev.yesterday || null), summaryDate: prev.summaryDate || "", backupDate: prev.backupDate || "",
    checkDate: check ? check.date : (prev.checkDate || ""), check: check || prev.check || null, robot: 2 };
  if (londonHour() >= 8 && out.summaryDate !== today && out.yesterday && check) {
    const y = out.yesterday;
    const lines = [`${y.newCalls} new availability check${y.newCalls === 1 ? "" : "s"}, ${y.updates} update${y.updates === 1 ? "" : "s"}.`];
    if (check.check) lines.push(`${check.check} email${check.check === 1 ? "" : "s"} wait for you in the Check list.`);
    if (check.duplicates) lines.push(`${check.duplicates} pair${check.duplicates === 1 ? "" : "s"} of jobs look like copies (Check list).`);
    lines.push(check.missing ? `Self-check: ${check.missing} email${check.missing === 1 ? "" : "s"} had been missed – now added.` : "Self-check: every agency email is in the app.");
    if (check.rebuiltDiffer) lines.push(`Self-check: ${check.rebuiltDiffer} job${check.rebuiltDiffer === 1 ? "" : "s"} corrected.`);
    if (y.errors) lines.push(`${y.errors} problem${y.errors === 1 ? "" : "s"} reading the inbox – open the app.`);
    await push("Filming Schedule – yesterday", lines, ["clipboard"]);
    out.summaryDate = today;
  }
  await db.collection("meta").doc("health").set(out);
  HEALTH = out;
}

// ---------- sealed copies (only the key's owner can open them) ----------
async function everything() {
  const [calls, records] = await Promise.all([db.collection("calls").get(), db.collection("records").get()]);
  return { calls: calls.docs.map(d => ({ id: d.id, ...d.data() })), records: records.docs.map(d => d.data()) };
}
async function weeklyBackup() {
  const sunday = new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short" }) === "Sun";
  const last = HEALTH.backupDate ? new Date(HEALTH.backupDate + "T12:00:00Z").getTime() : 0;
  if (!(MODE === "backup" || (sunday && Date.now() - last > 6 * 864e5))) return;
  const all = await everything();
  const robotKey = crypto.createPublicKey(serviceAccount.private_key).export({ type: "spki", format: "pem" });
  const { seal } = require("./vault.js");
  fs.writeFileSync("backup.sealed.json", JSON.stringify(seal(robotKey, { at: nowIso(), ...all })));
  await db.collection("meta").doc("health").set({ backupDate: londonDate() }, { merge: true });
  report("notice", "Backup", `Sealed backup of ${all.calls.length} jobs and ${all.records.length} emails.`);
}
async function writeAll(coll, items, idOf) {
  for (let i = 0; i < items.length; i += 400) {
    const b = db.batch();
    items.slice(i, i + 400).forEach(x => { const { id: _drop, ...body } = x; b.set(db.collection(coll).doc(idOf(x)), body); });
    await b.commit();
  }
}

// ---------- main ----------
(async () => {
  try { await db.collection("meta").limit(1).get(); }
  catch (err) { report("error", "Database", "Can't open the Firebase database (" + (err.code || err.name) + ")."); process.exit(1); }
  await loadMeta();

  if (MODE === "test_alert") { await push("Test alert", ["If you can read this, phone alerts work."]); report("notice", "Phone", "Test alert sent."); return; }
  if (MODE === "export") {
    const { seal } = require("./vault.js");
    const all = await everything();
    const robotKey = crypto.createPublicKey(serviceAccount.private_key).export({ type: "spki", format: "pem" });
    fs.writeFileSync("export.sealed.json", JSON.stringify(seal(fs.readFileSync(__dirname + "/export-key.pem", "utf8"), { at: nowIso(), robotKey, ...all })));
    report("notice", "Export", `Sealed ${all.calls.length} jobs and ${all.records.length} emails.`);
    return;
  }
  if (MODE === "restore") {
    const { open } = require("./vault.js");
    const data = open(serviceAccount.private_key, JSON.parse(fs.readFileSync("restore.sealed.json", "utf8")));
    await writeAll("calls", data.calls || [], x => x.id);
    if (data.records) await writeAll("records", data.records, x => x.key);
    report("notice", "Restore", `Put back ${(data.calls || []).length} jobs from the backup of ${String(data.at || "").slice(0, 10)}. Run "rederive" next.`);
    return;
  }
  if (MODE === "migrate") {
    // one-off move to the new robot: the sealed plan holds every job and email record, checked beforehand
    const { open } = require("./vault.js");
    const plan = open(serviceAccount.private_key, JSON.parse(fs.readFileSync("plan.sealed.json", "utf8")));
    await writeAll("records", plan.records, x => x.key);
    const existing = new Set((await db.collection("calls").get()).docs.map(d => d.id));
    let upd = 0, made = 0, del = 0;
    for (let i = 0; i < plan.jobs.length; i += 200) {
      const b = db.batch();
      plan.jobs.slice(i, i + 200).forEach(j => {
        const { id, ...body } = j;
        if (existing.has(id)) { b.update(db.collection("calls").doc(id), body); upd++; } else { b.set(db.collection("calls").doc(id), body); made++; }
      });
      await b.commit();
    }
    for (const id of plan.remove || []) { await db.collection("calls").doc(id).delete(); del++; }
    INDEX = {}; indexDirty = true;
    plan.jobs.forEach(j => setIndex(j.id, j));
    await db.collection("meta").doc("duplicates").set({ pairs: plan.duplicates || [], dismissed: [], at: nowIso() });
    await saveMeta();
    report("notice", "Migrate", `${plan.records.length} email records; jobs: ${upd} updated, ${made} added, ${del} removed. Next: run "rescan" for 7 days.`);
    return;
  }

  // safety lock: the new robot works only on data moved to the new layout (run "migrate" once)
  if (!INDEX_V && MODE !== "rederive") { report("notice", "Waiting", "The schedule hasn't been moved to the new robot yet (mode: migrate). Nothing was changed."); return; }
  let failed = 0, check = null;
  if (MODE === "normal" || MODE === "rescan") {
    const r = await readInboxes(MODE === "rescan" ? DAYS : null);
    failed = r.failed;
    for (const rec of r.records) {
      try { await fileRecord(rec, MODE === "normal" && Date.now() - new Date(rec.at).getTime() < 3 * 864e5); }
      catch (e) { report("warning", "Email", "One email couldn't be filed (" + (e.code || e.name) + "); the daily self-check will read it again."); }
    }
    await retryChecks();
    const marked = await db.collection("calls").where("needsDerive", "==", true).get();
    marked.docs.forEach(d => { if (!dirty.has(d.id)) markDirty(d.id, null, false); });
    try { await refreshPages(); } catch (e) { report("warning", "EP pages", "Could not refresh EP pages (" + (e.code || e.name) + ")."); }
  }
  for (const [id, info] of dirty) {
    try { await deriveAndSave(id, info, MODE !== "normal"); }
    catch (e) { report("warning", "Job", "A job couldn't be updated (" + (e.code || e.name) + "); it will be tried again."); }
  }
  if (MODE === "normal" || MODE === "rederive") {
    try { check = await dailyCheck(); } catch (e) { report("warning", "Self-check", "The daily self-check failed (" + (e.code || e.name) + ")."); }
  }
  await saveMeta();
  try { await writeHealth(failed, check); } catch (e) { report("warning", "Health", "Couldn't write the robot report (" + (e.code || e.name) + ")."); }
  try { await weeklyBackup(); } catch (e) { report("warning", "Backup", "Backup failed (" + (e.code || e.name) + ")."); }
  report("notice", "Result", `Filed ${stats.filed} emails on jobs, ${stats.newJobs} new jobs, ${stats.check} to your Check list, ${stats.ignored} ignored, ${stats.other} not job emails.` +
    (portal.read + portal.failed + portal.login ? ` EP pages: ${portal.read} read` + (portal.failed ? `, ${portal.failed} failed` : "") + (portal.login ? `, ${portal.login} need a login` : "") + "." : "") +
    (check ? ` Self-check: ${check.missing} missed emails added, ${check.rebuiltDiffer} jobs corrected, ${check.check} in the Check list, ${check.duplicates} possible copies.` +
      (check.upkeep ? ` Upkeep: ${check.upkeep.reread} emails read again with the improved rules, ${check.upkeep.copies} copies marked, ${check.upkeep.removed} jobs from old emails removed.` : "") : ""));
  process.exit(failed ? 1 : 0);
})().catch(e => { report("error", "Robot", "Stopped: " + (e.code || e.name || "error") + " " + String(e.message || "").slice(0, 120).replace(/[\w.+-]+@[\w.-]+/g, "…")); process.exit(1); });
