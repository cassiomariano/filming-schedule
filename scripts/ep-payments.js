/*
 * ep-payments.js — signs in to your Entertainment Partners (EP) portal and reads your Payments pages.
 *
 * It uses a real (invisible) browser, because EP's sign-in page is built in the browser.
 * It ONLY signs in and opens pages under /my/payments. It never clicks anything else,
 * so it can't answer a job or change your profile.
 *
 * Your EP email and password come from the GitHub secrets EP_EMAIL and EP_PASSWORD.
 * The public log shows only counts and the shape of the sign-in page, never your data.
 */
const fs = require("fs");
const { chromium } = require("playwright");
const { seal } = require("./vault.js");

const crypto = require("crypto");
const admin = require("firebase-admin");
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { open: unseal } = require("./vault.js");

// the database (same key as the email robot): for the code you type in the app,
// and to keep the signed-in session sealed so EP doesn't ask for a code every time
let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT || "").replace(/[“”„‟″]/g, '"').replace(/[‘’]/g, "'");
const serviceAccount = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const ROBOT_KEY = crypto.createPublicKey(serviceAccount.private_key).export({ type: "spki", format: "pem" });

const PORTAL = "https://uk.epcastingportal.com";
let LOGIN = null;
function report(kind, title, text) { console.log(`::${kind} title=${title}::${text}`); }

// Your EP login, from whichever secret names you used. Only the NAMES are reported, never the values.
function login() {
  const names = ["EP_EMAIL", "EP_PASSWORD", "EP_EMAIL_1", "EP_EMAIL_2", "EP_PASSWORD_1", "EP_PASSWORD_2", "ET_EMAIL_1", "ET_EMAIL_2"];
  const set = names.filter(n => (process.env[n] || "").trim());
  report("notice", "EP secrets found", set.length ? set.join(", ") : "none");
  const vals = set.map(n => ({ n, v: process.env[n].trim() }));
  const email = vals.find(x => /EMAIL/.test(x.n) && x.v.includes("@"));
  const pass = vals.find(x => /PASSWORD/.test(x.n) && x !== email) || vals.find(x => x !== email && !x.v.includes("@"));
  // one or two EP accounts: EP_EMAIL_1 + EP_PASSWORD_1, EP_EMAIL_2 + EP_PASSWORD_2
  const out = [];
  for (const sfx of ["", "_1", "_2"]) {
    const e = (process.env["EP_EMAIL" + sfx] || process.env["ET_EMAIL" + sfx] || "").trim();
    const p = (process.env["EP_PASSWORD" + sfx] || "").trim();
    if (e && p && e.includes("@")) out.push({ email: e, password: p, n: sfx || "_0" });
  }
  if (!out.length && email && pass) out.push({ email: email.v, password: pass.v, n: "_x" });
  report("notice", "EP login", `${out.length} EP account(s) to read`);
  return out.length ? out : null;
}

// what the sign-in page looks like (field types and button words only, nothing personal)
async function describeForm(page) {
  return page.evaluate(() => {
    const inputs = [...document.querySelectorAll("input")].filter(i => i.type !== "hidden")
      .map(i => `${i.type}${i.name ? ":" + i.name : ""}${i.id ? "#" + i.id : ""}${i.offsetParent ? "" : "(hidden)"}`);
    const buttons = [...document.querySelectorAll("button, input[type=submit], a.button, a[role=button]")]
      .map(b => (b.innerText || b.value || "").trim().slice(0, 30)).filter(Boolean);
    const flags = ["captcha", "verification code", "one-time", "authenticator", "text message", "remember"]
      .filter(w => document.body.innerText.toLowerCase().includes(w));
    return `inputs [${inputs.join(", ")}] · buttons [${buttons.join(" | ")}] · notes [${flags.join(", ")}]`;
  });
}

