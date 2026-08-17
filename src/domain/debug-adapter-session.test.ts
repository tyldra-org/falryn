import { describe, expect, test } from "bun:test";
import {
  parseBreakpointsResponse,
  parseEvaluateResponse,
  parseOutputEventBody,
  parseScopesResponse,
  parseStackTraceResponse,
  parseTargetExitEvent,
  parseThreadsResponse,
  parseVariablesResponse,
  projectEvaluateForModel,
  projectVariableForModel,
  REDACTED_VALUE,
  validateCancelRequest,
  validateDisconnectRequest,
  validateEvaluateRequest,
  validateSetBreakpointsRequest,
  validateTerminateRequest,
} from "./debug-adapter-session.ts";

describe("debug-adapter session contracts", () => {
  test("validates breakpoint requests and parses DAP bodies", () => {
    expect(
      validateSetBreakpointsRequest({
        sourcePath: "src/a.ts",
        breakpoints: [{ line: 10, column: 2 }],
      }),
    ).toBeNull();
    expect(
      validateSetBreakpointsRequest({
        sourcePath: "",
        breakpoints: [{ line: 1 }],
      }),
    ).toMatchObject({ reason: "invalid-source" });

    expect(
      parseBreakpointsResponse("src/a.ts", 3, {
        breakpoints: [{ id: 1, verified: true, line: 10, column: 2 }],
      }),
    ).toEqual({
      ok: true,
      value: {
        sourcePath: "src/a.ts",
        revision: 3,
        breakpoints: [{ id: 1, verified: true, line: 10, column: 2, message: null }],
      },
    });

    expect(parseThreadsResponse({ threads: [{ id: 1, name: "main" }] })).toEqual({
      ok: true,
      value: [{ id: 1, name: "main" }],
    });

    expect(
      parseStackTraceResponse({
        stackFrames: [
          {
            id: 7,
            name: "foo",
            line: 12,
            column: 1,
            source: { path: "/tmp/a.ts" },
          },
        ],
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          id: 7,
          name: "foo",
          line: 12,
          column: 1,
          sourcePath: "/tmp/a.ts",
        },
      ],
    });
  });

  test("parses scopes, variables, evaluate, and redacts sensitive projections", () => {
    expect(
      parseScopesResponse({
        scopes: [{ name: "Locals", variablesReference: 2, expensive: false, namedVariables: 3 }],
      }),
    ).toEqual({
      ok: true,
      value: [
        {
          name: "Locals",
          variablesReference: 2,
          expensive: false,
          namedVariables: 3,
          indexedVariables: null,
        },
      ],
    });

    const variables = parseVariablesResponse({
      variables: [
        { name: "count", value: "3", type: "number", variablesReference: 0 },
        { name: "api_token", value: "sekrit", type: "string", variablesReference: 0 },
      ],
    });
    expect(variables.ok).toBe(true);
    if (!variables.ok) {
      return;
    }
    expect(variables.value).toHaveLength(2);
    const count = variables.value[0];
    const token = variables.value[1];
    expect(count).toBeDefined();
    expect(token).toBeDefined();
    if (count === undefined || token === undefined) {
      return;
    }
    expect(projectVariableForModel(count)).toMatchObject({
      name: "count",
      value: "3",
      redacted: false,
      sensitive: false,
    });
    expect(projectVariableForModel(token)).toMatchObject({
      name: "api_token",
      value: REDACTED_VALUE,
      redacted: true,
      sensitive: true,
    });

    expect(validateEvaluateRequest({ expression: "", stoppedGeneration: 1 })).toMatchObject({
      reason: "invalid-expression",
    });
    expect(
      validateEvaluateRequest({
        expression: "x",
        stoppedGeneration: 1,
        context: "repl",
      }),
    ).toBeNull();

    const evaluated = parseEvaluateResponse({ result: "Bearer abc.def", type: "string" }, "watch");
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) {
      return;
    }
    expect(evaluated.value.mayMutate).toBe(false);
    expect(projectEvaluateForModel(evaluated.value).result).toBe(REDACTED_VALUE);

    const mutates = parseEvaluateResponse({ result: "4", type: "number" }, "repl");
    expect(mutates.ok).toBe(true);
    if (!mutates.ok) {
      return;
    }
    expect(mutates.value.mayMutate).toBe(true);

    expect(
      parseOutputEventBody({
        category: "stdout",
        output: "password=hunter2",
      }),
    ).toMatchObject({
      ok: true,
      value: { category: "stdout", sensitive: true, redacted: false },
    });
  });

  test("parses target exits and validates terminate/cancel/disconnect requests", () => {
    expect(parseTargetExitEvent("exited", { exitCode: 7 })).toEqual({
      ok: true,
      value: { kind: "exited", exitCode: 7 },
    });
    expect(parseTargetExitEvent("terminated", {})).toEqual({
      ok: true,
      value: { kind: "terminated", exitCode: null },
    });
    expect(validateDisconnectRequest({ terminateDebuggee: false, restart: true })).toBeNull();
    expect(validateTerminateRequest({ restart: false })).toBeNull();
    expect(validateCancelRequest({ requestId: 3 })).toBeNull();
    expect(validateCancelRequest({})).toMatchObject({ reason: "invalid-cancel" });
  });
});
