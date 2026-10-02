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
function report(kind, title, text) { console.log(`::${kind} title=${title}::${text}`); }

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
  await user.fill(process.env.EP_EMAIL);
  if (!(await pass().count())) {                       // email first, password on the next screen
    await submit().click();
    await page.waitForTimeout(3000);
    report("notice", "EP sign-in page (step 2)", await describeForm(page));
  }
  if (!(await pass().count())) { report("error", "EP sign-in", "Couldn't find the password box."); return false; }
  await pass().fill(process.env.EP_PASSWORD);
  await submit().click();
  try { await page.waitForURL(u => String(u).startsWith(PORTAL), { timeout: 45000 }); }
  catch (e) {
    report("error", "EP sign-in", "Didn't get back to the portal after signing in. What the page shows: " + await describeForm(page));
    return false;
  }
  return true;
}

(async () => {
  if (!process.env.EP_EMAIL || !process.env.EP_PASSWORD) {
    report("error", "EP", "Add the EP_EMAIL and EP_PASSWORD secrets first (SETUP.md, 'EP payments').");
    process.exit(1);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" });
  try {
    if (!(await signIn(page))) process.exit(1);
    // the payments list, then each payment's own page
    await page.goto(PORTAL + "/my/payments", { waitUntil: "networkidle", timeout: 60000 });
    const pages = [{ url: page.url(), html: await page.content(), text: await page.innerText("body") }];
    const links = [...new Set(await page.$$eval("a[href*='/my/payments/']", as => as.map(a => a.href)))];
    for (const url of links.slice(0, 200)) {
      if (!url.startsWith(PORTAL + "/my/payments/")) continue;   // never leave the payments pages
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      pages.push({ url, html: await page.content(), text: await page.innerText("body") });
    }
    report("notice", "EP payments", `Signed in. Read the payments list and ${pages.length - 1} payment pages.`);
    if (process.env.EP_EXPORT === "true") {
      const box = seal(fs.readFileSync(__dirname + "/export-key.pem", "utf8"), { at: new Date().toISOString(), pages });
      fs.writeFileSync("export.sealed.json", JSON.stringify(box));
    }
  } finally {
    await browser.close();
  }
})().catch(e => { report("error", "EP", "Stopped: " + (e.name || "error") + " " + String(e.message || "").split("\n")[0].slice(0, 160)); process.exit(1); });