// the screen asking for a verification code
async function isCodeScreen(page) {
  return page.evaluate(() => /verification code|one-time|passcode|security code|enter (the )?code|we('ve| have) sent|sent a code/i.test(document.body.innerText));
}
// the code: typed by you in the app (database "ep/code"), or found in an EP email in your Yahoo inbox
async function waitForCode(n) {
  const ref = db.collection("ep").doc("code");
  const askedAt = new Date().toISOString();
  await ref.set({ status: "waiting", account: n, askedAt, code: "" });
  if (process.env.NTFY_TOPIC) {
    await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      topic: process.env.NTFY_TOPIC, title: "EP sign-in code needed", priority: 5, tags: ["key"],
      message: "EP sent you a sign-in code. Open the Filming Schedule app and type it in the yellow box (within 8 minutes).",
      click: "https://cassiomariano.github.io/filming-schedule/" }) }).catch(() => {});
  }
  const until = Date.now() + 8 * 60 * 1000;
  while (Date.now() < until) {
    const d = (await ref.get()).data() || {};
    if (d.code && d.askedAt === askedAt) { await ref.set({ status: "used", account: n, askedAt, code: "" }); report("notice", "EP code", "Code typed in the app."); return String(d.code).replace(/\s/g, ""); }
    const mailed = await codeFromEmail(new Date(askedAt));
    if (mailed) { await ref.set({ status: "used", account: n, askedAt, code: "" }); report("notice", "EP code", "Code found in an EP email."); return mailed; }
    await new Promise(r => setTimeout(r, 6000));
  }
  await ref.set({ status: "expired", account: n, askedAt, code: "" });
  return null;
}
async function codeFromEmail(since) {
  for (const sfx of ["1", "2"]) {
    const user = process.env["YAHOO_EMAIL_" + sfx], pass = process.env["YAHOO_APP_PASSWORD_" + sfx];
    if (!user || !pass) continue;
    const client = new ImapFlow({ host: "imap.mail.yahoo.com", port: 993, secure: true, auth: { user, pass }, logger: false });
    client.on("error", () => {});
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        const uids = (await client.search({ since: new Date(since.getTime() - 864e5) }, { uid: true })) || [];
        for (const uid of uids.slice(-15).reverse()) {
          const msg = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
          const env = msg.envelope || {};
          const from = ((env.from && env.from[0]) || {}).address || "";
          if (!/ep\.com|entertainmentpartners|epcastingportal|pingidentity/i.test(from)) continue;
          if (env.date && new Date(env.date) < new Date(since.getTime() - 60000)) continue;
          const mail = await simpleParser(msg.source);
          const m = String((env.subject || "") + " " + (mail.text || "")).match(/\b(\d{6}|\d{4,8})\b/);
          if (m) return m[1];
        }
      } finally { lock.release(); }
    } catch (e) { /* try the other inbox */ } finally { try { await client.logout(); } catch (_) {} }
  }
  return null;
}
// the signed-in session (cookies), sealed for the robot only, so the next run skips the code
async function loadSession(n) {
  try {
    const d = (await db.collection("ep").doc("session" + n).get()).data();
    return d && d.box ? unseal(serviceAccount.private_key, JSON.parse(d.box)) : undefined;
  } catch (e) { return undefined; }
}
async function saveSession(n, context) {
  const state = await context.storageState();
  await db.collection("ep").doc("session" + n).set({ box: JSON.stringify(seal(ROBOT_KEY, state)), at: new Date().toISOString() });
}

