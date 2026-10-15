/**
 * Generic auto-login using Chrome's saved passwords (autofill).
 *
 * IMPORTANT: Chrome autofill only triggers on real mouse clicks (Puppeteer page.click),
 * NOT on JavaScript element.click() or element.focus(). This module uses page.click()
 * with actual coordinates to trigger the autofill dropdown, then waits for Chrome to
 * populate the fields and selects the first suggestion.
 *
 * Flow:
 * 1. Detect if we're on a login page (password field visible)
 * 2. Real mouse-click into email/username field → triggers Chrome autofill dropdown
 * 3. Wait for dropdown, then press ArrowDown + Enter to select first suggestion
 * 4. If fields are filled → click submit
 * 5. If fields are empty → return 'needs_manual_login'
 * 6. Wait for navigation after submit
 * 7. Handle 2FA / CAPTCHA → return 'needs_manual_login'
 *
 * This does NOT store or handle credentials — it only clicks buttons
 * on forms that Chrome's password manager has already filled.
 */
import type { Page } from 'puppeteer-core';

export type AutoLoginResult =
  | { status: 'already_logged_in' }
  | { status: 'login_successful'; message: string }
  | { status: 'needs_manual_login'; message: string }
  | { status: 'login_failed'; message: string };

/** Selectors for email/username input fields (broad set for many portals) */
const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]', 'input[name="account"]', 'input[name="username"]', 'input[name="login"]',
  'input[id="email"]', 'input[id="ap_email"]', 'input[id="login-email"]',
  'input[type="text"][name*="email"]', 'input[type="text"][name*="user"]',
  'input[type="text"][id*="email"]', 'input[type="text"][id*="user"]',
  'input[type="text"][id*="login"]', 'input[type="text"][autocomplete="username"]',
].join(', ');

/** Selectors for submit buttons */
const SUBMIT_SELECTORS = [
  '#signInSubmit', '#sign-in-button', 'button[type="submit"]',
  'input[type="submit"]', 'button[id*="login"]', 'button[id*="submit"]',
  '.auth-button', 'button[name="login"]', 'button[name="submit"]',
  '#continue', '#submitButton',
];

/**
 * Attempt auto-login on the current page using Chrome autofill.
 * Works for any portal — detects login forms generically.
 *
 * Uses real Puppeteer mouse clicks (not JS .click()) to trigger Chrome's
 * autofill dropdown for saved passwords.
 */
