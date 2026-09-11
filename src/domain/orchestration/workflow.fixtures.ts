export const emptyWorkflowValue = { type: "object", properties: {}, additionalProperties: false };
export const simpleWorkflow = () => ({
  version: 1,
  id: "user/test:checks",
  label: "Checks",
  argumentsSchema: emptyWorkflowValue,
  nodes: [
    {
      key: "read",
      kind: "action",
      capability: "builtin:test/read@1",
      effect: "observation",
      resultSchema: emptyWorkflowValue,
    },
  ],
  outputs: { result: { from: "node", node: "read" } },
});
