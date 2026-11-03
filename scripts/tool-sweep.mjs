// Manual smoke sweep: opens a real PDF in the built editor and exercises every
// rail tool, header button and page action, reporting PASS/WARN/FAIL per step
// plus console errors. Click positions are tuned for the A4 AI Preschool
// parent-portfolio layout (title card, photo, footer). Keep personal PDFs out of
// the repository; pass them by path. See docs/E2E.md.
//
// Usage (with the static export served, e.g. `node scripts/serve-static-e2e.mjs`):
//   node scripts/tool-sweep.mjs <portfolio.pdf>
// Env: SWEEP_URL (editor URL), SWEEP_OUT (screenshot folder),
//      PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH (browser binary).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const PDF = process.argv[2];
if (!PDF) { console.error('Usage: node scripts/tool-sweep.mjs <portfolio.pdf>'); process.exit(2); }
const SP = process.env.SWEEP_OUT || 'test-results/tool-sweep';
mkdirSync(SP, { recursive: true });
const BASE = process.env.SWEEP_URL || 'http://127.0.0.1:4179/Paperloom-PDF/editor/';
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
page.on('pageerror', e => consoleErrors.push('PAGEERROR ' + e.message.slice(0, 160)));
page.on('dialog', d => d.accept());
const results = [];
const errorToast = () => page.locator('[role=alert]').filter({ hasText: /fail|error|could not|cannot|unable/i });
async function step(name, fn) {
  const before = consoleErrors.length;
  try {
    await fn();
    await page.waitForTimeout(400);
    const toast = await errorToast().allTextContents().catch(() => []);
    const errs = consoleErrors.slice(before);
    results.push(`${toast.length || errs.length ? 'WARN' : 'PASS'} ${name}${toast.length ? ' | toast: ' + toast.join(' / ').slice(0, 160) : ''}${errs.length ? ' | console: ' + errs.join(' / ').slice(0, 200) : ''}`);
    for (const b of await page.getByRole('button', { name: /Dismiss (error|message)/ }).all()) await b.click().catch(() => {});
  } catch (e) {
    results.push(`FAIL ${name} | ${e.message.split('\n')[0].slice(0, 200)}`);
    await page.screenshot({ path: `${SP}/fail-${results.length}.png` }).catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }
}
await page.goto(BASE);
await page.locator('input[type=file]').first().setInputFiles(PDF);
const surface = page.locator('[data-page-render-surface] canvas.pdf-canvas');
await surface.waitFor(); await page.waitForTimeout(1500);
const box = async () => surface.boundingBox();
const at = async (fx, fy) => { const b = await box(); return [b.x + b.width * fx, b.y + b.height * fy]; };
const click = async (fx, fy) => { const [x, y] = await at(fx, fy); await page.mouse.click(x, y); };
const drag = async (a, b) => { const [x1, y1] = await at(...a); const [x2, y2] = await at(...b); await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 5 }); await page.mouse.move(x2, y2, { steps: 5 }); await page.mouse.up(); };
const rail = name => page.getByRole('button', { name, exact: true }).first();
const opt = name => page.getByRole('button', { name, exact: true }).first();

