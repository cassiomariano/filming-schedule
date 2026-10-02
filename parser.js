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
    // form fields on reply pages: ticked = ☒, not ticked = ☐, typed answers keep their value
    s = s.replace(/<input\b[^>]*>/gi, function (tag) {
      if (/type\s*=\s*["']?(radio|checkbox)/i.test(tag)) return /\bchecked\b/i.test(tag) ? " ☒ " : " ☐ ";
      var v = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
      return /type\s*=\s*["']?(hidden|submit|button)/i.test(tag) || !v ? " " : " " + v[1] + " ";
    });
    s = s.replace(/<textarea[^>]*>([\s\S]*?)<\/textarea>/gi, " $1 ");
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
  // Words in a SUBJECT that mean "this is not a new availability check"
  // (thank-you notes, reviews, invitations, reminders, payments, bookings...)
  var NOT_A_CALL = /thank|review|invit|reminder|newsletter|survey|feedback|payment|paid|invoice|remittance|timesheet|call ?sheet|password|verify|welcome|receipt|profile|update your|your (account|details)|confirm|booked|booking|released|release|cancel|unavailable|no longer/i;
  // Phrases that only appear in real availability checks
  var CALL_PHRASES = /availability (enquiry|request|check)|\bav ?check|\bavail\.? ?check|are you (free|available)|who'?s available|put you forward|1st option|2nd option|first option|pencil(led)? (you|for)|let us know (if|who)[^.]{0,40}availab/i;

  function isAvailabilityCheck(subject, text) {
    var subj = subject || "";
    if (NOT_A_CALL.test(subj)) return false;
    return CALL_PHRASES.test(subj) || CALL_PHRASES.test((text || "").slice(0, 3000));
  }

  // ---------- call times ----------
  var CALL_TIME_SUBJECT = /call ?time|call ?sheet|callsheet|unit call|your call\b|call details|tomorrow'?s call|call for (mon|tue|wed|thu|fri|sat|sun)|filming tomorrow|costume information|filming update|update\s*[-–:]\s*(filming|film|costume)/i;

  // Reads "Call time: 06:30" / "CALL 0630" / "call 6.30am" and the meeting place.
  // Returns {time: "06:30", place: "...", dates: [...]} (time "" when not found).
  function parseCallTime(email) {
    var text = email.text && email.text.trim() ? email.text : htmlToText(email.html || "");
    var lines = text.split("\n").map(function (l) { return l.trim(); });
    var time = "";
    var all = (email.subject || "") + "\n" + text;
    var m = all.match(/\bcall(?:\s*time)?\s*(?:is|at|:|-|–|@)?\s*(\d{1,2})[:.]?(\d{2})?\s*(am|pm|hrs|hours)?\b/i) ||
            all.match(/\b(?:arrival|arrive|report(?:ing)?|check[- ]?in|sign[- ]?in|be at (?:unit )?base|be on set|start)[^\n\d]{0,30}?(\d{1,2})[:.](\d{2})\s*(am|pm|hrs|hours)?\b/i) ||
            all.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm|hrs)\b/i);
    if (m) {
      var h = +m[1], min = m[2] ? +m[2] : 0, ap = (m[3] || "").toLowerCase();
      if (!m[2] && !ap && m[1].length <= 2 && h > 12) h = NaN;          // "call 23" alone is not a time
      if (m[1].length === 4 && !m[2]) { h = +m[1].slice(0, 2); min = +m[1].slice(2); }
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      if (h >= 0 && h < 24 && min < 60) time = pad(h) + ":" + pad(min);
    }
    var place = field(lines, ["Unit Base", "Unit base location", "Location", "Address", "Report to", "Reporting to", "Venue", "Studio", "Meeting point", "Where"]);
    if (!place && m) {                                   // "CALL 0545 at Unit Base, Brixton SW2 1AA"
      var after = all.slice(all.indexOf(m[0]) + m[0].length).match(/^\s*(?:at|@)\s+([^\n.]{4,90})/i);
      if (after) place = clean(after[1]);
    }
    var received = email.received || new Date().toISOString().slice(0, 10);
    var dates = findDates(lines, email.subject || "", received);
    if (!dates.length && /tomorrow/i.test(all)) {        // "your call for tomorrow"
      var t = new Date(received + "T12:00:00"); t.setDate(t.getDate() + 1);
      dates = [{ d: toKey(t.getFullYear(), t.getMonth() + 1, t.getDate()), kind: "film" }];
    }
    return { time: time, place: place, dates: dates };
  }

  // ---------- is this place in London? ----------
  // Studios and towns around London count as OUTSIDE London (they need travel planning).
  var OUTSIDE = /shepperton|pinewood|leavesden|watford|elstree|borehamwood|longcross|chertsey|bovingdon|hemel|\biver\b|sunbury|windsor|ascot|slough|reading|bray|dorset|surrey|bucks|buckinghamshire|herts|hertfordshire|kent|essex|sussex|lewes|cardiff|newport|wales|manchester|liverpool|leeds|hull|birmingham|bristol|scotland|edinburgh|glasgow|yorkshire|portsmouth|brighton|oxford|cambridge|esher|sandown|camberley|aldershot|amersham|beaconsfield|chatham|uckfield|madrid|spain|portugal|radlett|\bAL\d|\bWD\d|\bSL\d|\bHP\d|\bGU\d|\bRG\d/i;
  var LONDON = /london|\b(E|EC|N|NW|SE|SW|W|WC)\d{1,2}[A-Z]?\b|acton|barbican|brixton|camden|hammersmith|wembley|ealing|greenwich|bethnal|canary wharf|clapham|deptford|depford|hendon|park royal|stratford|olympic park|olimpic|croydon|twickenham|richmond|barnet|islington|hackney|shoreditch|soho|westminster|kensington|chelsea|fulham|wimbledon|lewisham|woolwich|plumstead|hampstead|camberwell|peckham|bermondsey|southwark|lambeth|battersea|wandsworth|tottenham|walthamstow|ilford|romford|uxbridge|hayes|harrow|enfield|brentford|chiswick|st james|mayfair|kings cross|paddington|piccadilly|three mills|twickenham/i;
  // "london" | "outside" | "" (unknown)
  function londonCheck(place) {
    var p = String(place || "").trim();
    if (!p || /^tbc$/i.test(p)) return "";
    if (OUTSIDE.test(p)) return "outside";
    if (LONDON.test(p)) return "london";
    return "outside";
  }

  // In a "thank you for replying" email: did you say available or not?
  function replyAnswer(subject, text) {
    var t = (subject || "") + " " + (text || "").slice(0, 1500);
    return /\bunavailable\b|not available|can'?t attend|cannot attend|declined/i.test(t) ? "declined" : "available";
  }

  // ---------- the agency's reply links (Respond / Yes / No) ----------
  // Returns up to 4 links: {kind: "yes" | "no" | "respond", text, url}.
  // These are only SHOWN in the app for you to tap. The robot never opens them,
  // because opening a "Yes, I can attend" link could answer for you.
  function extractLinks(html) {
    var out = [], seen = {}, m;
    var re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var skip = /unsubscribe|privacy|policy|facebook|twitter|instagram|x\.com\/|linkedin|tiktok|newsletter|sign.?up|art_edit|profile|rates|faq|mailto:|tel:|google\.com\/calendar|maps\./i;
    while ((m = re.exec(html || ""))) {
      var url = m[1].replace(/&amp;/g, "&").trim();
      var text = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      if (!/^https?:\/\//i.test(url) || skip.test(url) || skip.test(text) || seen[url]) continue;
      var kind = null;
      if (/\bno\b|can'?t|cannot|unavailable|not available|decline/i.test(text)) kind = "no";
      else if (/\byes\b|i can attend|i'?m available|i am available|accept/i.test(text)) kind = "yes";
      else if (/respond|reply|availab|open message|view|answer|click here/i.test(text) || /availab|respond|epcastingportal|enquir/i.test(url)) kind = "respond";
      if (!kind) continue;
      seen[url] = true;
      out.push({ kind: kind, text: text.slice(0, 40) || "Respond", url: url });
    }
    return out.slice(0, 4);
  }

  // What kind of agency email is this?
  //   "call"     a new availability check  -> becomes a New call
  //   "booked"   a booking confirmation    -> marks the matching call Confirmed
  //   "released" a release / cancellation  -> marks the matching call Released
  //   "replied"  the agency confirming your answer -> marks the call Available or Declined
  //   "calltime" call time / call sheet details -> adds the call time and place to that day
  //   null       anything else             -> ignored
  function classifyEmail(subject, text) {
    var subj = subject || "";
    // releases and bookings first: they often start with "Thank you for being available..."
    if (/you have (new )?booking updates?/i.test(subj)) return "epupdate";        // EP: "You have booking updates on …"
    if (/\breleased?\b|cancel+ed|cancellation|no longer (needed|required)|not (required|selected|needed)|unsuccessful|stood down/i.test(subj)) return "released";
    if (CALL_TIME_SUBJECT.test(subj)) return "calltime";
    if (/booking confirm|confirmed booking|you('| a)re booked|you have been booked|booked (for|on)|booking:\s|is confirmed|^\W*booked\b|^\W*booking\s*[-–:]|booking details|confirmed (fitting|day|date|dates|for)|confirm(ation of)? your dates|^\W*confirmation\b/i.test(subj)) return "booked";
    // a release written in the email itself ("Thank you for your availability, unfortunately you are not required")
    var top = String(text || "").slice(0, 1500);
    var looksLikeAv = /\bav\b|availability (check|request|enquiry)|are you available|availability for/i.test(subj) || /\bif (you|we)\b[^.]{0,40}(not (be )?required|released)/i.test(top);
    if (!looksLikeAv && /(you have been|you've been|you are|you're|we have|we've) (now )?(released|stood down)|released you|(will not|won't|no longer) (be )?(need|requir)|not (be )?(required|needed) (for|on|any ?more)|(have not|haven't|were not|weren't) been (selected|chosen|successful)|has been cancel+ed|(filming|shoot|job|booking) (is |has been )?cancel+ed/i.test(top)) return "released";
    // the agency confirming YOUR reply ("Thank you for letting us know that you are available")
    if (/thank you for (letting us know|responding|your (response|reply)|being (un)?available|confirming)/i.test(subj)) return "replied";
    if (/thank|review|invit|newsletter|survey|payment|invoice/i.test(subj)) return null;
    return isAvailabilityCheck(subj, text) ? "call" : null;
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
    // "Thank you for being Available on Falcon - You have been RELEASED!"
    if ((m = s.match(/\bavailable (?:on|for)\s+(.+?)\s*(?:[-–!|:]|$)/i))) return m[1];
    if ((m = s.match(/\breleased (?:from|on)\s+(.+?)\s*(?:[-–!|:]|$)/i))) return m[1];
    if ((m = s.match(/\bbooked (?:on|for)\s+(.+?)\s*(?:[-–!|:]|$)/i))) return m[1];
    if ((m = s.match(/booking confirm\w*\s*[-–:]\s*([^-–|]+)/i))) return m[1];
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
    var re = new RegExp("\\bby\\s+(?:to(?:day|morrow),?\\s+)?(?:[a-z]+day,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+" + MON + "[a-z]*\\.?(?:\\s+(\\d{4}))?,?\\s+(?:at\\s+)?(\\d{1,2})[:.](\\d{2})", "i");
    for (var i = 0; i < lines.length; i++) {
      if (!/expire|respond|reply|deadline/i.test(lines[i])) continue;
      var line = lines[i];
      if (/before:?\s*$/i.test(line)) {                  // the date is on the next line
        for (var j = i + 1; j < lines.length && j < i + 4; j++) if (lines[j]) { line = "by " + lines[j]; break; }
      }
      var m = line.replace(/\bbefore\b/i, "by").match(re);
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
        if (/^\W*rehears/i.test(cells[c])) mode = "reh";
        else if (/^\W*(costume\s+)?fit(ting)?s?\b/i.test(cells[c])) mode = "fit";
        else if (/^\W*(film(ing)?|shoot(ing)?|dates?|shoot dates?|filming dates?|production dates?)\b/i.test(cells[c])) mode = "film";
      }
      if (i > 0 && skip.test(line)) continue;
      // the reply deadline on the line after "Please respond before:" is not a work day
      var prev = (all[i - 1] || "") || (all[i - 2] || "");
      if (i > 0 && /(respond|reply) before:?\s*$|deadline:?\s*$|expires?:?\s*$/i.test(prev)) continue;
      // EP pages put "(Rehearsals in Epsom)" on the line under the date: read them together
      if (all[i + 1] && /^\(/.test(all[i + 1]) && /\d/.test(line)) { line = line + " " + all[i + 1]; lower = line.toLowerCase(); i++; }

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
      // ranges: "2nd to 6th November", "9th - 13th Nov", "Mon 2 - Fri 6 Nov"
      var RANGE = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|until|till|through|thru)\\s*(?:[a-z]{3,9}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+" + MON + "\\b(?:\\s+(\\d{4}))?", "gi");
      var r;
      while ((r = RANGE.exec(line))) {
        var a = +r[1], b = +r[2], rmo = monthNumber(r[3]), ry = r[4] ? +r[4] : null;
        if (rmo && b > a && b - a <= 31) for (var dd = a; dd <= b; dd++) found.push({ d: dd, mo: rmo, y: ry, at: r.index });
        lastMonth = rmo;
      }

      for (var k = 0; k < found.length; k++) {
        var f = found[k];
        var year = f.y || guessYear(f.mo, f.d, received);
        if (!validDay(year, f.mo, f.d)) continue;
        // the kind of day: a word in the same line wins ("available to fit on 14 Aug")
        var before = lower.slice(0, f.at);
        var fitPos = Math.max(before.lastIndexOf("fit"), before.lastIndexOf("costume"));
        var filmPos = Math.max(before.lastIndexOf("film"), before.lastIndexOf("shoot"));
        var rehPos = before.lastIndexOf("rehears");
        var kind = mode;
        if (rehPos > fitPos && rehPos > filmPos) kind = "reh";
        else if (fitPos > filmPos) kind = "fit";
        else if (filmPos > fitPos) kind = "film";
        else if (/rehears/i.test(line)) kind = "reh";
        else if (/\bfit(ting)?s?\b/i.test(line) && !/film|shoot/i.test(line)) kind = "fit";

        var entry = { d: toKey(year, f.mo, f.d), kind: kind };
        var at = line.slice(f.at).match(/@\s*([^(|]+?)(?:\s*\(|\s+-\s|\s*\||\s+\d{3,4}\s*-|$)/);
        if (at) entry.loc = clean(at[1]).slice(0, 60);
        if (!entry.loc) {                                 // "30th October in Epsom", "(Filming in Epsom)"
          var inPlace = line.slice(f.at).match(/\b(?:in|at)\s+([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})/);
          if (inPlace && !/^(the|a|an)$/i.test(inPlace[1])) entry.loc = inPlace[1].slice(0, 60);
        }
        // your answer on an EP page: "☒ Available ☐ Not available"
        if (/☒\s*not available/i.test(line)) entry.answer = "no";
        else if (/☒\s*available/i.test(line)) entry.answer = "yes";
        if (/night/i.test(line)) entry.night = true;
        // in a booking email: days kept "available / on hold" rather than confirmed
        if (/pencil|on hold|\bhold\b|stand ?-?by|remain(ing)? available|still available|keep .{0,20}available|provisional|to be confirmed|\btbc\b/i.test(line)) entry.hold = true;
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

    var project = field(lines, ["Project Title", "Project", "Production", "Company"]);
    if (!project) {                          // Entertainment Partners: "You have an availability enquiry for:" + name
      for (var i = 0; i < lines.length - 1 && !project; i++) {
        if (/availability (enquiry|request) for:?\s*$/i.test(lines[i])) {
          for (var j = i + 1; j < lines.length && j < i + 4; j++) if (lines[j]) { project = lines[j]; break; }
        }
      }
    }
    if (!project) project = projectFromSubject(subject);
    // "a new TV SERIES! Please reply ASAP" describes the job, it is not its name
    if (/^(a|an|the)?\s*(new|major|big|exciting|urgent|top)\b|please (reply|view|respond)|asap/i.test(project || "")) project = "";
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

  var api = { parseEmail: parseEmail, htmlToText: htmlToText, isAvailabilityCheck: isAvailabilityCheck, classifyEmail: classifyEmail, parseCallTime: parseCallTime, londonCheck: londonCheck, CALL_TIME_SUBJECT: CALL_TIME_SUBJECT, replyAnswer: replyAnswer, extractLinks: extractLinks, isFromCastingAgency: isFromCastingAgency, AGENCIES: AGENCIES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EmailParser = api;
})(this);