export async function attemptAutoLogin(page: Page, maxAttempts = 3): Promise<AutoLoginResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. Check if there's a login form on the page
    const formInfo = await page.evaluate(`
      (() => {
        const pwFields = document.querySelectorAll('input[type="password"]');
        if (pwFields.length === 0) return { hasLoginForm: false };

        const emailFields = document.querySelectorAll('${EMAIL_SELECTORS}');

        let emailFilled = false;
        let pwFilled = false;
        for (const f of emailFields) {
          if (f.value && f.value.length > 2) emailFilled = true;
        }
        for (const f of pwFields) {
          if (f.value && f.value.length > 0) pwFilled = true;
        }

        return {
          hasLoginForm: true,
          emailFieldCount: emailFields.length,
          pwFieldCount: pwFields.length,
          emailFilled,
          pwFilled,
        };
      })()
    `) as {
      hasLoginForm: boolean;
      emailFieldCount?: number;
      pwFieldCount?: number;
      emailFilled?: boolean;
      pwFilled?: boolean;
    };

    // No login form → already logged in or not a login page
    if (!formInfo.hasLoginForm) {
      return { status: 'already_logged_in' };
    }

    console.log(`[auto-login] Attempt ${attempt}: form detected, email=${formInfo.emailFilled}, pw=${formInfo.pwFilled}`);

    // 2. If fields aren't filled, trigger Chrome autofill via real mouse click
    if (!formInfo.emailFilled || !formInfo.pwFilled) {
      // Get coordinates of the email field for a real Puppeteer click
      const emailRect = await page.evaluate(`
        (() => {
          const selectors = '${EMAIL_SELECTORS}'.split(', ');
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
          }
          return null;
        })()
      `) as { x: number; y: number } | null;

      if (emailRect) {
        // Real mouse click triggers Chrome autofill dropdown
        await page.mouse.click(emailRect.x, emailRect.y);
        console.log(`[auto-login] Real mouse click at (${emailRect.x}, ${emailRect.y})`);
        await new Promise(r => setTimeout(r, 2000));

        // Press ArrowDown + Enter to select the first autofill suggestion
        await page.keyboard.press('ArrowDown');
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 2000));
      }

      // Re-check if fields were filled
      const recheckFilled = await page.evaluate(`
        (() => {
          const pw = document.querySelector('input[type="password"]');
          const emailFields = document.querySelectorAll('${EMAIL_SELECTORS}');
          let emailVal = '';
          for (const f of emailFields) { if (f.value) emailVal = f.value; }
          return { email: emailVal, pwFilled: pw ? pw.value.length > 0 : false };
        })()
      `) as { email: string; pwFilled: boolean };

      console.log(`[auto-login] After autofill: email="${recheckFilled.email ? '***' : ''}", pw=${recheckFilled.pwFilled}`);

      if (!recheckFilled.email && !recheckFilled.pwFilled) {
        // Try clicking the password field too (some sites need this)
        const pwRect = await page.evaluate(`
          (() => {
            const pw = document.querySelector('input[type="password"]');
            if (!pw) return null;
            const r = pw.getBoundingClientRect();
            return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          })()
        `) as { x: number; y: number } | null;

        if (pwRect) {
          await page.mouse.click(pwRect.x, pwRect.y);
          await new Promise(r => setTimeout(r, 2000));
          await page.keyboard.press('ArrowDown');
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, 2000));
        }

        // Final check
        const finalCheck = await page.evaluate(`
          (() => {
            const pw = document.querySelector('input[type="password"]');
            const emailFields = document.querySelectorAll('${EMAIL_SELECTORS}');
            let emailVal = '';
            for (const f of emailFields) { if (f.value) emailVal = f.value; }
            return { email: emailVal, pwFilled: pw ? pw.value.length > 0 : false };
          })()
        `) as { email: string; pwFilled: boolean };

        if (!finalCheck.email && !finalCheck.pwFilled) {
          return {
            status: 'needs_manual_login',
            message: 'Chrome Autofill hat keine Zugangsdaten eingefügt. Bitte im Bot-Browser einloggen und Passwort in Chrome speichern.',
          };
        }
      }
    }

    // 3. Submit the form
    console.log('[auto-login] Fields filled, submitting...');

    // Try submit buttons via real click (more reliable than JS click)
    let submitted = false;
    for (const sel of SUBMIT_SELECTORS) {
      const btnRect = await page.evaluate(`
        (() => {
          const btn = document.querySelector('${sel}');
          if (!btn || btn.offsetParent === null) return null;
          const r = btn.getBoundingClientRect();
          return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        })()
      `) as { x: number; y: number } | null;
      if (btnRect) {
        await page.mouse.click(btnRect.x, btnRect.y);
        submitted = true;
        break;
      }
    }

    // Fallback: try any button containing "Log In", "Sign In", "Submit"
    if (!submitted) {
      submitted = await page.evaluate(`
        (() => {
          const btns = [...document.querySelectorAll('button')];
          const loginBtn = btns.find(b => {
            const t = (b.textContent || '').trim().toLowerCase();
            return t === 'log in' || t === 'sign in' || t === 'login' || t === 'submit' || t === 'anmelden';
          });
          if (loginBtn) { loginBtn.click(); return true; }
          const form = document.querySelector('form');
          if (form) { form.submit(); return true; }
          return false;
        })()
      `) as boolean;
    }

    if (!submitted) {
      return { status: 'needs_manual_login', message: 'Login-Formular gefunden, aber kein Submit-Button erkannt.' };
    }

    // 4. Wait for navigation
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }

    // 5. Check if we're still on a login page
    const stillLogin = await page.evaluate(`
      (() => {
        const pw = document.querySelectorAll('input[type="password"]');
        const otp = document.querySelectorAll('input[name*="otp"], input[name*="code"], input[id*="otp"], input[id*="code"], input[name*="mfa"]');
        const captcha = document.querySelectorAll('#captchacharacters, .captcha, [id*="captcha"]');
        if (captcha.length > 0) return 'captcha';
        if (otp.length > 0) return 'otp';
        if (pw.length > 0) return 'password';
        return 'none';
      })()
    `) as string;

    if (stillLogin === 'captcha') {
      return { status: 'needs_manual_login', message: 'CAPTCHA erkannt. Bitte im Bot-Browser manuell lösen.' };
    }
    if (stillLogin === 'otp') {
      return { status: 'needs_manual_login', message: '2FA/OTP erforderlich. Bitte im Bot-Browser den Code eingeben.' };
    }
    if (stillLogin === 'password' && attempt < maxAttempts) {
      console.log('[auto-login] Multi-step login, password step...');
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    if (stillLogin === 'password') {
      return { status: 'needs_manual_login', message: 'Login fehlgeschlagen — Passwort-Seite wird weiterhin angezeigt.' };
    }

    // 6. Success
    return { status: 'login_successful', message: 'Automatisch angemeldet mit gespeicherten Zugangsdaten.' };
  }

  return { status: 'login_failed', message: 'Login nach mehreren Versuchen fehlgeschlagen.' };
}

