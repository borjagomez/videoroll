import type { Browser, Page } from "playwright";
import { config } from "../config.js";
import { launch, newContext } from "../browser.js";
import path from "node:path";
import { storageStatePath, ensureDir, profileDir, rel } from "../paths.js";
import { log, dim, bold } from "../log.js";

export interface LoginOptions {
  appUrl: string;
  profile: string;
  username?: string;
  password?: string;
  /** Open a real window and let a human finish (SSO, 2FA, captcha). */
  manual?: boolean;
  timeoutMs?: number;
}

const AUTH_URL = /\/(login|signin|sign_in|sign-in|auth|sessions?\/new)\b/i;
const CONTINUE_TEXT = /^(continue|next|sign in|log ?in|submit)$/i;

async function firstVisible(page: Page, selectors: string[], timeoutMs = 1200) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: timeoutMs })) return locator;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Wait for a client-rendered auth form to actually appear.
 *
 * The form is React-rendered, so at domcontentloaded the page has no inputs at
 * all. Probing immediately reports "no login form" and the run then saves an
 * unauthenticated session while claiming success - which is worse than failing.
 */
async function waitForForm(page: Page, timeoutMs = 20_000): Promise<void> {
  try {
    await page
      .locator('input:not([type="hidden"]), button[type="submit"]')
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    /* caller decides what an empty page means */
  }
}

/**
 * Are we looking at an authentication screen?
 *
 * A password box is the clearest signal, but email-first logins show only a
 * single text field and a Continue button on step one, so that alone is not
 * enough. The URL is the tiebreaker.
 */
async function isOnLoginScreen(page: Page): Promise<boolean> {
  if (await firstVisible(page, ['input[type="password"]'], 1200)) return true;
  if (!AUTH_URL.test(page.url())) return false;

  const identifier = await firstVisible(
    page,
    ['input[type="email"]', 'input[type="text"]', 'input:not([type="hidden"])'],
    1200,
  );
  return Boolean(identifier);
}

/**
 * Best-effort form login. Deliberately heuristic rather than configurable:
 * nearly every login page is an identifier field, a password field and a submit
 * button, and anything stranger than that is what `--manual` is for.
 */
async function autoLogin(page: Page, username: string, password: string): Promise<void> {
  const identifier = await firstVisible(page, [
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[type="text"]',
    // `<input>` with no type attribute behaves as text, but `[type="text"]`
    // does not match it - the DOM *property* defaults to "text" while the
    // attribute stays absent. Frameworks emit these constantly.
    "input:not([type])",
    // Last resort: the only field on screen that is not hidden or a password.
    'input:not([type="hidden"]):not([type="password"])',
  ]);
  if (!identifier) {
    throw new Error(
      "Could not find an email or username field on the login page. " +
        "Re-run with --manual and sign in by hand.",
    );
  }
  await identifier.fill(username);

  // Two-step logins ask for the identifier first and only then reveal the
  // password field, so advance past step one before looking for it.
  if (!(await firstVisible(page, ['input[type="password"]'], 800))) {
    const next =
      (await firstVisible(page, ['button[type="submit"]'], 800)) ??
      page.getByRole("button", { name: CONTINUE_TEXT }).first();
    try {
      await next.click({ timeout: 8_000 });
    } catch {
      await identifier.press("Enter");
    }
  }

  let passwordField;
  try {
    passwordField = page.locator('input[type="password"]').first();
    await passwordField.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    throw new Error(
      "Entered the email but no password field appeared. This login may use SSO " +
        "or a magic link - re-run with --manual and sign in by hand.",
    );
  }
  await passwordField.fill(password);

  const submit = await firstVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Continue")',
  ]);
  if (submit) await submit.click();
  else await passwordField.press("Enter");
}

