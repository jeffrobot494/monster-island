// Deliberately broken modules for dev testing of validation, quarantine and the watchdog.
const mod = (id: string, title: string, body: string) => `export default {
  id: '${id}', title: '${title}', description: 'dev test module',
  define(api) {},
  ${body}
  tests: [{ name: 'trivial', start: 'dawn', ticks: 10, check(api) { return true; } }],
};`;

export const DEV_BROKEN: Record<string, string> = {
  hang: mod('hang', 'Freezes the island after a while', `hooks: { onTick(api) { api.state.n = (api.state.n || 0) + 1; if (api.state.n === 60) { while (true) {} } } },`),
  thrower: mod('thrower', 'Throws every tick', `hooks: { onTick(api) { const e = api.ent.query({ kind: 'human' })[0]; if (e) api.vis.emote(e, '!', 1); throw new Error('boom'); } },`),
};
