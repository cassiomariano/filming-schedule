// Replay tests: sequences of emails → the job the app must show.
// Each test is a mistake the old robot really made (names are made up; real emails stay private).
// Run with: npm test
const Core = require("../core.js");
let failed = 0, passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log("✓ " + name); }
  else { failed++; console.log("✗ " + name + (detail ? "\n   " + detail : "")); }
}
// an email as the robot would read it
function mail(key, at, subject, text, agency) {
  return Core.recordFromEmail({ key, at, subject, text: text || "", from: { name: agency || "Extra People", address: "noreply@extra-people.uk.epcastingportal.com" } });
}
// a job made from a list of records, as the robot files them
function index(jobs) {
  const idx = {};
  Object.entries(jobs).forEach(([id, j]) => {
    const d = Core.deriveJob(j, j.recs || []);
    idx[id] = Core.indexEntry({ ...d, project: j.base && j.base.project || d.project, agency: j.base && j.base.agency || d.agency, records: (j.recs || []).map(r => r.key),
      recordDates: (j.recs || []).map(r => r.at.slice(0, 10)), pageCodes: (j.recs || []).flatMap(r => r.pages || []), names: j.names || [] });
  });
  return idx;
}
const states = job => job.dates.map(e => e.d.slice(5) + ":" + (e.state || (e.answer === "no" ? "no" : job.status))).join(" ");
const typed = (project, agency, status, dates) => ({ base: { at: "2026-09-01T00:00:00Z", project, agency, status, dates } });

