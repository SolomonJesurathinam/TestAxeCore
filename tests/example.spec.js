// @ts-check
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'fs';
import path from 'path';
import { generateAccessibilityReport } from '../generate-report.js';

/**
 * Highlights violated elements with a distinct red outline and badge,
 * and takes a context screenshot for each violation node.
 * @param {import('@playwright/test').Page} page
 * @param {any[]} violations
 * @param {string} scanName
 * @param {string} screenshotsDir
 */
async function captureViolationScreenshots(page, violations, scanName, screenshotsDir) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const safeScan = scanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  for (let vIdx = 0; vIdx < violations.length; vIdx++) {
    const v = violations[vIdx];
    const safeRule = v.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    for (let nIdx = 0; nIdx < (v.nodes || []).length; nIdx++) {
      const node = v.nodes[nIdx];
      const filename = `${safeScan}-${safeRule}-node${nIdx + 1}.png`;
      const filePath = path.join(screenshotsDir, filename);
      const relativePath = `screenshots/${filename}`;

      try {
        const selector = Array.isArray(node.target) ? node.target.join(' ') : node.target;
        if (!selector) continue;

        const loc = page.locator(selector).first();
        if (await loc.count() === 0) continue;

        const isVisible = await loc.isVisible().catch(() => false);
        if (!isVisible) continue;

        // Scroll element into view and inject marked highlight + label badge
        await loc.evaluate((el, ruleName) => {
          el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });

          // Preserve previous inline styles
          el.setAttribute('data-a11y-orig-outline', el.style.outline || '');
          el.setAttribute('data-a11y-orig-shadow', el.style.boxShadow || '');

          // Apply glowing red highlight
          el.style.setProperty('outline', '4px solid #ef4444', 'important');
          el.style.setProperty('outline-offset', '3px', 'important');
          el.style.setProperty('box-shadow', '0 0 0 6px rgba(239, 68, 68, 0.35), 0 0 20px rgba(239, 68, 68, 0.6)', 'important');

          // Add floating marker tag
          const badge = document.createElement('div');
          badge.id = 'a11y-highlight-badge';
          badge.textContent = '⚠️ VIOLATION: ' + ruleName;
          badge.style.position = 'absolute';
          badge.style.background = '#dc2626';
          badge.style.color = '#ffffff';
          badge.style.fontSize = '11px';
          badge.style.fontWeight = '700';
          badge.style.padding = '3px 8px';
          badge.style.borderRadius = '4px';
          badge.style.zIndex = '999999';
          badge.style.boxShadow = '0 2px 8px rgba(0,0,0,0.4)';
          badge.style.pointerEvents = 'none';

          const rect = el.getBoundingClientRect();
          badge.style.top = Math.max(0, window.scrollY + rect.top - 24) + 'px';
          badge.style.left = (window.scrollX + rect.left) + 'px';
          document.body.appendChild(badge);
        }, v.id);

        // Capture surrounding card/dialog context if available, otherwise element itself
        let captured = false;
        try {
          const containerHandle = await loc.evaluateHandle((el) => {
            return el.closest('[data-testid], [role="dialog"], .Recipe, .Recipes__card, form, table') || el;
          });
          const containerElem = containerHandle.asElement();
          if (containerElem) {
            await containerElem.screenshot({ path: filePath, timeout: 2500 });
            captured = true;
          }
        } catch {
          // container capture fallback
        }

        if (!captured) {
          await loc.screenshot({ path: filePath, timeout: 2500 });
        }

        node.screenshot = relativePath;

        // Cleanup highlight styles & badge
        await loc.evaluate((el) => {
          el.style.outline = el.getAttribute('data-a11y-orig-outline') || '';
          el.style.boxShadow = el.getAttribute('data-a11y-orig-shadow') || '';
          el.removeAttribute('data-a11y-orig-outline');
          el.removeAttribute('data-a11y-orig-shadow');
          const badge = document.getElementById('a11y-highlight-badge');
          if (badge) badge.remove();
        });
      } catch (err) {
        console.warn(`Could not screenshot node for ${v.id}: ${err.message}`);
      }
    }
  }
}

/**
 * Reusable function to perform an accessibility scan, save JSON report to disk, and attach to test results
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} scanName
 */
async function checkAccessibility(page, testInfo, scanName) {
  const scanResults = await new AxeBuilder({ page }).analyze();
  console.log(`${scanName} - Violations: ${scanResults.violations.length}, Passes: ${scanResults.passes.length}`);

  // Create reports/accessibility directory if it doesn't exist
  const reportsDir = path.join(process.cwd(), 'reports', 'accessibility');
  const screenshotsDir = path.join(reportsDir, 'screenshots');
  fs.mkdirSync(reportsDir, { recursive: true });

  // Capture marked screenshots for all violation nodes
  await captureViolationScreenshots(page, scanResults.violations, scanName, screenshotsDir);

  // Generate file path and write full scan data (violations + passes + screenshots)
  const safeName = scanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filePath = path.join(reportsDir, `${safeName}.json`);

  const scanData = {
    scanName,
    url: page.url(),
    timestamp: new Date().toISOString(),
    violations: scanResults.violations,
    passes: scanResults.passes,
    incomplete: scanResults.incomplete,
    inapplicable: scanResults.inapplicable,
  };

  fs.writeFileSync(filePath, JSON.stringify(scanData, null, 2), 'utf-8');
  console.log(`Saved scan data to: ${filePath}`);

  // Attach to Playwright HTML report
  await testInfo.attach(`${safeName}-scan`, {
    path: filePath,
    contentType: 'application/json',
  });

  return scanResults;
}

test('has title', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await page.goto('https://broken-workshop.dequelabs.com/');
  await page.waitForTimeout(1000);
  await checkAccessibility(page, testInfo, 'Scan 1 (Main Page)');

  await page.locator("(//img[@data-testid='edit-button'])[1]").click();
  await page.waitForTimeout(1000);
  await checkAccessibility(page, testInfo, 'Scan 2 (Edit Modal)');

  await page.locator("//button[@class='dqpl-button-secondary']").click();
  await page.waitForTimeout(1000);
  await page.locator("(//button[@data-testid='view-button'])[1]").click();
  await page.waitForTimeout(1000);
  await checkAccessibility(page, testInfo, 'Scan 3 (View Modal)');

  await page.locator("//button[@class='dqpl-button-secondary']").click();

  // Generate modern accessibility HTML & CSV reports with deduplication & passes
  const reports = generateAccessibilityReport();
  if (reports?.htmlFile) {
    await testInfo.attach('accessibility-unified-html-report', {
      path: reports.htmlFile,
      contentType: 'text/html',
    });
  }
  if (reports?.csvFile) {
    await testInfo.attach('accessibility-report-csv', {
      path: reports.csvFile,
      contentType: 'text/csv',
    });
  }
});



