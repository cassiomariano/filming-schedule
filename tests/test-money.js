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

// 7) Entertainment Partners remittance PDFs (real layout, made-up names and numbers): two in one go
const ep = M.readPayments(require("fs").readFileSync(__dirname + "/fixtures/ep-remittances.txt", "utf8"),
  [{ id: "k1", name: "Kestrel One", agency: "Test Casting", worked: ["2025-03-17"] }, { id: "k0", name: "Kestrel One", agency: "Test Casting", worked: ["2025-02-25"] }], "2026-10-03");
ok("EP PDFs: two remittances found", ep.length === 2, ep.length);
const a = ep[0];
ok("EP PDF: project, agency, invoice, hours", a.project === "KESTREL ONE" && a.agency === "Test Casting" && a.invoiceNo === "100001" && a.hours === 14.65, a);
ok("EP PDF: gross 388.46, admin fee 38.84 + VAT 7.77, commission 38.84 + VAT 7.77, deposited 295.24",
  a.gross === 388.46 && a.ep === 38.84 && a.epVat === 7.77 && a.commission === 38.84 && a.commissionVat === 7.77 && a.vat === 15.54 && a.net === 295.24, a);
ok("EP PDF: the day's parts (B/M, Travel, E/C, O/T, H/C, Basic)", JSON.stringify(a.perDay[0].parts) === JSON.stringify({ "B/M": 22.28, Travel: 35.85, "E/C": 100.2, "O/T": 111.4, "H/C": 11.54, Basic: 107.19 }) && a.perDay[0].d === "2025-03-17", a.perDay);
ok("EP PDF: second one has only Travel, H/C, Basic", JSON.stringify(ep[1].perDay[0].parts) === JSON.stringify({ Travel: 21.55, "H/C": 5.77, Basic: 53.6 }) && ep[1].net === 61.5, ep[1].perDay);
ok("EP PDF: each found its job by the day", a.job === "k1" && ep[1].job === "k0", [a.job, ep[1].job]);
ok("EP PDF: every check passes with 10% + 10% + VAT", M.checkPayment(a, f1, ["2025-03-17"]).every(c => c.ok), M.checkPayment(a, f1, ["2025-03-17"]));
ok("EP PDF: no National Insurance number is ever kept", M.redact("NI Number QQ123456C").indexOf("QQ123456C") === -1);

// 8) the table on the EP payments page, copied (tabs between cells)
const tab = "Project Name\tStatus\tRemittance Advice\tDeposit Date\tDays Worked\tGross\tFees\tVAT\tDeposited\nKESTREL ONE\tPaid\tDownload PDF\t15 April 2025\t17 Mar 2025\t388.46\t-77.68\t-15.54\t295.24\nKESTREL ONE\tPaid\tDownload PDF\t25 March 2025\t25 Feb 2025\t80.92\t-16.18\t-3.24\t61.5\nRows: 2";
const rows = M.readPayments(tab, [], "2026-10-03");
ok("Payments page: two rows with deposit date, day worked and amounts", rows.length === 2 && rows[0].paidOn === "2025-04-15" && rows[0].days.join() === "2025-03-17" && rows[0].fees === 77.68 && rows[0].vat === 15.54 && rows[1].net === 61.5, rows);
ok("Payments page: fees 20% and VAT checked", M.checkPayment(rows[0], f1, ["2025-03-17"]).every(c => c.ok));
const same = M.samePayment(rows[0], a), merged = M.mergePayment(a, rows[0]);
ok("The PDF and its row are the same payment; together they keep the breakdown AND the deposit date", same && merged.paidOn === "2025-04-15" && merged.perDay.length === 1 && merged.invoiceNo === "100001", merged);
const rowsCells = M.readPayments(tab.replace(/\t/g, "\n"), [], "x");
ok("Payments page copied one cell per line also works", rowsCells.length === 2 && rowsCells[1].paidOn === "2025-03-25", rowsCells);

// 9) seen on real remittances (made-up names): no commission on a meal; other payments' days; agency must match
const f20 = { agency: 20, ep: 0, vat: 20, plusVat: true, from: "agency" };
const meal = { gross: 189.58, commission: 34.91, ep: null, vat: 6.98, net: 147.69, days: ["2025-04-03"],
  perDay: [{ d: "2025-04-03", parts: { Meal: 15, Travel: 22.54, "S/F": 22.17, Overtime: 11.14, "Holiday Pay": 11.54, "Basic Fee": 107.19 }, total: 189.58 }] };
const cm = M.checkPayment(meal, f20, ["2025-04-03"]);
ok("No commission on the £15 meal: 20% of the rest passes", cm.every(c => c.ok) && cm.some(c => /none on the £15\.00 expenses/.test(c.what)), cm);
ok("A real 18% commission is still caught", M.checkPayment({ ...meal, commission: 30.00, vat: 6.00, net: 153.58 }, f20, ["2025-04-03"]).some(c => !c.ok && /commission/.test(c.what)));
const two = M.checkPayment({ gross: 100, commission: 20, ep: null, vat: 4, net: 76, days: ["2026-08-14"] }, f20, ["2026-08-14", "2026-08-28", "2026-09-07"], null, ["2026-08-28"]);
ok("Days paid by the job's other payment aren't 'not paid yet'", two.some(c => !c.ok && c.what === "Not paid yet: 2026-09-07"), two);
const agJobs = [{ id: "cc", name: "Gannet", agency: "Casting Collective", worked: ["2025-07-10"] }];
ok("A payment from another agency never goes to that job", M.readPayments("Payment for Gannet\nNet amount paid: £50.00", agJobs, "x")[0].job === "cc" &&
  M.sameAgency("Extra People", "Casting Collective") === false && M.sameAgency("Extra People", "Extra People Ltd") && M.sameAgency("", "Casting Collective"));

