import type { Document, Relationship, Resource, ResourceIdentifier } from './types.ts';

/** Indexes a compound document's `included` array by "type:id". */
export function indexIncluded(included: Resource[] | undefined): Map<string, Resource> {
  const index = new Map<string, Resource>();
  for (const resource of included ?? []) index.set(`${resource.type}:${resource.id}`, resource);
  return index;
}

/**
 * Resolves a to-one relationship against the included index. Matching is on the
 * type + id pair from `relationships.{rel}.data`, as the device discovery docs specify.
 */
export function resolveOne<A>(relationship: Relationship | undefined, index: Map<string, Resource>): A | undefined {
  const linkage = relationship?.data;
  if (!linkage || Array.isArray(linkage)) return undefined;
  return index.get(key(linkage))?.attributes as A | undefined;
}

export function resolveMany<A>(relationship: Relationship | undefined, index: Map<string, Resource>): A[] {
  const linkage = relationship?.data;
  if (!linkage) return [];
  const list = Array.isArray(linkage) ? linkage : [linkage];
  return list.flatMap((id) => {
    const found = index.get(key(id));
    return found ? [found.attributes as A] : [];
  });
}

/** Reads `page[key]` from a relative `links.next` URL. */
export function nextPageKey(doc: Document<unknown>): string | undefined {
  const next = doc.links?.next;
  if (typeof next !== 'string' || !next) return undefined;
  const url = new URL(next, 'https://placeholder.invalid');
  return url.searchParams.get('page[key]') ?? undefined;
}

function key(id: ResourceIdentifier): string {
  return `${id.type}:${id.id}`;
}