await step('Select: click blank page area selects nothing', async () => { await rail('Select').click(); await click(0.5, 0.97); if (await page.getByText('Drawing / Signature').count()) throw new Error('background got selected'); });
await step('Select: click photo selects image', async () => { await click(0.5, 0.6); await page.getByText('Image Properties').waitFor({ timeout: 3000 }); await opt('Deselect').click(); });
await step('Select: click card drawing + Delete + Undo', async () => {
  await click(0.12, 0.30);
  await page.getByText('Drawing / Signature').first().waitFor({ timeout: 3000 });
  await opt('Delete').click(); await page.waitForTimeout(800);
  if (await page.getByText('Drawing / Signature').count()) throw new Error('still selected after delete');
  await page.getByTitle('Undo (Ctrl+Z)').click();
});
await step('Select: duplicate photo, then undo', async () => {
  await click(0.5, 0.6); await page.getByText('Image Properties').waitFor({ timeout: 3000 });
  await opt('Duplicate').click(); await page.waitForTimeout(800);
  await page.screenshot({ path: `${SP}/duplicate-photo.png` });
  await page.getByText('Image Properties').waitFor({ timeout: 3000 });
  await page.getByTitle('Undo (Ctrl+Z)').click(); await page.waitForTimeout(500); await opt('Deselect').click().catch(() => {});
});
await step('Select: duplicate card with Ctrl/Cmd+D, then undo', async () => {
  await click(0.12, 0.30); await page.getByText('Drawing / Signature').first().waitFor({ timeout: 3000 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d'); await page.waitForTimeout(800);
  await page.screenshot({ path: `${SP}/duplicate-card.png` });
  await page.getByTitle('Undo (Ctrl+Z)').click(); await page.waitForTimeout(500); await opt('Deselect').click().catch(() => {});
});
await step('Edit Text: click title, type, Enter', async () => { await rail('Edit Text').click(); await click(0.2, 0.235); await page.locator('[contenteditable=true], textarea').first().waitFor({ timeout: 3000 }); await page.keyboard.press('End'); await page.keyboard.type(' 2026'); await page.keyboard.press('Enter'); await page.waitForTimeout(800); });
await step('Undo/Redo text edit', async () => { await page.getByTitle('Undo (Ctrl+Z)').click(); await page.waitForTimeout(500); await page.getByTitle('Redo (Ctrl+Shift+Z)').click(); });
await step('Edit Text: Add Text Box', async () => { await rail('Edit Text').click(); await opt('Add Text Box').click(); await click(0.3, 0.9); await page.keyboard.type('Hello box'); await page.keyboard.press('Escape'); });
await step('Highlight: click line', async () => { await rail('Highlight').click(); await click(0.3, 0.19); });
await step('Highlight: freehand drag', async () => { await drag([0.2, 0.92], [0.6, 0.92]); });
await step('Draw: freehand', async () => { await rail('Draw').click(); await drag([0.2, 0.8], [0.5, 0.85]); });
for (const shape of ['Line', 'Arrow', 'Rectangle', 'Ellipse']) {
  await step(`Draw: ${shape}`, async () => { await opt(shape).click(); await drag([0.6, 0.8], [0.8, 0.88]); });
}
await step('Erase: drag over drawings', async () => { await rail('Erase').click(); await drag([0.15, 0.82], [0.85, 0.86]); });
await step('Watermark: add text watermark', async () => { await rail('Watermark').click(); await page.getByRole('button', { name: /^Add watermark$/i }).click(); await page.getByText(/Watermark applied/).waitFor({ timeout: 5000 }); });
await step('Watermark: scan', async () => { await page.getByRole('button', { name: /Scan for Watermarks/i }).click(); await page.waitForTimeout(1000); const c = page.getByRole('button', { name: 'Cancel', exact: true }); if (await c.count()) await c.first().click(); });
await step('Sign: create typed signature and place', async () => {
  await rail('Sign').click(); await page.getByRole('button', { name: /Create signature/i }).first().click();
  const dlg = page.getByRole('dialog'); await dlg.getByRole('tab', { name: 'Type' }).click().catch(async () => dlg.getByRole('button', { name: 'Type', exact: true }).click());
  await dlg.getByLabel(/Typed name/i).fill('Wei Jun'); await dlg.getByRole('button', { name: /Save to library/i }).click();
  await click(0.7, 0.93); await page.waitForTimeout(800);
});
await step('Security: open tabs', async () => {
  await rail('Security').click();
  for (const t of ['Inspect', 'Protect', 'Clean', 'Policy']) { await page.getByRole('tab', { name: t }).or(page.getByRole('button', { name: t, exact: true })).first().click(); await page.waitForTimeout(300); }
  await page.getByRole('tab', { name: 'Inspect' }).or(page.getByRole('button', { name: 'Inspect', exact: true })).first().click();
  await page.getByRole('button', { name: 'Rescan' }).click();
});
await step('Find & Replace: search', async () => { await page.getByTitle('Toggle Find & Replace').click(); await page.getByPlaceholder(/Search/i).first().fill('Juniper'); await page.keyboard.press('Enter'); await page.waitForTimeout(800); await page.getByTitle('Toggle Find & Replace').click(); });
await step('Zoom in/out', async () => { await page.getByRole('button', { name: 'Zoom in' }).click(); await page.waitForTimeout(500); await page.getByRole('button', { name: 'Zoom out' }).click(); });
await step('Next/previous page', async () => { await page.getByRole('button', { name: 'Next page' }).click(); await page.waitForTimeout(800); await page.getByRole('button', { name: 'Previous page' }).click(); await page.waitForTimeout(800); });
await step('Theme toggle twice', async () => { const t = page.getByTitle(/Switch to (dark|white) mode/); await t.click(); await t.click(); });
await step('Focus mode on/off', async () => { await page.getByRole('button', { name: 'Focus mode' }).click(); await page.waitForTimeout(300); await page.getByRole('button', { name: 'Focus mode' }).click(); });
await step('Pages: rotate page 1', async () => { await page.getByRole('button', { name: 'Rotate page 1', exact: true }).click(); await page.waitForTimeout(800); });
await step('Pages: insert blank page', async () => { await page.getByRole('button', { name: 'Insert blank page' }).first().click(); await page.waitForTimeout(800); });
await step('Pages: move page 1 later', async () => { await page.getByRole('button', { name: 'Move page 1 later' }).click(); await page.waitForTimeout(800); });
await step('Pages: remove current page (confirm)', async () => { await page.getByRole('button', { name: 'Remove current page' }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click(); await page.waitForTimeout(800); });
await step('Pages: download current page', async () => { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Download current page' }).click()]); results.push('INFO downloaded ' + d.suggestedFilename()); });
await step('Export PNG', async () => {
  await page.getByTitle('Export to PNG, JPEG, SVG, or text').click(); const p = page.getByRole('dialog', { name: 'Export Document' });
  await p.getByRole('button', { name: /^PNG Image/ }).click();
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), p.getByRole('button', { name: 'Export as PNG Image' }).click()]);
  results.push('INFO downloaded ' + d.suggestedFilename()); await p.getByRole('button', { name: /Close export panel/ }).click().catch(() => page.keyboard.press('Escape'));
});
await step('Download PDF and reopen it', async () => {
  const [d] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByTitle('Download original / edited PDF (no recompression)').click()]);
  const path = `${SP}/sweep-out.pdf`; await d.saveAs(path);
  const p2 = await ctx.newPage(); await p2.goto(BASE);
  await p2.locator('input[type=file]').first().setInputFiles(path); await p2.locator('[data-page-render-surface] canvas.pdf-canvas').waitFor({ timeout: 20000 });
  await p2.waitForTimeout(1200); await p2.screenshot({ path: `${SP}/reopened.png` }); await p2.close();
});
await page.screenshot({ path: `${SP}/final.png` });
console.log(results.join('\n'));
console.log('CONSOLE ERRORS TOTAL', consoleErrors.length); console.log([...new Set(consoleErrors)].slice(0, 10).join('\n'));
await browser.close();
