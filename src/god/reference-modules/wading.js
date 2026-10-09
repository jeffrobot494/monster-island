export default {
  id: 'wading',
  title: 'Humans wade in shallow water',
  description: 'Humans can now walk through shallow water at triple cost. Wading slows them and makes them splash 💦. On calm days some go paddling.',
  requires: [],
  define(api) {
    api.vis.defineEmitter('splash', { color: '#cfe8ff', color2: '#ffffff', size: 0.1, rate: 10, life: 0.5, speed: 1.4, spread: 0.6, gravity: 4 });
  },
  init(api) {
    api.state.splashes = 0;
  },
  rules: {
    moveCost(kind, tile) {
      return kind === 'human' && tile === 'shallow-water' ? 3 : undefined;
    },
  },
  hooks: {
    onTick(api) {
      const t = api.time;
      for (const e of api.ent.query({ kind: 'human' })) {
        const d = api.data(e);
        const inWater = !e.hidden && api.world.tile(e.x, e.z) === 'shallow-water';
        if (inWater && !d.wet) {
          d.wet = true;
          api.ent.modify(e, 'speed', { mul: 0.5 });
          api.vis.emote(e, '💦', 2);
          api.vis.attach(e, 'splash');
          api.state.splashes += 1;
        } else if (!inWater && d.wet) {
          d.wet = false;
          api.ent.clearModify(e, 'speed');
          api.vis.detach(e, 'splash');
        }
        // on calm days a contented human sometimes decides to go paddling
        if (!t.isNight && e.behavior === 'wander' && e.hunger < 40 && !(d.paddleUntil > t.tick) && api.chance(0.0015)) {
          const spot = api.world.nearestTile(e.x, e.z, 'shallow-water', 7);
          if (spot) {
            d.paddleUntil = t.tick + 200;
            d.spot = [spot.x, spot.z];
          }
        }
      }
    },
  },
  behaviors: [
    {
      id: 'paddle',
      appliesTo: (api, e) => e.kind === 'human',
      score: (api, e) => {
        const d = api.data(e);
        return d.paddleUntil > api.time.tick && !api.time.isNight ? 30 : 0;
      },
      act(api, e) {
        const d = api.data(e);
        if (!d.spot) return;
        if (Math.hypot(e.x - d.spot[0] - 0.5, e.z - d.spot[1] - 0.5) < 0.6) {
          // arrived: hop to another nearby water tile
          const next = api.world.nearestTile(d.spot[0] + api.randInt(-2, 2), d.spot[1] + api.randInt(-2, 2), 'shallow-water', 2);
          if (next) d.spot = [next.x, next.z];
          if (api.chance(0.1)) api.vis.say(e, api.pick(['Splish!', 'Cold!', 'Wheee', 'Lovely']), 2);
        }
        api.ent.goTo(e, d.spot[0], d.spot[1]);
      },
    },
  ],
  tests: [
    {
      name: 'a human sent paddling gets wet',
      start: 'dawn',
      ticks: 600,
      setup(api) {
        for (const e of api.ent.query({ kind: 'human' })) {
          const spot = api.world.nearestTile(e.x, e.z, 'shallow-water', 20);
          if (spot) {
            const d = api.data(e);
            d.paddleUntil = api.time.tick + 590;
            d.spot = [spot.x, spot.z];
            return;
          }
        }
      },
      check(api) {
        return api.state.splashes > 0 || 'no human entered shallow water';
      },
    },
    {
      name: 'monsters still avoid water',
      start: 'dawn',
      ticks: 900,
      check(api) {
        const wet = api.ent.query({ kind: 'monster' }).filter((e) => api.world.tile(e.x, e.z) === 'shallow-water');
        return wet.length === 0 || `${wet.length} monsters in the water`;
      },
    },
  ],
};
