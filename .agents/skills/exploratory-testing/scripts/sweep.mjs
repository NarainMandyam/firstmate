// Click every visible control on one screen, each on a fresh page, and report inert or erroring ones.
// Usage: node sweep.mjs <setup-name>   (setup comes from PT_SETUPS; omit for the start screen)
import fs from 'node:fs';
import path from 'node:path';
import { launch, loadSetups, boot, OUT } from './lib.mjs';

const start = process.argv[2] || 'start';
const setups = await loadSetups();
const setup = setups[start] || (async () => {});
const sel = 'button:visible, [role=tab]:visible, [role=menuitem]:visible, summary:visible';
const state = p => p.evaluate(() => document.body.innerHTML.length + '|' + location.href + '|' + document.querySelectorAll('dialog[open]').length + '|' + document.activeElement?.tagName);
const names = p => p.$$eval(sel, els => els.map((e, i) => ({ i, n: (e.getAttribute('aria-label') || e.title || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 45) })));

const b = await launch();
async function fresh() {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/stylesheet/.test(m.text())) errs.push('console:' + m.text().slice(0, 100)); });
  await boot(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  await setup(page);
  await page.evaluate(() => { window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(JSON.stringify(e.reason)?.slice(0, 120))); });
  return { ctx, page, errs };
}

const first = await fresh();
const list = await names(first.page);
await first.ctx.close();
console.log('controls', list.length);
const results = [];
for (const item of list) {
  const { ctx, page, errs } = await fresh();
  const it = (await names(page))[item.i];
  if (!it || it.n !== item.n) { results.push({ ...item, note: 'shifted' }); await ctx.close(); continue; }
  const before = await state(page);
  try { await (await page.$$(sel))[item.i].click({ timeout: 2500 }); }
  catch (e) { results.push({ ...item, note: 'click failed: ' + e.message.split('\n')[0].slice(0, 80) }); await ctx.close(); continue; }
  await page.waitForTimeout(450);
  const after = await state(page);
  const rej = await page.evaluate(() => window.__rej);
  results.push({ ...item, changed: before !== after, errs: [...errs, ...rej] });
  await ctx.close();
}
fs.writeFileSync(path.join(OUT, `sweep-${start}.json`), JSON.stringify(results, null, 1));
for (const r of results) if (!r.changed || r.errs?.length || r.note) console.log(r.i, r.n, '|', r.note || (r.changed ? '' : 'NO CHANGE'), r.errs?.join(' ; ') || '');
await b.close();
