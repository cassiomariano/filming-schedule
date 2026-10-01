/*
 * parser.js — reads a casting agency email and pulls out the job details.
 *
 * It works with fixed rules (no AI): it looks for labels such as "Project:",
 * "SHOOT DATES:", "FITTING -" and for dates written in the usual ways
 * ("Wed 14 Oct 2026", "9th October", "Tue, Oct 06, 2026", "11th 12th and 13th").
 *
 * The same file is used in two places:
 *   - in the web app (index.html), when you paste an email by hand
 *   - in the GitHub robot (scripts/check-email.js), which reads your Yahoo inbox
 */
(function (root) {
  "use strict";

  // ---------- known agencies ----------
  // name shown in the app  +  words that identify it (in the sender, the web address or the email text)
  var AGENCIES = [
    ["Extra People", /extra[\s-]?people/i],
    ["Two 10 Casting", /two\s?10|two10/i],
    ["Casting Collective", /casting\s?collective/i],
    ["Key Casting", /key\s?casting/i],
    ["Universal Extras", /universal\s?extras/i],
    ["Lucas Extras", /lucas\s?extras/i],
    ["Camera Action Extras", /camera\s?action/i],
    ["Wilkins Casting", /wilkins/i],
    ["Sabell Casting", /sabell/i],
    ["BBB Talent", /\bbbb\b|bbbtalent/i],
    ["On Set Extras", /on\s?set\s?extras|onsetextras/i],
    ["True Edge", /true\s?edge|trueedge/i],
    ["Slick Casting", /slick\s?casting/i],
    ["Talent Talks", /talent\s?talks/i],
    ["VFA Casting", /\bvfa\b/i],
    ["Precious Agency", /precious\s?agency/i],
    ["Phoenix Casting", /phoenix\s?casting/i],
    ["Creative Casting", /creative\s?cast/i],
    ["Universal Extras", /universalextras/i],
    ["The Artist Book", /artist\s?book/i],
    ["Poppy Casting", /poppy\s?(casting|extras|agency)/i],
    ["Colour Sound", /colou?r\s?sound/i],
    ["Alessi Hartigan", /alessi\s?hartigan/i],
    ["Greenlight", /greenlight\s?(casting|extras|agency|talent)/i],
    ["MFS Casting", /mfs\s?casting/i],
    ["Mixedbab", /mixedbab/i],
    ["Phoenix Casting", /phoenix\s?(extras|agency|talent)/i]
  ];

  // ---------- is the sender a casting / extras agency? ----------
  // fromName, fromEmail: the sender. extraNames: agency names already in your schedule.
  function isFromCastingAgency(fromName, fromEmail, extraNames) {
    var who = (fromName || "") + " " + (fromEmail || "");
    if (/spotlight/i.test(who)) return false;     // Spotlight has its own app
    // Entertainment Partners' casting portal sends for most agencies (lucasextras.uk.epcastingportal.com)
    if (/epcastingportal\.com|entertainmentpartners/i.test(fromEmail || "")) return true;
    for (var i = 0; i < AGENCIES.length; i++) if (AGENCIES[i][1].test(who)) return true;
    var names = extraNames || [];
    for (var j = 0; j < names.length; j++) {
      var n = String(names[j] || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (n.length >= 5 && who.toLowerCase().replace(/[^a-z0-9@.]/g, "").indexOf(n) !== -1) return true;
    }
    return false;
  }

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  var MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

  // One regular expression that finds any of the date styles. The order matters:
  //  1) "14 Oct 2026", "9th October", "2nd of November"
  //  2) "Oct 06, 2026", "October 9th"
  //  3) "14/10/2026", "14/10"
  //  4) a lonely "12th" (the month comes from elsewhere in the email)
  var DATE_RE = new RegExp(
    "\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?[\\s-]+" + MON + "\\b\\.?(?:,?\\s+(\\d{4}))?" +
    "|\\b" + MON + "\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?" +
    "|\\b(\\d{1,2})[\\/.](\\d{1,2})(?:[\\/.](\\d{2,4}))?\\b" +
    "|\\b(\\d{1,2})(st|nd|rd|th)\\b",
    "gi"
  );

  // ---------- small helpers ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function toKey(y, m, d) { return y + "-" + pad(m) + "-" + pad(d); }
  function monthNumber(word) { return MONTHS[word.slice(0, 3).toLowerCase()]; }
  function clean(s) { return String(s || "").replace(/\s+/g, " ").replace(/^[\s:|\-–—@*]+|[\s:|\-–—*]+$/g, "").trim(); }
  function validDay(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var t = new Date(y, m - 1, d);
    return t.getMonth() === m - 1;
  }

  // Pick the year for a date written without one: the next time that day comes round
  // after the email arrived (allowing two weeks back, for emails about this week).
  function guessYear(m, d, received) {
    var r = received.split("-").map(Number);
    var y = r[0];
    var candidate = new Date(y, m - 1, d);
    var limit = new Date(r[0], r[1] - 1, r[2] - 14);
    if (candidate < limit) y = y + 1;
    return y;
  }

  // ---------- turn an HTML email into plain lines of text ----------
  function htmlToText(html) {
    var s = String(html || "");
    s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ");
    s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, " $1 ");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/(p|div|tr|li|h\d|table|ul|ol)>/gi, "\n");
    s = s.replace(/<\/t[dh]>/gi, " | ");
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
         .replace(/&quot;/gi, '"').replace(/&#39;|&rsquo;|&lsquo;/gi, "'").replace(/&pound;/gi, "£")
         .replace(/&ndash;|&mdash;/gi, "-").replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); });
    return s.split("\n").map(function (l) { return l.replace(/[ \t ]+/g, " ").replace(/^\s*\|\s*/, "").replace(/\s*\|\s*$/, "").trim(); })
            .filter(function (l, i, arr) { return l || (arr[i - 1] && arr[i - 1].trim()); })
            .join("\n");
  }

  // ---------- is this email an availability check? ----------
  function isAvailabilityCheck(subject, text) {
    var subj = subject || "";
    var start = (text || "").slice(0, 2500);
    var not = /thank you for (letting us know|responding)|invoice|newsletter|payment|remittance|password|verify your|booking confirmation|call ?sheet/i;
    if (not.test(subj)) return false;
    var yes = /availab|av check|\bavail\b|enquiry|put you forward|1st option|2nd option|pencil|are you free|who'?s available|are you available/i;
    return yes.test(subj) || yes.test(start);
  }

  // ---------- find a labelled value, e.g. "Project: Army Of Shadows" ----------
  function field(lines, labels) {
    for (var i = 0; i < lines.length; i++) {
      for (var j = 0; j < labels.length; j++) {
        var re = new RegExp("^\\s*" + labels[j] + "\\s*[:\\-–|@]+\\s*(.*)$", "i");
        var m = lines[i].match(re);
        if (m) {
          var value = clean(m[1]);
          if (!value && lines[i + 1]) value = clean(lines[i + 1]);   // value on the next line (tables)
          if (value) return value.slice(0, 160);
        }
      }
    }
    return "";
  }

  function findAgency(fromName, fromEmail, text) {
    var i;
    for (i = 0; i < AGENCIES.length; i++) if (AGENCIES[i][1].test(fromName || "")) return AGENCIES[i][0];
    var domain = String(fromEmail || "").split("@")[1] || "";
    for (i = 0; i < AGENCIES.length; i++) if (AGENCIES[i][1].test(domain)) return AGENCIES[i][0];
    // otherwise: the agency whose name appears first in the email
    var best = null, bestPos = Infinity;
    for (i = 0; i < AGENCIES.length; i++) {
      var m = AGENCIES[i][1].exec(text || "");
      if (m && m.index < bestPos) { best = AGENCIES[i][0]; bestPos = m.index; }
    }
    return best || clean(fromName);
  }

  function projectFromSubject(subject) {
    var s = subject || "", m;
    if ((m = s.match(/availability request\s*\(\s*([^)]+?)\s*\)/i))) return m[1];
    if ((m = s.match(/AV Check\s*-\s*([^-]+)/i))) return m[1];
    if ((m = s.match(/Availability Check\s*-\s*([^-]+)/i))) return m[1];
    if ((m = s.match(/option with\s+(.+?)\s+-\s+/i))) return m[1];
    if ((m = s.match(/\*\*\s*(.+?)\s*\*\*/))) return m[1];
    if ((m = s.match(/^\s*['‘"“](.+?)['’"”]/))) return m[1];
    m = s.match(/availability (?:request|enquiry|check) (?:on|for)\s+([^,]+?)(?:,|$)/i);
    if (m && !new RegExp(DATE_RE.source, "i").test(m[1])) return m[1];
    return "";
  }

  // ---------- reply deadline ----------
  function findRespondBy(lines, received) {
    var re = new RegExp("\\bby\\s+(?:today,?\\s+)?(?:[a-z]+day,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+" + MON + "[a-z]*\\.?(?:\\s+(\\d{4}))?,?\\s+(?:at\\s+)?(\\d{1,2})[:.](\\d{2})", "i");
    for (var i = 0; i < lines.length; i++) {
      if (!/expire|respond|reply|deadline/i.test(lines[i])) continue;
      var m = lines[i].match(re);
      if (m) {
        var d = +m[1], mo = monthNumber(m[2]);
        var y = m[3] ? +m[3] : guessYear(mo, d, received);
        if (validDay(y, mo, d)) return toKey(y, mo, d) + "T" + pad(+m[4]) + ":" + m[5];
      }
    }
    return null;
  }

  // ---------- all the dates, sorted into fittings and shoot days ----------
  function findDates(lines, subject, received) {
    var out = [], seen = {};
    var mode = "film";          // what the dates are, until a heading says otherwise
    var lastMonth = null, lastYear = null;
    var skip = /expire|respond|reply by|deadline|privacy|unsubscribe|updated our|sent from|copyright|recently including/i;
    var all = [subject || ""].concat(lines);

    for (var i = 0; i < all.length; i++) {
      var line = all[i];
      var lower = line.toLowerCase();
      // a heading such as "FITTING:", "Fittings -", "SHOOT DATES:", "FILMING -"
      // (tables put several cells on one line, separated by "|": each cell can be a heading)
      var cells = line.split("|");
      for (var c = 0; c < cells.length; c++) {
        if (/^\W*(costume\s+)?fit(ting)?s?\b/i.test(cells[c])) mode = "fit";
        else if (/^\W*(film(ing)?|shoot(ing)?|dates?|shoot dates?|filming dates?|production dates?)\b/i.test(cells[c])) mode = "film";
      }
      if (i > 0 && skip.test(line)) continue;

      var found = [], pendingOrdinals = [], m;
      DATE_RE.lastIndex = 0;
      while ((m = DATE_RE.exec(line))) {
        var d, mo, y = null;
        if (m[1]) { d = +m[1]; mo = monthNumber(m[2]); if (m[3]) y = +m[3]; }
        else if (m[4]) { mo = monthNumber(m[4]); d = +m[5]; if (m[6]) y = +m[6]; }
        else if (m[7]) {
          if (/[£%]/.test(line)) continue;
          d = +m[7]; mo = +m[8];
          if (m[9]) y = m[9].length === 2 ? 2000 + +m[9] : +m[9];
        } else {
          // "1st option", "2nd AD" are not dates
          if (/^\s*(option|choice|ad\b|assistant|class|floor|time|place|call|avail)/i.test(line.slice(m.index + m[0].length))) continue;
          pendingOrdinals.push({ d: +m[10], at: m.index });
          continue;
        }
        if (!mo) continue;
        // lonely ordinals before this date in the same line take this month ("4th & 5th Nov")
        pendingOrdinals.forEach(function (o) { found.push({ d: o.d, mo: mo, y: y, at: o.at }); });
        pendingOrdinals = [];
        found.push({ d: d, mo: mo, y: y, at: m.index });
        lastMonth = mo; lastYear = y;
      }
      // lonely ordinals with no month in the line ("11th 12th and 13th possible dates")
      pendingOrdinals.forEach(function (o) {
        if (lastMonth) found.push({ d: o.d, mo: lastMonth, y: lastYear, at: o.at });
      });

      for (var k = 0; k < found.length; k++) {
        var f = found[k];
        var year = f.y || guessYear(f.mo, f.d, received);
        if (!validDay(year, f.mo, f.d)) continue;
        // the kind of day: a word in the same line wins ("available to fit on 14 Aug")
        var before = lower.slice(0, f.at);
        var fitPos = Math.max(before.lastIndexOf("fit"), before.lastIndexOf("costume"));
        var filmPos = Math.max(before.lastIndexOf("film"), before.lastIndexOf("shoot"));
        var kind = mode;
        if (fitPos > filmPos) kind = "fit";
        else if (filmPos > fitPos) kind = "film";
        else if (/\bfit(ting)?s?\b/i.test(line) && !/film|shoot/i.test(line)) kind = "fit";

        var entry = { d: toKey(year, f.mo, f.d), kind: kind };
        var at = line.slice(f.at).match(/@\s*([^(|]+?)(?:\s*\(|\s+-\s|\s*\||\s+\d{3,4}\s*-|$)/);
        if (at) entry.loc = clean(at[1]).slice(0, 60);
        if (/night/i.test(line)) entry.night = true;
        var id = entry.d + entry.kind;
        if (seen[id]) {                       // same day again: keep extra details
          if (entry.loc && !seen[id].loc) seen[id].loc = entry.loc;
          if (entry.night) seen[id].night = true;
          continue;
        }
        seen[id] = entry;
        out.push(entry);
      }
    }
    out.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    return out;
  }

  // ---------- the main job ----------
  // email = { subject, fromName, fromEmail, text (or html), received: "YYYY-MM-DD" }
  function parseEmail(email) {
    var received = email.received || new Date().toISOString().slice(0, 10);
    var text = email.text && email.text.trim() ? email.text : htmlToText(email.html || "");
    var subject = email.subject || "";
    var lines = text.split("\n").map(function (l) { return l.trim(); });

    var project = field(lines, ["Project Title", "Project", "Production", "Company"]) || projectFromSubject(subject);
    if (!project) {
      for (var i = 0; i < lines.length - 1; i++) {
        if (/availability enquiry for:?\s*$/i.test(lines[i])) {
          for (var j = i + 1; j < lines.length && j < i + 4; j++) if (lines[j]) { project = lines[j]; break; }
        }
      }
    }
    var mp = !project && text.match(/new project\s*\**\s*([^*.\n]+?)\s*\**\s*[.\n]/i);
    if (mp) project = mp[1];
    project = clean(project).replace(/\s*\(.*?\)\s*$/, "").slice(0, 80);

    var role = field(lines, ["Role", "Roles", "Role\\/Character", "Character", "Product"]);
    if (!role) {
      var mr = text.match(/looking for (?:someone|people|SAs?) to (?:be|play) (?:a |an )?([^!.\n]+)/i);
      if (mr) role = mr[1];
    }
    var ms = subject.match(/option with\s+.+?\s+-\s+(.+)$/i);
    if (!role && ms) role = ms[1];

    var call = {
      project: project,
      agency: findAgency(email.fromName, email.fromEmail, text),
      role: clean(role).slice(0, 80),
      location: field(lines, ["Location", "Shoot Location", "Filming Location", "Studio", "Where"]),
      fitLocation: field(lines, ["Fitting Location", "Fittings? Venue"]),
      filmLocation: field(lines, ["Shoot Location", "Filming Location"]),
      rate: field(lines, ["Rate of Pay", "Rates?", "Day Rate", "Pay", "Fee"]),
      respondBy: findRespondBy(lines, received),
      dates: findDates(lines, subject, received),
      received: received,
      notes: ""
    };

    // a few useful lines for the notes
    var keep = /photo id|haircut|hair cut|parking|pick ?ups?|call times?|digi-?fit|1st option|2nd option|firearms|night shoot|travel|accommodation|tbc/i;
    var notes = [];
    lines.forEach(function (l) { if (l.length > 8 && l.length < 220 && keep.test(l) && notes.length < 4) notes.push(clean(l)); });
    call.notes = notes.join(" • ");

    var missing = [];
    if (!call.project) missing.push("production");
    if (!call.dates.length) missing.push("dates");
    if (!call.agency) missing.push("agency");
    call.review = missing.length > 0;
    call.reviewReason = missing.length ? "Couldn't find: " + missing.join(", ") : "";
    return call;
  }

  var api = { parseEmail: parseEmail, htmlToText: htmlToText, isAvailabilityCheck: isAvailabilityCheck, isFromCastingAgency: isFromCastingAgency, AGENCIES: AGENCIES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EmailParser = api;
})(this);
