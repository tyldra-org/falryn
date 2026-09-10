/** Iterative traversal shared by static planning and budgeted persisted work graphs. */
export function findDependencyCycle<Id>(
  roots: Iterable<Id>,
  dependencies: (id: Id) => Iterable<Id>,
): readonly Id[] | null {
  const state = new Map<Id, "visiting" | "done">();
  const frames: { id: Id; children: Iterator<Id> }[] = [];
  const enter = (id: Id) => {
    state.set(id, "visiting");
    frames.push({ id, children: dependencies(id)[Symbol.iterator]() });
  };
  for (const root of roots) {
    if (state.has(root)) continue;
    enter(root);
    while (frames.length > 0) {
      const frame = frames.at(-1);
      if (frame === undefined) break;
      const next = frame.children.next();
      if (next.done) {
        state.set(frame.id, "done");
        frames.pop();
        continue;
      }
      if (state.get(next.value) === "done") continue;
      if (state.get(next.value) === "visiting") {
        const start = frames.findIndex((entry) => entry.id === next.value);
        return frames.slice(Math.max(0, start)).map((entry) => entry.id);
      }
      enter(next.value);
    }
  }
  return null;
}

/** Empty prerequisites are satisfied for either join policy, as in static task progress. */
export function dependencyJoinSatisfied(
  join: "all" | "any",
  observations: Iterable<boolean>,
): boolean {
  let count = 0;
  for (const satisfied of observations) {
    count++;
    if (join === "all" && !satisfied) return false;
    if (join === "any" && satisfied) return true;
  }
  return count === 0 || join === "all";
}