/**
 * Attempt Google SSO login.
 * Looks for a Google icon/button on the login page, clicks it,
 * handles the Google account picker popup, and waits for redirect back.
 *
 * Works for portals that offer "Login with Google" (Bambu Lab, AliExpress, etc.).
 * Requires an active Google session in the bot browser.
 */
export async function attemptGoogleSSOLogin(page: Page, browser: any): Promise<AutoLoginResult> {
  // Find Google login button — try multiple strategies
  const googleClicked = await page.evaluate(`
    (() => {
      // Strategy 1: MuiIconButton (Bambu Lab style)
      var icons = document.querySelectorAll('.MuiIconButton-root');
      if (icons.length > 0) { icons[0].click(); return 'mui-icon'; }

      // Strategy 2: Button/link with "Google" text or class
      var els = Array.from(document.querySelectorAll('button, a, div'));
      var google = els.find(function(e) {
        var t = (e.textContent || '').toLowerCase();
        var c = (e.className || '').toString().toLowerCase();
        return (t.includes('google') || c.includes('google')) && !t.includes('play') && !t.includes('search');
      });
      if (google) { google.click(); return 'text-match'; }

      // Strategy 3: Image/SVG with Google branding near "Login with other" text
      var afterLogin = false;
      var allEls = document.querySelectorAll('*');
      for (var i = 0; i < allEls.length; i++) {
        if ((allEls[i].textContent || '').includes('Login with other') ||
            (allEls[i].textContent || '').includes('Sign in with') ||
            (allEls[i].textContent || '').includes('Continue with')) {
          afterLogin = true;
        }
        if (afterLogin && (allEls[i].tagName === 'BUTTON' || allEls[i].tagName === 'A')) {
          var r = allEls[i].getBoundingClientRect();
          if (r.width > 20 && r.width < 100 && r.height > 20) {
            allEls[i].click();
            return 'first-social-btn';
          }
        }
      }
      return null;
    })()
  `) as string | null;

  if (!googleClicked) {
    return { status: 'needs_manual_login', message: 'Kein Google-Login-Button gefunden.' };
  }

  console.log(`[auto-login] Google SSO clicked via: ${googleClicked}`);

  // Wait for Google popup
  let popupPage: Page | null = null;
  const popupPromise = new Promise<void>((resolve) => {
    const handler = async (target: any) => {
      if (target.type() === 'page' && target.url().includes('accounts.google.com')) {
        popupPage = await target.page();
        browser.off('targetcreated', handler);
        resolve();
      }
    };
    browser.on('targetcreated', handler);
    setTimeout(() => { browser.off('targetcreated', handler); resolve(); }, 10_000);
  });

  await popupPromise;

  if (!popupPage) {
    // Maybe redirected in same page instead of popup
    await new Promise(r => setTimeout(r, 5000));
    if (page.url().includes('accounts.google.com')) {
      // Account picker in same page — click first account
      await page.evaluate(`
        (() => {
          var accounts = document.querySelectorAll('div[data-email]');
          if (accounts.length > 0) accounts[0].click();
          var items = document.querySelectorAll('li[data-authuser]');
          if (items.length > 0) items[0].click();
        })()
      `);
      try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }); } catch {}
      return page.url().includes('sign-in') || page.url().includes('login')
        ? { status: 'needs_manual_login', message: 'Google SSO fehlgeschlagen.' }
        : { status: 'login_successful', message: 'Google SSO erfolgreich.' };
    }
    return { status: 'needs_manual_login', message: 'Google-Popup nicht geöffnet.' };
  }

  // Handle Google account picker popup
  console.log('[auto-login] Google popup opened, selecting account...');
  await new Promise(r => setTimeout(r, 3000));

  await (popupPage as Page).evaluate(`
    (() => {
      var accounts = document.querySelectorAll('div[data-email]');
      if (accounts.length > 0) { accounts[0].click(); return; }
      var items = document.querySelectorAll('li[data-authuser]');
      if (items.length > 0) { items[0].click(); return; }
      // "Continue as" button
      var btns = Array.from(document.querySelectorAll('button'));
      var cont = btns.find(function(b){ return b.textContent.includes('Continue') || b.textContent.includes('Weiter'); });
      if (cont) cont.click();
    })()
  `);

  // Wait for popup to close and main page to redirect
  await new Promise(r => setTimeout(r, 8000));

  const finalUrl = page.url();
  if (finalUrl.includes('sign-in') || finalUrl.includes('login')) {
    return { status: 'needs_manual_login', message: 'Google SSO abgeschlossen, aber noch auf Login-Seite.' };
  }

  return { status: 'login_successful', message: 'Über Google SSO angemeldet.' };
}
