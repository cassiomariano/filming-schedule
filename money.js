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
    ["net", /\bnet\b|total (?:paid|payment|payable|to pay|transferred)|amount (?:paid|payable|transferred)|payment amount|you(?:'ll| will) receive|paid to you|balance paid|total remitted/i],
    ["due", /total due|amount due|balance due/i],
    ["vat", /\bvat\b/i],
    ["ep", /admin(?:istration)?\s*fee|\bEP\b.*fee|entertainment partners|processing fee|platform fee|payroll fee/i],
    ["commission", /commission|agency fee|agent'?s? fee|\bcomm\b/i],
    ["gross", /\bgross\b|total (?:earnings|fees?|pay|before deductions)|sub-?\s?total|total income/i],
    ["paidOn", /payment date|paid on|date paid|pay(?:ment)? day|value date|remittance date|transfer date/i]
  ];
  // jobs = [{ id, name, agency, worked: ["YYYY-MM-DD", ...] }]
  function readRemittance(text, jobs, today) {
    var lines = String(text || "").split(/\r?\n/).map(function (l) { return l.replace(/\t/g, "  ").trim(); }).filter(Boolean);
    var res = { gross: null, commission: null, ep: null, vat: null, net: null, due: null, paidOn: null, items: [], kind: /\binvoice\b/i.test(text) && !/remittance|payment advice|paid/i.test(text) ? "invoice" : "remittance" };
    var vatSum = 0, vatSeen = false, other = [];
    lines.forEach(function (line, i) {
      var ds = datesIn(line);
      var nums = amountsIn(line, ds);
      var label = null;
      for (var k = 0; k < LABELS.length; k++) if (LABELS[k][1].test(line)) { label = LABELS[k][0]; break; }
      // a label alone on its line, with the amount on the next one (tables pasted from a PDF)
      var heading = line.split(/\s{2,}/).length >= 4 && !nums.length && !ds.length;   // a table's column names (4 or more, spaced apart)
      if (heading) return;
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
      } else if (!ds.length && nums.length === 1) {
        // an amount with a name we don't know (e.g. "Travel expenses £20.00"): used only if the sum proves it
        other.push({ what: line.replace(AMT, "").replace(/[:\s]+$/, "").replace(/\s+/g, " ").trim().slice(0, 40), amount: nums[0] });
      }
    });
    if (vatSeen) res.vat = r2(vatSum);
    // "Total Due": what you're paid when nothing else says so; before the deductions when a net line follows
    if (res.due !== undefined && res.due !== null) {
      if (res.net === null) res.net = res.due;
      else if (res.due > res.net && (res.commission !== null || res.ep !== null)) res.gross = res.due;
    }
    delete res.due;
    // the sum of the day lines is the gross when no gross total is written
    var itemsSum = r2(res.items.reduce(function (s, x) { return s + x.amount; }, 0));
    if (res.gross === null && res.items.length) res.gross = itemsSum;
    if (res.net === null && res.gross !== null && (res.commission !== null || res.ep !== null)) res.net = r2(res.gross - (res.commission || 0) - (res.ep || 0) - (res.vat || 0));
    if (res.net === null && res.gross !== null && res.commission === null && res.ep === null && res.vat === null) res.net = res.gross;
    // net ≠ gross − deductions: an extra amount explains the difference (expenses added, or a fee taken off)
    if (res.gross !== null && res.net !== null && (res.commission !== null || res.ep !== null)) {
      var gap = r2(res.net - (res.gross - (res.commission || 0) - (res.ep || 0) - (res.vat || 0)));
      var hit = Math.abs(gap) > 0.02 && other.filter(function (o) { return Math.abs(Math.abs(o.amount) - Math.abs(gap)) <= 0.02; })[0];
      if (hit) res.extras = [{ what: hit.what || "Other", amount: gap > 0 ? Math.abs(hit.amount) : -Math.abs(hit.amount) }];
    }
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

  // ---------- Entertainment Partners remittance (the PDF from the payments page) ----------
  // Sections: SELF BILLING INVOICE (what the production pays per day: B/M, Travel, E/C, O/T, H/C, Basic…),
  // COMMISSIONS INVOICE (Admin Fee* + VAT, Agent Commission + VAT), Deposit Summary, PAYSLIP (hours).
  // text = the PDF's text with its columns kept (layoutText below), one or several remittances.
  var PART_NAMES = { "basic": "Basic fee", "h/c": "Holiday pay", "o/t": "Overtime", "e/c": "Early call", "travel": "Travel", "b/m": "B/M", "n/s": "Night supplement", "fit": "Fitting", "w/c": "Wardrobe call" };
  // the value written under a heading on the next lines ("Project" → "BROKEN EGGS")
  function under(lines, i, label) {
    var at = lines[i].indexOf(label);
    for (var j = i + 1; j < Math.min(lines.length, i + 3); j++) {
      var l = lines[j];
      if (!l.trim()) continue;
      // the word(s) that start near that column
      var re = /\S+(?: \S+)*/g, m, best = null;
      while ((m = re.exec(l))) { var d = Math.abs(m.index - at); var end = m.index + m[0].length; if ((m.index <= at + label.length + 2 && end >= at - 2) && (!best || d < best.d)) best = { v: m[0], d: d }; }
      if (best) return best.v;
    }
    return "";
  }
  // a table: heading line (Date … Total) and its rows; each number goes to the heading it lines up with
  function table(lines, i) {
    var head = lines[i], cols = [], re = /\S+(?: \S+)*/g, m;
    while ((m = re.exec(head))) if (!/^date$/i.test(m[0])) cols.push({ name: m[0], end: m.index + m[0].length, at: m.index });
    var rows = [];
    for (var j = i + 1; j < lines.length; j++) {
      var l = lines[j];
      if (!l.trim()) continue;
      var ds = datesIn(l);
      if (!ds.length || ds[0].at > 12 + (l.length - l.replace(/^\s+/, "").length)) break;   // the rows start with a date; "Total" ends them
      var row = { d: ds[0].d, cells: {} };
      var nre = /-?\d{1,3}(?:,\d{3})*\.\d{2}/g, n;
      while ((n = nre.exec(l))) {
        if (n.index < ds[0].end) continue;
        var end = n.index + n[0].length, best = null;
        cols.forEach(function (c, k) { var dist = Math.abs(c.end - end); if (!best || dist < best.dist) best = { k: k, dist: dist }; });
        if (best) { var key = cols[best.k].name + (cols.slice(0, best.k).filter(function (c) { return c.name === cols[best.k].name; }).length ? "#2" : ""); row.cells[key] = Number(n[0].replace(/,/g, "")); }
      }
      rows.push(row);
    }
    return rows;
  }
  function readEPRemittance(text) {
    var blocks = String(text).split(/(?=SELF BILLING INVOICE)/).filter(function (b) { return /SELF BILLING INVOICE/.test(b); });
    return blocks.map(function (b) {
      var lines = b.split(/\r?\n/);
      var p = { source: "ep-pdf", project: "", hirer: "", agency: "", invoiceNo: "", taxPoint: null, paidOn: null, hours: null, days: [], perDay: [],
        gross: null, ep: null, epVat: null, commission: null, commissionVat: null, vat: null, fees: null, net: null, status: "paid" };
      var section = "earn";
      lines.forEach(function (l, i) {
        if (/COMMISSIONS INVOICE/.test(l)) section = "fees";
        if (/^\s*PAYSLIP/.test(l)) section = "slip";
        if (/\bProject\b/.test(l) && !p.project) p.project = under(lines, i, "Project");
        if (/\bHirer\b/.test(l) && !p.hirer) p.hirer = under(lines, i, "Hirer");
        if (/Invoice No/.test(l) && !p.invoiceNo) p.invoiceNo = under(lines, i, "Invoice No");
        if (/Tax Point/.test(l) && !p.taxPoint) { var tp = datesIn(under(lines, i, "Tax Point")); if (tp.length) p.taxPoint = tp[0].d; }
        if (/Hours Worked/.test(l) && p.hours === null) { var h = under(lines, i, "Hours Worked"); if (/^\d+(\.\d+)?$/.test(h)) p.hours = Number(h); }
        if (/Registered in England/i.test(l) && !p.agency) { var prev = (lines[i - 1] || "").trim().split(/\s{2,}/)[0]; if (/\b(ltd|limited|casting|extras|agency)\b/i.test(prev)) p.agency = prev.replace(/\s+(limited|ltd)\.?$/i, ""); }
        if (/^\s*Date\b/.test(l) && /Total/.test(l)) {
          var rows = table(lines, i);
          if (section === "earn" && !p.perDay.length) p.perDay = rows.map(function (r) {
            var parts = {}; Object.keys(r.cells).forEach(function (k) { if (!/^total/i.test(k)) parts[k] = r.cells[k]; });
            return { d: r.d, parts: parts, total: r.cells.Total !== undefined ? r.cells.Total : null };
          });
          if (section === "fees") rows.forEach(function (r) {
            Object.keys(r.cells).forEach(function (k) {
              var v = r.cells[k];
              if (/admin/i.test(k)) p.ep = r2((p.ep || 0) + v);
              else if (/commission/i.test(k)) p.commission = r2((p.commission || 0) + v);
              else if (/^vat/i.test(k)) { if (/#2$/.test(k)) p.commissionVat = r2((p.commissionVat || 0) + v); else p.epVat = r2((p.epVat || 0) + v); }
            });
          });
        }
        var amt = l.match(/(-?\d{1,3}(?:,\d{3})*\.\d{2})\s*$/);
        if (/Total due from the Hirer/i.test(l) && amt) p.gross = Number(amt[1].replace(/,/g, ""));
        if (/Total deposited to your account/i.test(l) && amt) p.net = Number(amt[1].replace(/,/g, ""));
      });
      if (p.gross === null && p.perDay.length) p.gross = r2(p.perDay.reduce(function (s, x) { return s + (x.total || 0); }, 0));
      p.vat = p.epVat !== null || p.commissionVat !== null ? r2((p.epVat || 0) + (p.commissionVat || 0)) : null;
      p.fees = p.ep !== null || p.commission !== null ? r2((p.ep || 0) + (p.commission || 0)) : null;
      if (p.net === null && p.gross !== null) p.net = r2(p.gross - (p.fees || 0) - (p.vat || 0));
      p.days = p.perDay.map(function (x) { return x.d; });
      p.paidOn = p.taxPoint;          // the PDF has no deposit date; the payments page does (paste it to add it)
      return p;
    });
  }

  // ---------- the table on your EP payments page, copied and pasted ----------
  // Project Name | Status | Remittance Advice | Deposit Date | Days Worked | Gross | Fees | VAT | Deposited
  function readEPTable(text) {
    var toks = String(text).split(/\t|\r?\n/).map(function (t) { return t.trim(); }).filter(function (t) { return t && !/^(download pdf|filter|x|rows:.*)$/i.test(t); });
    var num = function (t) { return /^-?£?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(t) ? Number(t.replace(/[£,]/g, "")) : null; };
    var out = [], start = 0;
    for (var i = 0; i + 3 < toks.length; i++) {
      var g = num(toks[i]), f = num(toks[i + 1]), v = num(toks[i + 2]), n = num(toks[i + 3]);
      if (g === null || f === null || v === null || n === null) continue;
      // a row ends with Gross, Fees, VAT, Deposited (Gross − Fees − VAT = Deposited)
      if (Math.abs(g - Math.abs(f) - Math.abs(v) - n) > 0.02) continue;
      var head = toks.slice(start, i).filter(function (t) { return !/^(project name|status|remittance advice|deposit date|days worked|gross|fees|vat|deposited)$/i.test(t); });
      var dates = [], words = [];
      head.forEach(function (t) { var ds = datesIn(t); if (ds.length) dates.push.apply(dates, ds.map(function (x) { return x.d; })); else words.push(t); });
      var status = words.filter(function (w) { return /^(paid|pending|processing|approved|on hold|unpaid)$/i.test(w); })[0] || "Paid";
      var project = words.filter(function (w) { return !/^(paid|pending|processing|approved|on hold|unpaid)$/i.test(w); }).join(" ").trim();
      out.push({ source: "ep-table", project: project, agency: "", invoiceNo: "", status: /paid/i.test(status) ? "paid" : "pending",
        paidOn: dates[0] || null, days: dates.slice(1).sort(), perDay: [], hours: null,
        gross: g, fees: Math.abs(f), ep: null, commission: null, vat: Math.abs(v), epVat: null, commissionVat: null, net: n });
      start = i + 4; i += 3;
    }
    return out;
  }
  var looksEPTable = function (t) { return /Deposited|Download PDF/i.test(t) && /Gross/i.test(t) || readEPTable(t).length >= 1 && !/SELF BILLING INVOICE/.test(t) && /\t/.test(t); };

  // ---------- remittances printed from an agency's own website ----------
  // the amount at the end of a line: 1,395.80 · £145.00 · -£18.13
  function endAmount(l) { var m = String(l).match(/(-?)\s*£?\s*(\d{1,3}(?:,\d{3})*\.\d{2})\s*$/); return m ? Number(m[2].replace(/,/g, "")) : null; }
  function blankPayment(source, agency) {
    return { source: source, project: "", agency: agency, invoiceNo: "", taxPoint: null, paidOn: null, hours: null, days: [], perDay: [],
      gross: null, ep: null, epVat: null, commission: null, commissionVat: null, vat: null, fees: null, ni: null, net: null, status: "paid" };
  }
  function finishPayment(p, productions) {
    p.project = productions.filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(" / ");
    p.perDay.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    p.days = p.perDay.map(function (x) { return x.d; });
    if (p.gross === null && p.perDay.length) p.gross = r2(p.perDay.reduce(function (t, x) { return t + (x.total || 0); }, 0));
    p.fees = p.commission;
    p.commissionVat = p.vat;
    if (p.net === null && p.gross !== null) p.net = r2(p.gross - (p.commission || 0) - (p.vat || 0) - (p.ni || 0));
    return p;
  }
  function addDay(p, d, amount) {
    var x = p.perDay.filter(function (y) { return y.d === d; })[0];
    if (x) x.total = r2(x.total + amount); else p.perDay.push({ d: d, parts: {}, total: amount });
  }
  // Casting Collective ("Your remittances" → View → print): Remittance Date / Remittance No, a line per day
  // (Production, Work Date, Voucher, Ref, Received, Gross), then Total Due, NI, Commission, VAT on Commission, Net Payment
  var looksCC = function (t) { return /Remittance No/i.test(t) && /Net Payment/i.test(t) && /VAT on Commission/i.test(t) && /Casting Collective|Voucher/i.test(t); };
  function readCCRemittance(text) {
    var blocks = String(text).split(/(?=^[ \t]*Remittance Date\s*:)/m).filter(function (b) { return /Net Payment/i.test(b); });
    return blocks.map(function (b) {
      var p = blankPayment("cc-pdf", "Casting Collective"), names = [];
      b.split(/\r?\n/).forEach(function (l) {
        var ds = datesIn(l), amt = endAmount(l);
        if (/^\s*Remittance Date/i.test(l)) { if (ds.length) p.paidOn = ds[0].d; return; }
        if (/^\s*Remittance No/i.test(l)) { var no = l.match(/\bR?\d{4,}\b/); if (no) p.invoiceNo = no[0]; return; }
        if (amt === null) return;
        if (/Total Due/i.test(l)) { p.gross = amt; return; }
        if (/^\s*NI\b/.test(l)) { p.ni = amt; return; }
        if (/VAT on Commission/i.test(l)) { p.vat = amt; return; }
        if (/^\s*Commission\b/i.test(l)) { p.commission = amt; return; }
        if (/Net Payment/i.test(l)) { p.net = amt; return; }
        // a day: the production's name, then the work date … the gross at the end
        if (ds.length && ds[0].at > 0) {
          var name = l.slice(0, ds[0].at).trim();
          if (!name || /https?:|remittance/i.test(name)) return;
          names.push(name); addDay(p, ds[0].d, amt);
        }
      });
      return finishPayment(p, names);
    });
  }
  // Talent Talks ("Payment Remittance"): Remittance No / Date, "Reference: <production> £amount" + "Shoot Date:",
  // Subtotal, "TT Commission 12.50%", "VAT (20%) on Commission", Total Paid
  var looksTT = function (t) { return /Payment Remittance/i.test(t) && /Total Paid/i.test(t) && /Commission/i.test(t); };
  function readTTRemittance(text) {
    var blocks = String(text).split(/(?=Payment Remittance)/i).filter(function (b) { return /Total Paid/i.test(b); });
    return blocks.map(function (b) {
      var p = blankPayment("tt-pdf", "Talent Talks"), names = [], waiting = [], other = [];
      b.split(/\r?\n/).forEach(function (l) {
        var ds = datesIn(l), amt = endAmount(l);
        if (/Remittance No\s*:/i.test(l)) { p.invoiceNo = l.replace(/^.*Remittance No\s*:\s*/i, "").trim(); return; }
        if (/Remittance Date\s*:/i.test(l)) { if (ds.length) p.paidOn = ds[0].d; return; }
        if (/Reference\s*:/i.test(l)) { names.push(l.replace(/^.*Reference\s*:\s*/i, "").replace(/-?\s*£?\s*\d{1,3}(?:,\d{3})*\.\d{2}\s*$/, "").trim()); waiting.push(amt); return; }
        if (/Shoot Date\s*:/i.test(l)) { if (ds.length && waiting.length) addDay(p, ds[0].d, waiting.shift() || 0); return; }
        if (amt === null) return;                       // the advice text at the bottom mentions commission and VAT too
        if (/Subtotal/i.test(l)) { p.gross = amt; return; }
        if (/VAT\b.*Commission/i.test(l)) { p.vat = amt; return; }
        if (/Commission/i.test(l)) {
          p.commission = amt;
          var pc = l.match(/(\d+(?:\.\d+)?)\s*%/); if (pc) p.feesSaid = { agency: Number(pc[1]), ep: 0, vat: VAT, plusVat: true, from: "said" };
          return;
        }
        if (/Total Paid/i.test(l)) { p.net = amt; return; }
        // any other line with an amount (e.g. expenses with no commission, or a fee): kept with its sign
        var sign = /-\s*£?\s*\d[\d,]*\.\d{2}\s*$/.test(l) ? -1 : 1;
        other.push({ what: l.replace(/-?\s*£?\s*\d{1,3}(?:,\d{3})*\.\d{2}\s*$/, "").replace(/\s+/g, " ").trim().slice(0, 40), amount: r2(sign * amt), afterSubtotal: p.gross !== null });
      });
      finishPayment(p, names);
      // what's paid on top of (or taken off) the subtotal, only when the sum proves it
      if (p.gross !== null && p.net !== null) {
        var gap = r2(p.net - (p.gross - (p.commission || 0) - (p.vat || 0)));
        if (Math.abs(gap) > 0.02) {
          var after = other.filter(function (o) { return o.afterSubtotal; });
          var tot = r2(after.reduce(function (t, o) { return t + o.amount; }, 0));
          if (after.length && Math.abs(tot - gap) <= 0.02) p.extras = after.map(function (o) { return { what: o.what, amount: o.amount }; });
        }
      }
      return p;
    });
  }

  // ---------- any of them → payments, each with the job it belongs to ----------
  // jobs = [{ id, name, agency, worked: [days] }]
  function readPayments(text, jobs, today) {
    var t = String(text || "");
    var list;
    if (/SELF BILLING INVOICE/.test(t)) list = readEPRemittance(t);
    else if (looksCC(t) && readCCRemittance(t).length) list = readCCRemittance(t);
    else if (looksTT(t) && readTTRemittance(t).length) list = readTTRemittance(t);
    else if (looksEPTable(t) && readEPTable(t).length) list = readEPTable(t);
    else {
      var r = readRemittance(t, [], today);
      list = [{ source: "text", project: "", agency: "", invoiceNo: "", status: r.kind === "invoice" ? "invoice" : "paid", paidOn: r.paidOn, days: r.days, perDay: [], hours: null,
        gross: r.gross, ep: r.ep, commission: r.commission, vat: r.vat, fees: r.ep !== null || r.commission !== null ? r2((r.ep || 0) + (r.commission || 0)) : null, net: r.net, extras: r.extras }];
    }
    list.forEach(function (p) { p.job = matchPayment(p, t, jobs || []); });
    return list;
  }
  // the same agency (or one of them unknown): "Extra People" never goes to a "Casting Collective" job
  function agencyKey(a) { return String(a || "").toLowerCase().replace(/\b(ltd|limited|casting|extras?|agency|uk|talent|management|the)\b/g, "").replace(/[^a-z0-9]/g, ""); }
  function sameAgency(a, b) { var x = agencyKey(a), y = agencyKey(b); return !x || !y || x === y || x.indexOf(y) !== -1 || y.indexOf(x) !== -1; }
  function matchPayment(p, text, jobs) {
    // a payment that names its agency only goes to a job of that agency (never to one with no agency)
    jobs = jobs.filter(function (j) { return agencyKey(p.agency) ? agencyKey(j.agency) && sameAgency(p.agency, j.agency) : true; });
    var byDay = jobs.filter(function (j) { return p.days.some(function (d) { return (j.worked || []).indexOf(d) !== -1; }); });
    if (byDay.length === 1) return byDay[0].id;
    var forms = function (name) { var f = String(name || ""); return [f, f.replace(/\s*[\(\[].*$/, ""), f.replace(/^[A-Za-z]{2,4}\s*[-–:]\s*/, "")].map(norm).filter(function (x) { return x.length >= 4; }); };
    var named = (byDay.length ? byDay : jobs).filter(function (j) {
      return p.project ? forms(j.name).some(function (f) { return forms(p.project).indexOf(f) !== -1 || norm(p.project).indexOf(f) === 0; }) : forms(j.name).some(function (f) { return norm(text).indexOf(f) !== -1; });
    });
    if (named.length === 1) return named[0].id;
    // same name: the job whose days are nearest to the paid days
    if (named.length > 1 && p.days.length) {
      var dist = function (j) { return Math.min.apply(null, (j.worked || []).map(function (w) { return Math.min.apply(null, p.days.map(function (d) { return Math.abs(new Date(w) - new Date(d)); })); })); };
      return named.slice().sort(function (a, b) { return dist(a) - dist(b); })[0].id;
    }
    return null;
  }
  // a payment saved twice (e.g. its PDF and its row on the payments page): the same job, days and amount
  function samePayment(a, b) {
    if (a.invoiceNo && b.invoiceNo) return a.invoiceNo === b.invoiceNo;
    return Math.abs((a.net || 0) - (b.net || 0)) < 0.01 && Math.abs((a.gross || 0) - (b.gross || 0)) < 0.01 && (a.days || []).join() === (b.days || []).join();
  }
  // keeps the most of both (the PDF knows the breakdown, the page knows the deposit date)
  function mergePayment(a, b) {
    var out = {}; Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    Object.keys(b).forEach(function (k) { if (out[k] === null || out[k] === undefined || out[k] === "" || (Array.isArray(out[k]) && !out[k].length)) out[k] = b[k]; });
    if (b.source === "ep-table" && b.paidOn) { out.paidOn = b.paidOn; out.deposited = true; }   // the real deposit date
    if (a.source === "ep-table" && a.paidOn) { out.paidOn = a.paidOn; out.deposited = true; }
    return out;
  }

  // ---------- a PDF's words with their positions → lines that keep the columns ----------
  // pages = [[{ s: text, x, y }]] (as pdf.js gives them)
  function layoutText(pages) {
    var out = [];
    pages.forEach(function (items) {
      var rows = [];
      items.filter(function (it) { return it.s && it.s.trim(); }).forEach(function (it) {
        var r = null; rows.forEach(function (x) { if (!r && Math.abs(x.y - it.y) < 2.5) r = x; });
        if (!r) { r = { y: it.y, items: [] }; rows.push(r); }
        r.items.push(it);
      });
      rows.sort(function (a, b) { return b.y - a.y; }).forEach(function (r) {
        var line = "";
        r.items.sort(function (a, b) { return a.x - b.x; }).forEach(function (it) {
          var col = Math.round(it.x / 4);
          if (line.length < col) line += new Array(col - line.length + 1).join(" ");
          else if (line.length && line[line.length - 1] !== " ") line += " ";
          line += it.s;
        });
        out.push(line.replace(/\s+$/, ""));
      });
      out.push("");
    });
    return out.join("\n");
  }
  // numbers that identify you (National Insurance number) are never kept
  function redact(text) { return String(text || "").replace(/\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi, "[NI number removed]"); }

  // ---------- is it right? ----------
  // payment = { gross, commission, ep, vat, net, days[] }; fees from the emails; worked = the job's worked days
  // parts the agency takes no commission on (seen on Extra People remittances: a £15 meal)
  var NO_COMMISSION = /^(meals?( allowance)?|subsistence|per ?diem)$/i;
  function noCommission(p) {
    return r2((p.perDay || []).reduce(function (s, x) { return s + Object.keys(x.parts || {}).reduce(function (t, k) { return t + (NO_COMMISSION.test(k.trim()) ? x.parts[k] : 0); }, 0); }, 0));
  }
  // paidElsewhere = days already paid by the job's other payments (they are not "not paid yet")
  function checkPayment(p, fees, worked, rate, paidElsewhere) {
    var out = [];
    if (!fees && p.feesSaid) fees = p.feesSaid;          // the rate printed on the remittance itself
    var near = function (a, b) { return Math.abs(a - b) <= 0.02 + Math.abs(b) * 0.002; };
    var other = paidElsewhere || [];
    if (p.days && p.days.length && worked) {
      var missing = worked.filter(function (d) { return p.days.indexOf(d) === -1 && other.indexOf(d) === -1; });
      var extra = p.days.filter(function (d) { return worked.indexOf(d) === -1; });
      out.push(!missing.length && !extra.length ? { ok: true, what: "Pays every day you worked (" + p.days.length + ")" }
        : { ok: false, what: (missing.length ? "Not paid yet: " + missing.join(", ") : "") + (missing.length && extra.length ? " · " : "") + (extra.length ? "Paid days not marked worked: " + extra.join(", ") : "") });
    }
    if ((p.gross === null || p.gross === undefined) && p.net !== null && p.net !== undefined && p.source && p.source !== "text" && p.source !== "ep-table")
      out.push({ ok: false, what: "The gross couldn't be read from this remittance – please send me this PDF" });
    if (p.gross !== null && p.net !== null && (p.commission !== null || p.ep !== null || p.vat !== null || (p.fees !== null && p.fees !== undefined))) {
      var plus = r2((p.extras || []).reduce(function (t, o) { return t + o.amount; }, 0));   // e.g. expenses paid with no commission
      var sum = r2(p.gross - (p.commission !== null || p.ep !== null ? (p.commission || 0) + (p.ep || 0) : (p.fees || 0)) - (p.vat || 0) - (p.ni || 0) + plus);
      out.push(near(sum, p.net) ? { ok: true, what: "The sum is right: gross − deductions = net" } : { ok: false, what: "The sum doesn't add up: gross − deductions = " + sum.toFixed(2) + ", but it says " + p.net.toFixed(2) });
    }
    if (fees && p.gross && p.commission === null && p.ep === null && p.fees !== null && p.fees !== undefined) {
      // the payments page shows commission + EP fee as one "Fees" figure
      var both = r2(p.gross * (fees.agency + fees.ep) / 100);
      out.push(near(p.fees, both) ? { ok: true, what: "Fees are " + (fees.agency + fees.ep) + "% (" + fees.agency + "% agency" + (fees.ep ? " + " + fees.ep + "% EP" : "") + ")" }
        : { ok: false, what: "Fees are " + (p.fees / p.gross * 100).toFixed(1) + "% of gross (expected " + (fees.agency + fees.ep) + "%)" });
      if (p.vat !== null && fees.plusVat) out.push(near(p.vat, r2(p.fees * fees.vat / 100)) ? { ok: true, what: "VAT is " + fees.vat + "% of the fees" } : { ok: false, what: "VAT is " + p.vat.toFixed(2) + " (" + fees.vat + "% of the fees would be " + r2(p.fees * fees.vat / 100).toFixed(2) + ")" });
    }
    if (fees && p.gross && (p.commission !== null || p.ep !== null)) {
      // fees are on the gross, or on the gross without a meal allowance (whichever the remittance used)
      var free = noCommission(p), base = p.gross;
      if (free > 0) {
        var onAll = expectedNet(p.gross, fees), onPart = expectedNet(r2(p.gross - free), fees);
        var paidFee = p.commission !== null ? p.commission : p.ep, ref = p.commission !== null ? "commission" : "ep";
        if (!near(paidFee, onAll[ref]) && near(paidFee, onPart[ref])) base = r2(p.gross - free);
      }
      var exp = expectedNet(base, fees);
      exp.net = r2(p.gross - exp.commission - exp.ep - exp.vat - (p.ni || 0) + (p.extras || []).reduce(function (t, o) { return t + o.amount; }, 0));
      var noFee = base !== p.gross ? " (none on the £" + free.toFixed(2) + " meal)" : "";
      var said = { agency: "usual for this agency", remittance: "from an earlier remittance", you: "you typed", said: "the remittance says" }[fees.from] || "the emails say";
      if (p.commission !== null) out.push(near(p.commission, exp.commission) ? { ok: true, what: "Agency commission is " + fees.agency + "%" + noFee } : { ok: false, what: "Agency commission is " + (p.commission / base * 100).toFixed(1) + "% (" + said + " " + fees.agency + "%)" });
      if (p.ep !== null && fees.ep) out.push(near(p.ep, exp.ep) ? { ok: true, what: "EP admin fee is " + fees.ep + "%" + noFee } : { ok: false, what: "EP admin fee is " + (p.ep / base * 100).toFixed(1) + "% (" + said + " " + fees.ep + "%)" });
      if (p.vat !== null && fees.plusVat) {
        var base = (p.commission || 0) + (p.ep || 0);
        out.push(near(p.vat, r2(base * fees.vat / 100)) ? { ok: true, what: "VAT is " + fees.vat + "% of the fees" } : { ok: false, what: "VAT is " + p.vat.toFixed(2) + " (" + fees.vat + "% of the fees would be " + r2(base * fees.vat / 100).toFixed(2) + ")" });
      }
      if (p.net !== null) out.push(near(p.net, exp.net) ? { ok: true, what: "Net pay matches the expected fees" } : { ok: false, what: "Net pay " + p.net.toFixed(2) + " – with the expected fees (" + said + ") it would be " + exp.net.toFixed(2) });
    }
    (p.perDay || []).forEach(function (x) {
      if (!Object.keys(x.parts || {}).length) return;      // only the day's total is written
      var parts = Object.keys(x.parts || {}).reduce(function (s, k) { return s + x.parts[k]; }, 0);
      if (x.total !== null && Math.abs(r2(parts) - x.total) > 0.02) out.push({ ok: false, what: x.d + ": the parts add up to " + r2(parts).toFixed(2) + ", not " + x.total.toFixed(2) });
    });
    var dayTotals = (p.perDay || []).filter(function (x) { return x.total !== null && x.total !== undefined; });
    if (p.gross !== null && dayTotals.length && dayTotals.length === (p.perDay || []).length) {
      var all = r2(dayTotals.reduce(function (t, x) { return t + x.total; }, 0));
      if (Math.abs(all - p.gross) > 0.02) out.push({ ok: false, what: "The days add up to " + all.toFixed(2) + ", but the gross says " + p.gross.toFixed(2) });
    }
    if (rate && p.gross && p.days && p.days.length) {
      var per = p.gross / p.days.length;
      if (per < rate - 0.5) out.push({ ok: false, what: "Gross per day £" + per.toFixed(2) + " is below your day rate £" + rate });
    }
    return out;
  }

  var api = { feesFrom: feesFrom, expectedNet: expectedNet, readRemittance: readRemittance, readPayments: readPayments, readEPRemittance: readEPRemittance, readEPTable: readEPTable, readCCRemittance: readCCRemittance, readTTRemittance: readTTRemittance,
    samePayment: samePayment, mergePayment: mergePayment, layoutText: layoutText, redact: redact, checkPayment: checkPayment, sameAgency: sameAgency, datesIn: datesIn, PART_NAMES: PART_NAMES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Money = api;
})(this);
