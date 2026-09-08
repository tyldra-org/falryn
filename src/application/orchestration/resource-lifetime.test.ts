import { describe, expect, test } from "bun:test";
import { createResourceLifetime } from "./resource-lifetime.ts";

describe("resource lifetime transfer", () => {
  test("caller release disposes immediately without a retained owner", () => {
    let disposed = 0;
    const lifetime = createResourceLifetime(() => disposed++);
    lifetime.close();
    lifetime.close();
    expect(disposed).toBe(1);
    expect(lifetime.accepting()).toBe(false);
    expect(lifetime.retain()).toBeNull();
  });

  test("retained execution survives caller close without accepting another owner", () => {
    let disposed = 0;
    const lifetime = createResourceLifetime(() => disposed++);
    const first = lifetime.retain();
    const second = lifetime.retain();
    if (first === null || second === null) throw new Error("retention refused");
    lifetime.close();
    expect(disposed).toBe(0);
    expect(lifetime.accepting()).toBe(false);
    expect(lifetime.retain()).toBeNull();
    first();
    first();
    expect(disposed).toBe(0);
    second();
    second();
    expect(disposed).toBe(1);
  });

  test("returning a hold does not close an active caller", () => {
    let disposed = 0;
    const lifetime = createResourceLifetime(() => disposed++);
    const release = lifetime.retain();
    if (release === null) throw new Error("retention refused");
    release();
    expect(disposed).toBe(0);
    expect(lifetime.accepting()).toBe(true);
    lifetime.close();
    expect(disposed).toBe(1);
  });

  test("retained owners are bounded and release makes room", () => {
    let disposed = 0;
    const lifetime = createResourceLifetime(() => disposed++);
    const releases = Array.from({ length: 64 }, () => lifetime.retain());
    expect(releases.every((release) => release !== null)).toBe(true);
    expect(lifetime.retain()).toBeNull();
    releases[0]?.();
    const replacement = lifetime.retain();
    expect(replacement).not.toBeNull();
    lifetime.close();
    for (const release of releases) release?.();
    expect(disposed).toBe(0);
    replacement?.();
    expect(disposed).toBe(1);
  });
});
