import { expect, test } from "bun:test";
import { httpHookDeclaration } from "./hook-fixtures.ts";
import {
  hookCredentialReference,
  httpHookContract,
  httpHookGrantProblem,
  httpHookGrantRequirement,
} from "./hook-http.ts";
import { contributionDeclarationSchema } from "./manifest.ts";

const URL = "https://hooks.example.com/decide";
const CONTRIBUTION = "sha256:" + "c".repeat(64);
const code = (run: () => unknown) => {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

test("an HTTP hook declares only an external effect and at most its own credential", () => {
  const plain = httpHookDeclaration(URL);
  expect(httpHookContract(plain).handler).toEqual({ kind: "http-v1", url: URL });
  expect(code(() => httpHookContract(httpHookDeclaration(URL, { credential: "t" })))).toBe("ok");
  const broaden = (authority: Record<string, unknown>) =>
    contributionDeclarationSchema.parse({
      ...plain,
      authority: { ...plain.authority, ...authority },
    });
  for (const authority of [
    { effects: ["observation"] },
    { effects: ["external", "mutation"] },
    { permissions: ["read"] },
    { roots: ["workspace"] },
    { destinations: ["anything"] },
    { localData: ["cache"] },
    { secretReferences: ["undeclared"] },
  ])
    expect(code(() => httpHookContract(broaden(authority)))).toBe("hook-http-declaration-invalid");
  // A named credential must be the only secret reference, and only that one.
  const named = httpHookDeclaration(URL, { credential: "t" });
  expect(
    code(() =>
      httpHookContract(
        contributionDeclarationSchema.parse({
          ...named,
          authority: { ...named.authority, secretReferences: [] },
        }),
      ),
    ),
  ).toBe("hook-http-declaration-invalid");
});

test("a grant approves exactly the declared endpoint and credential", () => {
  const requirement = httpHookGrantRequirement(
    CONTRIBUTION,
    httpHookContract(httpHookDeclaration(URL, { credential: "hook_token" })),
  );
  expect(requirement).toEqual({ contribution: CONTRIBUTION, url: URL, credential: "hook_token" });
  const credential = {
    storeKind: "environment" as const,
    locator: "HOOK_TOKEN",
    accountLabel: null,
  };
  const grant = { contribution: CONTRIBUTION, url: URL, credential };
  expect(httpHookGrantProblem(requirement, grant)).toBeNull();
  expect(httpHookGrantProblem(requirement, undefined)).toBe("hook-grant-required");
  expect(httpHookGrantProblem(requirement, { ...grant, url: URL + "/other" })).toBe(
    "hook-grant-destination-mismatch",
  );
  expect(httpHookGrantProblem(requirement, { ...grant, credential: null })).toBe(
    "hook-grant-credential-mismatch",
  );
  // The credential resolves only for this contribution.
  expect(hookCredentialReference(grant)).toEqual({
    ...credential,
    consumer: "hook:" + CONTRIBUTION,
  });
  expect(hookCredentialReference({ ...grant, credential: null })).toBeNull();
});