const wrongAg = M.readPayments(require("fs").readFileSync(__dirname + "/fixtures/ep-remittances.txt", "utf8"), [{ id: "o", name: "Kestrel One", agency: "Other Agency", worked: ["2025-03-17"] }], "x");
ok("Same name and day but another agency: not matched (added as a new job instead)", wrongAg.every(p => p.job === null), wrongAg.map(p => p.job));
// 10) Casting Collective and Talent Talks remittances, printed from their websites (real layout, made-up names and amounts)
const [ccText, ttText] = require("fs").readFileSync(__dirname + "/fixtures/agency-remittances.txt", "utf8").split("=====");
const cc = M.readPayments(ccText, [{ id: "os", name: "Osprey", agency: "Casting Collective", worked: ["2025-10-15", "2025-10-16"] }], "x");
ok("Casting Collective: one payment, its two days, paid on the remittance date", cc.length === 1 && cc[0].days.join() === "2025-10-15,2025-10-16" && cc[0].paidOn === "2025-11-12" && cc[0].invoiceNo === "R100001", cc);
ok("Casting Collective: gross 500, commission 100, VAT 20, NI 0, net 380, job found", cc[0].gross === 500 && cc[0].commission === 100 && cc[0].vat === 20 && cc[0].ni === 0 && cc[0].net === 380 && cc[0].job === "os" && cc[0].agency === "Casting Collective", cc[0]);
ok("Casting Collective: every check passes with 20% + VAT (no breakdown warnings)", M.checkPayment(cc[0], f20, ["2025-10-15", "2025-10-16"]).every(c => c.ok), M.checkPayment(cc[0], f20, ["2025-10-15", "2025-10-16"]));
ok("Casting Collective: NI taken off is part of the sum", M.checkPayment({ ...cc[0], ni: 10, net: 370 }, f20, null).some(c => c.ok && /sum is right/.test(c.what)));
const tt = M.readPayments(ttText, [{ id: "he", name: "Heron", agency: "Talent Talks", worked: ["2026-05-28"] }], "x");
ok("Talent Talks: project, day, remittance no and date", tt.length === 1 && tt[0].project === "Heron (Crowd)" && tt[0].days.join() === "2026-05-28" && tt[0].invoiceNo === "Heron1234" && tt[0].paidOn === "2026-07-17", tt);
ok("Talent Talks: subtotal 120, commission 15 (12.5%), VAT 3, paid 102, job found", tt[0].gross === 120 && tt[0].commission === 15 && tt[0].vat === 3 && tt[0].net === 102 && tt[0].job === "he" && tt[0].feesSaid.agency === 12.5, tt[0]);
const ttc = M.checkPayment(tt[0], null, ["2026-05-28"]);
ok("Talent Talks: checked against the 12.5% written on it when the emails don't say", ttc.every(c => c.ok) && ttc.some(c => /commission is 12\.5%/.test(c.what)), ttc);
ok("No name from the remittance is kept", JSON.stringify(cc.concat(tt)).indexOf("Test Person") === -1);

ok("A payment from an agency never goes to a job with no agency", M.readPayments(require("fs").readFileSync(__dirname + "/fixtures/ep-remittances.txt", "utf8"), [{ id: "n", name: "Other work", agency: "", worked: ["2025-03-17", "2025-02-25"] }], "x").every(p => p.job === null));
ok("Any remittance pasted as text: 'Total Due' before deductions is the gross, 'Net Payment' the net", (() => { const r = M.readRemittance(ccText, [], "x"); return r.gross === 500 && r.commission === 100 && r.vat === 20 && r.net === 380; })(), M.readRemittance(ccText, [], "x"));
const ttX = M.readPayments(ttText.replace(/(\s+Total Paid\s+)£102\.00/, "\n     Travel Expenses        £20.00$1£122.00"), [], "x")[0];
ok("Talent Talks: expenses paid on top (no commission) are found by the sum and kept", ttX.net === 122 && ttX.extras && ttX.extras[0].amount === 20 && M.checkPayment(ttX, null, ttX.days).every(c => c.ok), ttX);
const pasted = M.readPayments("Remittance\nSubtotal: £130.00\nCommission 12.5%: -£16.25\nVAT on commission: -£3.25\nTravel expenses: £20.00\nTotal Paid: £130.50", [], "x")[0];
ok("Pasted text: an extra amount is used only when it explains the sum (travel £20 added)", pasted.net === 130.5 && pasted.extras && pasted.extras[0].amount === 20 && M.checkPayment(pasted, null, null).every(c => c.ok), pasted);
// 11) Nightfall-style EP remittance: 10% + 10% on Basic + O/T, none on "Exp." (made-up figures)
const exp = { gross: 400.00, commission: 38.00, ep: 38.00, vat: 15.20, net: 308.80, days: ["2026-05-19"], perDay: [{ d: "2026-05-19", parts: { Basic: 200, "O/T": 180, "Exp.": 20 }, total: 400 }] };
ok("EP: no commission or admin fee on expenses ('Exp.')", M.checkPayment(exp, f1, ["2026-05-19"]).every(c => c.ok), M.checkPayment(exp, f1, ["2026-05-19"]));
ok("EP names Two 10 Casting 'Another 210 Production': the same agency", M.sameAgency("Another 210 Production", "Two 10 Casting") && !M.sameAgency("Another 210 Production", "Casting Collective"));
const partial = M.checkPayment({ gross: 100, commission: 20, ep: null, vat: 4, net: 76, days: ["2026-01-01"], perDay: [{ d: "2026-01-01", parts: { Basic: 80 }, total: 100 }] }, f20, null);
ok("A breakdown read only in part is a note, not an alert", partial.every(c => c.ok) && partial.some(c => c.note), partial);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
