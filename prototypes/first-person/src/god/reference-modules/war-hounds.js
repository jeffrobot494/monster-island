export default {
  id: 'war-hounds',
  title: 'War-hounds of the Most High',
  description: 'Hounds live among the humans. They shadow workers in the field, run down any monster they see and bite it. One pup is whelped each midnight, up to six.',
  requires: [],
  define(api) {
    api.vis.defineShape('war-hound', {
      parts: [
        { prim: 'box', size: [0.2, 0.18, 0.42], pos: [0, 0.24, 0], color: 'tint' },
        { prim: 'box', size: [0.16, 0.15, 0.2], pos: [0, 0.32, 0.26], color: 'tint' },
        { prim: 'cone', size: [0.05, 0.1, 0.05], pos: [0.05, 0.43, 0.24], color: '#3a2a1a' },
        { prim: 'cone', size: [0.05, 0.1, 0.05], pos: [-0.05, 0.43, 0.24], color: '#3a2a1a' },
        { prim: 'box', size: [0.05, 0.16, 0.05], pos: [0.07, 0.08, 0.14], color: '#3a2a1a' },
        { prim: 'box', size: [0.05, 0.16, 0.05], pos: [-0.07, 0.08, 0.14], color: '#3a2a1a' },
        { prim: 'box', size: [0.05, 0.16, 0.05], pos: [0.07, 0.08, -0.14], color: '#3a2a1a' },
        { prim: 'box', size: [0.05, 0.16, 0.05], pos: [-0.07, 0.08, -0.14], color: '#3a2a1a' },
        { prim: 'box', size: [0.04, 0.04, 0.2], pos: [0, 0.32, -0.28], rot: [30, 0, 0], color: 'tint', anim: { type: 'sway', speed: 9, amount: 0.4 } },
      ],
    });
  },
  init(api) {
    api.state.bites = 0;
    api.state.lost = 0;
    for (let i = 0; i < 4; i++) whelp(api);
    api.log('The Most High sends hounds to walk beside the villagers.', 2);
  },
  hooks: {
    onMidnight(api) {
      if (api.ent.query({ kind: 'war-hound', owner: api.id }).length < 6) whelp(api);
    },
    onTick(api) {
      if (api.time.tick % 2) return;
      const hounds = api.ent.query({ kind: 'war-hound', owner: api.id });
      for (const h of hounds) {
        const d = api.data(h);
        let m = d.target ? api.ent.get(d.target) : undefined;
        if (!m || m.kind !== 'monster' || m.downed || m.state === 'bound' || api.ent.dist(h, m) > 14) {
          m = undefined;
          d.target = 0;
          if (api.time.tick % 10 === 0) {
            const near = api.ent.query({ kind: 'monster', near: { x: h.x, z: h.z, r: 10 } }).filter((x) => !x.downed && x.state !== 'bound');
            if (near.length) {
              d.target = near[0].id;
              api.vis.emote(h, '❗', 1);
            }
          }
        }
        if (m) {
          if (api.ent.dist(h, m) > 0.9) api.ent.moveToward(h, m.x, m.z, 1.5);
          else if (api.time.tick >= (d.cd || 0)) {
            d.cd = api.time.tick + 10;
            api.ent.damage(m, 5, { type: 'bite', source: h });
            api.state.bites += 1;
            if (api.state.bites === 1) api.log('A war-hound sinks its teeth into a monster.', 2);
            d.hp = (d.hp || 30) - 4;
            if (d.hp <= 0) {
              api.vis.burst('blood', h.x, 0.4, h.z);
              api.ent.remove(h);
              api.state.lost += 1;
              api.log('A war-hound dies fighting.', 1);
            }
          }
          continue;
        }
        // shadow a worker in the fields
        let w = d.ward ? api.ent.get(d.ward) : undefined;
        if (!w || w.kind !== 'human' || w.hidden) {
          const people = api.ent.query({ kind: 'human' }).filter((p) => !p.hidden && !p.champion);
          w = people.length ? api.pick(people) : undefined;
          d.ward = w ? w.id : 0;
        }
        const to = w || api.game.villageCenter;
        if (Math.hypot(to.x - h.x, to.z - h.z) > 1.8) api.ent.moveToward(h, to.x + 0.8, to.z + 0.4, 1.0);
      }
    },
  },
  tests: [
    {
      name: 'four hounds arrive',
      ticks: 20,
      check(api) {
        return api.ent.query({ kind: 'war-hound' }).length >= 4 || 'expected at least 4 hounds';
      },
    },
    {
      name: 'hounds bite a nearby monster',
      ticks: 400,
      setup(api) {
        const m = api.ent.query({ kind: 'monster' })[0];
        for (const h of api.ent.query({ kind: 'war-hound' })) api.ent.setPos(h, m.x + 1, m.z + 1);
      },
      check(api) {
        return api.state.bites > 0 || 'no bites';
      },
    },
  ],
};
function whelp(api) {
  const c = api.game.villageCenter;
  const h = api.ent.spawn({ kind: 'war-hound', x: c.x + api.rand() * 2 - 1, z: c.z + api.rand() * 2 - 1, shape: 'war-hound', tint: api.pick(['#6a4a2a', '#8a6a4a', '#3a2a20']), speed: 1.2 });
  api.data(h).hp = 30;
}
