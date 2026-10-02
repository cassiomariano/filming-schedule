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
  // weekday names: "Wed", "Wednesday", "Thurs"... (written out so "sunset" is not read as Sunday)
  var WEEKDAY = "(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
  var DAY_NUMBER = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

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
  // ("thank" must be the word "thanks" / "thank you": "Thanksgiving scenes" is still a job)
  var NOT_A_CALL = /\bthank(s| you)\b|review|invit|reminder|newsletter|survey|feedback|payment|paid|invoice|remittance|timesheet|call ?sheet|password|verify|welcome|receipt|profile|update your|new photos|headshots?|your (account|details)|confirm(?! (your |my )?availab)|booked|booking|released|release|cancel|unavailable|no longer/i;
  // Phrases that only appear in real availability checks
  var CALL_PHRASES = /availability (enquiry|request|check)|confirm (your |my )?availab|\bav ?check|\bavail\.? ?check|are you (free|available)|who'?s available|put you forward|1st option|2nd option|first option|pencil(led)? (you|for)|(possible|pencil(led)?|provisional) booking|let us know (if|who)[^.]{0,40}availab/i;
  // A subject that clearly asks "are you available?"
  var AV_SUBJECT = /\bav\b|\bav ?check|\bavail\.? ?check|availability (check|request|enquiry)|availability for|are you (free|available|around)|who'?s (free|available)|(possible|pencil(led)?|provisional) booking/i;

  function isAvailabilityCheck(subject, text) {
    var subj = subject || "";
    // "Possible booking" / "Pencil booking" is still only a check, not a booking
    subj = subj.replace(/\b(possible|pencil(led)?|provisional) booking/gi, "possible job");
    // "Please confirm your dates - AV check": the word "confirm" does not make it a booking
    if (/\bav ?check|\bavail\.? ?check|availability (check|request|enquiry)/i.test(subj)) subj = subj.replace(/confirm\w*/gi, "");
    if (NOT_A_CALL.test(subj)) return false;
    return CALL_PHRASES.test(subject || "") || CALL_PHRASES.test((text || "").slice(0, 3000));
  }

  // ---------- call times ----------
  var CALL_TIME_SUBJECT = /call ?time|call ?sheet|callsheet|unit call|your call\b|call details|tomorrow'?s call|call for (mon|tue|wed|thu|fri|sat|sun)|filming tomorrow|costume information|filming update|update\s*[-–:]\s*(filming|film|costume)/i;

  // Reads "Call time: 06:30" / "CALL 0630" / "call 6.30am" and the meeting place.
  // Returns {time: "06:30", place: "...", dates: [...]} (time "" when not found).
  // "call 0630", "Call time: 06:30", "call 6.30am". The time must not be followed by more
  // numbers, so a phone number ("call 020 8123 4567") is never read as a time.
  var CALL_AT = /\bcall(?:\s*time)?\s*(?:is|at|:|-|–|@)?\s*(\d{1,2})[:.]?(\d{2})?\s*(am|pm|hrs|hours)?\b(?!\s*\d)/i;
  // words for YOUR call (supporting artists / background), not the crew's "Unit call"
  var SA_WORDS = /\b(sas?|s\.a\.s?|supporting artists?|background( artists?)?|crowd)\b/i;

  function parseCallTime(email) {
    var text = email.text && email.text.trim() ? email.text : htmlToText(email.html || "");
    var lines = text.split("\n").map(function (l) { return l.trim(); });
    var time = "";
    var all = (email.subject || "") + "\n" + text;
    var m = null;
    // first choice: a line with the SA / background call ("Unit call 06:00 | SA call 07:30")
    for (var i = 0; i < lines.length && !m; i++) {
      var sa = lines[i].match(SA_WORDS);
      if (sa && /\bcall/i.test(lines[i])) {
        var part = lines[i].slice(sa.index);
        m = part.match(CALL_AT) || part.match(/\b(\d{1,2})[:.](\d{2})\s*(am|pm|hrs)?\b/i);
      }
    }
    m = m || all.match(CALL_AT) ||
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
  // "Thank you for letting us know that you are available" → available; "...not available" → declined.
  // The subject decides when it can. The body is only read for a sentence about YOU
  // ("you are not available"), because these emails often repeat the "Available / Not available"
  // choices or say "if you become unavailable", which says nothing about your answer.
  function replyAnswer(subject, text) {
    var s = subject || "";
    if (/\b(un)?available\b|not available|can'?t attend|cannot attend|declin/i.test(s))
      return /\bunavailable\b|not available|can'?t attend|cannot attend|declin/i.test(s) ? "declined" : "available";
    // leave out sentences that start with "if" ("If you are not available any more, let us know"):
    // they say what to do later, not what you answered
    var t = String(text || "").slice(0, 2000).split(/[.!?\n]+/).filter(function (sentence) {
      return !/^\s*(if|should)\b/i.test(sentence);
    }).join(". ");
    // a ticked box on the reply page: "☐ Available ☒ Not available"
    if (/☒\s*(not available|unavailable)/i.test(t)) return "declined";
    if (/☒\s*available/i.test(t)) return "available";
    // sentences saying you can't do it
    if (DECLINED.test(t)) return "declined";
    return "available";
  }
  // "you are not available", "Sorry you can't make it", "you are unable to attend",
  // "Your response: Not available", "You have responded Not Available", "you're not free"
  var DECLINED = /(you are|you're|you have said you are|you said you are|you've told us you are) (not |un)available|you('re| are) not (available|free)|(you are|you're) unable to (attend|make|work|do)|(you|your) (have )?declined|you can'?t (attend|make|do|work)|you cannot (attend|make|do|work)|your (response|answer|reply)( is| was)?\s*:?\s*["'“]?(not available|unavailable|declined?|no\b)|you (have )?(responded|replied|answered)( with)?\s*:?\s*["'“]?(not available|unavailable|no\b)/i;

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
  // Agents writing personally ("Supporting artist required – 23rd June, let me know"): from a known
  // agency + a date + wording like this counts as an availability check
  var CALL_LOOSE = /\b(supporting |background )?artists?\b|\bSAs?\b|\bextras?\b|required|looking for|needed|wanted|let me know|are you around|can you (do|make|work)|would you be|casting for|interested in/i;
  // a real date: needs a month name ("23rd June", "Oct 6") or a weekday ("Wed 14th").
  // Times like "9.30 - 5.30" do not count.
  var HAS_DATE = new RegExp("\\b\\d{1,2}(st|nd|rd|th)?\\s*(of\\s+)?" + MON + "\\b|\\b" + MON + "\\.?\\s+\\d{1,2}(st|nd|rd|th)?\\b|\\b" + WEEKDAY + "\\.?,?\\s+\\d{1,2}(st|nd|rd|th)?\\b(?![.:]\\d)", "i");

  // Phrases that always mean "you are released", even in an "Availability check" email
  var STRONG_RELEASE = /(have not|haven't) been selected|you have been released|you've been released|we have released you|we've released you/gi;
  // Release words in a subject
  var SUBJECT_RELEASE = /\breleased?\b|cancel+ed|cancellation|no longer (needed|required)|not (required|selected|needed)|unsuccessful|stood down/gi;
  // Release sentences in the email itself ("Thank you for your availability, unfortunately you are not required")
  var BODY_RELEASE = /(you have been|you've been|you are|you're|we have|we've) (now )?(released|stood down)|released you|(will not|won't|no longer) (be )?(need|requir)|not (be )?(required|needed) (for|on|any ?more)|(have not|haven't|were not|weren't) been (selected|chosen|successful)|has been cancel+ed|(filming|shoot|job|booking) (is |has been )?cancel+ed/gi;
  // Booking confirmation subjects
  var BOOKED_SUBJECT = /booking confirm|confirmed booking|you('| a)re booked|you have been booked|booked (for|on)|booking:\s|is confirmed|^\W*booked\b|^\W*booking\s*[-–:]|booking details|confirmed (fitting|day|date|dates|for)|confirm(ation of)? your dates|^\W*confirmation\b/i;

  // Is a release phrase really about YOU? Not when its sentence starts with "if"
  // ("If you have not been selected you won't hear from us"), and (when checkTopic is true)
  // not when it is about a fitting, costume, travel or photo ID ("a costume fitting is not required").
  function saysReleased(text, re, checkTopic) {
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      var start = Math.max(text.lastIndexOf(".", m.index), text.lastIndexOf("!", m.index),
                           text.lastIndexOf("?", m.index), text.lastIndexOf("\n", m.index)) + 1;
      var before = text.slice(start, m.index);
      var after = text.slice(m.index + m[0].length, m.index + m[0].length + 40).split(/[.!?\n]/)[0];
      if (/\b(if|unless|whether)\b/i.test(before)) continue;
      if (checkTopic && /fitting|costume|travel|photo ?id|parking|expenses/i.test(before + " " + after)) continue;
      return true;
    }
    return false;
  }

  function classifyEmail(subject, text, fromAgency) {
    var subj = subject || "";
    var top = String(text || "").slice(0, 1500);
    if (/you have (new )?booking updates?/i.test(subj)) return "epupdate";        // EP: "You have booking updates on …"
    // 1) "you have not been selected" / "you have been released" always means released
    if (saysReleased(subj + "\n" + top, STRONG_RELEASE, false)) return "released";
    // 2) release words in the subject ("Fitting not required" is about the fitting, not you)
    if (saysReleased(subj, SUBJECT_RELEASE, true)) return "released";
    // 3) a subject asking "are you free?" is a new check, even if it says "filming tomorrow" or "confirm"
    var asksAv = AV_SUBJECT.test(subj);
    // 4) bookings are checked BEFORE call times ("Booking Confirmation - X - call time to follow")
    if (!asksAv && BOOKED_SUBJECT.test(subj)) return "booked";
    if (!asksAv && CALL_TIME_SUBJECT.test(subj)) return "calltime";
    // 5) a release written in the email itself
    var looksLikeAv = asksAv || /\bif (you|we)\b[^.]{0,40}(not (be )?required|released)/i.test(top);
    if (!looksLikeAv && saysReleased(top, BODY_RELEASE, true)) return "released";
    // the agency confirming YOUR reply ("Thank you for letting us know that you are available")
    if (/thank you for (letting us know|responding|your (response|reply)|being (un)?available|confirming)/i.test(subj)) return "replied";
    if (/\bthank(s| you)\b|review|invit|newsletter|survey|payment|invoice/i.test(subj)) return null;
    if (isAvailabilityCheck(subj, text)) return "call";
    // requests for new photos / headshots / profile updates are not jobs
    if (/photo|headshot|selfie|profile|update your|measurements/i.test(subj)) return null;
    var top2 = String(text || "").slice(0, 3000);
    if (fromAgency && !NOT_A_CALL.test(subj) && CALL_LOOSE.test(subj + "\n" + top2) && HAS_DATE.test(subj + "\n" + top2)) return "call";
    return null;
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
  // Reads "by Friday 2nd October 12:00", "before: Friday 2 October 2026 09:00",
  // "no later than Thursday 8th Oct", "expire on Sunday 4 Oct at 23:59", "by 04/10/2026 17:00".
  // With no time given, the end of that day (23:59) is used.
  function findRespondBy(lines, received) {
    var re = new RegExp("\\bby\\s+(?:the\\s+)?(?:to(?:day|morrow),?\\s+)?(?:" + WEEKDAY + "\\.?,?\\s+)?" +
      "(?:(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+" + MON + "[a-z]*\\.?(?:,?\\s+(\\d{4}))?" +   // 2nd October 2026
      "|(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4}))" +                                                       // 04/10/2026
      "(?:,?\\s+(?:at\\s+)?(\\d{1,2})[:.](\\d{2})\\s*(am|pm)?)?", "i");                              // 12:00
    for (var i = 0; i < lines.length; i++) {
      // only lines that talk about replying
      if (!/expire|respond|reply|deadline|confirm|let (me|us) know|get back|no later than/i.test(lines[i])) continue;
      var line = lines[i];
      if (/before:?\s*$/i.test(line)) {                  // the date is on the next line
        for (var j = i + 1; j < lines.length && j < i + 4; j++) if (lines[j]) { line = "by " + lines[j]; break; }
      }
      // "before:", "no later than", "expire on" all mean "by"
      var m = line.replace(/\b(no later than|before|expires? on)\b:?/gi, "by").match(re);
      if (m) {
        var d, mo, y;
        if (m[2]) { d = +m[2]; mo = monthNumber(m[3]); y = m[4] ? +m[4] : guessYear(mo, d, received); }
        else { d = +m[5]; mo = +m[6]; y = +m[7]; }           // UK order: day/month/year
        var h = m[8] ? +m[8] : 23, min = m[9] ? m[9] : "59";
        if (m[10] && m[10].toLowerCase() === "pm" && h < 12) h += 12;
        if (validDay(y, mo, d)) return toKey(y, mo, d) + "T" + pad(h) + ":" + min;
      }
    }
    return null;
  }

  // ---------- all the dates, sorted into fittings and shoot days ----------
  // Words that say what kind of day it is. Whole words only: "outfit" is not a fitting.
  var FIT_WORD = /\bfit(ting)?s?\b/g;
  var FILM_WORD = /\bfilm|\bshoot/g;
  var REH_WORD = /\brehears/g;
  // a weekday just before a date: "Wed 14 Oct", "Tuesday, Oct 6"
  var WEEKDAY_BEFORE = new RegExp("\\b" + WEEKDAY + "\\.?,?\\s*$", "i");
  var WEEKDAY_AFTER = new RegExp("^\\s*\\(?" + WEEKDAY + "\\b", "i");
  // a reply deadline just before a date: "confirm by Friday 2nd October", "respond before: 2 Oct",
  // "no later than Thursday 8th Oct", "expire on Sunday 4 Oct" (these are not work days)
  var DEADLINE_BEFORE = new RegExp("\\b(by|before|no later than|expires?(?: on)?|deadline)\\b:?\\s*(?:to(?:day|morrow),?\\s*)?" +
    "(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:am|pm)?\\s*(?:on\\s+)?)?(?:" + WEEKDAY + "\\.?,?\\s*)?(?:the\\s+)?$", "i");
  // ...but only on a line about replying
  var DEADLINE_LINE = /confirm|let (me|us) know|get back|respond|reply|answer|expir|deadline|no later than/i;
  // ordinals that are not dates: "1st option", "1st or 2nd option", "1st/2nd option", "2nd unit",
  // "3rd party", "18th century", "2nd series"...
  var NOT_A_DAY = /^\s*(?:(?:or|and|&|\/|-)\s*\d{1,2}(?:st|nd|rd|th)\s*)?(option|choice|ad\b|assistant|class|floor|time|place|call|avail|unit|party|century|series|season|episode|round|day\b|week|year|half|team|generation|draft|attempt)/i;

  // where the last match of a word is in a piece of text (-1 if not there)
  function lastPos(text, re) {
    var pos = -1, m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) pos = m.index;
    return pos;
  }

  // the kind of day named in a short piece of text ("(fitting)", "- shoot"), or "" if none
  function kindOf(text) {
    var fit = text.search(/\bfit(ting)?s?\b/), film = text.search(/\bfilm|\bshoot/), reh = text.search(/\brehears/);
    var best = "", bestPos = Infinity;
    if (reh !== -1 && reh < bestPos) { best = "reh"; bestPos = reh; }
    if (fit !== -1 && fit < bestPos) { best = "fit"; bestPos = fit; }
    if (film !== -1 && film < bestPos) { best = "film"; bestPos = film; }
    return best;
  }

  // a number written like a date that is really something else:
  // "call 06.11", "Call time 07.10", "dress size 10/12", "1/2 day", "episodes 3/4", "2026/11/04"
  function notReallyADate(line, m) {
    var before = line.slice(Math.max(0, m.index - 14), m.index);
    var after = line.slice(m.index + m[0].length);
    if (/[£%]/.test(line)) return true;                                                   // money, percentages
    if (/\b(call|time|arrive|arrival|wrap|hrs|size|ep|eps|episodes?)\b[^\d]{0,12}$/i.test(before)) return true;
    if (/^\s*(am|pm|hrs|hours|day|days)\b/i.test(after)) return true;                       // "06.30 am", "1/2 day"
    if (/\d{4}[\/.-]$/.test(before) || /^[\/.]\d/.test(after)) return true;                // part of 2026/11/04
    // "14.10" with a dot needs a year or a weekday next to it ("Wed 14.10")
    if (m[0].indexOf(".") !== -1 && !m[9] && !WEEKDAY_BEFORE.test(line.slice(0, m.index)) && !WEEKDAY_AFTER.test(after)) return true;
    return false;
  }

  // the lines around line i look like a forwarded email header (From: / Sent: / To: / Subject:)
  function isHeaderBlock(all, i) {
    for (var j = i - 2; j <= i + 2; j++) {
      if (j !== i && all[j] && /^\s*(from|sent|to|subject|cc)\s*:/i.test(all[j])) return true;
    }
    return false;
  }

  // warnings: an optional list; reasons to check the call by hand are added to it
  function findDates(lines, subject, received, warnings) {
    var out = [], seen = {};
    var mode = "film";          // what the dates are, until a heading says otherwise
    var lastMonth = null, lastYear = null;
    // lines that never hold work days: footers, "office is closed", forwarded email headers
    var skip = /privacy|unsubscribe|updated our|sent from|copyright|recently including|wrote:|office is closed|\bclosed\b|^\s*(sent|from)\s*:/i;
    var all = [subject || ""].concat(lines);
    var receivedTime = new Date(received + "T12:00:00").getTime();
    function warn(reason) { if (warnings && warnings.indexOf(reason) === -1) warnings.push(reason); }

    for (var i = 0; i < all.length; i++) {
      var line = all[i];
      // a heading such as "FITTING:", "Fittings -", "SHOOT DATES:", "FILMING -"
      // (tables put several cells on one line, separated by "|": each cell can be a heading)
      var cells = line.split("|");
      for (var c = 0; c < cells.length; c++) {
        if (/^\W*rehears/i.test(cells[c])) mode = "reh";
        else if (/^\W*(costume\s+)?fit(ting)?s?\b/i.test(cells[c])) mode = "fit";
        else if (/^\W*(film(ing)?|shoot(ing)?|dates?|shoot dates?|filming dates?|production dates?)\b/i.test(cells[c])) mode = "film";
      }
      if (i > 0 && skip.test(line)) continue;
      // forwarded email header: "Date: Mon, 28 Sep 2026" next to "From:" / "Sent:" lines
      if (i > 0 && /^\s*date\s*:/i.test(line) && isHeaderBlock(all, i)) continue;
      // "On Mon 28 Sep 2026, Jo <jo@x.com> wrote:" (sometimes split over two lines)
      if (i > 0 && /^\s*on\b/i.test(line) && /\bwrote:?\s*$/i.test(line + " " + (all[i + 1] || ""))) continue;
      // the reply deadline on the line after "Please respond before:" is not a work day
      var prev = (all[i - 1] || "") || (all[i - 2] || "");
      if (i > 0 && /(respond|reply) before:?\s*$|deadline:?\s*$|expires?:?\s*$/i.test(prev)) continue;
      // EP pages put "(Rehearsals in Epsom)" on the line under the date: read them together.
      // The word in brackets decides the kind of day, before any heading.
      var bracketKind = "";
      if (all[i + 1] && /^\(/.test(all[i + 1]) && /\d/.test(line)) {
        var b = all[i + 1].split("|")[0].toLowerCase();
        if (/rehears/.test(b)) bracketKind = "reh";
        else if (/\bfit|costume/.test(b)) bracketKind = "fit";
        else if (/film|shoot/.test(b)) bracketKind = "film";
        line = line + " " + all[i + 1];
        i++;
      }

      var found = [], pendingOrdinals = [], m, n;
      // lists with slashes: "Nov 4/5/6" and "4/5/6 Nov" (read them, then blank them out
      // so they are not read again as "4/5" = 4th May)
      var LIST_AFTER = new RegExp("\\b" + MON + "\\.?\\s+(\\d{1,2}(?:\\s*\\/\\s*\\d{1,2})+)\\b", "gi");
      var LIST_BEFORE = new RegExp("\\b(\\d{1,2}(?:\\s*\\/\\s*\\d{1,2})+)\\s+" + MON + "\\b", "gi");
      var lists = [];
      while ((m = LIST_AFTER.exec(line))) lists.push({ at: m.index, text: m[0], days: m[2], mo: monthNumber(m[1]) });
      while ((m = LIST_BEFORE.exec(line))) lists.push({ at: m.index, text: m[0], days: m[1], mo: monthNumber(m[2]) });
      for (n = 0; n < lists.length; n++) {
        var days = lists[n].days.split("/");
        for (var q = 0; q < days.length; q++) {
          found.push({ d: +days[q], mo: lists[n].mo, y: null, at: lists[n].at, end: lists[n].at + lists[n].text.length });
        }
        line = line.slice(0, lists[n].at) + new Array(lists[n].text.length + 1).join(" ") + line.slice(lists[n].at + lists[n].text.length);
        lastMonth = lists[n].mo;
      }
      var lower = line.toLowerCase();

      DATE_RE.lastIndex = 0;
      while ((m = DATE_RE.exec(line))) {
        var d, mo, y = null;
        var textBefore = line.slice(0, m.index);
        // the weekday written before the date, if any ("Wed 14 Oct")
        var wdMatch = textBefore.match(WEEKDAY_BEFORE);
        var wd = wdMatch ? DAY_NUMBER[wdMatch[1].slice(0, 3).toLowerCase()] : null;
        if (m[1]) { d = +m[1]; mo = monthNumber(m[2]); if (m[3]) y = +m[3]; }
        else if (m[4]) { mo = monthNumber(m[4]); d = +m[5]; if (m[6]) y = +m[6]; }
        else if (m[7]) {
          if (notReallyADate(line, m)) continue;
          d = +m[7]; mo = +m[8];                       // UK order: day/month
          if (m[9]) y = m[9].length === 2 ? 2000 + +m[9] : +m[9];
        } else {
          // "1st option", "2nd unit", "3rd party", "18th century" are not dates
          if (NOT_A_DAY.test(line.slice(m.index + m[0].length))) continue;
          pendingOrdinals.push({ d: +m[10], at: m.index, end: m.index + m[0].length, wd: wd });
          continue;
        }
        if (!mo) continue;
        // lonely ordinals before this date in the same line take this month ("4th & 5th Nov")
        for (n = 0; n < pendingOrdinals.length; n++) {
          var o = pendingOrdinals[n];
          found.push({ d: o.d, mo: mo, y: y, at: o.at, end: o.end, wd: o.wd });
        }
        pendingOrdinals = [];
        lastMonth = mo; lastYear = y;
        // a reply deadline ("Let me know by Sunday 4th Oct") is not a work day
        if (DEADLINE_LINE.test(line) && DEADLINE_BEFORE.test(line.slice(Math.max(0, m.index - 60), m.index))) continue;
        found.push({ d: d, mo: mo, y: y, at: m.index, end: m.index + m[0].length, wd: wd });
      }
      // lonely ordinals with no month in the line ("11th 12th and 13th possible dates")
      for (n = 0; n < pendingOrdinals.length; n++) {
        if (lastMonth) found.push({ d: pendingOrdinals[n].d, mo: lastMonth, y: lastYear, at: pendingOrdinals[n].at, end: pendingOrdinals[n].end, wd: pendingOrdinals[n].wd });
      }
      // ranges in one month: "2nd to 6th November", "9th - 13th Nov", "Mon 2 - Fri 6 Nov"
      var RANGE = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|to|until|till|through|thru)\\s*(?:[a-z]{3,9}\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+" + MON + "\\b(?:\\s+(\\d{4}))?", "gi");
      var r;
      while ((r = RANGE.exec(line))) {
        var a = +r[1], bb = +r[2], rmo = monthNumber(r[3]), ry = r[4] ? +r[4] : null;
        if (rmo && bb > a && bb - a <= 31) for (var dd = a; dd <= bb; dd++) found.push({ d: dd, mo: rmo, y: ry, at: r.index, end: r.index + r[0].length });
        lastMonth = rmo;
      }
      // ranges with two full dates: "30th Oct - 3rd Nov", "28th Dec - 2nd Jan",
      // "Monday 2nd November - Friday 6th November"
      var RANGE2 = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+" + MON + "\\.?(?:,?\\s+(\\d{4}))?" +
        "\\s*(?:-|–|to|until|till|through|thru)\\s*(?:[a-z]{3,9},?\\s+)?" +
        "(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+" + MON + "\\.?(?:,?\\s+(\\d{4}))?", "gi");
      while ((r = RANGE2.exec(line))) {
        var d1 = +r[1], m1 = monthNumber(r[2]), y1 = r[3] ? +r[3] : null;
        var d2 = +r[4], m2 = monthNumber(r[5]), y2 = r[6] ? +r[6] : null;
        // a missing year: the start year comes from the end year (or the other way round)
        if (y2 && !y1) y1 = m2 < m1 ? y2 - 1 : y2;
        if (y1 && !y2) y2 = m2 < m1 ? y1 + 1 : y1;
        var sy = y1 || guessYear(m1, d1, received);
        var ey = y2 || (m2 < m1 ? sy + 1 : sy);
        var count = Math.round((new Date(ey, m2 - 1, d2) - new Date(sy, m1 - 1, d1)) / 864e5);
        if (count > 0 && count <= 31) {
          for (var k2 = 0; k2 <= count; k2++) {
            var day = new Date(sy, m1 - 1, d1 + k2);
            // years written in the email are kept; otherwise each day guesses its own year
            found.push({ d: day.getDate(), mo: day.getMonth() + 1, y: y1 ? day.getFullYear() : null, at: r.index, end: r.index + r[0].length });
          }
        }
      }
      // "w/c 9th Nov" (week commencing): keep the date, but ask you to check it
      if (found.length && /\bw\/c\b|\bw\.c\.|week commencing/i.test(line)) warn("week commencing – dates to confirm");

      for (var k = 0; k < found.length; k++) {
        var f = found[k];
        var year = f.y || guessYear(f.mo, f.d, received);
        if (!validDay(year, f.mo, f.d)) continue;
        // the weekday must match the date: "Wed 14 Oct 2025" is a typo for 2026 when 14 Oct 2026 is a Wednesday
        if (f.wd !== null && f.wd !== undefined && new Date(year, f.mo - 1, f.d).getDay() !== f.wd) {
          var tries = [year + 1, year - 1], fixed = null;
          for (var t = 0; t < tries.length; t++) {
            var away = (new Date(tries[t], f.mo - 1, f.d).getTime() - receivedTime) / 864e5;
            if (validDay(tries[t], f.mo, f.d) && new Date(tries[t], f.mo - 1, f.d).getDay() === f.wd && away > -15 && away <= 210) { fixed = tries[t]; break; }
          }
          if (fixed) year = fixed;
          else warn("weekday doesn't match " + toKey(year, f.mo, f.d) + " – check the date");
        }
        // a date more than ~7 months away is almost always something else on the page
        // (a footer, an old date): extras jobs are not booked that far ahead.
        // A date with a year written that is before the email arrived is old too.
        var daysAway = (new Date(year, f.mo - 1, f.d).getTime() - receivedTime) / 864e5;
        if (daysAway > 210) continue;
        if (f.y && toKey(year, f.mo, f.d) < received) continue;

        // the kind of day. Only the "|" table cell holding the date is read, so
        // "Costume: smart casual" in another cell does not make a fitting.
        var cellStart = line.lastIndexOf("|", f.at) + 1;
        var cellEnd = line.indexOf("|", f.at);
        if (cellEnd === -1) cellEnd = line.length;
        // 1) the "(Filming in Epsom)" line under an EP date
        var kind = bracketKind;
        // 2) a word right after the date, up to the next date: "12 Oct (fitting), 14 Oct (shoot)"
        if (!kind) {
          var nextAt = cellEnd;
          for (var o2 = 0; o2 < found.length; o2++) if (found[o2].at >= f.end && found[o2].at < nextAt) nextAt = found[o2].at;
          kind = kindOf(lower.slice(f.end, Math.min(nextAt, f.end + 25)));
        }
        // 3) the last such word before the date ("available to fit on 14 Aug")
        if (!kind) {
          var before = lower.slice(cellStart, f.at);
          var fitPos = lastPos(before, FIT_WORD), filmPos = lastPos(before, FILM_WORD), rehPos = lastPos(before, REH_WORD);
          if (rehPos > fitPos && rehPos > filmPos) kind = "reh";
          else if (fitPos > filmPos) kind = "fit";
          else if (filmPos > fitPos) kind = "film";
        }
        // 4) otherwise the last heading
        if (!kind) kind = mode;

        var entry = { d: toKey(year, f.mo, f.d), kind: kind };
        // a place after "@": it must start with a letter, not be a time, and not be part of a sentence
        var at = line.slice(f.at).match(/@\s*([^(|]+?)(?:\s*\(|\s+-\s|\s*\||\s+\d{3,4}\s*-|$)/);
        if (at) {
          var place = clean(at[1]);
          if (/^[A-Za-z]/.test(place) && !/^\d{1,2}([:.]\d{2})?\s*(am|pm)?\b/i.test(place) &&
              !/\b(will|if you|please|considered|reading this)\b/i.test(place)) {
            entry.loc = place.split(" ").slice(0, 6).join(" ").slice(0, 60);
          }
        }
        if (!entry.loc) {                                 // "30th October in Epsom", "(Filming in Epsom)"
          var inPlace = line.slice(f.at).match(/\b(?:in|at)\s+([A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]+){0,3})/);
          if (inPlace && !/^(the|a|an)$/i.test(inPlace[1])) entry.loc = inPlace[1].slice(0, 60);
        }
        // your answer on an EP page: "☒ Available ☐ Not available"
        if (/☒\s*not available/i.test(line)) entry.answer = "no";
        else if (/☒\s*available/i.test(line)) entry.answer = "yes";
        // a night shoot: the word "night(s)", but not "no nights" and not "fortnight"
        if (/\bnights?\b/i.test(line.replace(/\bno\s+nights?\b/gi, ""))) entry.night = true;
        // in a booking email: days kept "available / on hold" rather than confirmed
        // ("dates TBC" counts, "times TBC" does not)
        if (/\b(date|day)s? (tbc|to be confirmed)|pencil|on hold|stand ?-?by|remain(ing)? available|still available|keep .{0,20}available|provisional/i.test(line)) entry.hold = true;
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

    var warnings = [];                       // things to check by hand ("week commencing", wrong weekday)
    var call = {
      project: project,
      agency: findAgency(email.fromName, email.fromEmail, text),
      role: clean(role).slice(0, 80),
      location: field(lines, ["Location", "Shoot Location", "Filming Location", "Studio", "Where"]),
      fitLocation: field(lines, ["Fitting Location", "Fittings? Venue"]),
      filmLocation: field(lines, ["Shoot Location", "Filming Location"]),
      rate: field(lines, ["Rate of Pay", "Rates?", "Day Rate", "Pay", "Fee"]),
      respondBy: findRespondBy(lines, received),
      dates: findDates(lines, subject, received, warnings),
      received: received,
      notes: ""
    };

    // the reply deadline is not a work day: drop a date that equals the deadline (or the day the
    // email arrived) when it sits apart from the job's other days ("please reply by Fri 2 Oct")
    var dl = (call.respondBy || "").slice(0, 10);
    if (call.dates.length > 1) {
      call.dates = call.dates.filter(function (e) {
        if (e.d !== dl && e.d !== received) return true;
        var t = new Date(e.d + "T12:00:00").getTime();
        return call.dates.some(function (o) { return o !== e && Math.abs(new Date(o.d + "T12:00:00").getTime() - t) <= 4 * 864e5; });
      });
    }

    // a few useful lines for the notes
    var keep = /photo id|haircut|hair cut|parking|pick ?ups?|call times?|digi-?fit|1st option|2nd option|firearms|night shoot|travel|accommodation|tbc/i;
    var notes = [];
    lines.forEach(function (l) { if (l.length > 8 && l.length < 220 && keep.test(l) && notes.length < 4) notes.push(clean(l)); });
    call.notes = notes.join(" • ");

    var missing = [];
    if (!call.project) missing.push("production");
    if (!call.dates.length) missing.push("dates");
    if (!call.agency) missing.push("agency");
    var reasons = warnings.slice();
    if (missing.length) reasons.unshift("Couldn't find: " + missing.join(", "));
    call.review = reasons.length > 0;
    call.reviewReason = reasons.join("; ");
    return call;
  }

  var api = { parseEmail: parseEmail, htmlToText: htmlToText, isAvailabilityCheck: isAvailabilityCheck, classifyEmail: classifyEmail, parseCallTime: parseCallTime, londonCheck: londonCheck, CALL_TIME_SUBJECT: CALL_TIME_SUBJECT, replyAnswer: replyAnswer, extractLinks: extractLinks, isFromCastingAgency: isFromCastingAgency, AGENCIES: AGENCIES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EmailParser = api;
})(this);
