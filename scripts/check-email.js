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
const { findPlaces } = require("../parser.js");
const { parseEmail, isAvailabilityCheck, classifyEmail, replyAnswer, extractLinks, parseCallTime, londonCheck, CALL_TIME_SUBJECT, isFromCastingAgency, htmlToText } = require("../parser.js");

// ---------- settings (stored as GitHub secrets, never in the code) ----------
const DAYS_BACK = Number(process.env.DAYS_BACK || 3);
// "Re-read everything": go through every folder, oldest email first, and work out the status
// of each job again (request → your answer → booking / release → call times). No phone alerts.
const REBUILD = process.env.REBUILD === "true";
const SURVEY = process.env.SURVEY === "true";
const survey = {};
const SURVEY_WORDS = ["book", "confirm", "selected", "pencil", "hold", "call sheet", "call time", "callsheet", "schedule", "details", "final", "release", "cancel", "stood down", "not required", "unfortunately", "update", "change", "reminder", "fitting", "wardrobe", "costume", "travel", "tomorrow", "pay", "re:", "availability", "av ", "check", "request"];
const epu = { found: 0, opened: 0, login: 0, booked: 0, released: 0, unclear: 0, matched: 0 };
// Booking, release and call-time emails often don't label the production. Look for the name of
// a job you already have in the subject (then the body); the longest name found wins.
function norm(x) { return " " + String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " "; }
// a job's name and its short form: "Falcon(Project 12)" → also "Falcon"; "EXP - Roundabout S2" → also "Roundabout S2"
function nameForms(p) {
  const full = String(p || "").trim();
  const forms = [full, full.replace(/\s*\(.*$/, ""), full.replace(/^[A-Z]{2,4}\s*-\s*/, ""), full.split(/\s+-\s+/)[0]];
  // also without a season marker: "Roundabout S2" → "Roundabout"
  forms.slice().forEach(f => forms.push(f.replace(/\s+(s|series|season)\s*\d+\s*$/i, "")));
  return [...new Set(forms.map(f => f.trim()).filter(f => norm(f).trim().length >= 4))];
}
function findKnownProject(subject, text) {
  const names = [...new Set((existingCalls || []).map(c => String(c.project || "").trim()).filter(Boolean))];
  for (const hay of [norm(subject), norm(String(text || "").slice(0, 4000))]) {
    // the longest matching form wins, and the job's full name is what we return
    const hits = [];
    names.forEach(p => nameForms(p).forEach(f => { if (hay.includes(norm(f))) hits.push([p, norm(f).length]); }));
    if (hits.length) return hits.sort((a, b) => b[1] - a[1])[0][0];
  }
  return "";
}
function knownName(r, subject, text) {
  if (r.project && (existingCalls || []).some(c => c.project && sameProject(c.project, r.project))) return;
  const k = findKnownProject(subject, text);
  if (k) r.project = k;
}
const why = {};
function miss(k) { why[k] = (why[k] || 0) + 1; }
// several copies of the same job (reminders): use the one you've acted on, else the newest
function pickOne(list) {
  const rank = c => ({ confirmed: 4, available: 3, released: 2, pending: 1 }[c.status] || 0);
  return list.slice().sort((a, b) => rank(b) - rank(a) || String(b.received || "").localeCompare(String(a.received || "")))[0];
}
const stats = { amended: 0, booked: [0, 0, 0], released: [0, 0], replied: [0, 0], calltime: [0, 0], restored: 0, folders: 0 };
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
// Emails already handled, kept in ONE small database record ("meta/seen"), so each 5-minute check
// costs a couple of reads instead of one read per email (Firebase's free plan: 50,000 reads a day)
let seenCache = null, seenDirty = false;
async function loadSeenCache() {
  if (seenCache) return;
  const d = (await db.collection("meta").doc("seen").get()).data();
  seenCache = new Map(Object.entries((d && d.keys) || {}));
}
function markSeen(key) { if (seenCache && !seenCache.has(key)) { seenCache.set(key, Date.now()); seenDirty = true; } }
async function saveSeenCache() {
  if (!seenCache || !seenDirty) return;
  const keep = [...seenCache.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1500);
  await db.collection("meta").doc("seen").set({ keys: Object.fromEntries(keep), at: new Date().toISOString() });
}
// Your jobs, loaded only when needed. To stay inside Firebase's free reads, an email from an agency
// loads only THAT agency's jobs (field "agencyKey"), not the whole schedule. Everything else
// (re-reads, clean-ups, unknown senders) loads the lot.
let existingCalls = null;
let fullLoaded = false, scopeAgency = null, keysReady = null;
const known = new Map();                 // id → job, shared by every lookup in this run
const scopedLoaded = new Set();
function rememberJobs(list) { list.forEach(c => { if (!known.has(c.id)) known.set(c.id, c); }); existingCalls = [...known.values()]; }
function addKnown(c) { known.set(c.id, c); existingCalls = [...known.values()]; }
function resetCalls() { existingCalls = null; fullLoaded = false; known.clear(); scopedLoaded.clear(); }
async function loadExistingCalls() {
  if (fullLoaded) return existingCalls;
  const k = scopeAgency ? canonAgency(scopeAgency) : "";
  if (k && !REBUILD && process.env.CLEANUP !== "true") {
    if (keysReady === null) keysReady = !!(((await db.collection("meta").doc("flags").get()).data() || {}).agencyKeys);
    if (keysReady) {
      if (!scopedLoaded.has(k)) {
        const snap = await db.collection("calls").where("agencyKey", "==", k).get();
        scopedLoaded.add(k);
        rememberJobs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }
      return existingCalls || (existingCalls = []);
    }
  }
  const snap = await db.collection("calls").get();
  known.clear();
  rememberJobs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  fullLoaded = true;
  return existingCalls;
}
// every job carries "agencyKey" so the robot can look up one agency's jobs cheaply
async function backfillAgencyKeys() {
  await loadExistingCalls();
  let n = 0;
  for (const c of existingCalls) {
    const k = canonAgency(c.agency);
    if (c.agencyKey !== k) { await db.collection("calls").doc(c.id).update({ agencyKey: k }); c.agencyKey = k; n++; }
  }
  await db.collection("meta").doc("flags").set({ agencyKeys: true, at: new Date().toISOString() }, { merge: true });
  return n;
}

// Each robot change is noted on the job (newest last, up to 8) with the values from before,
// so the app's "Undo this change" button can put them back.
function withHistory(c, what, changes) {
  const before = {};
  for (const f of ["status", "dates", "agency", "project"])
    if (f in changes && JSON.stringify(changes[f]) !== JSON.stringify(c[f])) before[f] = c[f] === undefined ? null : c[f];
  if (!Object.keys(before).length) return changes;
  const history = (Array.isArray(c.history) ? c.history : []).concat([{ at: new Date().toISOString(), what: String(what).slice(0, 120), before }]).slice(-8);
  return { ...changes, history };
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
  // only ever grows: merging or cleaning up calls must not make the robot forget an agency
  const names = [...new Set([...(data && data.names || []), ...trustedAgencies(existingCalls)])];
  await ref.set({ names: names, updatedAt: new Date().toISOString() });
  return names;
}

// ---------- phone notification (free ntfy app) ----------
// Sends the new call to your phone. The topic name works like a password: keep it private.
async function notifyPhone(call) {
  if (REBUILD) return;                                 // re-reading old emails: no alerts
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

// ---------- which job is this email about? ----------
// Several agencies can send the same production, and each one is its own job: an email from
// Extra People never changes a Casting Collective job. Agency names are compared loosely
// ("Two 10 Casting" = "Two10", "Lucas Extras" = "Lucas").
function canonAgency(a) {
  return String(a || "").toLowerCase().replace(/\b(ltd|limited|casting|extras?|agency|uk|talent|management|the)\b/g, "").replace(/[^a-z0-9]/g, "");
}
function sameAgency(a, b) { const x = canonAgency(a), y = canonAgency(b); return !!x && x === y; }
function overlaps(c, listed) { return (c.dates || []).some(e => listed.has(e.d)); }
// Returns { job, why }. Order: same EP message page → named production (same agency only; when the
// email names a production we never fall back to another job) → same agency + same days →
// (releases) the one live job from that agency → (answers) the one recent new request from that agency.
function matchJob(kind, r, links, received, statuses) {
  const pool = existingCalls.filter(c => c.id && statuses.includes(c.status));
  const agencyKnown = !!canonAgency(r.agency);
  const sameAg = c => !agencyKnown || !canonAgency(c.agency) || sameAgency(c.agency, r.agency);
  const listed = new Set((r.dates || []).map(x => x.d));
  const ep = portalLink({ links: (links || []).filter(l => l.kind === "respond") });
  if (ep) { const byPage = pool.filter(c => portalLink(c) === ep); if (byPage.length) return { job: pickOne(byPage) }; }
  if (r.project) {
    const named = existingCalls.filter(c => c.id && c.project && closeName(c.project, r.project) && sameAg(c));
    if (named.length) {
      let m = pool.filter(c => named.includes(c));
      if (m.length > 1 && listed.size) { const byDay = m.filter(c => overlaps(c, listed)); if (byDay.length) m = byDay; }
      if (m.length > 1) m = [pickOne(m)];
      return m.length ? { job: m[0] } : { job: null, why: "job is " + [...new Set(named.map(c => c.status))].join("/") };
    }
    if (existingCalls.some(c => c.project && closeName(c.project, r.project))) return { job: null, why: "only another agency has this production" };
  }
  if (agencyKnown && listed.size) {
    const byDay = pool.filter(c => sameAgency(c.agency, r.agency) && overlaps(c, listed) && c.status !== "released");
    if (byDay.length === 1) return { job: byDay[0] };
  }
  if (!r.project && agencyKnown && kind === "released") {
    const since = String(received || "").slice(0, 10);
    const live = pool.filter(c => ["available", "confirmed", "pending"].includes(c.status) && sameAgency(c.agency, r.agency) &&
      (c.dates || []).some(e => e.d >= since && (!listed.size || listed.has(e.d))));
    const acted = live.filter(c => c.status !== "pending");
    if (acted.length === 1) return { job: acted[0] };
    if (live.length === 1) return { job: live[0] };
  }
  if (!r.project && agencyKnown && kind === "replied") {
    const from = new Date(new Date((received || londonDate()) + "T12:00:00Z").getTime() - 21 * 864e5).toISOString().slice(0, 10);
    const recent = pool.filter(c => c.status === "pending" && sameAgency(c.agency, r.agency) && (c.received || "") >= from && (c.received || "") <= (received || "9999"));
    if (recent.length === 1) return { job: recent[0] };
  }
  return { job: null, why: !r.project ? "no name in email" : "no job with that name" };
}
// an older email must not undo a newer one (e.g. a release read after a later booking)
function olderThanStatus(c, received) { return !!(c.statusAt && received && received < c.statusAt); }

async function applyStatusEmail(kind, r, subject, received, skipId, links, source) {
  await loadExistingCalls();
  // a booking is the final word, so it can also revive a job marked declined, canceled or expired
  const okStatus = kind === "booked" ? ["pending", "available", "confirmed", "released", "declined", "canceled", "expired"] : ["pending", "available", "confirmed", "released"];
  const listed = new Set((r.dates || []).map(x => x.d));
  const found = matchJob(kind, r, links, received, okStatus);
  const matches = found.job && found.job.id !== skipId ? [found.job] : [];
  if (matches.length !== 1) {
    miss(`${kind}: ${found.why || "no match"}` + (listed.size ? "" : ", no dates"));
    // a booking we can't link to any request: add it as its own booked job
    if (kind === "booked" && source && r.project) {
      const call = buildCall(r, source);
      call.status = "confirmed";
      call.review = true;
      call.reviewReason = "Made from a booking email (no availability check from this agency found)" + ((r.dates || []).length ? ". Check the dates" : ". The email gave no dates – add them");
      call.statusAt = received;
      call.notes = "Booked by email on " + received + ": " + String(subject).slice(0, 120);
      const id = "b" + source.key;
      await enrichFromPortal(call);
      call.status = "confirmed";
      await db.collection("calls").doc(id).set(call);
      addKnown({ id, ...call });
      stats.booked[2]++;
      await notifyPhone({ ...call, project: "BOOKED: " + call.project });
      return id;
    }
    return null;
  }
  const c = matches[0];
  const was = { status: c.status, dates: c.dates, agency: c.agency, project: c.project, history: c.history };
  const label = (kind === "booked" ? "Booking" : "Release") + " email " + received;
  if (olderThanStatus(c, received)) { miss(`${kind}: older than the job's latest news`); return c.id; }
  if (kind === "released" && c.status === "released") return c.id;
  // "Not required for filming on 3rd Oct": only those days are released when the job has other days
  if (kind === "released" && listed.size && (c.dates || []).some(e => !listed.has(e.d))) {
    const dates = c.dates.map(e => ({ ...e }));
    let hit = false;
    dates.forEach(e => { if (listed.has(e.d) && e.state !== "released") { e.state = "released"; hit = true; } });
    // every day released or canceled → the whole job is released
    const allOff = dates.every(e => ["released", "canceled"].includes(e.state));
    if (hit || allOff) {
      const ch = { dates, updatedAt: new Date().toISOString(), statusAt: received };
      if (allOff && c.status !== "released") ch.status = "released";
      const ch2 = withHistory(was, label + " (some days)", ch);
      await db.collection("calls").doc(c.id).update(ch2);
      Object.assign(c, ch2);
    }
    return c.id;
  }
  const status = kind === "booked" ? "confirmed" : "released";
  const note = (kind === "booked" ? "Booked" : "Released") + " by email on " + received + ": " + String(subject).slice(0, 120);
  const changes = { status: status, statusAt: received, updatedAt: new Date().toISOString() };
  const wasBooked = c.status === "confirmed";
  if (!String(c.notes || "").includes(note)) changes.notes = (c.notes ? c.notes + " • " : "") + note;
  // A booking email that lists dates: those days are booked (green). Days it says are "on hold /
  // pencilled / tbc", and shoot days it doesn't mention, stay yellow (still available, not confirmed).
  // Fittings are only touched if the email lists fitting days.
  if (kind === "booked" && listed.size) {
    const listsFit = r.dates.some(x => x.kind === "fit"), listsFilm = r.dates.some(x => x.kind === "film");
    const hold = new Set(r.dates.filter(x => x.hold).map(x => x.d));
    const dates = (c.dates || []).map(e => ({ ...e }));
    dates.forEach(e => {
      if (hold.has(e.d)) { if (!e.state || e.state === "released" || e.state === "canceled") e.state = "available"; }
      else if (listed.has(e.d)) { if (["released", "canceled", "available", "pending"].includes(e.state)) delete e.state; }
      // days this booking doesn't mention stay yellow — unless you were already booked for them
      else if (!wasBooked && (!e.state || (REBUILD && e.state === "released")) && ((e.kind === "film" && listsFilm) || (e.kind === "fit" && listsFit))) e.state = "available";
      // (re-reading: days an older version greyed out become yellow again; later release emails grey them properly)
    });
    r.dates.forEach(x => {
      if (dates.some(e => e.d === x.d)) return;
      const { hold: h, answer, ...day } = x;
      dates.push(h ? { ...day, state: "available" } : day);
    });
    dates.sort((a, b) => a.d.localeCompare(b.d));
    changes.dates = dates;
  }
  const changes2 = withHistory(was, label, changes);
  await db.collection("calls").doc(c.id).update(changes2);
  Object.assign(c, changes2);
  await notifyPhone({ ...c, project: (kind === "booked" ? "BOOKED: " : "Released: ") + c.project });
  return c.id;
}


// ---------- one job = one call ----------
// Same production? Names match, or one contains the other and the shorter is 6+ letters
// ("Tea Time" and "TEA TIME (TV Series)").
function closeName(a, b) {
  const x = norm(a).trim(), y = norm(b).trim();
  return !!x && !!y && (x === y || ((x.includes(y) || y.includes(x)) && Math.min(x.length, y.length) >= 6));
}
// the days a call covers, widened by 60 days, so a job from last year isn't mixed with this year's
function span(c) {
  const ds = (c.dates || []).map(e => e.d).filter(Boolean).sort();
  const a = ds[0] || c.received || "", b = ds[ds.length - 1] || c.received || "";
  if (!a) return null;
  const shift = (d, n) => { const t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  return [shift(a, -60), shift(b, 60)];
}
function closeInTime(a, b) {
  const x = span(a), y = span(b);
  return !x || !y || (x[0] <= y[1] && y[0] <= x[1]);
}
const ACTIVE = ["pending", "available", "confirmed"];
// the call this new email belongs to: same EP message, or same production + agency at around the same time
function findTwin(call) {
  const ep = portalLink(call);                     // the same EP message page = the same job
  if (ep) {
    const byPage = existingCalls.filter(c => c.id && portalLink(c) === ep);
    if (byPage.length) return pickOne(byPage);
  }
  if (!call.project) return null;
  // same production from the SAME agency (another agency's request is a different job)
  const pool = existingCalls.filter(c => c.id && c.project && closeName(c.project, call.project) &&
    canonAgency(c.agency) && canonAgency(call.agency) && sameAgency(c.agency, call.agency) && closeInTime(c, call));
  const active = pool.filter(c => ACTIVE.includes(c.status));
  if (active.length) return pickOne(active);
  // a closed job (released, declined...): only a reminder with no new days counts as the same
  const reminder = pool.filter(c => call.dates.length && call.dates.every(d => (c.dates || []).some(e => e.d === d.d)));
  return reminder.length ? pickOne(reminder) : null;
}
// a later email about a job you already have: add only what's new (dates, missing details, links)
async function amendCall(c, call) {
  const dates = (c.dates || []).map(e => ({ ...e }));
  const added = [];
  (call.dates || []).forEach(x => {
    const have = dates.find(e => e.d === x.d);
    if (have) {
      if (!have.loc && x.loc) have.loc = x.loc;
      if (x.night) have.night = true;
      if (x.kind === "reh" && have.kind === "film") have.kind = "reh";
      return;
    }
    const { answer, hold, ...day } = x;
    if (c.status !== "pending") day.state = "pending";   // a new day you haven't answered yet (white)
    dates.push(day);
    added.push(x.d);
  });
  dates.sort((a, b) => a.d.localeCompare(b.d));
  const changes = { dates, updatedAt: new Date().toISOString() };
  for (const k of ["role", "location", "fitLocation", "filmLocation", "rate"]) if (!c[k] && call[k]) changes[k] = call[k];
  if (!c.project && call.project) changes.project = call.project;
  if (added.length && call.respondBy && (!c.respondBy || call.respondBy > c.respondBy)) changes.respondBy = call.respondBy;
  const urls = new Set((c.links || []).map(l => l.url));
  const newLinks = (call.links || []).filter(l => !urls.has(l.url));
  if (newLinks.length) changes.links = (c.links || []).concat(newLinks).slice(0, 20);
  if ((call.answers || []).length && !(c.answers || []).length) changes.answers = call.answers;
  const what = [added.length ? `${added.length} new date${added.length > 1 ? "s" : ""}` : "",
                Object.keys(changes).some(k => ["role", "location", "rate", "respondBy"].includes(k)) ? "new details" : ""].filter(Boolean).join(" + ");
  if (what) { changes.newInfo = true; changes.newInfoText = what + " from a later email"; }
  const changes2 = withHistory(c, "Later email: " + (what || "details"), changes);
  await db.collection("calls").doc(c.id).update(changes2);
  Object.assign(c, changes2);
  stats.amended++;
  if (added.length) await notifyPhone({ ...c, project: "Update: " + nameOfCall(c), dates: dates.filter(e => added.includes(e.d)) });
  return c.id;
}
function nameOfCall(c) { return c.project || c.emailSubject || "a job"; }

// every email about a job is kept on it (for checking): date, type, subject, text
function emailRecord(m, kind) {
  return { key: m.key, date: m.received, kind, subject: String(m.subject || "").slice(0, 200),
           text: String(m.text || "").replace(/\n{3,}/g, "\n\n").slice(0, 2500) };
}
async function logEmail(callId, m, kind) {
  if (!callId || !m || !m.key) return;
  const c = (existingCalls || []).find(x => x.id === callId);
  if (c && (c.emails || []).some(e => e.key === m.key)) return;
  const rec = emailRecord(m, kind);
  try {
    await db.collection("calls").doc(callId).update({ emails: admin.firestore.FieldValue.arrayUnion(rec) });
    if (c) c.emails = (c.emails || []).concat(rec);
  } catch (e) { /* the call was deleted: nothing to log */ }
}

// Clean up: copies of the same job (same production + agency, around the same time) become one.
// Your own entries are never deleted; robot copies are folded into the best one.
async function mergeDuplicates() {
  resetCalls();
  await loadExistingCalls();
  // the copy with the "furthest along" status wins (a release beats a reminder that came earlier)
  const rank = { done: 8, confirmed: 7, released: 6, canceled: 6, declined: 5, available: 4, pending: 3, expired: 2, lapsed: 2 };
  const dayFor = { done: "worked", available: "available", pending: "pending", released: "released", canceled: "canceled", declined: "canceled", expired: "canceled" };
  const used = new Set();
  let merged = 0;
  for (const a of existingCalls) {
    if (used.has(a.id) || !a.project) continue;
    // only copies from the same agency (a copy with no agency joins only if just one agency is involved)
    let group = existingCalls.filter(b => !used.has(b.id) && b.project && closeName(a.project, b.project) && closeInTime(a, b));
    const agencies = new Set(group.map(g => canonAgency(g.agency)).filter(Boolean));
    if (agencies.size > 1) group = canonAgency(a.agency) ? group.filter(g => sameAgency(g.agency, a.agency)) : [];
    const robot = group.filter(g => String(g.source || "").startsWith("email"));
    if (group.length < 2 || !robot.length) continue;
    group.forEach(g => used.add(g.id));
    const manual = group.filter(g => !String(g.source || "").startsWith("email"));
    const byRank = (x, y) => (rank[y.status] || 0) - (rank[x.status] || 0) || String(x.received || "").localeCompare(String(y.received || ""));
    const primary = (manual.length ? manual : group).slice().sort(byRank)[0];
    const dups = robot.filter(g => g.id !== primary.id);
    if (!dups.length) continue;
    const members = [primary, ...dups];
    const finalStatus = members.slice().sort(byRank)[0].status;
    // days: each copy's days keep the colour they had
    const dates = [];
    // days of the copies that already have the final status come first and keep their colour
    members.slice().sort((x, y) => (y.status === finalStatus) - (x.status === finalStatus)).forEach(mem => (mem.dates || []).forEach(e => {
      if (dates.some(x => x.d === e.d)) return;
      const day = { ...e };
      if (!day.state && mem.status !== finalStatus && dayFor[mem.status]) day.state = dayFor[mem.status];
      dates.push(day);
    }));
    dates.sort((x, y) => x.d.localeCompare(y.d));
    const out = { dates, status: finalStatus, updatedAt: new Date().toISOString() };
    for (const k of ["role", "location", "fitLocation", "filmLocation", "rate", "respondBy", "emailSubject", "emailFrom", "rawEmail"])
      if (!primary[k]) { const v = dups.map(d => d[k]).find(Boolean); if (v) out[k] = v; }
    const links = [], seenUrl = new Set();
    members.forEach(mem => (mem.links || []).forEach(l => { if (!seenUrl.has(l.url)) { seenUrl.add(l.url); links.push(l); } }));
    if (links.length) out.links = links.slice(0, 20);
    const answers = [...new Set(members.flatMap(mem => mem.answers || []))];
    if (answers.length) out.answers = answers.slice(0, 12);
    const notes = [...new Set(members.map(mem => mem.notes).filter(Boolean))];
    if (notes.length) out.notes = notes.join(" • ").slice(0, 2000);
    // keep every email: the ones already logged + each copy's original email
    const emails = [], seenKey = new Set();
    members.forEach(mem => {
      (mem.emails || []).forEach(e => { if (!seenKey.has(e.key)) { seenKey.add(e.key); emails.push(e); } });
      if (mem.rawEmail && !(mem.emails || []).length && !seenKey.has("raw:" + mem.id)) {
        seenKey.add("raw:" + mem.id);
        const [subj, ...rest] = String(mem.rawEmail).split("\n\n");
        emails.push({ key: "raw:" + mem.id, date: mem.received || "", kind: mem === primary ? "call" : "merged",
                      subject: (mem.emailSubject || subj || "").slice(0, 200), text: rest.join("\n\n").slice(0, 2500) });
      }
    });
    if (emails.length) out.emails = emails.slice(-40);
    out.newInfo = true;
    out.newInfoText = `${dups.length + 1} copies of this job merged into one`;
    out.review = false; out.reviewReason = "";
    await db.collection("calls").doc(primary.id).update(out);
    for (const d of dups) await db.collection("calls").doc(d.id).delete();
    merged += dups.length;
  }
  resetCalls();
  await loadExistingCalls();
  return merged;
}

// a new call from an email
function buildCall(r, src) {
  return {
    project: r.project, agency: r.agency, agencyKey: canonAgency(r.agency), role: r.role,
    location: r.location, fitLocation: r.fitLocation, filmLocation: r.filmLocation,
    rate: r.rate, notes: r.notes, dates: r.dates.map(({ hold, ...d }) => d),
    respondBy: r.respondBy, received: src.received,
    status: "pending", attention: false,
    review: r.review, reviewReason: r.reviewReason,
    source: "email (" + src.account.email.split("@")[1] + ")",
    emailSubject: src.subject.slice(0, 300),
    emailFrom: ((src.from.name || "") + " <" + (src.from.address || "") + ">").slice(0, 200),
    rawEmail: (src.subject + "\n\n" + src.text).slice(0, 8000),
    links: extractLinks(src.html || ""),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Call time email: find the booked job (by production name, else by date) and store
// the call time + place on that day. Adds the day if the job didn't have it yet.
async function applyCallTime(r, ct, subject) {
  await loadExistingCalls();
  const day = ct.dates.length ? ct.dates[0].d : null;
  const found = matchJob("calltime", { ...r, dates: ct.dates }, [], null, ["confirmed", "available"]);
  let match = found.job ? [found.job] : [];
  // no name: the one booked job (same agency if known) that has that day
  if (!match.length && !r.project && day) {
    match = existingCalls.filter(c => c.id && c.status === "confirmed" && (c.dates || []).some(e => e.d === day) &&
      (!canonAgency(r.agency) || sameAgency(c.agency, r.agency)));
    if (match.length > 1) match = [];
  }
  if (match.length !== 1) { miss("calltime: " + (found.why || "no match") + (day ? "" : ", no date")); return null; }
  const c = match[0];
  const was = { status: c.status, dates: c.dates, history: c.history };
  const dates = (c.dates || []).map(e => ({ ...e }));
  const d = day || (dates.filter(e => e.d >= new Date().toISOString().slice(0, 10)).sort((a, b) => a.d.localeCompare(b.d))[0] || {}).d;
  if (!d) return null;
  let entry = dates.find(e => e.d === d && e.kind === "film") || dates.find(e => e.d === d);
  if (!entry) { entry = { d: d, kind: "film" }; dates.push(entry); dates.sort((a, b) => a.d.localeCompare(b.d)); }
  entry.callTime = ct.time;
  const newStatus = c.status === "available" ? "confirmed" : c.status;   // a call time means you're booked
  if (ct.place) entry.callPlace = ct.place.slice(0, 160);              // the call sheet is the most exact
  if (ct.w3w) entry.w3w = ct.w3w;
  if (ct.postcode) entry.postcode = ct.postcode;
  const chC = withHistory(was, "Call time email", { dates: dates, status: newStatus, updatedAt: new Date().toISOString() });
  await db.collection("calls").doc(c.id).update(chC);
  Object.assign(c, chC);
  c.dates = dates;
  const t = new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  await notifyPhone({ ...c, project: "Call time: " + c.project, role: t + " — call " + ct.time + (ct.place ? " @ " + ct.place : ""), dates: [] , location: ct.place || c.location });
  return c.id;
}

// ---------- Entertainment Partners message pages ----------
// The "Respond" link in an EP email opens a message page (no login needed) with the production
// name, every date, the deadline and, once you've replied, your answers. The robot only READS
// these pages (a normal page visit). It never opens Yes/No links, which could answer for you.
const YES_RE = /^(yes|available|i am available|i'm available|i can|can attend|i can attend|happy to|confirm)/i;
const NO_RE = /^(no\b|not available|unavailable|i am not|i'm not|i can'?not|can'?t|cannot|decline)/i;
const shapes = {};   // counts of answer shapes only (no content), for the format check
function shape(k) { shapes[k] = (shapes[k] || 0) + 1; }
// every ticked choice on the page: { yes/no, the date it belongs to (if any) }
function tickedAnswers(text, parse) {
  const L = text.split("\n").map(x => x.trim()).filter(Boolean);
  const out = [];
  let lastDate = null, lastDateLine = -99, availQ = false;
  L.forEach((line, i) => {
    if (/\?\s*$/.test(line) || /^(question|q\d)/i.test(line)) availQ = /availab|attend|dates?\b|work (on|the)|book/i.test(line);
    const ds = parse(line);
    if (ds.length) { lastDate = ds; lastDateLine = i; }
    const parts = line.split("☒");
    for (let k = 1; k < parts.length; k++) {
      const after = parts[k].split("☐")[0].replace(/^[\s|:-]+/, "");
      const before = parts[k - 1].split("☐").pop().replace(/[\s|:-]+$/, "").split(/\s{2,}|\|/).pop().trim();
      let a = YES_RE.test(after) ? "yes" : NO_RE.test(after) ? "no" : null;
      let where = "after";
      if (!a && after === "") { const nx = (L[i + 1] || ""); a = YES_RE.test(nx) ? "yes" : NO_RE.test(nx) ? "no" : null; where = "nextline"; }
      if (!a) { a = /(^|\s)(yes|available)$/i.test(before) && !/not available$/i.test(before) ? "yes" : /(^|\s)(no|not available|unavailable)$/i.test(before) ? "no" : null; where = "before"; }
      shape(a ? `${a}-${where}` : (after ? "other-word" : "empty"));
      const near = ds.length ? ds : (i - lastDateLine <= 4 ? lastDate : null);
      shape(ds.length ? "date-same-line" : near ? "date-near" : "no-date");
      if (a && (near || availQ)) { out.push({ answer: a, dates: (near || []).map(d => d.d) }); shape(near ? "used-date" : "used-question"); }
      else if (a) shape("ignored-other-question");
    }
  });
  return out;
}
const portal = { read: 0, failed: 0, login: 0, answered: 0, recorded: 0, radios: 0, ticked: 0, scripts: 0, dated: 0 };
function portalLink(c) {
  // the NEWEST EP page (a later request for the same job adds its link at the end)
  const eps = (c.links || []).filter(x => x.kind === "respond" && /^https:\/\/[a-z0-9.-]*epcastingportal\.com\//i.test(x.url));
  return eps.length ? eps[eps.length - 1].url : null;
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
  // counts only (no content) so the page format can be checked from the public log
  if (/recorded your response/i.test(text)) portal.recorded++;
  if (/type=["']?radio/i.test(html)) portal.radios++;
  if (/☒/.test(text)) portal.ticked++;
  if (/<script/i.test(html) && html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim().length < 400) portal.scripts++;
  if (r.dates.length) portal.dated++;
  if (r.project && (!call.project || call.review)) call.project = r.project;
  if (!call.role && r.role) call.role = r.role;
  if (!call.rate && r.rate) call.rate = r.rate;
  if (!call.respondBy && r.respondBy) call.respondBy = r.respondBy;
  if (!call.location) call.location = r.location || (r.dates.find(d => d.loc) || {}).loc || "";
  // dates: add the ones the page lists (keeps your own day changes)
  const dates = (call.dates || []).map(e => ({ ...e }));
  // New days are only added to a new or unanswered job (so days you deleted don't come back).
  // The page's day type (fitting / rehearsal / shoot) is more reliable than the email's.
  const mayAdd = !call.id || call.status === "pending" || call.status === "available";
  r.dates.forEach(x => {
    const have = dates.find(e => sameDay(e, x));
    if (!have) { if (mayAdd) dates.push({ d: x.d, kind: x.kind, ...(x.loc ? { loc: x.loc } : {}), ...(x.night ? { night: true } : {}) }); }
    else { if (!have.loc && x.loc) have.loc = x.loc; if (x.kind && x.kind !== have.kind && !have.state) have.kind = x.kind; }
  });
  dates.sort((a, b) => a.d.localeCompare(b.d));
  call.dates = dates;
  // your answers, once you've replied on the page
  if (/successfully recorded your response/i.test(text)) {
    call.replied = true;
    const ticks = tickedAnswers(text, line => parseEmail({ subject: "", fromName: "", html: "", text: line, received: call.received }).dates);
    const yes = ticks.some(t => t.answer === "yes") || r.dates.some(d => d.answer === "yes");
    const no = ticks.some(t => t.answer === "no") || r.dates.some(d => d.answer === "no");
    // remember which days you said yes / no to
    ticks.forEach(t => t.dates.forEach(d => { const e = call.dates.find(x => x.d === d); if (e) e.answer = t.answer; }));
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
    if (yes || no) portal.answered++;
    // what you ticked on the EP page is the final word on your answer
    if (yes && (["pending", "expired"].includes(call.status) || (call.status === "declined" && call.declinedBy === "robot"))) { call.status = "available"; call.declinedBy = ""; }
    else if (no && !yes && ["pending", "available"].includes(call.status)) { call.status = "declined"; call.declinedBy = "robot"; }
  }
  if (call.project && call.dates.length && /^Couldn't find/.test(call.reviewReason || "")) { call.review = false; call.reviewReason = ""; }
  return true;
}
// every 20 minutes, look again at EP pages of calls you haven't answered yet (max 6 per run)
async function refreshPendingPortalPages() {
  // Firebase's free plan allows 50,000 reads a day: only look every 30 minutes, and only at
  // the calls that can still change (not the whole schedule)
  const slot = Math.floor(Date.now() / (5 * 60 * 1000)) % 6;
  if (slot !== 0 && !process.env.PORTAL_DEBUG && !REBUILD) return;
  const snapR = await db.collection("calls").where("status", "in", ["pending", "available", "declined"]).get();
  const openJobs = snapR.docs.map(d => ({ id: d.id, ...d.data() }));
  const dbg = !!process.env.PORTAL_DEBUG;
  const today = londonDate();
  // new requests: every 20 minutes; ones you've answered (with days still ahead): every 6 hours
  const every = { pending: 20, available: 360, declined: 360 };
  const due = openJobs.filter(c => c.id && every[c.status] && portalLink(c) && (c.dates || []).some(e => e.d >= today) &&
    (dbg || !c.portalCheckedAt || Date.now() - new Date(c.portalCheckedAt).getTime() > every[c.status] * 60 * 1000))
    .sort((a, b) => (a.portalCheckedAt || "").localeCompare(b.portalCheckedAt || "")).slice(0, dbg ? 30 : 8);
  for (const c of due) {
    const before = JSON.stringify([c.status, c.project, c.dates, c.answers]);
    const copy = { ...c };
    await enrichFromPortal(copy);
    const changed = JSON.stringify([copy.status, copy.project, copy.dates, copy.answers]) !== before;
    // write only what the page changed, so an edit you made in the app meanwhile isn't overwritten
    const ch = { portalCheckedAt: copy.portalCheckedAt };
    if (changed) {
      for (const k of ["status", "project", "dates", "answers", "replied", "declinedBy", "role", "rate", "respondBy", "location", "review", "reviewReason"])
        if (copy[k] !== undefined && JSON.stringify(copy[k]) !== JSON.stringify(c[k])) ch[k] = copy[k];
      ch.updatedAt = new Date().toISOString();
    }
    await db.collection("calls").doc(c.id).update(changed ? withHistory(c, "EP page", ch) : ch);
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
async function applyReply(r, links, answer, received) {
  await loadExistingCalls();
  const found = matchJob("replied", r, links, received, ["pending", "available", "declined"]);
  const c = found.job;
  if (!c) { miss("reply: " + (found.why || "no match")); return null; }
  if (olderThanStatus(c, received)) return c.id;
  if (c.status === "declined" && c.declinedBy !== "robot") return c.id;        // you set it yourself
  const copy = { ...c, status: answer };
  if (portalLink(c)) await enrichFromPortal(copy);       // the EP page shows what you really ticked
  if (copy.status === c.status && JSON.stringify(copy.dates) === JSON.stringify(c.dates)) return c.id;
  const changes = { status: copy.status, dates: copy.dates || [], statusAt: received || londonDate(), repliedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  changes.declinedBy = copy.status === "declined" ? "robot" : "";
  if (copy.answers) changes.answers = copy.answers;
  const changes2 = withHistory(c, "Answer email " + (received || ""), changes);
  await db.collection("calls").doc(c.id).update(changes2);
  Object.assign(c, changes2);
  return c.id;
}

// "Find an email": what happened to emails whose SUBJECT contains some words?
// Reports only yes/no facts, never names or contents (GitHub logs are public).
// common words only; anything else (names, places) becomes "*"
function maskShape(subj) {
  const SAFE = new Set("a an the for on of to in at your you you're are is be been have has we our from and with re fw fwd booking booked book confirmed confirmation confirm update availability available av check request new job work dates date day days tomorrow today next week call time shoot filming fitting costume selected not required needed final please reply urgent asap important change thanks thank released release hold pencil extras extra sa supporting artist role tv film series feature commercial free can could would like interested any this monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun – - : | ! ?".split(" "));
  return String(subj).toLowerCase().replace(/[0-9]+/g, "#").split(/\s+/).map(w => { const x = w.replace(/[^a-z'#–:|!?-]/g, ""); return SAFE.has(x) || /^#/.test(x) ? x : "*"; }).join(" ").replace(/(\* )+\*/g, "*");
}
const PHRASE_PROBES = [["are you free/available", /are you (free|available)/i], ["would you be", /would you be (free|available|interested|happy)/i],
  ["can you do", /can you (do|make|work)/i], ["availability for", /availability (for|on)/i], ["confirm availability", /confirm (your |my )?availab/i],
  ["let me know", /let me know/i], ["interested", /interested/i], ["submit", /submit/i], ["job for you", /(job|work|role) for you/i],
  ["date in text", /\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i], ["booked", /booked|booking/i], ["released", /released|not required/i]];
async function findEmails(words) {
  await loadExistingCalls();
  for (let i = 0; i < accounts.length; i++) {
    const client = new ImapFlow({ host: "imap.mail.yahoo.com", port: 993, secure: true, auth: { user: accounts[i].email, pass: accounts[i].password }, logger: false });
    await client.connect();
    for (const { path: folder } of await mailFolders(client)) {
      let lock;
      try { lock = await client.getMailboxLock(folder); } catch (e) { continue; }
      try {
        const bySender = /^from:/i.test(words);
        const since = new Date(Date.now() - (bySender ? 480 : 14) * 24 * 60 * 60 * 1000);
        const query = bySender ? { since, from: words.slice(5).trim() } : { since, subject: words };
        const uids = await client.search(query, { uid: true }) || [];
        if (!uids.length) { if (!bySender) report("notice", `Find · account ${i + 1} · ${folder}`, "No email with those words in the subject (last 14 days)."); continue; }
        for (const uid of uids.slice(-15)) {
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
            "type: " + (classifyEmail(env.subject || "", text, isFromCastingAgency(from.name, from.address, knownAgencies)) || "not a call"),
            "robot has seen it: " + (seen.exists ? "yes" : "no"),
            "call in the app: " + (inApp ? "yes" : (callId ? "it was deleted" : "no")),
            "production name found: " + (r.project ? "yes" : "no"),
            "dates found: " + r.dates.length,
            "reply link: " + (extractLinks(mail.html || "").some(l => /epcastingportal/i.test(l.url)) ? "EP page" : "none"),
            "subject shape: " + maskShape(env.subject || ""),
            "phrases: " + PHRASE_PROBES.filter(([, re]) => re.test((env.subject || "") + "\n" + text.slice(0, 3000))).map(([k]) => k).join(", "),
          ].join(" · "));
        }
      } finally { lock.release(); }
    }
    await client.logout();
  }
}

// every folder except Sent and Drafts (agency emails can be in Spam, Archive or your own folders)
async function mailFolders(client) {
  const list = await client.list();
  const out = list
    .filter(f => !(f.flags && f.flags.has("\\Noselect")) && !["\\Sent", "\\Drafts"].includes(f.specialUse) && !/^(sent|drafts?|outbox|templates)$/i.test(f.name))
    .map(f => ({ path: f.path, trash: f.specialUse === "\\Trash" || /^(trash|deleted)/i.test(f.name) }));
  return out.sort((a, b) => (b.path === "INBOX") - (a.path === "INBOX"));
}

async function connect(account) {
  const client = new ImapFlow({
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    auth: { user: account.email, pass: account.password },
    logger: false,
    socketTimeout: 120000,
  });
  client.on("error", () => {});                       // a dropped connection is handled below
  await client.connect();
  return client;
}
const rebuildItems = [];      // re-read mode: emails from BOTH accounts, sorted by date before handling
async function checkAccount(account) {
  const counts = { looked: 0, alreadySeen: 0, notACall: 0, added: 0, updated: 0, folders: 0, skipped: 0 };
  let client = await connect(account);
  const folders = await mailFolders(client);
  const all = [];                                      // re-read mode: every email, sorted by date afterwards
  for (const folder of folders) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (!client.usable) client = await connect(account);
        const lock = await client.getMailboxLock(folder.path);
        try { await checkFolder(client, account, counts, folder, REBUILD ? all : null); } finally { lock.release(); }
        counts.folders++;
        break;
      } catch (e) {
        if (e.authenticationFailed) throw e;
        if (attempt === 2) counts.skipped++;
        try { await client.logout(); } catch (_) {}
        client = { usable: false };
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  try { if (client.usable) await client.logout(); } catch (_) {}
  // re-read mode: the emails are worked through later, together with the other account's, oldest first
  if (REBUILD) { all.forEach(x => { x.counts = counts; }); rebuildItems.push(...all); }
  return counts;
}

async function checkFolder(client, account, counts, folder, collect) {
  const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

  // 1) read only the envelopes (sender, subject, ID) of recent emails: small and fast
  const candidates = [];
  // big folders: ask for the list of emails first, then read their envelopes 200 at a time
  // (one huge request can be cut off by Yahoo part-way through)
  const uids = (await client.search({ since: since }, { uid: true })) || [];
  const batches = [];
  for (let i = 0; i < uids.length; i += 200) batches.push(uids.slice(i, i + 200));
  const envelopes = async function* () {
    for (const b of batches) for await (const msg of client.fetch(b.join(","), { envelope: true, uid: true }, { uid: true })) yield msg;
  };
  for await (const msg of envelopes()) {
    counts.looked++;
    const env = msg.envelope || {};
    const from = (env.from && env.from[0]) || {};
    // only emails sent by a casting / extras agency (never Spotlight, shops, apps...)
    if (SURVEY && isFromCastingAgency(from.name, from.address, knownAgencies)) {
      const subj = String(env.subject || "").toLowerCase();
      const k = classifyEmail(env.subject || "", "") || "other";
      survey["all " + k] = (survey["all " + k] || 0) + 1;
      if (k === "other" && /book|confirm|update|selected|not required|pencil|check/.test(subj)) {
        const SAFE = new Set("a an the for on of to in at your you you're youre are is be been have has we our from and with re fw fwd booking booked book confirmed confirmation confirm update updated updates details detail info information availability available av check request new job work dates date day days tomorrow today next week call time sheet schedule shoot filming fitting costume selected not required needed final please reply urgent asap important change changes changed status thanks thank released release hold pencil pencilled extras extra sa supporting artist artists role tv film series feature commercial – - : | !".split(" "));
        const shapeTxt = subj.replace(/[0-9]+/g, "#").split(/\s+/).map(w => SAFE.has(w.replace(/[^a-z'#–:|!-]/g, "")) || /^#/.test(w) ? w.replace(/[^a-z'#–:|!-]/g, "") : "*").join(" ").replace(/(\* )+\*/g, "*");
        const t = "shape: " + shapeTxt; survey[t] = (survey[t] || 0) + 1;
      }
      SURVEY_WORDS.forEach(w => { if (subj.includes(w)) { const t = `"${w}"→${k}`; survey[t] = (survey[t] || 0) + 1; } });
      continue;
    }
    if (isFromCastingAgency(from.name, from.address, knownAgencies) || CALL_TIME_SUBJECT.test(env.subject || "")) {
      candidates.push({ uid: msg.uid, id: env.messageId || account.email + ":" + msg.uid });
    } else {
      counts.notACall++;
    }
  }

  // 2) download in full only the possible casting emails we haven't seen before
  //    (re-read mode: all of them, to be worked through in date order)
  for (const cand of candidates) {
    const key = emailKey(cand.id);
    if (!collect) { await loadSeenCache(); if (seenCache.has(key)) { counts.alreadySeen++; continue; } }
    const seenRef = db.collection("processed").doc(key);
    const seenDoc = await seenRef.get();
    if (seenDoc.exists) markSeen(key);
    if (seenDoc.exists && !collect) {
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
    const item = {
      key, seenRef, seen: seenDoc.exists ? seenDoc.data() : null, trash: folder.trash,
      subject: mail.subject || "", html: mail.html || "",
      text: mail.html ? htmlToText(mail.html) : (mail.text || ""),
      from: (mail.from && mail.from.value && mail.from.value[0]) || {},
      date: mail.date ? new Date(mail.date).getTime() : 0,
      pdfs: (mail.attachments || []).filter(a => /pdf/i.test(a.contentType || "") && (a.size || 0) < 4e6).slice(0, 3).map(a => ({ name: a.filename || "", content: a.content })),
      received: londonDate(mail.date), account,
    };
    if (collect) { if (!collect.some(x => x.key === key)) collect.push(item); }
    else await safeHandle(item, account, counts, false);
  }
}


// ---------- the robot's own report (shown in the app's header) + a daily summary ----------
async function pushNote(title, message) {
  if (!process.env.NTFY_TOPIC || REBUILD) return;
  try {
    await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: process.env.NTFY_TOPIC, title, message, tags: ["clipboard"], click: "https://cassiomariano.github.io/filming-schedule/" }) });
  } catch (e) { /* the summary is only a nice-to-have */ }
}
function londonHour() { return Number(new Date().toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false })); }
async function writeHealth(accountCounts, failed) {
  const ref = db.collection("meta").doc("health");
  const prev = (await ref.get()).data() || {};
  const today = londonDate();
  const sum = k => accountCounts.reduce((n, [, c]) => n + (c[k] || 0), 0);
  const added = sum("added"), updated = sum("updated"), errors = sum("errors") + (failed ? 1 : 0);
  const unmatched = Object.values(why).reduce((a, b) => a + b, 0);
  const rolled = prev.day && prev.day.date !== today;
  const base = prev.day && !rolled ? prev.day : { date: today, newCalls: 0, updates: 0, unmatched: 0, errors: 0 };
  const day = { date: today, newCalls: base.newCalls + added, updates: base.updates + updated, unmatched: base.unmatched + unmatched, errors: base.errors + errors };
  const out = {
    lastRun: new Date().toISOString(),
    lastNewCall: added ? new Date().toISOString() : (prev.lastNewCall || null),
    unmatched: day.unmatched, errors: day.errors,
    message: failed ? "An inbox couldn't be checked on the last run" : `Today: ${day.newCalls} new calls, ${day.updates} updates`,
    day, yesterday: rolled ? prev.day : (prev.yesterday || null),
    summaryDate: prev.summaryDate || "", backupDate: prev.backupDate || "",
  };
  // once a day after 08:00: yesterday in one phone message
  if (londonHour() >= 8 && out.summaryDate !== today && out.yesterday) {
    const y = out.yesterday;
    await pushNote("Filming Schedule – yesterday",
      `${y.newCalls} new availability check${y.newCalls === 1 ? "" : "s"}, ${y.updates} update${y.updates === 1 ? "" : "s"}` +
      (y.unmatched ? `, ${y.unmatched} email${y.unmatched === 1 ? "" : "s"} I couldn't match to a job` : "") +
      (y.errors ? `, ${y.errors} problem${y.errors === 1 ? "" : "s"} – open the app` : ". All good."));
    out.summaryDate = today;
  }
  await ref.set(out);
  return out;
}

// ---------- weekly backup (Sundays), sealed so only the robot can open it ----------
async function weeklyBackup(health) {
  const sunday = new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London", weekday: "short" }) === "Sun";
  const last = health && health.backupDate ? new Date(health.backupDate + "T12:00:00Z").getTime() : 0;
  if (!(process.env.BACKUP === "true" || (sunday && Date.now() - last > 6 * 864e5))) return;
  const snap = await db.collection("calls").get();
  const calls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const robotKey = crypto.createPublicKey(serviceAccount.private_key).export({ type: "spki", format: "pem" });
  const { seal } = require("./vault.js");
  require("fs").writeFileSync("backup.sealed.json", JSON.stringify(seal(robotKey, { at: new Date().toISOString(), calls })));
  await db.collection("meta").doc("health").set({ backupDate: londonDate() }, { merge: true });
  report("notice", "Backup", `Sealed backup of ${calls.length} jobs.`);
}

// ---------- call sheets: read the text of PDF attachments ----------
async function pdfText(pdfs) {
  let out = "";
  try {
    const parse = require("pdf-parse/lib/pdf-parse.js");
    for (const p of pdfs) {
      const r = await Promise.race([parse(p.content), new Promise((_, no) => setTimeout(() => no(new Error("slow")), 20000))]);
      out += "\n" + String(r.text || "").slice(0, 20000);
    }
  } catch (e) { stats.pdfFailed = (stats.pdfFailed || 0) + 1; }
  return out;
}
const SHEET_NAME = /call ?sheet|callsheet|schedule|movement|unit ?base|info/i;

// Booking emails and call sheets often give the exact place: put it on the booked job's days
// (fittings get the fitting address, shoot/rehearsal days the base address). Days that already
// have a place from a call sheet keep it.
async function addPlaces(callId, text) {
  if (!callId) return;
  const c = (existingCalls || []).find(x => x.id === callId);
  if (!c || c.status !== "confirmed") return;
  const p = findPlaces(text);
  const dates = (c.dates || []).map(e => ({ ...e }));
  let changed = false;
  dates.forEach(e => {
    const src = e.kind === "fit" ? p.fit : p.film;
    if (src.address && !e.callPlace) { e.callPlace = src.address; changed = true; }
    if (src.w3w && !e.w3w) { e.w3w = src.w3w; changed = true; }
    if (src.postcode && !e.postcode) { e.postcode = src.postcode; changed = true; }
  });
  if (!changed) return;
  const ch = withHistory(c, "Place from a booking email", { dates, updatedAt: new Date().toISOString() });
  await db.collection("calls").doc(c.id).update(ch);
  Object.assign(c, ch);
  stats.places = (stats.places || 0) + 1;
}

// one email that goes wrong must not stop the others (it's counted and skipped next time)
async function safeHandle(item, account, counts, rereading) {
  try { await handleMail(item, account, counts, rereading); }
  catch (e) {
    counts.errors = (counts.errors || 0) + 1;
    try { await item.seenRef.set({ at: new Date().toISOString(), call: null, error: String(e.code || e.name || "error") }); markSeen(item.key); } catch (_) {}
  }
}
// work out what one email means and update the schedule
async function handleMail(m, account, counts, rereading) {
  const { key, seenRef, subject, html, from, received } = m;
  let text = m.text;
  let kind = classifyEmail(subject, text, isFromCastingAgency(from.name, from.address, knownAgencies));
  // call sheets usually come as a PDF: read it for call-time and booking emails, or when it's named like one
  const pdfs = m.pdfs || [];
  if (pdfs.length && (kind === "calltime" || kind === "booked" || pdfs.some(p => SHEET_NAME.test(p.name)))) {
    const extra = await pdfText(pdfs);
    if (extra.trim()) { text = text + "\n\n" + extra; m.text = text; stats.pdfRead = (stats.pdfRead || 0) + 1; }
    if (!kind && pdfs.some(p => /call ?sheet|callsheet/i.test(p.name))) kind = "calltime";
  }
  if (!kind) {
    if (!m.seen) await seenRef.set({ at: new Date().toISOString(), call: null });
    markSeen(key);
    counts.notACall++;
    return;
  }
  if (m.seen && rereading) counts.alreadySeen++;
  const r = parseEmail({ subject, fromName: from.name, fromEmail: from.address, text, received });
  scopeAgency = r.agency || null;                      // look up only this agency's jobs
  if (kind !== "call") { await loadExistingCalls(); knownName(r, subject, text); }
  const remember = async id => {
    const callId = id || (m.seen && m.seen.call) || null;
    await seenRef.set({ at: new Date().toISOString(), call: callId, kind });
    markSeen(key);
    await logEmail(callId, { ...m, key }, kind);
  };

  // EP "You have booking updates": open the EP page it links to and see what changed
  if (kind === "epupdate") {
    epu.found++;
    const links = extractLinks(html).concat(allUrls(html));
    const url = portalLink({ links });
    let callId = null;
    if (url) {
      const before = portal.login;
      const page = await fetchPortalPage(url);
      if (portal.login > before) epu.login++;
      if (page) {
        epu.opened++;
        const ptext = htmlToText(page);
        [["been released", /(have|has) been released|you('| a)re released/i], ["released from", /released from/i], ["not required", /not (required|needed)/i],
         ["been booked", /(have|has) been booked|you('| a)re booked|booking (is )?confirmed/i], ["word booked", /\bbooked\b/i], ["word released", /\breleased?\b/i],
         ["status label", /status\s*:/i], ["pencil", /pencil/i], ["cancel", /cancel/i]].forEach(([k, re]) => { if (re.test(ptext)) miss("EP page says " + k); });
        const r2 = parseEmail({ subject: "", fromName: from.name, fromEmail: from.address, html: page, text: "", received });
        if (!r2.agency) r2.agency = r.agency;
        knownName(r2, "", ptext);
        // a booking is checked first; a release needs a clear sentence about YOU or the job
        const k2 = /(have|has) been booked|you('| a)re booked|booking (is )?confirmed|confirmed booking/i.test(ptext) ? "booked"
                 : /(you have|you've) been released|you('| a)re released|released you|you are not (required|needed)|not (required|needed) for (filming|this job|the shoot)|not been selected|stood down|(job|booking|filming|shoot) (has been )?cancel+ed/i.test(ptext) ? "released" : null;
        if (k2) {
          epu[k2]++;
          callId = await applyStatusEmail(k2, r2, subject, received, null, links, m.trash ? null : { ...m, key, html: page, text: ptext });
          if (callId) { epu.matched++; counts.updated++; }
        } else epu.unclear++;
        if (k2 && !callId) miss("EP update: page " + (r2.project ? "has a name" : "has no name") + ", " + r2.dates.length + " dates");
      }
    }
    await remember(callId);
    return;
  }

  // Call time / call sheet: add the time and place to that day of your booked job
  if (kind === "calltime") {
    stats.calltime[0]++;
    const ct = parseCallTime({ subject, text, received });
    if (!ct.time) miss("calltime: no time found");
    const callId = ct.time ? await applyCallTime(r, ct, subject) : null;
    if (callId) { counts.updated++; stats.calltime[1]++; }
    await remember(callId);
    return;
  }

  // The agency confirming your answer: mark the call Available or Declined
  if (kind === "replied") {
    stats.replied[0]++;
    const callId = await applyReply(r, extractLinks(html).concat(allUrls(html)), replyAnswer(subject, text), received);
    if (callId) { counts.updated++; stats.replied[1]++; }
    await remember(callId);
    return;
  }

  // A booking confirmation or a release: update the matching call
  if (kind === "booked" || kind === "released") {
    stats[kind][0]++;
    const links = extractLinks(html).concat(allUrls(html));
    const callId = await applyStatusEmail(kind, r, subject, received, null, links, m.trash ? null : { ...m, key });
    if (callId) { counts.updated++; stats[kind][1]++; }
    if (callId && kind === "booked") await addPlaces(callId, text);
    await remember(callId);
    return;
  }

  // An availability check
  await loadExistingCalls();
  if (m.seen) {
    // already handled before: just make sure the email is kept on its job
    const exists = m.seen.call && existingCalls.some(c => c.id === m.seen.call);
    if (exists) { await logEmail(m.seen.call, { ...m, key }, kind); return; }
    // re-read mode: a request missing from the app comes back only if its dates are still ahead
    if (m.trash || !r.dates.some(d => d.d >= londonDate())) return;
  } else if (m.trash) {                                // old requests you deleted: don't add them back
    await remember(null);
    return;
  }
  const call = buildCall(r, { ...m, account });
  await enrichFromPortal(call);                   // EP message page: real name, all dates, your answers
  // the same job again (reminder, extra dates, notes): amend the call you already have
  const twin = findTwin(call);
  if (twin) {
    const id = await amendCall(twin, call);
    counts.updated++;
    await remember(id);
    return;
  }
  if (m.seen) { call.review = true; call.reviewReason = "Found again while re-reading all your emails"; }
  const callId = "e" + key;
  call.emails = [emailRecord({ ...m, key }, "call")];
  await db.collection("calls").doc(callId).set(call);
  await remember(callId);
  addKnown({ id: callId, ...call });
  counts.added++;
  if (m.seen) stats.restored++;
  await notifyPhone(call);
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
    resetCalls();
    await loadExistingCalls();
    let reread = 0;
    for (const c of existingCalls) {
      if (!String(c.source || "").startsWith("email") || !["pending", "available"].includes(c.status)) continue;
      if ((c.dates || []).some(e => e.state || e.callTime)) continue;
      if ((c.emails || []).length > 1) continue;          // built from several emails: don't re-read from the first one only
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
    resetCalls();
    await loadExistingCalls();
    report("notice", "Re-read", `Re-read ${reread} calls with the improved reader.`);
    report("notice", "Clean-up", `Removed ${removed} emails that were not availability checks; ${repaired} booking/release emails applied to their calls; ${flagged} marked "check details" because you had booked them.`);
  }

  if (process.env.FIND) { await findEmails(process.env.FIND); process.exit(0); }

  // Private export: the whole schedule, sealed with the key in scripts/export-key.pem
  // (only its owner can open it). The workflow puts the sealed file on the "vault" branch.
  if (process.env.EXPORT === "true") {
    const { seal } = require("./vault.js");
    const snap = await db.collection("calls").get();
    const calls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // the robot's own public key, so fixes can be sealed for the robot only
    const robotKey = crypto.createPublicKey(serviceAccount.private_key).export({ type: "spki", format: "pem" });
    const box = seal(require("fs").readFileSync(__dirname + "/export-key.pem", "utf8"), { at: new Date().toISOString(), robotKey, calls });
    require("fs").writeFileSync("export.sealed.json", JSON.stringify(box));
    report("notice", "Export", `Sealed ${calls.length} calls.`);
    process.exit(0);
  }

  // Restore a weekly backup (chosen by hand in the workflow): puts every job back as it was then
  if (process.env.RESTORE) {
    const { open } = require("./vault.js");
    const data = open(serviceAccount.private_key, JSON.parse(require("fs").readFileSync("restore.sealed.json", "utf8")));
    let n = 0;
    for (const c of data.calls || []) { const { id, ...body } = c; await db.collection("calls").doc(id).set(body); n++; }
    report("notice", "Restore", `Put back ${n} jobs from the backup of ${String(data.at || "").slice(0, 10)}.`);
    process.exit(0);
  }

  // Private fixes: patch.sealed.json (sealed for the robot's key) lists changes to make
  if (process.env.PATCH === "true") {
    const { open } = require("./vault.js");
    const ops = open(serviceAccount.private_key, JSON.parse(require("fs").readFileSync("patch.sealed.json", "utf8")));
    const ALLOWED = new Set(["project", "agency", "role", "status", "dates", "location", "fitLocation", "filmLocation", "rate", "notes",
      "respondBy", "received", "review", "reviewReason", "newInfo", "newInfoText", "attention", "emails", "links", "answers", "agencyKey", "history", "source"]);
    const n = { update: 0, delete: 0, create: 0, skipped: 0 };
    for (const o of ops) {
      const ref = db.collection("calls").doc(String(o.id || ""));
      if (!o.id) { n.skipped++; continue; }
      if (o.op === "delete") { await ref.delete(); n.delete++; continue; }
      const body = {};
      Object.entries(o.set || o.data || {}).forEach(([k, v]) => { if (ALLOWED.has(k)) body[k] = v; });
      body.updatedAt = new Date().toISOString();
      if (o.op === "create") { await ref.set({ createdAt: body.updatedAt, source: "fix", ...body }); n.create++; }
      else if (o.op === "update") { if ((await ref.get()).exists) { await ref.update(body); n.update++; } else n.skipped++; }
      else n.skipped++;
    }
    report("notice", "Fixes", `Updated ${n.update}, created ${n.create}, deleted ${n.delete}, skipped ${n.skipped}.`);
    process.exit(0);
  }
  if (REBUILD || process.env.CLEANUP === "true") {
    report("notice", "Agencies", `${knownAgencies.length} known agency names.`);
    const n = await mergeDuplicates();
    const keyed = await backfillAgencyKeys();
    report("notice", "Agency keys", `Tagged ${keyed} jobs with their agency (for cheap look-ups).`);
    // remove far-away dates an older reader picked up from page footers (e.g. "Fri 18 Jun" next year)
    let odd = 0;
    const far = new Date(Date.now() + 210 * 864e5).toISOString().slice(0, 10);
    const near = (a, b) => Math.abs(new Date(a) - new Date(b)) <= 60 * 864e5;
    for (const c of existingCalls) {
      const ds = c.dates || [];
      // a lonely date more than 7 months away (no other day of the job near it, not worked, no call time)
      // impossible dates (before 2020, e.g. a time "11:30" read as a year) always go
      const keep = ds.filter(e => /^\d{4}-\d\d-\d\d$/.test(e.d || "") && e.d >= "2020-01-01" &&
        (e.d <= far || e.callTime || e.state === "worked" || ds.some(o => o !== e && near(o.d, e.d))));
      if (keep.length !== (c.dates || []).length) {
        odd += c.dates.length - keep.length;
        await db.collection("calls").doc(c.id).update({ dates: keep });
        c.dates = keep;
      }
    }
    report("notice", "Odd dates", `Removed ${odd} far-away dates picked up by mistake.`);
    report("notice", "Duplicates", `Merged ${n} duplicate copies into their jobs.`);
  }
  if (SURVEY) {
    for (const a of accounts) { try { await checkAccount(a); } catch (e) { report("warning", "Survey", "account skipped (" + (e.code || e.name) + ")"); } }
    const rows = Object.entries(survey).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v);
    for (let i = 0; i < rows.length; i += 25) report("notice", "Subject words " + (i / 25 + 1), rows.slice(i, i + 25).join(" · "));
    process.exit(0);
  }

  let failed = false;
  const accountCounts = [];
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
      accountCounts.push([i, c]);
      if (REBUILD) continue;                                // reported after the emails are handled
      report("notice", `Account ${i + 1}`, `Looked at ${c.looked} emails in ${c.folders} folders${c.skipped ? ` (${c.skipped} folders could not be opened)` : ""}: ${c.alreadySeen} already seen, ${c.notACall} not availability checks, ${c.added} new calls added, ${c.updated} calls updated (booked/released).`);
    } catch (err) {
      failed = true;
      // only the kind of error (the full message can contain the address)
      const why = err.authenticationFailed ? "Yahoo refused the login - check the email and app password secrets"
                : (err.code || err.name || "unknown error") + (err.responseText ? " - " + String(err.responseText).slice(0, 120) : "");
      report("error", `Account ${i + 1}`, "Could not check this inbox: " + why);
    }
  }
  if (REBUILD) {
    // oldest first across both inboxes: request → answer → booking → release → call time
    rebuildItems.sort((a, b) => a.date - b.date);
    for (const item of rebuildItems) await safeHandle(item, item.account, item.counts, true);
    for (const [i, c] of accountCounts) report("notice", `Account ${i + 1}`, `Looked at ${c.looked} emails in ${c.folders} folders: ${c.alreadySeen} already seen, ${c.notACall} not availability checks, ${c.added} new calls added, ${c.updated} calls updated${c.errors ? `, ${c.errors} emails skipped after an error` : ""}.`);
  }
  if (REBUILD) {
    resetCalls();
    await loadExistingCalls();
    const today = londonDate();
    const old = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const c of existingCalls) {
      if (c.status !== "pending" || !String(c.source || "").startsWith("email")) continue;
      const ds = c.dates || [];
      if (ds.length ? ds.every(e => e.d < today) : (c.received || today) < old) {
        await db.collection("calls").doc(c.id).update({ status: "expired", updatedAt: new Date().toISOString() });
        stats.expired = (stats.expired || 0) + 1;
      }
    }
  }
  if (Object.keys(why).length) report("notice", "Not matched – why", Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + " " + v).join(" · "));
  if (epu.found) report("notice", "EP booking updates", `${epu.found} emails; page opened ${epu.opened}, needed a login ${epu.login}; said booked ${epu.booked}, released ${epu.released}, unclear ${epu.unclear}; matched to a job ${epu.matched}.`);
  if (stats.places) report("notice", "Places", `Added exact places (address / postcode / what3words) to ${stats.places} booked jobs.`);
  if (stats.pdfRead || stats.pdfFailed) report("notice", "Call sheets", `Read ${stats.pdfRead || 0} PDF attachments` + (stats.pdfFailed ? `, ${stats.pdfFailed} couldn't be read` : "") + ".");
  if (REBUILD) report("notice", "Re-read everything", `Booking emails: ${stats.booked[0]} found, ${stats.booked[1]} matched to a job, ${stats.booked[2]} added as new booked jobs. ` +
    `Release emails: ${stats.released[0]} found, ${stats.released[1]} matched. Answer confirmations: ${stats.replied[0]} found, ${stats.replied[1]} matched. ` +
    `Call times: ${stats.calltime[0]} found, ${stats.calltime[1]} matched. Requests brought back: ${stats.restored}. Jobs amended by later emails (instead of a new copy): ${stats.amended}. Old requests never answered (now "Expired"): ${stats.expired || 0}.`);
  try { await saveSeenCache(); } catch (e) { /* only a speed-up */ }
  let health = null;
  try { health = await writeHealth(accountCounts, failed); } catch (e) { report("warning", "Health", "Couldn't write the robot report (" + (e.code || e.name) + ")."); }
  try { await weeklyBackup(health); } catch (e) { report("warning", "Backup", "Backup failed (" + (e.code || e.name) + ")."); }
  try { await refreshPendingPortalPages(); } catch (e) { report("warning", "EP pages", "Could not refresh EP pages (" + (e.code || e.name) + ")."); }
  if (portal.read + portal.failed + portal.login) {
    if (process.env.PORTAL_DEBUG) report("notice", "EP page check", `pages: ${portal.read}; with "recorded your response": ${portal.recorded}; with answer buttons: ${portal.radios}; with ticked answers: ${portal.ticked}; mostly script (built in the browser): ${portal.scripts}; with dates found: ${portal.dated}; answer shapes: ${Object.entries(shapes).map(([k, v]) => k + " " + v).join(", ") || "none"}`);
    report("notice", "EP pages", `Read ${portal.read} EP message pages, ${portal.answered} answers picked up` +
      (portal.failed ? `, ${portal.failed} could not be opened` : "") + (portal.login ? `, ${portal.login} asked for a login` : "") + ".");
  }
  process.exit(failed ? 1 : 0);
})();
