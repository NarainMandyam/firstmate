import fs from 'node:fs';
import path from 'node:path';
import * as pw from '@playwright/test';

export const URL_ = process.env.PT_URL || 'http://localhost:4291/';
export const OUT = process.env.PT_OUT || './.pt';
export const READY = process.env.PT_READY || '';
const ENGINE = process.env.PT_ENGINE || 'webkit';
fs.mkdirSync(OUT, { recursive: true });

export function launch() {
  return pw[ENGINE].launch({ headless: true });
}

export async function loadSetups() {
  if (!process.env.PT_SETUPS) return { start: async () => {} };
  return (await import(path.resolve(process.env.PT_SETUPS))).default;
}

export async function boot(page) {
  await page.goto(URL_);
  if (READY) await page.waitForSelector(READY, { state: 'attached', timeout: 15000 }).catch(() => {});
}

export async function open({ w = 1440, h = 900 } = {}) {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ' ' + m.text()); });
  await boot(page);
  return { b, ctx, page, errs };
}

export async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

export async function texts(page, sel) {
  return page.$$eval(sel, els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)));
}
