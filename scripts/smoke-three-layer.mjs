#!/usr/bin/env node
// Run: node scripts/smoke-three-layer.mjs [--headed]
//
// Three-layer ouroboros smoke test. Validates:
//   Layer 2 (Manidex) → Layer 1 (Manifex on Fly devbox) → Layer 0 (customer app)
// in a single automated run via Playwright.
//
// Requires: a running Manidex at http://localhost:37459 (or MANIDEX_URL env).
// Does NOT restart any running processes — purely observational + interactive.

import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MANIDEX_URL = process.env.MANIDEX_URL || 'http://localhost:37459';
const HEADED = process.argv.includes('--headed');
const SCREENSHOT_DIR = '/tmp/governor/projects/manifex/screenshots';
const BUILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 min for Layer 0 build
const NAV_TIMEOUT_MS = 60 * 1000;       // 60s for page loads / compile

if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

const ts = () => new Date().toISOString().replace(/[:.]/g, '-');
const screenshot = (page, name) => page.screenshot({ path: join(SCREENSHOT_DIR, `${name}-${ts()}.png`), fullPage: true });
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const results = [];
function step(name, passed, detail = '') {
  results.push({ name, passed, detail, time: elapsed() });
  console.log(`  ${passed ? '✓' : '✗'} [${elapsed()}] ${name}${detail ? ' — ' + detail : ''}`);
}

// ───────────────────────────────────────────────────────────────────

console.log(`\n🔬 Three-layer smoke test — ${MANIDEX_URL}\n`);

