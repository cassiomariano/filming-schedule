/*
 * core.js — the robot's rules, in one place, with no database or inbox code.
 *
 *   1. recordFromEmail()  an agency email → a "record": what kind of email it is and what it says
 *   2. matchRecord()      which job a record belongs to — or "check" when it isn't sure
 *   3. deriveJob()        a job worked out from scratch: its records (in time order) + your own changes
 *
 * Because nothing here touches the database, every rule can be tested with real email sequences
 * (tests/test-core.js), and the same email always gives the same result.
 * Used by the robot (scripts/check-email.js), the app (index.html) and the tests.
 */
(function (root) {
  "use strict";
  var P = typeof module !== "undefined" && module.exports ? require("./parser.js") : root.EmailParser;
  var VERSION = 2;          // goes up when the rules change: emails the robot read are read again with the new rules

  // ---------- small helpers ----------
  function addDays(d, n) { var t = new Date(d + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function dayOf(at) { return String(at || "").slice(0, 10); }
  function uniq(list) { var seen = {}; return list.filter(function (x) { if (seen[x]) return false; seen[x] = true; return true; }); }
  function copy(o) { return JSON.parse(JSON.stringify(o)); }

  // ---------- names ----------
  // Words that describe a job but are not its name: never used to join two jobs
  var PLACEHOLDER = /^(tbc|tba|untitled|unknown|unnamed|confidential|commercial|advert|advertisement|feature|featurefilm|film|tv|tvseries|tvdrama|tvshow|series|drama|project|newproject|musicvideo|featuredrole|featured|role|sa|sas|supportingartists?|background|extras?|standin|photodouble|majorstudiofeature(film)?|pencil|pencilled|option|firstoption|secondoption|majorstudiofilm|studiofeature|netflixseries|bbcdrama|availability|availabilitycheck|avcheck|tomorrow|today|urgent|reminder|question|update|release|booking|thankyou|thanks|castingcollective|extrapeople|two10casting|two10|keycasting|lucasextras|bbbtalent|sabellcasting|theartistbook|trueedge|onsetextras|universalextras|wilkinscasting)$/;
  function normName(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
  }
  // a production's name and its short forms, all in plain lower case:
  // "Falcon(Project 12)" → falcon project 12, falcon · "EXP - Roundabout S2" → exp roundabout s2, roundabout s2, roundabout
  function nameForms(name) {
    var full = String(name || "").trim();
    if (!full) return [];
    var forms = [full, full.replace(/\s*[\(\[].*?[\)\]]\s*/g, " "), full.replace(/^[A-Za-z]{2,4}\s*[-–:]\s*/, "")];
    forms.slice().forEach(function (f) { forms.push(f.split(/\s+[-–|]\s*|\s*[-–|]\s+/)[0]); });
    forms = forms.map(normName);
    // "the Chairman" → chairman · "CLOVER FEATURE FILM" → clover · "Roundabout S2" / "Larkin 2" → roundabout / larkin
    forms.slice().forEach(function (f) { forms.push(f.replace(/^(the|project|production) /, "")); });
    forms.slice().forEach(function (f) { forms.push(f.split(" ").map(function (w) { return w.length > 3 ? w.replace(/s$/, "") : w; }).join(" ")); });
    forms.slice().forEach(function (f) { forms.push(f.replace(/ (feature film|feature|film|movie|tv series|series|tv drama|drama|commercial|advert|music video|short film)$/, "")); });
    forms.slice().forEach(function (f) { forms.push(f.replace(/ (s|series|season)? ?\d{1,2}$/, "")); });
    // spaces don't matter: "LArkin2" = "Larkin 2"
    forms = forms.map(function (f) { return f.replace(/ /g, ""); });
    return uniq(forms).filter(function (f) { return f.length >= 3 && !PLACEHOLDER.test(f) && !/^\d+$/.test(f); });
  }
  function sameName(a, b) {
    var x = nameForms(a), y = nameForms(b);
    return x.some(function (f) { return y.indexOf(f) !== -1; });
  }
  // agency names compared loosely: "Two 10 Casting" = "Two10", "Lucas Extras" = "Lucas"
  function agencyKey(a) {
    return String(a || "").toLowerCase().replace(/\b(ltd|limited|casting|extras?|agency|uk|talent|management|the)\b/g, "").replace(/[^a-z0-9]/g, "");
  }
  // the EP message page code in a link: https://x.uk.epcastingportal.com/m/r/0752eb01bf87 → 0752eb01bf87
  function pageCode(url) {
    var m = String(url || "").match(/epcastingportal\.com\/(?:m\/)?r\/([a-z0-9-]{6,})/i);
    return m ? m[1].toLowerCase() : "";
  }

  // Every place an email may give the production's name. Each one is only a CANDIDATE: a record joins
  // a job only when one of them is exactly that job's name (or short form) — no guessing from the body.
  //   "Release on FIGHTLAND, please view ASAP" · "Casting Collective - Booking Confirmation ( ICEBREAKER )"
  //   "Matador - You have been released" · "NOT required for ROUNDABOUT." · "...available for a role on MKT."
  var FILLER = /^(re|fw|fwd|please( view| read| reply| respond)?( asap)?|asap|urgent|important|thanks?( you)?|thanks for being available|thank you for being available( on| for)?|you have been released( on| from)?|released( on| from)?|release( on| from| notification)?|bbb release notification|booking confirmation|booking confirmed|booking|confirmed|confirmation|availability( check| request| enquiry| updates?)?( on| for)?|av check|call time and location details for|call time|call sheet|action required|not required( for)?|new|update|updates?( on)?|you have booking updates( on)?|thank you for (confirming|responding|letting us know)( that you are (not )?available)?( for)?)$/i;
  function nameCandidates(subject, text, project) {
    var out = [];
    if (project) out.push(project);
    var s = String(subject || "").replace(/<[^>]*>/g, " ");
    var m;
    var pats = [
      /\(\s*([^()]{2,60}?)\s*\)/g,                                                         // ( ICEBREAKER )
      /\b(?:available|released|release|cancell?ed|booked|required|confirming|details|updates?|role|request|check) +(?:on|for|from)\s+([^,!|.(]+?)(?=\s*(?:[,!|.(]|\s[-–]\s|please|$))/gi,
      /\b(?:for|on)\s+((?:the\s+)?[A-Z][^,!|.(]*?)(?=\s*(?:[,!|.(]|\s[-–]\s|please|$))/g,
      /\benquiry for:?\s*([^,!|.(]+?)(?=\s*(?:[,!|.(]|\s[-–]\s|please|$))/gi,
      /\boption with\s+(.+?)(?=\s+[-–]\s|\s*$)/gi
    ];
    pats.forEach(function (re) { re.lastIndex = 0; while ((m = re.exec(s))) out.push(m[1]); });
    // what follows the last "on" / "for": "Thank you for confirming on Mon 29 Jun on MUDLARKERS"
    var last = s.split(/\s(?:on|for)\s/i);
    if (last.length > 1) out.push(last[last.length - 1].split(/\s*(?:[,!|.(]|\s[-–]\s|please)/i)[0]);
    // the parts between " - " (and around them), without the filler words
    s.split(/\s+[-–|:]\s+|\s*[|]\s*/).forEach(function (part) {
      var p = part.replace(/\(.*?\)/g, " ").replace(/\b(please view asap|please view|please read|asap|thanks?.*$)/gi, " ").replace(/[!?*]+/g, " ").trim();
      if (p && !FILLER.test(p) && !/^\d/.test(p) && p.length <= 60) out.push(p);
    });
    // replies and EP emails: "available for a role on MKT." / "You have an availability enquiry for:" + next line
    var t = String(text || "").slice(0, 1500);
    var re2 = /\b(?:a role on|role on|enquiry for:?|regarding|in relation to)\s+([A-Z0-9][^.,\n!]{1,50})/g;
    while ((m = re2.exec(t))) out.push(m[1]);
    var lines = t.split("\n");
    for (var i = 0; i < lines.length - 1; i++) if (/availability (enquiry|request) for:?\s*$/i.test(lines[i])) { out.push(lines[i + 1]); break; }
    return uniq(out.map(function (x) { return String(x).replace(/\s+/g, " ").trim(); }).filter(goodName)).slice(0, 8);
  }
  // a sentence or a date is not a name ("letting us know that you are available", "Mon 29 Jun 2026 on X")
  var NOT_NAME = /\b(you|your|you're|us|we|our|please|thank|thanks|letting|know|responding|confirming|available|unavailable|released|booked|required|selected|needed|being|have|has|been)\b|\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(mon|tue|wed|thu|fri|sat|sun)\w*\s+\d/i;
  // a clean production name (not a sentence, a date or a placeholder)
  function goodName(x) { return !!x && !NOT_NAME.test(x) && nameForms(x).length > 0; }

  // ---------- 1. an email → a record ----------
  // Your answer in a "thank you for responding" email. Only an answer the email clearly states counts;
  // otherwise "unknown" (the EP page then says what you ticked).
  function answerOf(subject, text) {
    var s = String(subject || "");
    if (/not available|unavailable|can'?t attend|cannot attend|declin/i.test(s)) return "no";
    if (/\bavailable\b/i.test(s)) return "yes";
    var t = String(text || "").slice(0, 2000).split(/[.!?\n]+/).filter(function (x) { return !/^\s*(if|should)\b/i.test(x); }).join(". ");
    if (/☒\s*(not available|unavailable)/i.test(t)) return "no";
    if (/☒\s*available/i.test(t)) return "yes";
    if (P.replyAnswer("", t) === "declined") return "no";
    if (/\b(you are|you're|you said you are|you have said you are|for being|as being) available\b|thank you for (confirming|letting us know) (that )?you('re| are) available/i.test(t)) return "yes";
    return "unknown";
  }
  // email = { key, at (ISO time), account, folder, from:{name,address}, subject, text, html, messageId, inReplyTo, references[], trash, knownAgencies[] }
  function recordFromEmail(email) {
    var from = email.from || {};
    var subject = String(email.subject || "");
    var text = String(email.text || "");
    var fromAgency = P.isFromCastingAgency(from.name, from.address, email.knownAgencies || []);
    var kind = P.classifyEmail(subject, text, fromAgency) || null;
    var received = dayOf(email.at);
    var r = P.parseEmail({ subject: subject, fromName: from.name, fromEmail: from.address, text: text, received: received });
    var links = email.links || (email.html ? P.extractLinks(email.html) : []);
    var allLinks = (email.allUrls || []).concat(links);
    var pages = uniq(allLinks.map(function (l) { return pageCode(l.url); }).filter(Boolean));
    var parsed = {
      project: r.project || "", agency: r.agency || "", role: r.role || "",
      dates: (r.dates || []).map(function (x) { var o = { d: x.d, kind: x.kind }; if (x.loc) o.loc = x.loc; if (x.night) o.night = true; if (x.hold) o.hold = true; return o; }),
      respondBy: r.respondBy || null, location: r.location || "", fitLocation: r.fitLocation || "", filmLocation: r.filmLocation || "",
      rate: r.rate || "", notes: r.notes || ""
    };
    if (parsed.project && !goodName(parsed.project)) parsed.project = "";
    parsed.names = nameCandidates(subject, text, parsed.project);
    if (!parsed.project && parsed.names.length && kind === "call") parsed.project = parsed.names[0];
    if (kind === "replied") parsed.answer = answerOf(subject, text);
    if (kind === "calltime" || kind === "booked") {
      var ct = P.parseCallTime({ subject: subject, text: text, received: received });
      parsed.call = { time: ct.time || "", place: ct.place || "", w3w: ct.w3w || "", postcode: ct.postcode || "", dates: (ct.dates || []).map(function (x) { return x.d; }) };
      parsed.places = ct.places || null;
    }
    return {
      key: email.key, v: VERSION, at: email.at, account: email.account || "", folder: email.folder || "", trash: !!email.trash,
      from: { name: String(from.name || "").slice(0, 120), address: String(from.address || "").slice(0, 120) },
      subject: subject.slice(0, 300), text: text.replace(/\n{3,}/g, "\n\n").slice(0, 6000),
      messageId: email.messageId || "", replyTo: uniq([email.inReplyTo].concat(email.references || []).filter(Boolean)).slice(0, 10),
      kind: kind, fromAgency: fromAgency, parsed: parsed, links: links.slice(0, 6), pages: pages
    };
  }

  // ---------- 2. which job? ----------
  // index entry for one job (kept in one small database document, so matching costs one read)
  function indexEntry(job) {
    var days = (job.dates || []).map(function (e) { return e.d; }).filter(Boolean).sort();
    var recDays = (job.recordDates || []).slice().sort();
    var names = uniq([].concat(nameForms(job.project), (job.names || []).reduce(function (a, n) { return a.concat(nameForms(n)); }, [])));
    var span = days.concat(recDays).concat(job.received ? [dayOf(job.received)] : []).sort();
    return {
      a: agencyKey(job.agency), n: names, full: normName(job.project).replace(/ /g, ""), p: uniq((job.pageCodes || []).concat((job.links || []).map(function (l) { return pageCode(l.url); }).filter(Boolean))),
      t: (job.threads || []).slice(-8), d: days, f: span[0] || "", l: span[span.length - 1] || "", s: job.status || "", sheet: !job.records || !job.records.length ? 1 : 0
    };
  }
  function overlapsDays(entry, days) { return days.some(function (d) { return entry.d.indexOf(d) !== -1; }); }
  // around the same time: the record's days (or date) within 45 days of the job's days / emails
  function nearInTime(entry, days, at) {
    if (!entry.f) return true;
    var lo = addDays(entry.f, -45), hi = addDays(entry.l, 45);
    var ds = days.length ? days : [dayOf(at)];
    return ds.some(function (d) { return d >= lo && d <= hi; });
  }
  // Returns { job: id | null, how, sure: true|false, candidates: [ids], why }.
  // sure = the record may change that job. Not sure → the Check list (never guessed).
  // index = { id: entry }
  function matchRecord(rec, index) {
    var ids = Object.keys(index);
    var p = rec.parsed || {};
    var days = (p.dates || []).map(function (x) { return x.d; });
    if (rec.kind === "calltime" && p.call && p.call.dates && p.call.dates.length) days = uniq(days.concat(p.call.dates));
    var ak = agencyKey(p.agency);
    var out = function (job, how, sure, cands, why) { return { job: job, how: how, sure: sure, candidates: cands || (job ? [job] : []), why: why || "" }; };

    // 0) you filed it yourself (Check list or "move this email")
    if (rec.userJob === "ignore") return out(null, "you: ignore", false, [], "You chose to ignore it");
    if (rec.userJob === "new") return out(null, "you: new job", true, [], "new");
    if (rec.userJob && index[rec.userJob]) return out(rec.userJob, "you", true);

    // 1) the same EP message page (each enquiry has its own page)
    if (rec.pages && rec.pages.length) {
      var byPage = ids.filter(function (id) { return rec.pages.some(function (c) { return index[id].p.indexOf(c) !== -1; }); });
      if (byPage.length === 1) return out(byPage[0], "same EP page", true);
      if (byPage.length > 1) {
        var pa = byPage.filter(function (id) { return index[id].a === ak; });
        if (pa.length === 1) return out(pa[0], "same EP page + agency", true);
        return out(null, "same EP page on several jobs", false, byPage, "Several jobs share this agency page");
      }
    }
    // 2) the same email conversation (a reply to an email of that job)
    if (rec.replyTo && rec.replyTo.length) {
      var byThread = ids.filter(function (id) { return rec.replyTo.some(function (t) { return index[id].t.indexOf(t) !== -1; }); });
      if (byThread.length === 1) return out(byThread[0], "same email thread", true);
    }
    // 3) the same production name + the same agency + around the same time
    var forms = uniq([].concat.apply(nameForms(p.project), (p.names || []).map(nameForms)));
    if (forms.length) {
      var named = ids.filter(function (id) { return index[id].n.some(function (f) { return forms.indexOf(f) !== -1; }); });
      var sameAg = named.filter(function (id) { return ak && index[id].a === ak; });
      var near = sameAg.filter(function (id) { return nearInTime(index[id], days, rec.at); });
      // a NEW request joins a job only while that job still has days ahead (or shares a day with it):
      // a returning production you finished last month is a new job
      if (rec.kind === "call") near = near.filter(function (id) { return overlapsDays(index[id], days) || (index[id].d.length ? index[id].d[index[id].d.length - 1] : index[id].l) >= dayOf(rec.at); });
      if (near.length > 1 && days.length) {
        var withDay = near.filter(function (id) { return overlapsDays(index[id], days); });
        if (withDay.length >= 1) near = withDay;
      }
      if (near.length > 1) {
        // a copy you typed in your spreadsheet and a robot copy: the one with emails wins only when the other has none of these days
        var live = near.filter(function (id) { return index[id].l >= addDays(dayOf(rec.at), -30); });
        if (live.length === 1) near = live;
      }
      if (near.length > 1) {
        // several jobs of one production (e.g. different roles): the one whose FULL name is in the subject
        var subj = normName(rec.subject).replace(/ /g, "");
        var full = near.filter(function (id) { return index[id].full && subj.indexOf(index[id].full) !== -1; });
        if (full.length === 1) near = full;
      }
      if (near.length === 1) return out(near[0], "name + agency", true);
      if (near.length > 1) return out(null, "name matches several jobs", false, near, "Several jobs from this agency have this name");
      if (rec.kind === "call") return out(null, "new production", true, [], "new");
      if (rec.kind === "booked" && days.length && goodName(p.project)) return out(null, "booking without a request", true, [], "new");
      var why = sameAg.length ? "This production's job is from another time" : named.length ? "Only another agency has this production" : "No job with this name";
      // a booking or call time must never be lost: offer this agency's jobs around that time
      if (!sameAg.length && (rec.kind === "booked" || rec.kind === "calltime")) {
        var around = ids.filter(function (id) { return (!ak || index[id].a === ak) && nearInTime(index[id], days, rec.at) && index[id].l >= addDays(dayOf(rec.at), -7); });
        return out(null, "no job", false, around.slice(0, 6), why + " — which job is it?");
      }
      return out(null, "no job", false, sameAg.length ? sameAg : [], why);
    }
    // 4) no production name in the email
    if (rec.kind === "call") return out(null, "new request, no name", true, [], "new");
    if (!ak && rec.kind !== "calltime") return out(null, "no name, no agency", false, [], "No production name or agency in the email");
    var open = ids.filter(function (id) { var s = index[id].s; return s !== "released" && s !== "canceled" && s !== "declined" && index[id].l >= addDays(dayOf(rec.at), -3); });
    var mine = open.filter(function (id) { return !ak || index[id].a === ak; });
    if (days.length) {
      var onDay = mine.filter(function (id) { return overlapsDays(index[id], days); });
      if (rec.kind === "calltime") onDay = onDay.filter(function (id) { return index[id].s === "confirmed" || index[id].s === "available"; });
      if (onDay.length === 1) return out(onDay[0], "agency + same days (only one job)", true);
      return out(null, "no name", false, onDay.length ? onDay : mine.slice(0, 6), "No production name, and " + (onDay.length ? "several jobs" : "no job") + " on these days");
    }
    return out(null, "no name", false, mine.slice(0, 6), "No production name and no dates");
  }

  // ---------- 3. a job, worked out from scratch ----------
  // Day states used while working it out:
  //   pending (new, not answered) · available (said yes / on hold) · booked · worked · declined · released · canceled
  var ORDER = { call: 0, replied: 1, booked: 2, calltime: 3, released: 4 };
  function byTime(a, b) {
    var x = String(a.at || ""), y = String(b.at || "");
    if (x !== y) return x < y ? -1 : 1;
    return (ORDER[a.kind] || 0) - (ORDER[b.kind] || 0);
  }
  // a day typed in your spreadsheet → its state
  function baseState(e, status) {
    if (e.state === "worked" || e.done) return "worked";
    if (e.state) return e.state;
    if (e.answer === "no") return "declined";
    return { confirmed: "booked", done: "worked", available: "available", lapsed: "available", pending: "pending", expired: "pending", declined: "declined", released: "released", canceled: "canceled" }[status] || "pending";
  }
  var APP_STATE = { pending: "pending", available: "available", worked: "worked", released: "released", canceled: "canceled" };
  // job = { base:{status,dates,project,agency,role,received,...}, pages:{code: facts}, mine:{status, project, agency, role, days:{d:{state,kind,callTime,loc,removed}}}, ... }
  // records = the records filed on this job
  function deriveJob(job, records) {
    var base = job.base || {};
    var pages = job.pages || {};
    var mine = job.mine || {};
    var all = (records || []).filter(function (r) { return r.kind && r.kind !== "epupdate" && !r.copyOf; }).slice().sort(byTime);
    // base.at: the job's days and status were saved as they stood at that moment (e.g. when the robot
    // was rebuilt): only emails after it change them. Older emails stay listed on the job.
    // An email found only after the job was saved (e.g. one the robot had missed) counts only when it is
    // newer than every email the saved job already includes — an older one could undo newer news, so it is
    // listed on the job and flagged for you instead.
    var known = base.at ? all.filter(function (r) { return !(String(r.seen || r.at) > base.at); }) : [];
    var lastKnown = known.reduce(function (m, r) { return String(r.at) > m ? String(r.at) : m; }, "");
    var late = [];
    var recs = base.at ? all.filter(function (r) {
      if (String(r.at) > base.at) return true;
      if (!(String(r.seen || "") > base.at)) return false;
      if (dayOf(r.at) > dayOf(lastKnown)) return true;
      late.push(r); return false;
    }) : all;
    var days = {};
    var notes = [];
    function day(d, kind) {
      if (!days[d]) days[d] = { d: d, kind: kind || "film", st: "pending" };
      return days[d];
    }
    function fill(dd, x, fromPage) {
      if (x.loc && !dd.loc) dd.loc = x.loc;
      if (x.night) dd.night = true;
      if (x.kind && (fromPage || !dd.kindSure)) { dd.kind = x.kind; if (fromPage) dd.kindSure = true; }
    }
    (base.dates || []).forEach(function (e) {
      if (!e || !/^\d{4}-\d\d-\d\d$/.test(e.d || "")) return;
      var dd = day(e.d, e.kind);
      dd.st = baseState(e, base.status);
      dd.kindSure = true;
      ["loc", "night", "callTime", "callPlace", "w3w", "postcode"].forEach(function (k) { if (e[k]) dd[k] = e[k]; });
      if (e.answer) dd.answer = e.answer;
    });
    var answered = base.status && base.status !== "pending" ? base.status : "";
    var respondBy = base.respondBy || null, lastAsk = null;
    recs.forEach(function (r) {
      var p = r.parsed || {};
      var listed = p.dates || [];
      if (r.kind === "call") {
        lastAsk = r;
        respondBy = p.respondBy || respondBy;
        // the enquiry's EP page: its own day labels and your ticks are the most exact
        var pg = (r.pages || []).map(function (c) { return pages[c]; }).filter(Boolean)[0];
        var asked = listed.map(function (x) { return { x: x, page: false }; });
        if (pg) (pg.dates || []).forEach(function (x) {
          var i = -1; asked.forEach(function (a, k) { if (a.x.d === x.d) i = k; });
          if (i === -1) asked.push({ x: x, page: true }); else asked[i] = { x: x, page: true };
        });
        if (pg && pg.respondBy) respondBy = pg.respondBy;
        asked.forEach(function (a) {
          var dd = days[a.x.d], isNew = !dd;
          dd = day(a.x.d, a.x.kind);
          // asked again after being released (e.g. a new role on the same days): open again
          if (!isNew && (dd.st === "released" || dd.st === "canceled" || dd.st === "declined")) { dd.st = "pending"; delete dd.answer; }
          fill(dd, a.x, a.page);
          if (a.page && a.x.answer) {
            dd.answer = a.x.answer;
            if (a.x.answer === "yes" && dd.st === "pending") dd.st = "available";
            if (a.x.answer === "no" && (dd.st === "pending" || dd.st === "available")) dd.st = "declined";
          }
        });
        if (pg && pg.answer && !asked.some(function (a) { return a.x.answer; })) {
          asked.forEach(function (a) { var dd = days[a.x.d]; if (dd.st === "pending") dd.st = pg.answer === "yes" ? "available" : "declined"; });
          answered = pg.answer === "yes" ? "available" : "declined";
        }
      } else if (r.kind === "replied") {
        var ans = p.answer;
        if (ans === "unknown") {
          // the page of the request says what you ticked
          var pg2 = lastAsk && (lastAsk.pages || []).map(function (c) { return pages[c]; }).filter(Boolean)[0];
          if (pg2 && pg2.answer) ans = pg2.answer;
        }
        if (ans === "yes" || ans === "no") {
          Object.keys(days).forEach(function (d) {
            var dd = days[d];
            if (dd.st !== "pending") return;
            if (dd.answer === "no") dd.st = "declined"; else if (dd.answer === "yes") dd.st = "available";
            else dd.st = ans === "yes" ? "available" : "declined";
          });
          answered = ans === "yes" ? "available" : "declined";
        } else notes.push("You answered on " + dayOf(r.at) + " (answer not in the email)");
      } else if (r.kind === "booked") {
        var hold = {}, book = {};
        listed.forEach(function (x) { if (x.hold) hold[x.d] = x; else book[x.d] = x; });
        if (listed.length) {
          listed.forEach(function (x) {
            var dd = day(x.d, x.kind); fill(dd, x, false);
            if (book[x.d]) dd.st = "booked";
            else if (dd.st !== "booked" && dd.st !== "worked") dd.st = "available";
          });
          Object.keys(days).forEach(function (d) { if (days[d].st === "pending") days[d].st = "available"; });
        } else {
          Object.keys(days).forEach(function (d) { var s = days[d].st; if (s === "pending" || s === "available") days[d].st = "booked"; });
        }
        answered = "confirmed";
      } else if (r.kind === "released") {
        var hit = 0;
        // the email's own word: "cancelled" → canceled, anything else → released
        var word = /cancel+ed|cancellation/i.test(r.subject + " " + String(r.text || "").slice(0, 400)) ? "canceled" : "released";
        if (listed.length) {
          listed.forEach(function (x) { var dd = days[x.d]; if (dd && dd.st !== "worked") { dd.st = word; hit++; } });
          if (!hit) notes.push("Release on " + dayOf(r.at) + " named days this job doesn't have");
        } else {
          Object.keys(days).forEach(function (d) { var dd = days[d]; if (dd.st === "pending" || dd.st === "available" || dd.st === "booked") { dd.st = word; hit++; } });
          if (!Object.keys(days).length) answered = word;
        }
      } else if (r.kind === "calltime") {
        var c = p.call || {};
        if (!c.time) return;
        var d = (c.dates || [])[0];
        if (!d) {
          var next = Object.keys(days).sort().filter(function (k) { return k >= dayOf(r.at) && (days[k].st === "booked" || days[k].st === "available"); })[0];
          d = next;
        }
        if (!d) return;
        var dd = day(d, "film");
        dd.callTime = c.time;
        if (c.place) dd.callPlace = String(c.place).slice(0, 160);
        if (c.w3w) dd.w3w = c.w3w;
        if (c.postcode) dd.postcode = c.postcode;
        if (dd.st !== "worked") dd.st = "booked";
        answered = "confirmed";
      }
      // exact places from a booking email or call sheet
      if ((r.kind === "booked" || r.kind === "calltime") && p.places) {
        Object.keys(days).forEach(function (d) {
          var dd = days[d]; if (dd.st !== "booked") return;
          var src = dd.kind === "fit" ? p.places.fit : p.places.film;
          if (!src) return;
          if (src.address && !dd.callPlace) dd.callPlace = src.address;
          if (src.w3w && !dd.w3w) dd.w3w = src.w3w;
          if (src.postcode && !dd.postcode) dd.postcode = src.postcode;
        });
      }
    });

    var md = mine.days || {};
    var status, dates;
    if (base.at && !recs.length) {
      // nothing new since the job was saved: it stays exactly as it was, plus your own changes
      dates = (base.dates || []).filter(function (e) { return e && /^\d{4}-\d\d-\d\d$/.test(e.d || ""); }).map(function (e) { return copy(e); });
      Object.keys(md).forEach(function (d) {
        var o = md[d] || {};
        var i = -1; dates.forEach(function (e, k) { if (e.d === d) i = k; });
        if (o.removed) { if (i !== -1) dates.splice(i, 1); return; }
        var e = i !== -1 ? dates[i] : (dates.push({ d: d, kind: o.kind || "film" }), dates[dates.length - 1]);
        if (o.kind) e.kind = o.kind;
        if (o.state !== undefined) { delete e.done; if (o.state) e.state = o.state; else delete e.state; }
        ["callTime", "loc", "callPlace"].forEach(function (k) { if (o[k] !== undefined) { if (o[k]) e[k] = o[k]; else delete e[k]; } });
        if (o.night !== undefined) { if (o.night) e.night = true; else delete e.night; }
      });
      dates.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
      status = mine.status || base.status || "pending";
    } else {
    // ---- your own changes always win ----
    Object.keys(md).forEach(function (d) {
      var o = md[d] || {};
      if (o.removed) { delete days[d]; return; }
      var dd = day(d, o.kind);
      if (o.kind) dd.kind = o.kind;
      if (o.state) dd.st = o.state === "worked" ? "worked" : o.state;
      if (o.state === "") { /* back to automatic */ }
      ["callTime", "loc", "callPlace"].forEach(function (k) { if (o[k] !== undefined) { if (o[k]) dd[k] = o[k]; else delete dd[k]; } });
      if (o.night !== undefined) { if (o.night) dd.night = true; else delete dd.night; }
    });

    // ---- the job's status from its days ----
    var list = Object.keys(days).sort().map(function (d) { return days[d]; });
    var has = function (s) { return list.some(function (x) { return x.st === s; }); };
    if (has("booked") || (has("worked") && !has("pending") && !has("available"))) status = "confirmed";
    else if (has("available")) status = "available";
    else if (has("pending")) status = "pending";
    else if (list.length && list.every(function (x) { return x.st === "declined"; })) status = "declined";
    else if (list.length && list.every(function (x) { return x.st === "canceled"; })) status = "canceled";
    else if (list.length) status = list.some(function (x) { return x.st === "declined"; }) && !list.some(function (x) { return x.st === "released" || x.st === "canceled"; }) ? "declined" : "released";
    else status = answered || base.status || "pending";
    if (status === "confirmed" && !has("booked") && base.status === "done") status = "done";
    if (mine.status) status = mine.status;

    // ---- days as the app shows them ----
    var shown = { confirmed: "booked", done: "worked", available: "available", pending: "pending", declined: "declined", released: "released", canceled: "canceled" }[status];
    dates = list.map(function (x) {
      var o = { d: x.d, kind: x.kind || "film" };
      ["loc", "night", "callTime", "callPlace", "w3w", "postcode"].forEach(function (k) { if (x[k]) o[k] = x[k]; });
      if (x.answer) o.answer = x.answer;
      if (x.st === "declined") o.answer = "no";
      else if (x.st !== shown && APP_STATE[x.st]) o.state = APP_STATE[x.st];
      else if (x.st === "booked" && shown !== "booked") o.state = "available";   // shown only if you overrode the status
      return o;
    });
    }

    // ---- details: your changes, then your spreadsheet, then the emails (newest request first) ----
    var calls = all.filter(function (r) { return r.kind === "call"; });
    var pageList = Object.keys(pages).map(function (k) { return pages[k]; });
    function pick(field) {
      if (mine[field]) return mine[field];
      if (base[field]) return base[field];
      for (var i = pageList.length - 1; i >= 0; i--) if (pageList[i][field]) return pageList[i][field];
      for (var j = calls.length - 1; j >= 0; j--) if ((calls[j].parsed || {})[field]) return calls[j].parsed[field];
      for (var k = all.length - 1; k >= 0; k--) if ((all[k].parsed || {})[field]) return all[k].parsed[field];
      return "";
    }
    var first = all[0];
    var out = {
      status: status, dates: dates,
      project: pick("project"), agency: mine.agency || base.agency || (calls[0] || first || { parsed: {} }).parsed.agency || "",
      role: pick("role"), location: pick("location"), fitLocation: pick("fitLocation"), filmLocation: pick("filmLocation"), rate: pick("rate"),
      respondBy: mine.respondBy || (status === "pending" ? respondBy : (respondBy || null)),
      received: base.received || (first ? dayOf(first.at) : ""),
      answers: pageList.reduce(function (a, pg) { return a.concat(pg.answers || []); }, []).concat(base.answers || []).slice(0, 12),
      notes2: notes
    };
    out.agencyKey = agencyKey(out.agency);
    var links = [], seenL = {};
    (base.links || []).forEach(function (l) { if (!seenL[l.url]) { seenL[l.url] = 1; links.push(l); } });
    all.forEach(function (r) { (r.links || []).forEach(function (l) { if (!seenL[l.url]) { seenL[l.url] = 1; links.push(l); } }); });
    out.links = links.slice(-20);
    out.emails = all.map(function (r) { return { key: r.key, date: dayOf(r.at), kind: r.kind, subject: r.subject, text: String(r.text || "").slice(0, 2500) }; });
    if (first && calls[0]) { out.emailSubject = calls[0].subject; out.emailFrom = (calls[0].from.name || "") + " <" + (calls[0].from.address || "") + ">"; }
    var missing = [];
    if (!out.project) missing.push("production name");
    if (!dates.length) missing.push("dates");
    out.review = !!all.length && !base.status && missing.length > 0;
    out.reviewReason = out.review ? "Couldn't find: " + missing.join(", ") + (Object.keys(pages).length ? "" : " (open the agency page)") : "";
    if (late.length) out.lateEmails = late.map(function (r) { return r.key; });
    out.coreV = VERSION;
    return out;
  }

  // ---------- EP message page → facts ----------
  // text = the page as plain text (parser.htmlToText). Your ticks become yes/no per day.
  function pageFacts(url, html, received) {
    var text = P.htmlToText(html || "");
    var r = P.parseEmail({ subject: "", fromName: "", html: html, text: "", received: received });
    var facts = { url: url, project: r.project || "", role: r.role || "", respondBy: r.respondBy || null, dates: [], replied: /successfully recorded your response/i.test(text), answer: null, answers: [] };
    (r.dates || []).forEach(function (x) { var o = { d: x.d, kind: x.kind }; if (x.loc) o.loc = x.loc; if (x.night) o.night = true; if (x.answer) o.answer = x.answer; facts.dates.push(o); });
    if (facts.replied) {
      var lines = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      // the main availability question: a tick next to Available / Not available
      var yes = /☒\s*available\b/i.test(text), no = /☒\s*(not available|unavailable)/i.test(text);
      if (no && !yes) facts.answer = "no"; else if (yes && !no) facts.answer = "yes";
      else if (yes && no) {
        var ys = facts.dates.filter(function (x) { return x.answer === "yes"; }).length, ns = facts.dates.filter(function (x) { return x.answer === "no"; }).length;
        facts.answer = ys && !ns ? "yes" : ns && !ys ? "no" : ys ? "yes" : null;
      }
      for (var i = 0; i < lines.length; i++) {
        if (/\?$/.test(lines[i]) && lines[i].length < 140) {
          var picked = [];
          for (var j = i + 1; j < lines.length && j < i + 12 && !/\?$/.test(lines[j]); j++) {
            lines[j].split("☒").slice(1).forEach(function (part) { var a = part.split("☐")[0].trim(); if (a) picked.push(a); });
          }
          if (picked.length) facts.answers.push(lines[i].replace(/\?$/, "") + ": " + picked.join(", "));
        }
      }
      facts.answers = facts.answers.slice(0, 12);
    }
    // a release / booking written on the page ("You have booking updates")
    if (/(have|has) been booked|you('| a)re booked|booking (is )?confirmed|confirmed booking/i.test(text)) facts.update = "booked";
    else if (/(you have|you've) been released|you('| a)re released|released you|you are not (required|needed)|not (been )?selected|stood down|(job|booking|filming|shoot) (has been )?cancel+ed/i.test(text)) facts.update = "released";
    return facts;
  }

  var api = { VERSION: VERSION, normName: normName, nameForms: nameForms, sameName: sameName, agencyKey: agencyKey, pageCode: pageCode,
    answerOf: answerOf, recordFromEmail: recordFromEmail, indexEntry: indexEntry, matchRecord: matchRecord, deriveJob: deriveJob, pageFacts: pageFacts, addDays: addDays };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Core = api;
})(this);