// 1) A release naming a production by its short name goes to THAT job, never to another job of the same agency on the same day
{
  const jobs = {
    falcon: typed("Falcon(Project 12)", "Extra People", "available", [{ d: "2026-10-05", kind: "fit" }, { d: "2026-10-07", kind: "film" }]),
    onsay: typed("On-Say", "Extra People", "available", [{ d: "2026-10-05", kind: "fit" }, { d: "2026-10-23", kind: "film" }]),
  };
  const r = mail("r1", "2026-10-02T14:00:00Z", "AVAILABILITY Updates on FALCON - Please View ASAP!",
    "Thank you for being available on Mon 5th October for FALCON - Costume Fitting.\nYOU HAVE BEEN RELEASED FOR COSTUME FITTING MONDAY 5TH OCT ONLY!\n*ALL OTHER AVAILABLE FILMING DATES STILL STAND!!!*");
  const m = Core.matchRecord(r, index(jobs));
  ok("Short name 'FALCON' finds 'Falcon(Project 12)', not On-Say", m.job === "falcon" && m.sure, JSON.stringify(m));
  const j = Core.deriveJob(jobs.falcon, [r]);
  ok("Only the released fitting day is greyed out", states(j) === "10-05:released 10-07:available", states(j));
}
// 2) A release for one production never lands on another production's job (Larkin 2 vs Roundabout)
{
  const jobs = {
    round: typed("EXP - Roundabout S2", "Extra People", "confirmed", [{ d: "2026-09-11", kind: "film" }]),
    larkin: typed("Larkin", "Extra People", "available", [{ d: "2026-09-11", kind: "film" }]),
  };
  const r = mail("r2", "2026-09-10T10:00:00Z", "Released on Larkin 2, please view ASAP", "Thank you for being available for Larkin 2 on 11 Sep 2026, unfortunately you were not selected this time.");
  const m = Core.matchRecord(r, index(jobs));
  ok("'Larkin 2' release goes to Larkin, not Roundabout", m.job === "larkin", JSON.stringify(m));
}
// 3) No production name and two jobs on that day: it waits in the Check list instead of guessing
{
  const jobs = {
    a: typed("Alpha", "Extra People", "available", [{ d: "2026-11-02", kind: "film" }]),
    b: typed("Bravo", "Extra People", "available", [{ d: "2026-11-02", kind: "film" }]),
  };
  const r = mail("r3", "2026-10-30T10:00:00Z", "Update", "You have been released from filming on Monday 2nd November.");
  const m = Core.matchRecord(r, index(jobs));
  ok("No name + two jobs on the day → Check list, not guessed", !m.sure && m.candidates.length === 2, JSON.stringify(m));
}
// 4) A release that arrives before its request is not lost: it matches once the request exists
{
  const rel = mail("r4b", "2026-10-01T09:00:00Z", "Release on KESTREL, please view ASAP", "You have been released. Thank you for being available for Kestrel on 12 Oct 2026.");
  const m1 = Core.matchRecord(rel, {});
  const call = mail("r4a", "2026-09-28T09:00:00Z", "New Availability request on KESTREL, please view ASAP", "You have an availability enquiry for:\nKestrel\nMon 12 Oct 2026\n(Filming)");
  const jobs = { k: { base: {}, recs: [call] } };
  const m2 = Core.matchRecord(rel, index(jobs));
  ok("Release before its request: not filed anywhere at first", !m1.job && !m1.sure, JSON.stringify(m1));
  ok("…and filed on the right job once the request is in", m2.job === "k" && m2.sure, JSON.stringify(m2));
  const j = Core.deriveJob({ base: {} }, [rel, call]);
  ok("…and the job ends released (time order, not reading order)", j.status === "released", states(j));
}
// 5) A new enquiry for days you were released from re-opens them (new role on the same days)
{
  const c1 = mail("r5a", "2026-09-25T10:00:00Z", "New Availability request on HERON", "You have an availability enquiry for:\nHeron\nWed 7 Oct 2026\n(Filming)\nThu 8 Oct 2026\n(Filming)");
  const rel = mail("r5b", "2026-09-30T10:00:00Z", "Released on Heron, please view ASAP", "You have been released. Thank you for being available for Heron, unfortunately you were not selected this time.");
  const c2 = mail("r5c", "2026-10-02T10:00:00Z", "EXCITING NEW ROLE on HERON", "You have an availability enquiry for:\nHeron\nWed 7 Oct 2026\n(Filming)\nThu 8 Oct 2026\n(Filming)");
  const ans = mail("r5d", "2026-10-02T12:00:00Z", "Thank you for letting us know that you are available for Heron", "Thank you for responding.");
  const j = Core.deriveJob({ base: {} }, [c1, rel, c2, ans]);
  ok("New role on released days: back on hold", states(j) === "10-07:available 10-08:available", states(j));
}
// 6) A booking and a release on the same day: the later one wins, whichever is read first
{
  const job = typed("Osprey", "Two 10 Casting", "available", [{ d: "2026-11-10", kind: "film" }]);
  const book = mail("r6a", "2026-11-05T09:00:00Z", "Booking Confirmation - Osprey", "You are booked for Tue 10 Nov 2026.", "Two 10 Casting");
  const rel = mail("r6b", "2026-11-05T17:00:00Z", "Osprey - You have been released", "Unfortunately the production no longer require you. You have been released.", "Two 10 Casting");
  const a = Core.deriveJob(job, [book, rel]), b = Core.deriveJob(job, [rel, book]);
  ok("Booking 09:00 then release 17:00 → released, in any reading order", a.status === "released" && b.status === "released", a.status + " / " + b.status);
}
// 7) Your own changes always win over emails
{
  const job = typed("Puffin", "Lucas Extras", "confirmed", [{ d: "2026-10-20", kind: "film" }, { d: "2026-10-21", kind: "film" }]);
  job.mine = { days: { "2026-10-21": { state: "canceled" } }, status: "confirmed" };
  const later = mail("r7", "2026-10-10T09:00:00Z", "Booking Confirmation - Puffin", "You are booked for Tue 20 Oct 2026 and Wed 21 Oct 2026.", "Lucas Extras");
  const j = Core.deriveJob(job, [later]);
  ok("A day you canceled stays canceled after a booking email", states(j) === "10-20:confirmed 10-21:canceled", states(j));
}
// 8) Placeholder names never join jobs ("TBC", "Commercial")
{
  const jobs = { t: typed("TBC", "Sabell Casting", "available", [{ d: "2026-10-12", kind: "film" }]) };
  const r = mail("r8", "2026-10-03T10:00:00Z", "Availability check - TBC", "Production: TBC\nShoot: Wed 21 Oct 2026", "Sabell Casting");
  const m = Core.matchRecord(r, index(jobs));
  ok("'TBC' is not a name: a new request makes a new job", m.job === null && m.sure, JSON.stringify(m));
}
// 9) A job name is never guessed from words in the body ("Home" vs "travel home safely")
{
  const jobs = { h: typed("Home", "Key Casting", "confirmed", [{ d: "2026-10-15", kind: "film" }]) };
  const r = mail("r9", "2026-10-14T10:00:00Z", "Call time for tomorrow", "Call time 07:00. Please travel home safely after wrap.", "Key Casting");
  const m = Core.matchRecord(r, index(jobs));
  ok("Body words are not names: no match by 'home'", m.how !== "name + agency", JSON.stringify(m));
}
// 10) Last year's job of a returning production doesn't get this year's request
{
  const jobs = { old: typed("Wren", "Extra People", "confirmed", [{ d: "2025-10-12", kind: "film" }]) };
  const r = mail("r10", "2026-10-01T10:00:00Z", "New Availability request on WREN", "You have an availability enquiry for:\nWren\nMon 19 Oct 2026\n(Filming)");
  const m = Core.matchRecord(r, index(jobs));
  ok("Wren 2025 job stays closed; Wren 2026 is a new job", m.job === null && m.sure, JSON.stringify(m));
}
// 11) An answer email that doesn't say yes or no changes nothing (the EP page decides)
{
  const job = { base: {} };
  const c = mail("r11a", "2026-10-01T10:00:00Z", "New Availability request on Gannet", "You have an availability enquiry for:\nGannet\nFri 16 Oct 2026\n(Filming)");
  const a = mail("r11b", "2026-10-01T12:00:00Z", "Thank you for responding", "Thank you for responding to our recent message. If you responded as Available, we will take your details to production.");
  const j = Core.deriveJob(job, [c, a]);
  ok("'Thank you for responding' alone: still waiting for your answer", j.status === "pending", states(j));
  const page = { ["p1"]: { url: "x", dates: [{ d: "2026-10-16", kind: "film", answer: "no" }], answer: "no" } };
  c.pages = ["p1"];
  const j2 = Core.deriveJob({ base: {}, pages: page }, [c, a]);
  ok("…the EP page tick 'Not available' makes it declined", j2.status === "declined", states(j2));
}
// 12) A saved job only changes with emails that arrive after it was saved
{
  const job = typed("Kite", "Extra People", "available", [{ d: "2026-10-30", kind: "film", state: "available" }]);
  job.base.at = "2026-10-03T23:59:59Z";
  const old = mail("r12a", "2026-09-20T10:00:00Z", "Released on Kite, please view ASAP", "You have been released.");
  const j = Core.deriveJob(job, [old]);
  ok("An old email already accounted for doesn't change the saved job", states(j) === "10-30:available" && j.emails.length === 1, states(j));
  const late = mail("r12b", "2026-09-20T10:00:00Z", "Released on Kite, please view ASAP", "You have been released.");
  late.seen = "2026-10-04T08:00:00Z";
  const j2 = Core.deriveJob(job, [late]);
  ok("…but an email first seen after it (even if dated earlier) does", j2.status === "released", states(j2));
}
// 12b) An email the robot had missed, found later: applied only if newer than everything the saved job knew
{
  const job = typed("Lark", "Extra People", "available", [{ d: "2026-10-07", kind: "film", state: "released" }, { d: "2026-10-08", kind: "film" }]);
  job.base.at = "2026-10-03T12:00:00Z";
  const known = mail("r12c", "2026-10-02T10:00:00Z", "Released on Lark, please view ASAP", "Not required for filming on Wed 7th October.");
  const oldReminder = mail("r12d", "2026-09-28T10:00:00Z", "New Availability request on LARK", "You have an availability enquiry for:\nLark\nWed 7 Oct 2026\n(Filming)");
  oldReminder.seen = "2026-10-03T13:00:00Z";
  const j = Core.deriveJob(job, [known, oldReminder]);
  ok("A missed OLDER email doesn't undo newer news (released day stays released)", states(j) === "10-07:released 10-08:available" && (j.lateEmails || []).length === 1, states(j));
  const newer = mail("r12e", "2026-10-03T11:00:00Z", "Booking Confirmation - Lark", "You are booked for Thu 8 Oct 2026.");
  newer.seen = "2026-10-03T13:00:00Z";
  const j2 = Core.deriveJob(job, [known, newer]);
  ok("…while a missed NEWER email is applied", j2.status === "confirmed", states(j2));
}
// 13) Two roles of one production from the same agency: the email with the full name goes to its role's job
{
  const jobs = { a: typed("Dept X 2 - Brunch Eaters", "BBB Talent", "available", [{ d: "2026-09-01", kind: "film" }]),
                 b: typed("Dept X 2 - New Detectives", "BBB Talent", "available", [{ d: "2026-09-01", kind: "film" }]) };
  const r = mail("r13", "2026-08-31T10:00:00Z", "BBB Release Notification - Dept X 2 - New Detectives", "Unfortunately you have not been selected.", "BBB Talent");
  const m = Core.matchRecord(r, index(jobs));
  ok("Role named in full picks that role's job", m.job === "b" && m.sure, JSON.stringify(m));
}
// 14) A booking that matches no job is never dropped (Check list)
{
  const jobs = { n: typed("Nightjar", "Lucas Extras", "available", [{ d: "2026-05-19", kind: "film" }]) };
  const r = mail("r14", "2026-05-15T10:00:00Z", "Booking Confirmation: Tuesday 19th May – Hull Night Shoot", "You are booked.", "Lucas Extras");
  const m = Core.matchRecord(r, index(jobs));
  ok("Unplaced booking → Check list with the likely job offered", !m.sure && m.candidates.indexOf("n") !== -1, JSON.stringify(m));
}
// 15) Same input, same output (no hidden state)
{
  const c = mail("r15", "2026-10-01T10:00:00Z", "New Availability request on Ibis", "You have an availability enquiry for:\nIbis\nFri 16 Oct 2026\n(Fitting)");
  ok("Deriving twice gives exactly the same job", JSON.stringify(Core.deriveJob({ base: {} }, [c])) === JSON.stringify(Core.deriveJob({ base: {} }, [c])));
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
