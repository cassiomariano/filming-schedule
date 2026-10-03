// Replay of your REAL emails (sealed in tests/real.sealed.json; only the robot's key opens it).
// It checks that the rules still give the same result on every job and every email as when this
// snapshot was approved. It prints counts only — never names or email contents (logs are public).
const fs = require("fs");
const Core = require("../core.js");
const { open } = require("../scripts/vault.js");
let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || "").replace(/[“”„‟″]/g, '"').replace(/[‘’]/g, "'");
if (!raw.trim()) { console.log("No robot key here: real-email replay skipped."); process.exit(0); }
const key = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)).private_key;
const data = open(key, JSON.parse(fs.readFileSync(__dirname + "/real.sealed.json", "utf8")));
const recs = new Map(data.records.map(r => [r.key, r]));
let jobsBad = 0, matchBad = 0;
const index = {};
data.jobs.forEach(j => {
  const d = Core.deriveJob(j, j.records.map(k => recs.get(k)));
  const got = JSON.stringify([d.status, d.dates]);
  if (got !== JSON.stringify(data.expected.jobs[j.id])) jobsBad++;
  index[j.id] = Core.indexEntry({ ...d, names: j.names, records: j.records, recordDates: j.records.map(k => String(recs.get(k).at).slice(0, 10)), pageCodes: j.records.flatMap(k => recs.get(k).pages || []) });
});
data.records.forEach(r => {
  const m = Core.matchRecord(r, index);
  const got = m.job && m.sure ? "job:" + m.job : (!m.job && m.sure ? "new" : "check");
  if (got !== data.expected.match[r.key]) matchBad++;
});
console.log(`Real-email replay: ${data.jobs.length} jobs, ${data.records.length} emails · jobs that changed: ${jobsBad} · emails filed differently: ${matchBad}`);
if (jobsBad || matchBad) { console.log("✗ The rules now give a different result on your real emails — check the change before it goes live."); process.exit(1); }
console.log("✓ Same result on every real job and email");
