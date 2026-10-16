import type { Entity } from '../types';
export function addTag(e: Entity, tag: string, key: string) {
  const owners = ((e.eventTagOwners ??= {})[tag] ??= e.tags.includes(tag)
    ? ['core']
    : []);
  if (!owners.includes(key)) owners.push(key);
  if (!e.tags.includes(tag)) e.tags.push(tag);
}
export function removeTag(e: Entity, tag: string, key: string) {
  const owners = e.eventTagOwners?.[tag];
  if (!owners) return;
  const left = owners.filter((owner) => owner !== key);
  if (left.length) e.eventTagOwners![tag] = left;
  else {
    delete e.eventTagOwners![tag];
    e.tags = e.tags.filter((t) => t !== tag);
  }
}
export const scaleMul = (e: Entity) =>
  Object.values(e.scaleMods ?? {}).reduce((a, b) => a * b, 1);
