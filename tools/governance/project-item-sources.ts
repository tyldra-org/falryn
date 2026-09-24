/**
 * Merges the two GitHub reads of one issue's Project items.
 *
 * A Project's paged `items` connection is an index that can lag behind item
 * creation: during an indexing delay it omits recently added items and its
 * `totalCount` agrees with the omission, so pagination checks cannot notice.
 * The issue's own `projectItems` connection reads the same items directly.
 *
 * Capture keeps every item either source reports. For an item both report, the
 * issue-side value wins because it is read from the item itself. An item that
 * neither source reports stays absent, so a real membership gap still fails
 * the audit.
 */
export type ProjectItemSourceMerge<Item> = {
  readonly items: readonly Item[];
  /** Items the issue reported that the Project list omitted. */
  readonly recovered: number;
};

export function mergeProjectItemSources<Item extends { readonly id: string }>(
  listed: readonly Item[],
  issueSide: readonly Item[],
): ProjectItemSourceMerge<Item> {
  const issueSideById = new Map<string, Item>();
  for (const item of issueSide) {
    if (issueSideById.has(item.id)) {
      throw new Error(`issue-side Project items contain duplicate item ${item.id}`);
    }
    issueSideById.set(item.id, item);
  }
  const listedIds = new Set<string>();
  const items: Item[] = [];
  for (const item of listed) {
    if (listedIds.has(item.id)) {
      throw new Error(`listed Project items contain duplicate item ${item.id}`);
    }
    listedIds.add(item.id);
    items.push(issueSideById.get(item.id) ?? item);
  }
  let recovered = 0;
  for (const item of issueSide) {
    if (!listedIds.has(item.id)) {
      items.push(item);
      recovered += 1;
    }
  }
  return { items, recovered };
}
