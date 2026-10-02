// Run with:  node tests/test-parser.js
// Checks the email reader against copies of real availability emails.
const fs = require("fs");
const path = require("path");
const { parseEmail, isAvailabilityCheck, isFromCastingAgency, classifyEmail, replyAnswer, parseCallTime } = require("../parser.js");

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "emails.json"), "utf8"));
let failed = 0;

for (const c of cases) {
  // the robot needs both: sent by a casting agency, and reads like an availability check
  const body = c.email.text || require("../parser.js").htmlToText(c.email.html || "");
  const isCall = isFromCastingAgency(c.email.fromName, c.email.fromEmail, ["Casting Collective"]) && isAvailabilityCheck(c.email.subject, body);
  if (isCall !== c.expect.isCall) {
    console.log(`✗ ${c.name}: isCall should be ${c.expect.isCall}`);
    failed++;
    continue;
  }
  // optional: what kind of email the robot thinks it is ("call", "released", null...)
  if (c.expect.kind !== undefined) {
    const kind = classifyEmail(c.email.subject, body, true);
    if (kind !== c.expect.kind) { console.log(`✗ ${c.name}: kind should be ${c.expect.kind}, got ${kind}`); failed++; continue; }
  }
  if (!isCall) { console.log(`✓ ${c.name} (ignored, not a call)`); continue; }

  const got = parseEmail(c.email);
  const problems = [];
  for (const k of ["project", "agency", "role", "respondBy"]) {
    if (c.expect[k] !== undefined && got[k] !== c.expect[k]) problems.push(`${k}: got "${got[k]}", want "${c.expect[k]}"`);
  }
  if (c.expect.dates) {
    const g = got.dates.map(d => `${d.d} ${d.kind}${d.night ? " night" : ""}`).join(", ");
    const w = c.expect.dates.join(", ");
    if (g !== w) problems.push(`dates: got [${g}], want [${w}]`);
  }
  if (problems.length) { failed++; console.log(`✗ ${c.name}\n   ` + problems.join("\n   ")); }
  else console.log(`✓ ${c.name}  →  ${got.project} | ${got.agency} | ${got.role} | ${got.dates.map(d => d.d.slice(5) + (d.kind==="fit"?"F":d.kind==="reh"?"R":"S")).join(" ")}${c.expect.kind ? " | " + c.expect.kind : ""}`);
}

// ---------- what kind of email is it? ----------
console.log("\nclassifyEmail");
const kinds = [
  { subject: "Supporting artists needed - Wed 14 Oct", text: "A costume fitting is not required for this role. Please let me know if you are free.", fromAgency: true, kind: "call" },
  { subject: "SAs wanted - Thu 15 Oct", text: "You won't need a fitting. Let me know.", fromAgency: true, kind: "call" },
  { subject: "Booking Confirmation - Falcon - call time to follow", text: "", fromAgency: true, kind: "booked" },
  { subject: "URGENT - are you free for filming tomorrow?", text: "", fromAgency: true, kind: "call" },
  { subject: "Please confirm your dates - AV check", text: "", fromAgency: true, kind: "call" },
  { subject: "Possible booking - Falcon - Wed 14 Oct", text: "", fromAgency: true, kind: "call" },
  { subject: "Pencil booking for Fri 16 Oct", text: "", fromAgency: true, kind: "call" },
  { subject: "Thanksgiving scenes - extras needed Thu 26 Nov", text: "Let me know if you are free.", fromAgency: true, kind: "call" },
  { subject: "Thank you", text: "Extras needed, let me know if free on Thu 26 Nov.", fromAgency: true, kind: null },
  { subject: "Extras needed", text: "Hours 9.30 - 5.30, let me know.", fromAgency: true, kind: null },
  { subject: "New photos needed", text: "Please send new headshots by 30th November, let me know.", fromAgency: true, kind: null },
  { subject: "Availability check - Falcon", text: "Sorry, you have not been selected this time.", fromAgency: true, kind: "released" },
  { subject: "Availability check - Falcon", text: "If you have not been selected you will not hear from us.", fromAgency: true, kind: "call" },
  { subject: "Your call time for tomorrow", text: "Call 0700", fromAgency: true, kind: "calltime" },
];
for (const k of kinds) {
  const got = classifyEmail(k.subject, k.text, k.fromAgency);
  if (got !== k.kind) { failed++; console.log(`✗ "${k.subject}": got ${got}, want ${k.kind}`); }
  else console.log(`✓ "${k.subject}"  →  ${got}`);
}