async function signIn(page) {
  await page.goto(PORTAL + "/my/payments", { waitUntil: "networkidle", timeout: 60000 });
  const signedIn = await page.evaluate(() => /log ?out|sign ?out/i.test(document.body.innerText) && !/log in|login/i.test(document.querySelector("nav, header")?.innerText || ""));
  if (page.url().startsWith(PORTAL) && signedIn) { report("notice", "EP sign-in", "Still signed in from last time (no code needed)."); return true; }
  // the "Log In" link goes to EP's sign-in site (auth.ep.com); follow its address directly
  if (page.url().startsWith(PORTAL)) {
    const hrefs = await page.$$eval("a[href*='auth.ep.com']", as => as.map(a => a.href));
    const signin = hrefs.find(h => !/register|reset|forgot|password/i.test(h)) || hrefs[0] ||
      "https://auth.ep.com/as/authorize?client_id=02cc3685-34ab-413d-b80c-19c939bdeb88&response_type=code&scope=ep+openid&redirect_uri=https%3A%2F%2Fuk.epcastingportal.com%2Foauth%2Fep%2Fcallback%3Fsite_id%3D1";
    await page.goto(signin, { waitUntil: "networkidle", timeout: 60000 });
  }
  await page.waitForTimeout(3000);
  report("notice", "EP sign-in page", `on ${new URL(page.url()).host} · ${await describeForm(page)}`);

  const user = page.locator("input[type=email]:visible, input[name*=user i]:visible, input[name*=email i]:visible, input[id*=user i]:visible, input[type=text]:visible").first();
  const pass = () => page.locator("input[type=password]:visible").first();
  const submit = () => page.locator("button[type=submit]:visible, input[type=submit]:visible, button:has-text('Sign On'):visible, button:has-text('Sign In'):visible, button:has-text('Log In'):visible, button:has-text('Next'):visible, button:has-text('Continue'):visible, a:has-text('Sign On'):visible").first();

  if (!(await user.count())) { report("error", "EP sign-in", "Couldn't find the email box on the sign-in page."); return false; }
  await user.fill(LOGIN.email);
  if (!(await pass().count())) {                       // email first, password on the next screen
    await submit().click();
    await page.waitForTimeout(3000);
    report("notice", "EP sign-in page (step 2)", await describeForm(page));
  }
  if (!(await pass().count())) { report("error", "EP sign-in", "Couldn't find the password box."); return false; }
  await pass().fill(LOGIN.password);
  // press "Sign in" itself (not "Forgot password?" or "Back")
  const signBtn = page.locator("button:has-text('Sign in'):visible, button:has-text('Sign In'):visible, button:has-text('Sign On'):visible, button:has-text('Log in'):visible").first();
  await ((await signBtn.count()) ? signBtn : submit()).click();
  // EP may show a hand-over page with one "Submit" button (it normally sends itself on)
  for (let i = 0; i < 6 && !page.url().startsWith(PORTAL); i++) {
    await page.waitForTimeout(3000);
    // a wrong password keeps you on the password screen with an error message
    if (await isCodeScreen(page)) break;                   // the code step comes next
    const bad = (await pass().count()) && await page.evaluate(() => /incorrect|invalid|not recogni|locked/i.test(document.body.innerText));
    if (bad) {
      const words = await page.evaluate(() => ["incorrect", "invalid", "not recogni", "locked", "try again", "required", "captcha", "robot", "attempts"]
        .filter(w => document.body.innerText.toLowerCase().includes(w)));
      if (i < 2) continue;                                  // give the page a few seconds first
      report("error", "EP sign-in", `Still on the password screen. Words on the page: ${words.join(", ") || "none"} · ${await describeForm(page)}`);
      return false;
    }
    const handover = page.locator("button:has-text('Submit'):visible, input[type=submit][value*=Submit i]:visible").first();
    if (!page.url().startsWith(PORTAL) && (await handover.count()) && !(await pass().count())) await handover.click().catch(() => {});
  }
  // EP's verification code
  if (!page.url().startsWith(PORTAL) && await isCodeScreen(page)) {
    report("notice", "EP sign-in", "EP asks for a verification code: " + await describeForm(page));
    const code = await waitForCode(LOGIN.n);
    if (!code) { report("error", "EP sign-in", "No code arrived within 8 minutes. Run it again and type the code in the app when your phone buzzes."); return false; }
    const box = page.locator("input[autocomplete=one-time-code]:visible, input[name*=code i]:visible, input[id*=code i]:visible, input[name*=otp i]:visible, input[id*=otp i]:visible, input[type=tel]:visible, input[type=number]:visible, input[type=text]:visible, input[type=password]:visible").first();
    await box.fill(code);
    const remember = page.locator("input[type=checkbox]:visible").first();
    if (await remember.count()) await remember.check().catch(() => {});          // "remember this device"
    const go = page.locator("button:has-text('Verify'):visible, button:has-text('Submit'):visible, button:has-text('Continue'):visible, button:has-text('Sign'):visible, button[type=submit]:visible").first();
    await go.click();
    for (let i = 0; i < 6 && !page.url().startsWith(PORTAL); i++) {
      await page.waitForTimeout(3000);
      const handover = page.locator("button:has-text('Submit'):visible").first();
      if (!(await isCodeScreen(page)) && (await handover.count())) await handover.click().catch(() => {});
    }
  }
  try { await page.waitForURL(u => String(u).startsWith(PORTAL), { timeout: 30000 }); }
  catch (e) {
    report("error", "EP sign-in", "Didn't get back to the portal after signing in. What the page shows: " + await describeForm(page));
    return false;
  }
  return true;
}

