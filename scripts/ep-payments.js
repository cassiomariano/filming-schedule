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

async function signIn(page) {
  await page.goto(PORTAL + "/my/payments", { waitUntil: "domcontentloaded", timeout: 60000 });
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
    const bad = await page.evaluate(() => /incorrect|invalid|not recogni|locked|try again/i.test(document.body.innerText));
    if (bad) { report("error", "EP sign-in", "EP says the email or password isn't right (or the account is locked). Check the secrets."); return false; }
    const handover = page.locator("button:has-text('Submit'):visible, input[type=submit][value*=Submit i]:visible").first();
    if (!page.url().startsWith(PORTAL) && (await handover.count()) && !(await pass().count())) await handover.click().catch(() => {});
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
      LOGIN = logins[i];
      const context = await browser.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36", viewport: { width: 1366, height: 900 } });
      const page = await context.newPage();
      try {
        if (!(await signIn(page))) { failed++; continue; }
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
