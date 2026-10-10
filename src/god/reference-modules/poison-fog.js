export default {
  id: 'poison-fog',
  title: 'The sweet fog of the salt flats',
  description: 'Some nights a green fog rises from the salt flats and drifts toward the village. Humans inside it sicken; monsters inside it heal. It burns off at dawn.',
  requires: [],
  define(api) {
    api.vis.defineShape('fog-bank', {
      parts: [
        { prim: 'sphere', size: [3, 0.7, 3], pos: [0, 0.35, 0], color: '#a8c080', opacity: 0.32, anim: { type: 'pulse', speed: 0.6, amount: 0.12 } },
        { prim: 'sphere', size: [2, 0.9, 2], pos: [0.8, 0.5, -0.4], color: '#b8d090', opacity: 0.25 },
      ],
    });
    api.vis.defineEmitter('fog-mist', { color: '#9ab86a', color2: '#c8d890', size: 0.8, rate: 3, life: 5, speed: 0.3, spread: 1, gravity: -0.05 });
  },
  init(api) {
    api.state.on = false;
    api.state.nights = 0;
    api.state.force = false;
  },
  hooks: {
    onHour(api) {
      const h = Math.floor(api.time.hour);
      if (api.state.on) {
        if (h === 6) return lift(api);
        // drift toward the village
        const c = api.game.villageCenter;
        for (const b of api.ent.query({ kind: 'fog-bank', owner: api.id })) {
          const dx = c.x - b.x, dz = c.z - b.z, d = Math.hypot(dx, dz) || 1;
          api.ent.setPos(b, Math.max(1, Math.min(126, b.x + (dx / d) * 4)), Math.max(1, Math.min(126, b.z + (dz / d) * 4)));
        }
        return;
      }
      if ((h >= 19 || h < 4) && (api.state.force || api.chance(0.4))) rise(api);
    },
    onTick(api) {
      if (!api.state.on || api.time.tick % 10) return;
      const banks = api.ent.query({ kind: 'fog-bank', owner: api.id });
      for (const e of api.ent.query({ inhabitant: true })) {
        if (e.hidden || !banks.some((b) => Math.hypot(b.x - e.x, b.z - e.z) < 3)) continue;
        if (e.kind === 'human') api.ent.damage(e, api.perHour(3) * 10, { type: 'poison' });
        else api.ent.heal(e, api.perHour(8) * 10);
      }
    },
  },
  tests: [
    {
      name: 'the fog rises at night when forced',
      start: 'night',
      ticks: 600,
      setup(api) {
        api.state.force = true;
      },
      check(api) {
        return api.state.nights > 0 || 'the fog never rose';
      },
    },
  ],
};
function rise(api) {
  const salt = api.world.findTiles('salt', 4000).concat(api.world.findTiles('marsh', 2000));
  if (!salt.length) return;
  for (let i = 0; i < 8; i++) {
    const t = api.pick(salt);
    const b = api.ent.spawn({ kind: 'fog-bank', x: t.x + 0.5, z: t.z + 0.5, shape: 'fog-bank' });
    if (i < 4) api.vis.attach(b, 'fog-mist');
  }
  api.state.on = true;
  api.state.nights += 1;
  api.vis.atmosphere({ weather: 'fog', fogColor: '#8a9a78', fogDensity: 0.25 });
  if (api.state.nights === 1) api.log('A sweet green fog rises from the salt flats. The beasts breathe it gladly.', 3);
}
function lift(api) {
  for (const b of api.ent.query({ kind: 'fog-bank', owner: api.id })) api.ent.remove(b);
  api.state.on = false;
  api.vis.atmosphere({ weather: 'none', fogDensity: 0 });
}