(async () => {
  const logins = login();
  if (!logins) {
    report("error", "EP", "Need two secrets: your EP email and your EP password (SETUP.md, 'EP portal').");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const all = [];
  let failed = 0;
  try {
    for (let i = 0; i < logins.length; i++) {
      if (process.env.EP_ONLY && String(i + 1) !== process.env.EP_ONLY) continue;
      LOGIN = logins[i];
      const saved = await loadSession(LOGIN.n);
      const context = await browser.newContext({ storageState: saved, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36", viewport: { width: 1366, height: 900 } });
      const page = await context.newPage();
      try {
        if (!(await signIn(page))) { failed++; continue; }
        await saveSession(LOGIN.n, context);
        const pages = await readPortal(page, i + 1);
        pages.forEach(p => { p.account = i + 1; all.push(p); });
      } finally { await context.close(); }
    }
    if (process.env.EP_EXPORT === "true" && all.length) {
      const box = seal(fs.readFileSync(__dirname + "/export-key.pem", "utf8"), { at: new Date().toISOString(), pages: all });
      fs.writeFileSync("export.sealed.json", JSON.stringify(box));
    }
  } finally {
    await browser.close();
  }
  if (failed === logins.length) process.exit(1);
})().catch(e => { report("error", "EP", "Stopped: " + (e.name || "error") + " " + String(e.message || "").split("\n")[0].slice(0, 160)); process.exit(1); });

// Every section in the menu, read-only: open the page, never press a button or send a form.
async function readPortal(page, n) {
  const SECTIONS = ["/my/dashboard", "/my/diary", "/my/payments", "/my/schedule", "/my/contracts", "/my/job-review", "/my/inbox", "/my/profiles"];
  const pages = [];
  const seen = new Set();
  const read = async url => {
    if (seen.has(url) || !url.startsWith(PORTAL + "/my") || /logout|sign-?out|delete|remove|edit|respond|reply|accept|decline|withdraw|cancel/i.test(url)) return null;
    seen.add(url);
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      const p = { url: page.url(), html: await page.content(), text: await page.innerText("body") };
      pages.push(p);
      return p;
    } catch (e) { return null; }
  };
  const menu = [...new Set(await page.$$eval("nav a[href], header a[href]", as => as.map(a => a.href)))].filter(u => u.startsWith(PORTAL + "/my"));
  const sections = [...new Set([...menu, ...SECTIONS.map(x => PORTAL + x)])];
  const counts = {};
  for (const url of sections) {
    const p = await read(url);
    if (!p) continue;
    // one level deeper: each payment, contract and inbox message (up to 120 each)
    const sub = [...new Set(await page.$$eval("a[href]", as => as.map(a => a.href)))]
      .filter(u => u.startsWith(url.replace(/\/$/, "") + "/") && u !== url);
    for (const u of sub.slice(0, 120)) await read(u);
    counts[new URL(url).pathname] = 1 + sub.slice(0, 120).length;
  }
  report("notice", "EP portal " + n, `Signed in. Pages read: ${Object.entries(counts).map(([k, v]) => k + " " + v).join(", ")}.`);
  return pages;
}
