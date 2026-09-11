import { expect, test } from "bun:test";
import { simpleWorkflow } from "./workflow.fixtures.ts";
import {
  decodeWorkflowDefinition,
  resolveWorkflowValue,
  workflowPath,
} from "./workflow-definition.ts";

test("definition validation is inert, canonical and rejects invalid graph ownership", () => {
  const good = decodeWorkflowDefinition(simpleWorkflow());
  expect(good.ok).toBeTrue();
  if (!good.ok) throw new Error("fixture");
  expect(good.definition.nodes[0]?.retries).toBe(0);
  expect(Object.isFrozen(good.definition)).toBeTrue();
  expect(decodeWorkflowDefinition(good.definition)).toEqual(good);
  const first = simpleWorkflow().nodes[0];
  for (const nodes of [
    [first, first],
    [{ ...first, dependencies: ["missing"] }],
    [{ ...first, dependencies: ["read"] }],
    [{ ...first, input: { value: { from: "node", node: "missing" } } }],
    [{ ...first, effect: "mutation", retries: 1 }],
    [{ ...first, input: { value: { from: "item" } } }],
    Array.from({ length: 257 }, (_, i) => ({ ...first, key: `node-${i}` })),
  ])
    expect(decodeWorkflowDefinition({ ...simpleWorkflow(), nodes }).ok).toBeFalse();
});
test("typed traversal does not evaluate strings or inherit object properties", () => {
  expect(workflowPath({ nested: [{ value: 4 }] }, ["nested", 0, "value"])).toBe(4);
  expect(() => workflowPath({}, ["toString"])).toThrow();
  expect(() => workflowPath({ constructor: "inert" }, ["constructor"])).toThrow();
  expect(resolveWorkflowValue({ from: "literal", value: "$(touch example)" }, {}, new Map())).toBe(
    "$(touch example)",
  );
  expect(() =>
    resolveWorkflowValue({ from: "node", node: "lost", path: [] }, {}, new Map()),
  ).toThrow();
});
