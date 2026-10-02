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
  if (email && pass) report("notice", "EP login", `email from ${email.n}, password from ${pass.n}`);
  return email && pass ? { email: email.v, password: pass.v } : null;
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
  // EP sends you to its sign-in site (auth.ep.com); some pages have a "Log In" link first
  if (page.url().startsWith(PORTAL)) {
    const login = page.locator("a:has-text('Log In'), a:has-text('Login'), a:has-text('Sign in')").first();
    if (await login.count()) await Promise.all([page.waitForLoadState("domcontentloaded"), login.click()]);
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
  await submit().click();
  try { await page.waitForURL(u => String(u).startsWith(PORTAL), { timeout: 45000 }); }
  catch (e) {
    report("error", "EP sign-in", "Didn't get back to the portal after signing in. What the page shows: " + await describeForm(page));
    return false;
  }
  return true;
}

(async () => {
  LOGIN = login();
  if (!LOGIN) {
    report("error", "EP", "Need two secrets: your EP email and your EP password (SETUP.md, 'EP portal').");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" });
  try {
    if (!(await signIn(page))) process.exit(1);
    // Every section in the menu, read-only: open the page, never press a button or send a form.
    const SECTIONS = ["/my/dashboard", "/my/diary", "/my/payments", "/my/schedule", "/my/contracts", "/my/job-review", "/my/inbox", "/my/profiles"];
    const pages = [];
    const seen = new Set();
    const read = async url => {
      if (seen.has(url) || !url.startsWith(PORTAL + "/my/") || /logout|sign-?out|delete|remove|edit|respond|reply|accept|decline/i.test(url)) return null;
      seen.add(url);
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
        const p = { url: page.url(), html: await page.content(), text: await page.innerText("body") };
        pages.push(p);
        return p;
      } catch (e) { return null; }
    };
    // the menu itself tells us the real addresses
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
    report("notice", "EP portal", `Signed in. Pages read: ${Object.entries(counts).map(([k, v]) => k + " " + v).join(", ")}.`);
    if (process.env.EP_EXPORT === "true") {
      const box = seal(fs.readFileSync(__dirname + "/export-key.pem", "utf8"), { at: new Date().toISOString(), pages });
      fs.writeFileSync("export.sealed.json", JSON.stringify(box));
    }
  } finally {
    await browser.close();
  }
})().catch(e => { report("error", "EP", "Stopped: " + (e.name || "error") + " " + String(e.message || "").split("\n")[0].slice(0, 160)); process.exit(1); });
