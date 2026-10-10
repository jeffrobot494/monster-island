export default {
  id: 'fireflies',
  title: 'Fireflies drift through the forest at night',
  description: 'At dusk glowing fireflies rise over forest tiles and drift about; inhabitants who see them show ✨. They vanish at dawn.',
  requires: [],
  define(api) {
    api.vis.defineShape('firefly', {
      parts: [{ prim: 'sphere', size: [0.12, 0.12, 0.12], pos: [0, 0.9, 0], color: '#f6ff8a', emissive: 1, anim: { type: 'bob', speed: 2, amount: 0.25 } }],
    });
    api.vis.defineEmitter('firefly-glow', { color: '#f6ff8a', color2: '#b8ff6a', size: 0.08, rate: 3, life: 0.8, speed: 0.2, spread: 1, gravity: 0, glow: true });
  },
  init(api) {
    api.state.nights = 0;
  },
  hooks: {
    onDusk(api) {
      const forest = api.world.findTiles('forest');
      if (!forest.length) return;
      for (let i = 0; i < 24; i++) {
        const t = api.pick(forest);
        const f = api.ent.spawn({ kind: 'firefly', x: t.x + 0.5, z: t.z + 0.5, shape: 'firefly' });
        api.ent.modify(f, 'speed', { mul: 0.3 });
        api.data(f).home = [t.x + 0.5, t.z + 0.5];
        if (i < 6) api.vis.attach(f, 'firefly-glow');
      }
      api.state.nights += 1;
      if (api.state.nights === 1) api.log('Fireflies rise from the forest for the first time.', 2);
    },
    onDawn(api) {
      for (const f of api.ent.query({ kind: 'firefly' })) api.ent.remove(f);
    },
    onTick(api) {
      if (!api.time.isNight) return;
      const flies = api.ent.query({ kind: 'firefly' });
      for (const f of flies) {
        const d = api.data(f);
        if (!d.to || api.chance(0.02)) {
          const x = Math.min(api.world.size - 1, Math.max(0, d.home[0] + (api.rand() - 0.5) * 6));
          const z = Math.min(api.world.size - 1, Math.max(0, d.home[1] + (api.rand() - 0.5) * 6));
          d.to = [x, z];
        }
        api.ent.moveToward(f, d.to[0], d.to[1]);
      }
      if (api.time.tick % 20 !== 0 || !flies.length) return;
      for (const e of api.ent.query({ inhabitant: true })) {
        if (e.hidden || !api.chance(0.3)) continue;
        if (flies.some((f) => api.ent.dist(e, f) < 2.5)) api.vis.emote(e, '✨', 1.5);
      }
    },
  },
  tests: [
    {
      name: 'fireflies appear after dusk',
      start: 'dusk',
      ticks: 20,
      check(api) {
        return api.ent.query({ kind: 'firefly' }).length > 0 || 'no fireflies after dusk';
      },
    },
    {
      name: 'fireflies are gone by morning',
      start: 'dusk',
      ticks: 700,
      check(api) {
        return api.ent.query({ kind: 'firefly' }).length === 0 || 'fireflies still around after dawn';
      },
    },
  ],
};
