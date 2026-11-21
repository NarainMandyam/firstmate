// Seeded random clicks, keys and typed text; reports page errors and unhandled rejections.
// Usage: node monkey.mjs <seed> <steps>   Extra shortcuts: PT_KEYS="Meta+k,Meta+s"
import fs from 'node:fs';
import path from 'node:path';
import { launch, boot, OUT } from './lib.mjs';

const seed0 = Number(process.argv[2] || 1), steps = Number(process.argv[3] || 250);
function rng(s) { return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const r = rng(seed0);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const log = [], findings = [];
page.on('pageerror', e => findings.push({ step: log.length, kind: 'pageerror', msg: String(e.message).slice(0, 200), trail: log.slice(-6) }));
page.on('console', m => { if (m.type() === 'error' && !/stylesheet/.test(m.text())) findings.push({ step: log.length, kind: 'console', msg: m.text().slice(0, 200), trail: log.slice(-6) }); });
await boot(page);
await page.evaluate(() => window.addEventListener('unhandledrejection', e => console.error('UNHANDLED ' + (e.reason && e.reason.message || JSON.stringify(e.reason)))));
await page.keyboard.press('Escape');
const keys = ['Escape', 'Enter', 'Tab', 'Shift+Tab', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space', 'Backspace', ...(process.env.PT_KEYS || '').split(',').filter(Boolean)];
const words = ['lamp', '', '  ', '<b>', 'x'.repeat(80), 'é🌟', '"', "'", '\\', '12'];
const sel = 'button:visible,[role=tab]:visible,[role=menuitem]:visible,a:visible,input:visible,textarea:visible,select:visible,[role=option]:visible,[contenteditable]:visible';
for (let i = 0; i < steps; i++) {
  const k = r();
  try {
    if (k < 0.6) {
      const els = await page.$$(sel);
      if (!els.length) continue;
      const el = els[Math.floor(r() * els.length)];
      const d = await el.evaluate(e => e.tagName + ':' + ((e.getAttribute('aria-label') || e.textContent || e.placeholder || '') + '').trim().replace(/\s+/g, ' ').slice(0, 30));
      const right = r() < 0.08;
      log.push((right ? 'RCLICK ' : 'CLICK ') + d);
      await el.click({ timeout: 1500, button: right ? 'right' : 'left' });
    } else if (k < 0.85) {
      const key = keys[Math.floor(r() * keys.length)];
      log.push('KEY ' + key);
      await page.keyboard.press(key);
    } else {
      const w = words[Math.floor(r() * words.length)];
      log.push('TYPE ' + JSON.stringify(w).slice(0, 20));
      await page.keyboard.insertText(w);
    }
  } catch (e) { log.push('  (skip: ' + String(e.message).split('\n')[0].slice(0, 50) + ')'); }
  await page.waitForTimeout(60);
  if (!(await page.locator('body').count())) { findings.push({ step: i, kind: 'gone', msg: 'body gone', trail: log.slice(-6) }); break; }
}
await page.waitForTimeout(500);
fs.writeFileSync(path.join(OUT, `monkey-${seed0}.json`), JSON.stringify({ findings, log }, null, 1));
console.log('seed', seed0, 'steps', log.length, 'findings', findings.length);
const seen = new Set();
for (const f of findings) {
  const key = f.kind + f.msg.slice(0, 80);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(' ', f.kind, f.msg.slice(0, 150), '\n    trail:', f.trail.join(' > ').slice(0, 300));
}
await b.close();
