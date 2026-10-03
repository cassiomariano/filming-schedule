/*
 * money.js — the app's money rules (no database code, so they can be tested).
 *
 *   feesFrom(text)                   "Fees: 10% commission plus VAT and Entertainment Partners admin fee of 10% plus VAT"
 *                                     → { agency: 10, ep: 10, vat: 20 }
 *   expectedNet(gross, fees)         what should reach your bank: gross − commission − EP fee − VAT on both
 *   readRemittance(text, jobs)       a pasted remittance / invoice → amounts, the days it pays, and which job(s)
 *   checkPayment(payment, fees, ...) is it right? days, commission, VAT, EP fee, the sum
 *
 * Used by the app (index.html) and the tests (tests/test-money.js).
 */
(function (root) {
  "use strict";
  var VAT = 20;
  var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function r2(n) { return Math.round(n * 100) / 100; }

  // ---------- fees stated in the job's emails / call sheet ----------
  function feesFrom(text) {
    var t = String(text || "");
    var out = { agency: null, ep: null, vat: VAT, plusVat: true };
    var m = t.match(/(\d+(?:\.\d+)?)\s*%\s*(?:agency\s*)?(?:commission|com\b|agency (?:com|fee))/i) || t.match(/commission(?: of| at| is)?\s*:?\s*(\d+(?:\.\d+)?)\s*%/i);
    if (m) out.agency = Number(m[1]);
    var e = t.match(/(?:entertainment partners?'?s?|\bEP\b)'?s?\s*admin(?:istration)?\s*fee\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*%/i) || t.match(/admin(?:istration)?\s*fee\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*%/i);
    if (e) out.ep = Number(e[1]);
    if (out.agency === null && out.ep === null) return null;
    if (out.ep === null) out.ep = 0;
    if (out.agency === null) out.agency = 0;
    out.plusVat = /plus vat|\+\s*vat/i.test(t);
    return out;
  }
  // the deductions on a gross amount, and what's left
  function expectedNet(gross, fees) {
    if (gross === null || gross === undefined) return null;
    if (!fees) return { gross: r2(gross), commission: null, ep: null, vat: null, net: null };
    var c = gross * fees.agency / 100, e = gross * fees.ep / 100;
    var v = fees.plusVat ? (c + e) * (fees.vat || VAT) / 100 : 0;
    return { gross: r2(gross), commission: r2(c), ep: r2(e), vat: r2(v), net: r2(gross - c - e - v) };
  }

  // ---------- reading a pasted remittance or invoice ----------
  // dates written as 02/10/2026, 2/10/26, 2026-10-02, 2 Oct 2026, Fri 2nd October 2026, 02-Oct-26
  var DATE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b|\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?[\s-]+(\d{2,4})\b/gi;
  function datesIn(line) {
    var out = [], m;
    DATE.lastIndex = 0;
    while ((m = DATE.exec(line))) {
      var y, mo, d;
      if (m[1]) { y = +m[1]; mo = +m[2]; d = +m[3]; }
      else if (m[4]) { d = +m[4]; mo = +m[5]; y = +m[6]; }
      else { d = +m[7]; mo = MON[m[8].slice(0, 3).toLowerCase()]; y = +m[9]; }
      if (y < 100) y += 2000;
      if (y >= 2020 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.push({ d: y + "-" + pad(mo) + "-" + pad(d), at: m.index, end: m.index + m[0].length });
    }
    return out;
  }
  // money: £1,234.56 · 1234.56 · -12.00 · (12.00) · £120 (a whole number only with £)
  var AMT = /(\(?-?\s*£\s*\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?|\(?-?\d{1,3}(?:,\d{3})*\.\d{2}\)?)/g;
  function amountsIn(line, skip) {
    var out = [], m;
    AMT.lastIndex = 0;
    while ((m = AMT.exec(line))) {
      if (skip.some(function (s) { return m.index < s.end && m.index + m[0].length > s.at; })) continue;   // part of a date
      var raw = m[0], neg = /^\(|-/.test(raw.trim());
      var n = Number(raw.replace(/[£,()\s-]/g, ""));
      if (!isNaN(n)) out.push(neg ? -n : n);
    }
    return out;
  }
  var LABELS = [
    ["net", /\bnet\b|total (?:paid|payment|payable|due|to pay|transferred)|amount (?:paid|payable|transferred|due)|payment amount|you(?:'ll| will) receive|paid to you|balance (?:paid|due)|total remitted/i],
    ["vat", /\bvat\b/i],
    ["ep", /admin(?:istration)?\s*fee|\bEP\b.*fee|entertainment partners|processing fee|platform fee|payroll fee/i],
    ["commission", /commission|agency fee|agent'?s? fee|\bcomm\b/i],
    ["gross", /\bgross\b|total (?:earnings|fees?|pay|before deductions)|sub-?\s?total|total income/i],
    ["paidOn", /payment date|paid on|date paid|pay(?:ment)? day|value date|remittance date|transfer date/i]
  ];
  // jobs = [{ id, name, agency, worked: ["YYYY-MM-DD", ...] }]
  function readRemittance(text, jobs, today) {
    var lines = String(text || "").split(/\r?\n/).map(function (l) { return l.replace(/\t/g, "  ").trim(); }).filter(Boolean);
    var res = { gross: null, commission: null, ep: null, vat: null, net: null, paidOn: null, items: [], kind: /\binvoice\b/i.test(text) && !/remittance|payment advice|paid/i.test(text) ? "invoice" : "remittance" };
    var vatSum = 0, vatSeen = false;
    lines.forEach(function (line, i) {
      var ds = datesIn(line);
      var nums = amountsIn(line, ds);
      var label = null;
      for (var k = 0; k < LABELS.length; k++) if (LABELS[k][1].test(line)) { label = LABELS[k][0]; break; }
      // a label alone on its line, with the amount on the next one (tables pasted from a PDF)
      if (label && label !== "paidOn" && !nums.length && lines[i + 1] && !LABELS.some(function (L) { return L[1].test(lines[i + 1]); })) nums = amountsIn(lines[i + 1], datesIn(lines[i + 1]));
      if (label === "paidOn") { var pd = ds.length ? ds : datesIn(lines[i + 1] || ""); if (pd.length) res.paidOn = pd[0].d; return; }
      if (label && nums.length) {
        var v = Math.abs(nums[nums.length - 1]);               // the last amount on the line is its total
        if (label === "vat") { vatSum += v; vatSeen = true; }
        else if (res[label] === null) res[label] = v;
        return;
      }
      // a line for one work day: a date and an amount ("02/10/2026  Basic fee  99.68")
      if (ds.length && nums.length && !/period|week ending|invoice date|due date/i.test(line)) {
        res.items.push({ d: ds[0].d, desc: line.replace(DATE, "").replace(AMT, "").replace(/\s+/g, " ").trim().slice(0, 60), amount: nums[nums.length - 1] });
      }
    });
    if (vatSeen) res.vat = r2(vatSum);
    // the sum of the day lines is the gross when no gross total is written
    var itemsSum = r2(res.items.reduce(function (s, x) { return s + x.amount; }, 0));
    if (res.gross === null && res.items.length) res.gross = itemsSum;
    if (res.net === null && res.gross !== null && (res.commission !== null || res.ep !== null)) res.net = r2(res.gross - (res.commission || 0) - (res.ep || 0) - (res.vat || 0));
    if (res.net === null && res.gross !== null && res.commission === null && res.ep === null && res.vat === null) res.net = res.gross;
    res.days = res.items.map(function (x) { return x.d; }).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort();
    if (!res.paidOn && res.kind === "remittance") res.paidOn = today || null;
    res.jobs = matchJobs(res, text, jobs || []);
    return res;
  }
  // which job(s) it pays: by the days it lists (a day you worked belongs to one job), then by name
  function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
  function matchJobs(res, text, jobs) {
    var byDay = {};
    res.days.forEach(function (d) {
      var hit = jobs.filter(function (j) { return (j.worked || []).indexOf(d) !== -1; });
      if (hit.length === 1) byDay[d] = hit[0].id;
    });
    var ids = [];
    Object.keys(byDay).forEach(function (d) { if (ids.indexOf(byDay[d]) === -1) ids.push(byDay[d]); });
    if (!ids.length) {
      var t = norm(text);
      // the full name or its short form: "Falcon(Project 12)" → falcon, "EXP - Roundabout S2" → roundabouts2
      var forms = function (name) { var f = String(name || ""); return [f, f.replace(/\s*[\(\[].*$/, ""), f.replace(/^[A-Za-z]{2,4}\s*[-–:]\s*/, "")].map(norm).filter(function (x) { return x.length >= 4; }); };
      ids = jobs.filter(function (j) { return forms(j.name).some(function (n) { return t.indexOf(n) !== -1; }); }).map(function (j) { return j.id; });
      if (ids.length > 1) {
        // several names: the one whose agency is named too
        var withAg = ids.filter(function (id) { var j = jobs.filter(function (x) { return x.id === id; })[0]; return j.agency && t.indexOf(norm(j.agency).replace(/casting|extras/g, "")) !== -1; });
        if (withAg.length === 1) ids = withAg;
      }
    }
    // how much of the payment belongs to each job (by its day lines; one job takes it all)
    var out = ids.map(function (id) {
      var items = res.items.filter(function (x) { return byDay[x.d] === id; });
      var share = ids.length === 1 ? 1 : (res.gross ? items.reduce(function (s, x) { return s + x.amount; }, 0) / res.gross : 0);
      return { id: id, days: items.map(function (x) { return x.d; }).filter(function (d, i, a) { return a.indexOf(d) === i; }), share: share };
    });
    return out;
  }

  // ---------- is it right? ----------
  // payment = { gross, commission, ep, vat, net, days[] }; fees from the emails; worked = the job's worked days
  function checkPayment(p, fees, worked, rate) {
    var out = [];
    var near = function (a, b) { return Math.abs(a - b) <= 0.02 + Math.abs(b) * 0.002; };
    if (p.days && p.days.length && worked) {
      var missing = worked.filter(function (d) { return p.days.indexOf(d) === -1; });
      var extra = p.days.filter(function (d) { return worked.indexOf(d) === -1; });
      out.push(!missing.length && !extra.length ? { ok: true, what: "Pays every day you worked (" + p.days.length + ")" }
        : { ok: false, what: (missing.length ? "Not paid yet: " + missing.join(", ") : "") + (missing.length && extra.length ? " · " : "") + (extra.length ? "Paid days not marked worked: " + extra.join(", ") : "") });
    }
    if (p.gross !== null && p.net !== null && (p.commission !== null || p.ep !== null || p.vat !== null)) {
      var sum = r2(p.gross - (p.commission || 0) - (p.ep || 0) - (p.vat || 0));
      out.push(near(sum, p.net) ? { ok: true, what: "The sum is right: gross − deductions = net" } : { ok: false, what: "The sum doesn't add up: gross − deductions = " + sum.toFixed(2) + ", but it says " + p.net.toFixed(2) });
    }
    if (fees && p.gross) {
      var exp = expectedNet(p.gross, fees);
      var said = { agency: "usual for this agency", remittance: "from an earlier remittance", you: "you typed" }[fees.from] || "the emails say";
      if (p.commission !== null) out.push(near(p.commission, exp.commission) ? { ok: true, what: "Agency commission is " + fees.agency + "%" } : { ok: false, what: "Agency commission is " + (p.commission / p.gross * 100).toFixed(1) + "% (" + said + " " + fees.agency + "%)" });
      if (p.ep !== null && fees.ep) out.push(near(p.ep, exp.ep) ? { ok: true, what: "EP admin fee is " + fees.ep + "%" } : { ok: false, what: "EP admin fee is " + (p.ep / p.gross * 100).toFixed(1) + "% (" + said + " " + fees.ep + "%)" });
      if (p.vat !== null && fees.plusVat) {
        var base = (p.commission || 0) + (p.ep || 0);
        out.push(near(p.vat, r2(base * fees.vat / 100)) ? { ok: true, what: "VAT is " + fees.vat + "% of the fees" } : { ok: false, what: "VAT is " + p.vat.toFixed(2) + " (" + fees.vat + "% of the fees would be " + r2(base * fees.vat / 100).toFixed(2) + ")" });
      }
      if (p.net !== null) out.push(near(p.net, exp.net) ? { ok: true, what: "Net pay matches the expected fees" } : { ok: false, what: "Net pay " + p.net.toFixed(2) + " – with the expected fees (" + said + ") it would be " + exp.net.toFixed(2) });
    }
    if (rate && p.gross && p.days && p.days.length) {
      var per = p.gross / p.days.length;
      if (per < rate - 0.5) out.push({ ok: false, what: "Gross per day £" + per.toFixed(2) + " is below your day rate £" + rate });
    }
    return out;
  }

  var api = { feesFrom: feesFrom, expectedNet: expectedNet, readRemittance: readRemittance, checkPayment: checkPayment, datesIn: datesIn };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Money = api;
})(this);
