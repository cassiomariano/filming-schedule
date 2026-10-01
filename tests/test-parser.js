// Run with:  node tests/test-parser.js
// Checks the email reader against copies of real availability emails.
const fs = require("fs");
const path = require("path");
const { parseEmail, isAvailabilityCheck, isFromCastingAgency } = require("../parser.js");

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "emails.json"), "utf8"));
let failed = 0;

for (const c of cases) {
  // the robot needs both: sent by a casting agency, and reads like an availability check
  const isCall = isFromCastingAgency(c.email.fromName, c.email.fromEmail, ["Casting Collective"]) && isAvailabilityCheck(c.email.subject, c.email.text);
  if (isCall !== c.expect.isCall) {
    console.log(`✗ ${c.name}: isCall should be ${c.expect.isCall}`);
    failed++;
    continue;
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
  else console.log(`✓ ${c.name}  →  ${got.project} | ${got.agency} | ${got.role} | ${got.dates.map(d => d.d.slice(5) + (d.kind==="fit"?"F":"S")).join(" ")}`);
}
console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