const browser = await chromium.launch({
  headless: !HEADED,
  executablePath: '/home/vscode/.cache/ms-playwright/chromium-1212/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(NAV_TIMEOUT_MS);

try {
  // ─── Step 1: Layer 2 home ───────────────────────────────────────
  console.log('Layer 2 (Manidex home)');
  await page.goto(MANIDEX_URL, { waitUntil: 'networkidle' });
  const homeH1 = await page.locator('h1').first().textContent().catch(() => '');
  step('Home page loads', !!homeH1, `h1="${homeH1?.trim()}"`);

  const docsBtn = page.getByRole('button', { name: /Open Manifex Docs|View Manifex/i });
  const docsBtnVisible = await docsBtn.isVisible().catch(() => false);
  step('Docs button visible', docsBtnVisible);

  // ─── Step 2: Navigate to Layer 2 editor ─────────────────────────
  console.log('\nLayer 2 (Manidex editor)');
  await docsBtn.click();
  await page.waitForURL(/\/[0-9a-f-]{36}/, { timeout: NAV_TIMEOUT_MS });
  step('Editor URL loaded', true, page.url());

  // Wait for hydration — first-request compile on the editor route can
  // take 10-60s on a cold dev server. We wait for the nav buttons to
  // appear as the signal that the page is interactive.
  console.log('  ⏳ Waiting for editor to hydrate (up to 90s)...');
  await page.locator('nav button').first().waitFor({ state: 'visible', timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(2000); // let remaining nav items render

  const navButtons = await page.locator('nav button').allTextContents();
  const expectedPages = ['Overview', 'Environment', 'How It Works', 'Pages and Layout', 'Look and Feel', 'Data and Storage', 'Tests'];
  const allPagesPresent = expectedPages.every(p => navButtons.some(b => b.includes(p)));
  step('7-page sidebar present', allPagesPresent, `order: ${navButtons.join(', ')}`);
  if (navButtons.length > 0 && navButtons[0] !== 'Overview') {
    step('(cosmetic) Overview is first nav item', false, `first="${navButtons[0]}"`);
  }

  // Check for spec content — wait for the overview heading to render
  await page.locator('h1').filter({ hasText: 'Overview' }).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  const overviewContent = await page.locator('h1').filter({ hasText: 'Overview' }).first().isVisible().catch(() => false);
  step('Spec content visible (Overview heading)', overviewContent);

  await screenshot(page, 'layer2-editor');

  // ─── Step 3: Click Build (deploy Layer 1 to Fly) ────────────────
  console.log('\nLayer 1 build (Manifex → Fly devbox)');
  // The build button might say "Deploy Manifex to Fly", "Build your app",
  // or similar. Wait for it to appear post-hydration.
  const buildBtn = page.getByRole('button', { name: /Deploy.*Fly|Build your app/i });
  await buildBtn.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  const buildBtnVisible = await buildBtn.isVisible().catch(() => false);
  step('Build button visible', buildBtnVisible, await buildBtn.textContent().catch(() => ''));

  if (buildBtnVisible) {
    await buildBtn.click();
    // Wait for either the build log overlay to appear or the iframe to load.
    // The build can be cached (fast) or cold (minutes). We look for the
    // iframe src changing from about:blank or the overlay showing completion.
    console.log('  ⏳ Waiting for build to complete (up to 5 min)...');

    // Poll for iframe with a real src (not about:blank / empty)
    let iframeFound = false;
    const buildStart = Date.now();
    while (Date.now() - buildStart < BUILD_TIMEOUT_MS) {
      // Check if an iframe has a real src (Fly devbox URL)
      const iframeSrc = await page.locator('iframe').first().getAttribute('src').catch(() => '');
      if (iframeSrc && iframeSrc.startsWith('http') && !iframeSrc.includes('about:blank')) {
        iframeFound = true;
        step('Layer 1 iframe loaded', true, iframeSrc);
        break;
      }
      // Also check if the "Click Build to see your app" text is gone
      const placeholder = await page.locator('text=Click Build to see your app').isVisible().catch(() => false);
      if (!placeholder) {
        // Text gone — iframe might be loading without src attr (srcdoc)
        const iframeCount = await page.locator('iframe').count();
        if (iframeCount > 0) {
          const src = await page.locator('iframe').first().getAttribute('src').catch(() => '');
          if (src) {
            iframeFound = true;
            step('Layer 1 iframe loaded', true, src);
            break;
          }
        }
      }
      await page.waitForTimeout(3000);
    }
    if (!iframeFound) {
      step('Layer 1 iframe loaded', false, `timeout after ${BUILD_TIMEOUT_MS / 1000}s`);
      await screenshot(page, 'layer1-build-timeout');
    }

    await screenshot(page, 'layer1-after-build');

    // ─── Step 4: Explore Layer 1 inside iframe ──────────────────────
    if (iframeFound) {
      console.log('\nLayer 1 (Manifex in iframe)');
      const frame = page.frameLocator('iframe').first();

      // Wait for Layer 1 content to compile (Next.js first-request compile)
      await page.waitForTimeout(5000); // initial compile buffer

      // Try to find Manifex UI elements inside the iframe
      const layer1H1 = await frame.locator('h1').first().textContent({ timeout: 90000 }).catch(() => '');
      step('Layer 1 content renders', !!layer1H1, `h1="${layer1H1?.trim()?.slice(0, 60)}"`);
      await screenshot(page, 'layer1-content');

      // Look for a create-project button or a project listing
      const createBtn = frame.getByRole('button', { name: /create|start|new project|build/i });
      const createBtnVisible = await createBtn.first().isVisible().catch(() => false);
      step('Layer 1 has project creation UI', createBtnVisible);

      if (createBtnVisible) {
        console.log('\nLayer 0 (customer app via Layer 1 Build)');
        // Try to create a project in Layer 1
        // Look for a text input for the project idea
        const ideaInput = frame.locator('textarea, input[type="text"]').first();
        const inputVisible = await ideaInput.isVisible().catch(() => false);
        if (inputVisible) {
          await ideaInput.fill('A simple counter app with increment and decrement buttons');
          await page.waitForTimeout(500);
          await createBtn.first().click();
          step('Layer 0 project creation triggered', true);

          // Wait for navigation to editor
          await page.waitForTimeout(10000); // compile time

          // Look for a Build button inside the Layer 1 editor
          const innerBuildBtn = frame.getByRole('button', { name: /build|deploy/i });
          const innerBuildVisible = await innerBuildBtn.first().isVisible({ timeout: 60000 }).catch(() => false);
          step('Layer 1 editor Build button visible', innerBuildVisible);

          if (innerBuildVisible) {
            await innerBuildBtn.first().click();
            step('Layer 0 Build clicked', true);

            // Wait for Layer 0 to appear (this is the Fly devbox cycle)
            console.log('  ⏳ Waiting for Layer 0 build (up to 5 min)...');
            const l0Start = Date.now();
            let l0Found = false;
            while (Date.now() - l0Start < BUILD_TIMEOUT_MS) {
              // Look for a nested iframe inside the first iframe
              const innerIframeCount = await frame.locator('iframe').count().catch(() => 0);
              if (innerIframeCount > 0) {
                const innerSrc = await frame.locator('iframe').first().getAttribute('src').catch(() => '');
                if (innerSrc && innerSrc.startsWith('http')) {
                  l0Found = true;
                  step('Layer 0 iframe loaded', true, innerSrc);
                  break;
                }
              }
              await page.waitForTimeout(5000);
            }
            if (!l0Found) {
              step('Layer 0 iframe loaded', false, `timeout after ${BUILD_TIMEOUT_MS / 1000}s`);
            }
            await screenshot(page, 'layer0-result');
          }
        } else {
          step('Layer 0 project creation triggered', false, 'no text input found for project idea');
        }
      }

      // Visual check for bottom-bar overlap
      await screenshot(page, 'bottom-bar-check');
      step('Bottom-bar screenshot captured', true, 'manual visual review needed');
    }
  } else {
    step('Build skipped', false, 'Build button not found');
  }

} catch (err) {
  step('UNEXPECTED ERROR', false, err.message);
  await screenshot(page, 'error-state').catch(() => {});
} finally {
  await browser.close();
}

// ─── Final report ───────────────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log('SMOKE TEST REPORT');
console.log('═'.repeat(60));
const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
for (const r of results) {
  console.log(`  ${r.passed ? '✓' : '✗'} [${r.time}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(`\nTotal: ${passed} PASS / ${failed} FAIL / ${elapsed()} total`);
console.log(`Screenshots: ${SCREENSHOT_DIR}`);
console.log(failed === 0 ? '\n🟢 ALL PASS' : '\n🔴 FAILURES DETECTED');
process.exit(failed === 0 ? 0 : 1);