/** Resolves when the human has signed in, or when they press Enter. */
async function waitForHuman(page: Page, timeoutMs: number): Promise<void> {
  log.blank();
  log.info(
    `${bold("A browser window is open.")} Sign in there — including any SSO or ` +
      `2FA step.`,
  );
  log.detail("Detection is automatic; press Enter here if it does not notice.");
  log.blank();

  const pressedEnter = new Promise<void>((resolve) => {
    const onData = () => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });

  const signedIn = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1500);
      if (page.isClosed()) return;
      if (!(await isOnLoginScreen(page))) {
        // Let the post-login app settle before snapshotting cookies.
        await page.waitForTimeout(2500);
        return;
      }
    }
    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for sign-in.`);
  })();

  await Promise.race([pressedEnter, signedIn]);
}

/**
 * Block until the browser is demonstrably inside the application.
 *
 * "No password box visible" is not proof - it is also true of a blank page and
 * of a login form that has not rendered yet. Signing in has to move us off the
 * auth URL and put some navigation on screen before we believe it.
 */
async function waitUntilSignedIn(
  page: Page,
  timeoutMs: number,
  profile: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = "";

  while (Date.now() < deadline) {
    await page.waitForTimeout(1000);
    lastSeen = page.url();

    if (await isOnLoginScreen(page)) continue;
    if (AUTH_URL.test(lastSeen)) continue;

    const links = await page
      .locator("nav a[href], aside a[href], [role='navigation'] a[href]")
      .count()
      .catch(() => 0);
    if (links > 0) return;
  }

  // A login that fails headlessly is otherwise invisible - the page usually
  // says exactly what went wrong, so keep a picture of it.
  let shot = "";
  try {
    shot = path.join(ensureDir(profileDir(profile)), "login-failure.png");
    await page.screenshot({ path: shot, fullPage: false });
  } catch {
    shot = "";
  }

  const onScreen = await page
    .locator("body")
    .innerText()
    .then((t) => t.replace(/\s+/g, " ").trim().slice(0, 300))
    .catch(() => "");

  throw new Error(
    `Could not confirm the sign-in succeeded - still at ${lastSeen}.\n` +
      (onScreen ? `  The page says: ${onScreen}\n` : "") +
      (shot ? `  Screenshot: ${rel(shot)}\n` : "") +
      `  Check the credentials in .env, or re-run with --manual to sign in by hand.`,
  );
}

export interface LoginResult {
  browser: Browser;
  page: Page;
  /** Where the app landed after login - the natural start for demos. */
  landingUrl: string;
}

/**
 * Signs in and leaves the browser open so the caller can go on to map the app.
 * The caller owns closing it.
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const timeoutMs = options.timeoutMs ?? (options.manual ? 300_000 : 60_000);

  const browser = await launch(!options.manual);
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    log.step(`Opening ${options.appUrl}`);
    await page.goto(options.appUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForForm(page);

    if (options.manual) {
      await waitForHuman(page, timeoutMs);
    } else {
      const username = options.username || config.demo.username;
      const password = options.password || config.demo.password;
      if (!username || !password) {
        throw new Error(
          "No credentials. Set VDG_DEMO_USERNAME and VDG_DEMO_PASSWORD in .env, " +
            "pass --username/--password, or use --manual to sign in by hand.",
        );
      }
      if (await isOnLoginScreen(page)) {
        log.step(`Signing in as ${username}`);
        // Demo environments cold-start, and a submit occasionally lands before
        // the form's handlers are wired up. One retry from a fresh load turns
        // an intermittent failure into a reliable command.
        for (let attempt = 1; attempt <= 2; attempt++) {
          await autoLogin(page, username, password);
          try {
            await waitUntilSignedIn(page, 30_000, options.profile);
            break;
          } catch (error) {
            if (attempt === 2) throw error;
            log.warn("Sign-in did not go through; retrying once.");
            await page.goto(options.appUrl, {
              waitUntil: "domcontentloaded",
              timeout: 45_000,
            });
            await waitForForm(page);
          }
        }
      } else if (AUTH_URL.test(page.url())) {
        throw new Error(
          `${page.url()} looks like a login page but no form appeared on it. ` +
            `Re-run with --manual to sign in by hand.`,
        );
      } else {
        log.detail("no login form - the session already appears to be open");
      }
    }

    // Prove we actually got in. Without this a run that silently failed to log
    // in still saves a session file and reports success, and the failure only
    // surfaces much later as an inexplicably empty app.
    await waitUntilSignedIn(page, options.manual ? 30_000 : 45_000, options.profile);

    ensureDir(profileDir(options.profile));
    await context.storageState({ path: storageStatePath(options.profile) });
    log.ok(`Session saved → ${rel(storageStatePath(options.profile))}`);

    return { browser, page, landingUrl: page.url() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

/** True when the saved session still gets us into the app. */
export async function sessionIsValid(profile: string, url: string): Promise<boolean> {
  const browser = await launch(true);
  try {
    const context = await newContext(browser, {
      storageStatePath: storageStatePath(profile),
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1500);
    const expired = await isOnLoginScreen(page);
    if (expired) log.warn(dim("saved session is no longer valid"));
    return !expired;
  } catch {
    return false;
  } finally {
    await browser.close();
  }
}
