// Example PT_SETUPS module: one async function per screen, run on a freshly booted page.
export default {
  start: async () => {},
  // settings: async p => { await p.getByRole('button', { name: 'Settings' }).click(); await p.waitForTimeout(500); },
};
