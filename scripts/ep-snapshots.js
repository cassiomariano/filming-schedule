/*
 * ep-snapshots.js — takes a picture of each job's EP message page (the page where you tick
 * Available / Not available), so the app can show exactly what you answered.
 *
 * It only OPENS the page (the same link as in the agency's email, no login). It never clicks,
 * types or submits anything, so it can't change your answer.
 *
 * Pictures are small JPEGs stored in the database under "pages/<job id>" (one per job),
 * which the app loads only when you open that job. Runs every hour (see .github/workflows/ep-snapshots.yml).
 */
const admin = require("firebase-admin");
const { chromium } = require("playwright");

function report(kind, title, text) { console.log(`::${kind} title=${title}::${text}`); }

let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || "").replace(/[“”„‟″]/g, '"').replace(/[‘’]/g, "'");
const serviceAccount = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 12);
const londonDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

// the EP message link from the agency's email ("Respond" button)
function portalLink(c) {
  // the newest one: a later enquiry (e.g. a new role) has its own page
  const eps = (c.links || []).filter(x => x.kind === "respond" && /^https:\/\/[a-z0-9.-]*epcastingportal\.com\/./i.test(x.url));
  return eps.length ? eps[eps.length - 1].url : null;
}

(async () => {
  const today = londonDate();
  // jobs that can still change, with days ahead (a small query, to stay inside the free reads)
  const snap = await db.collection("calls").where("status", "in", ["pending", "available", "declined", "confirmed"]).get();
  const jobs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(c => portalLink(c) && (c.dates || []).some(e => e.d >= today))
    // a new picture when there is none, or the job changed since the last one (e.g. you answered)
    .filter(c => process.env.ALL === "true" || !c.pageShotAt || (c.updatedAt && c.updatedAt > c.pageShotAt) ||
                 Date.now() - new Date(c.pageShotAt).getTime() > 24 * 3600 * 1000)
    .sort((a, b) => (a.pageShotAt || "").localeCompare(b.pageShotAt || ""))
    .slice(0, MAX_PER_RUN);
  if (!jobs.length) { report("notice", "EP pictures", "Nothing new to photograph."); return; }

  const browser = await chromium.launch();
  // phone-width page, sharp enough to read on a phone without zooming
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, isMobile: true,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" });
  let done = 0, failed = 0, login = 0;
  try {
    for (const c of jobs) {
      try {
        await page.goto(portalLink(c), { waitUntil: "networkidle", timeout: 45000 });
        // the page asks for a login → not one we can (or should) photograph
        if (/auth\.ep\.com/i.test(page.url()) || await page.locator("input[type=password]").count()) { login++; continue; }
        // photograph the whole page, getting smaller until it fits comfortably in the database (≤ 700 KB)
        let shot = null;
        for (const q of [55, 40, 28, 20]) {
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          shot = await page.screenshot({ type: "jpeg", quality: q, fullPage: height <= 4000,
            clip: height > 4000 ? { x: 0, y: 0, width: 430, height: 4000 } : undefined });
          if (shot.length <= 700 * 1024) break;
        }
        if (!shot || shot.length > 700 * 1024) { failed++; continue; }
        const at = new Date().toISOString();
        await db.collection("pages").doc(c.id).set({ img: "data:image/jpeg;base64," + shot.toString("base64"), at, url: portalLink(c) });
        await db.collection("calls").doc(c.id).update({ pageShotAt: at });
        done++;
      } catch (e) { failed++; }
    }
  } finally {
    await browser.close();
  }
  report("notice", "EP pictures", `Photographed ${done} EP pages` + (failed ? `, ${failed} failed` : "") + (login ? `, ${login} asked for a login` : "") + ".");
})().catch(e => { report("error", "EP pictures", "Stopped: " + (e.code || e.name || "error")); process.exit(1); });
