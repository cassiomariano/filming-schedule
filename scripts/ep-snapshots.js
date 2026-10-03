/*
 * ep-snapshots.js — takes a picture of each open job's EP message page (the page where you tick
 * Available / Not available), so the app can show exactly what you answered.
 *
 * It only OPENS the page (the same link as in the agency's email, no login). It never clicks,
 * types or submits anything, so it can't change your answer.
 *
 * The list of open jobs comes from the robot's one-document job index (meta/index), so each run costs
 * two database reads, however many jobs you have. Pictures are small JPEGs stored under "pages/<job id>",
 * loaded by the app only when you open that job. Runs every hour (.github/workflows/ep-snapshots.yml).
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

(async () => {
  const today = londonDate();
  const [iDoc, sDoc] = await Promise.all([db.collection("meta").doc("index").get(), db.collection("meta").doc("shots").get()]);
  const index = (iDoc.exists && iDoc.data().jobs) || {};
  const shots = (sDoc.exists && sDoc.data().at) || {};
  // jobs that can still change, with days ahead and an EP page: a new picture once a day,
  // or sooner when the page was read again since the last picture (e.g. you answered)
  const jobs = Object.entries(index)
    .filter(([, e]) => ["pending", "available", "declined", "confirmed"].includes(e.s) && e.pu && e.l >= today)
    .filter(([id, e]) => process.env.ALL === "true" || !shots[id] || (e.pa && e.pa > shots[id]) || Date.now() - new Date(shots[id]).getTime() > 24 * 3600 * 1000)
    .sort((a, b) => String(shots[a[0]] || "").localeCompare(String(shots[b[0]] || "")))
    .slice(0, MAX_PER_RUN);
  if (!jobs.length) { report("notice", "EP pictures", "Nothing new to photograph."); return; }

  const browser = await chromium.launch();
  // phone-width page, sharp enough to read on a phone without zooming
  const page = await browser.newPage({ viewport: { width: 430, height: 900 }, deviceScaleFactor: 2, isMobile: true,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" });
  let done = 0, failed = 0, login = 0;
  try {
    for (const [id, e] of jobs) {
      try {
        await page.goto(e.pu, { waitUntil: "networkidle", timeout: 45000 });
        if (/auth\.ep\.com/i.test(page.url()) || await page.locator("input[type=password]").count()) { login++; continue; }
        let shot = null;
        for (const q of [55, 40, 28, 20]) {
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          shot = await page.screenshot({ type: "jpeg", quality: q, fullPage: height <= 4000, clip: height > 4000 ? { x: 0, y: 0, width: 430, height: 4000 } : undefined });
          if (shot.length <= 700 * 1024) break;
        }
        if (!shot || shot.length > 700 * 1024) { failed++; continue; }
        const at = new Date().toISOString();
        await db.collection("pages").doc(id).set({ img: "data:image/jpeg;base64," + shot.toString("base64"), at, url: e.pu });
        await db.collection("calls").doc(id).update({ pageShotAt: at });
        shots[id] = at;
        done++;
      } catch (err) { failed++; }
    }
  } finally {
    await browser.close();
  }
  await db.collection("meta").doc("shots").set({ at: shots });
  report("notice", "EP pictures", `Photographed ${done} EP pages` + (failed ? `, ${failed} failed` : "") + (login ? `, ${login} asked for a login` : "") + ".");
})().catch(e => { report("error", "EP pictures", "Stopped: " + (e.code || e.name || "error")); process.exit(1); });
