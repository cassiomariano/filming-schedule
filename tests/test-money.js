// Money tests: fees from the emails, reading remittances/invoices, and the checks. Made-up amounts and names.
const M = require("../money.js");
let failed = 0, passed = 0;
function ok(name, cond, detail) { if (cond) { passed++; console.log("✓ " + name); } else { failed++; console.log("✗ " + name + (detail ? "\n   " + JSON.stringify(detail) : "")); } }

// fees as the agencies write them
const f1 = M.feesFrom("Rate: PACT/FAA agreement\nFees: 10% commission plus VAT and Entertainment Partners admin fee of 10% plus VAT");
ok("EP agency fees: 10% commission + 10% EP admin fee + VAT", f1 && f1.agency === 10 && f1.ep === 10 && f1.plusVat, f1);
const f2 = M.feesFrom("Fees: 20% commission plus VAT");
ok("Extra People fees: 20% commission + VAT, no EP fee", f2 && f2.agency === 20 && f2.ep === 0 && f2.plusVat, f2);
const f3 = M.feesFrom("RATES:- Scotland rate: £240/day\n22% Agency Commission");
ok("'22% Agency Commission'", f3 && f3.agency === 22, f3);
ok("No fees written: unknown (not guessed)", M.feesFrom("Rate: PACT/FAA rates") === null);
const n1 = M.expectedNet(200, f1);
ok("£200 gross with 10% + 10% + VAT → £152 net", n1.net === 152 && n1.vat === 8, n1);

const jobs = [
  { id: "falcon", name: "Falcon(Project 12)", agency: "Extra People", worked: ["2026-10-07", "2026-10-08"] },
  { id: "kite", name: "Kite", agency: "Lucas Extras", worked: ["2026-10-12"] },
  { id: "wren", name: "Wren", agency: "Lucas Extras", worked: ["2026-10-14", "2026-10-15"] },
];

// 1) a remittance with a line per day
const r1 = M.readRemittance(`Entertainment Partners UK
Remittance Advice
Payment date: 16/10/2026
Production: Falcon   Agency: Extra People
Work date    Description        Amount
07/10/2026   Basic daily fee    £120.00
07/10/2026   Holiday pay        £14.48
08/10/2026   Basic daily fee    £120.00
08/10/2026   Holiday pay        £14.48
Gross pay                        £268.96
Agency commission (20%)          £53.79
VAT on commission                £10.76
Net payment                      £204.41`, jobs, "2026-10-20");
ok("Remittance: gross, commission, VAT, net read", r1.gross === 268.96 && r1.commission === 53.79 && r1.vat === 10.76 && r1.net === 204.41, r1);
ok("Remittance: paid on 16 Oct, pays 7 and 8 Oct", r1.paidOn === "2026-10-16" && r1.days.join() === "2026-10-07,2026-10-08", r1);
ok("Remittance: found the Falcon job by its days", r1.jobs.length === 1 && r1.jobs[0].id === "falcon", r1.jobs);
const c1 = M.checkPayment(r1, f2, jobs[0].worked, 120);
ok("Remittance: every check passes", c1.length >= 4 && c1.every(c => c.ok), c1);

// 2) EP fee + VAT on both, labels on their own line (pasted from a PDF table)
const r2 = M.readRemittance(`PAYMENT ADVICE
Kite – Lucas Extras
12 Oct 2026 Filming day 200.00
Gross
200.00
Commission
20.00
Admin fee
20.00
VAT
8.00
Total paid
152.00
Paid on 23 October 2026`, jobs, "2026-10-30");
ok("PDF-style table: amounts on the line under their label", r2.gross === 200 && r2.commission === 20 && r2.ep === 20 && r2.vat === 8 && r2.net === 152, r2);
ok("PDF-style table: job Kite, paid 23 Oct", r2.jobs[0] && r2.jobs[0].id === "kite" && r2.paidOn === "2026-10-23", r2);
ok("PDF-style table: checks pass with 10% + 10% + VAT", M.checkPayment(r2, f1, jobs[1].worked).every(c => c.ok));

// 3) the mistakes the checks must catch
const wrong = { gross: 200, commission: 30, ep: 20, vat: 10, net: 140, days: ["2026-10-14"] };
const c3 = M.checkPayment(wrong, f1, jobs[2].worked, 110);
ok("Catches a day not paid (15 Oct)", c3.some(c => !c.ok && /Not paid yet: 2026-10-15/.test(c.what)), c3);
ok("Catches 15% commission instead of 10%", c3.some(c => !c.ok && /commission is 15\.0%/.test(c.what)), c3);
const c4 = M.checkPayment({ gross: 200, commission: 20, ep: 20, vat: 8, net: 150, days: [] }, f1, null);
ok("Catches a total that doesn't add up", c4.some(c => !c.ok && /doesn't add up/.test(c.what)), c4);

// 4) one remittance paying two jobs
const r4 = M.readRemittance(`Remittance – Lucas Extras
12/10/2026 Kite 200.00
14/10/2026 Wren 150.00
15/10/2026 Wren 150.00
Total 500.00`, jobs, "2026-10-30");
ok("Two jobs in one remittance: split by their days", r4.jobs.length === 2 && r4.jobs.find(j => j.id === "wren").days.length === 2 && Math.abs(r4.jobs.find(j => j.id === "kite").share - 0.4) < 1e-9, r4.jobs);

// 5) an invoice you send (not a payment yet)
const r5 = M.readRemittance(`INVOICE 0042
To: Lucas Extras
Wren – 14/10/2026 and 15/10/2026
14/10/2026 Day rate 150.00
15/10/2026 Day rate 150.00
Total due 300.00`, jobs, "2026-10-30");
ok("Invoice is recognised as an invoice (not paid)", r5.kind === "invoice" && r5.net === 300 && r5.jobs[0].id === "wren", r5);

// 6) no dates: found by the production's name
const r6 = M.readRemittance(`Payment for Falcon (Extra People)\nNet amount paid: £204.41`, jobs, "2026-10-20");
ok("No dates: job found by name", r6.jobs.length === 1 && r6.jobs[0].id === "falcon" && r6.net === 204.41, r6);
ok("Dates are never read as money", M.readRemittance("07/10/2026 Basic 120.00", jobs, "x").items[0].amount === 120);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