// ---------- in a reply email: did you say available or not? ----------
console.log("\nreplyAnswer");
const answers = [
  { subject: "Thank you for your response", text: "Sorry you can't make it this time.", answer: "declined" },
  { subject: "Your reply", text: "We understand you are unable to attend.", answer: "declined" },
  { subject: "Your reply", text: "Your response: Not available", answer: "declined" },
  { subject: "Response received", text: "You have responded Not Available to Falcon.", answer: "declined" },
  { subject: "Your reply", text: "We see you're not free on these dates.", answer: "declined" },
  { subject: "Your answers", text: "14 Oct 2026 ☐ Available ☒ Not available", answer: "declined" },
  { subject: "Thank you for your response", text: "Great, you are available. If you are not available any more, let us know.", answer: "available" },
];
for (const a of answers) {
  const got = replyAnswer(a.subject, a.text);
  if (got !== a.answer) { failed++; console.log(`✗ "${a.text}": got ${got}, want ${a.answer}`); }
  else console.log(`✓ "${a.text}"  →  ${got}`);
}

// ---------- call times ----------
console.log("\nparseCallTime");
const callTimes = [
  { email: { subject: "Call time - Falcon - Wed 14 Oct", text: "Unit call 06:00\nSA call 07:30 at Unit Base, Brixton SW2 1AA\nQuestions? call 020 8123 4567", received: "2026-10-10" }, time: "07:30" },
  { email: { subject: "Call details", text: "Please call 020 8123 4567 if you are running late.\nArrive 08:15 at base", received: "2026-10-10" }, time: "08:15" },
];
for (const t of callTimes) {
  const got = parseCallTime(t.email).time;
  if (got !== t.time) { failed++; console.log(`✗ "${t.email.subject}": got "${got}", want "${t.time}"`); }
  else console.log(`✓ "${t.email.subject}"  →  ${got}`);
}

// ---------- details on each day (place, night, on hold) and the "check this" note ----------
console.log("\ndate details");
function firstDay(text, received) { return parseEmail({ subject: "Availability check", fromName: "Universal Extras", text, received }); }
const details = [
  { name: "a sentence after @ is not a place", ok: () => !firstDay("Project: Crow\nFri 25 Sep @ 13:00 will not be considered, so if you are reading this after", "2026-09-20").dates[0].loc },
  { name: "a real place after @", ok: () => firstDay("Project: Crow\nShoot: Mon 2nd November @ Olympic House, SW13 9HL", "2026-10-01").dates[0].loc === "Olympic House, SW13 9HL" },
  { name: "\"fortnight\" and \"no nights\" are not night shoots", ok: () => !firstDay("Project: Crow\nShoot: Wed 14 Oct - no nights, a fortnight job", "2026-10-01").dates[0].night },
  { name: "\"night shoot\" is a night", ok: () => firstDay("Project: Crow\nShoot: Wed 14 Oct - night shoot", "2026-10-01").dates[0].night === true },
  { name: "\"dates TBC\" is on hold", ok: () => firstDay("Project: Crow\nWed 14 Oct (dates TBC)", "2026-10-01").dates[0].hold === true },
  { name: "\"times TBC\" is not on hold", ok: () => !firstDay("Project: Crow\nWed 14 Oct - times TBC", "2026-10-01").dates[0].hold },
  { name: "w/c date asks you to check", ok: () => { const c = firstDay("Project: Crow\nShoot w/c 9th Nov", "2026-10-01"); return c.dates[0].d === "2026-11-09" && c.review && /week commencing/.test(c.reviewReason); } },
  { name: "a weekday no year can fix asks you to check", ok: () => { const c = firstDay("Project: Crow\nShoot: Thu 14 Oct", "2026-10-01"); return c.review && /weekday/.test(c.reviewReason); } },
];
for (const d of details) {
  if (!d.ok()) { failed++; console.log(`✗ ${d.name}`); }
  else console.log(`✓ ${d.name}`);
}

// ---------- exact places (call sheets / booking emails) ----------
{
  const { findPlaces } = require("../parser.js");
  const sheet = "CALL SHEET\nSA Call: 06:30\nSA Base: Leavesden Studios, Gate 3\nSouth Way, Leavesden\nWD25 7LT\n///filled.count.soap\nCrew Parking: Car park B\nFitting Address: Angels Costumes, 1 Garrick Road, London NW9 6AA (w3w: tables.chair.lamp)";
  const p = findPlaces(sheet);
  const checks = [
    ["film address", p.film.address, "Leavesden Studios, Gate 3, South Way, Leavesden, WD25 7LT"],
    ["film postcode", p.film.postcode, "WD25 7LT"],
    ["film w3w", p.film.w3w, "filled.count.soap"],
    ["fit address", p.fit.address, "Angels Costumes, 1 Garrick Road, London NW9 6AA"],
    ["fit w3w", p.fit.w3w, "tables.chair.lamp"],
    ["TBC is not a place", findPlaces("Location: TBC").film.address, ""],
  ];
  let bad = 0;
  checks.forEach(([n, got, want]) => { if (got !== want) { bad++; console.log(`✗ places ${n}: got "${got}", want "${want}"`); } else console.log(`✓ places ${n}`); });
  failed += bad;
}
console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
