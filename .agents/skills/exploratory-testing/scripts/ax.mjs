// axe-core over every setup in PT_SETUPS. Injected as an init script because WebKit + a strict CSP blocks addScriptTag.
// Usage: node ax.mjs   (run where axe-core is installed)
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { open, loadSetups } from './lib.mjs';

const axeSrc = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const setups = await loadSetups();
for (const [name, fn] of Object.entries(setups)) {
  const { b, page, ctx } = await open();
  await ctx.addInitScript({ content: axeSrc });
  await page.reload();
  await page.waitForTimeout(500);
  try {
    await fn(page);
    const res = await page.evaluate(async () => (await axe.run(document, { resultTypes: ['violations'] })).violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, ex: v.nodes.slice(0, 2).map(n => n.target.join(' ').slice(0, 90) + ' :: ' + ((n.failureSummary || '').split('\n')[1] || '').slice(0, 120)) })));
    console.log('##', name, res.length ? '' : 'clean');
    for (const v of res) console.log('  ', v.impact, v.id, 'x' + v.n, '\n      ' + v.ex.join('\n      '));
  } catch (e) { console.log('##', name, 'ERR', e.message.split('\n')[0]); }
  await b.close();
}
