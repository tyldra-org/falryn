import { describe, expect, test } from "bun:test";

import { formatShortJournal } from "./format.ts";

describe("short journal format", () => {
  test("shares stable journal fields while retaining every distinct event and repeat count", () => {
    const source = [
      "Aug 24 10:00:00 falryn-host falryn[736]: INFO session started session=demo",
      "Aug 24 10:00:01 falryn-host falryn[736]: INFO context engine ready reducers=82",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:03 falryn-host falryn[736]: WARN reducer fallback command=unknown",
      "Aug 24 10:00:04 falryn-host falryn[736]: ERROR capture unavailable id=cap-42",
      "Aug 24 10:00:05 falryn-host falryn[736]: INFO request complete tokens=219",
      "",
    ].join("\n");

    expect(formatShortJournal(source)).toBe(
      [
        "Aug 24 10:00 falryn-host falryn[736]",
        "00 [I] session started session=demo",
        "01 [I] context engine ready reducers=82",
        "02 [I] waiting for provider ×3",
        "03 [W] reducer fallback command=unknown",
        "04 [E] capture unavailable id=cap-42",
        "05 [I] request complete tokens=219",
        "",
      ].join("\n"),
    );
  });

  test("keeps order across changing prefixes and marks an unspecified level", () => {
    const source = [
      "Aug 24 10:00:59 host-a falryn[1]: INFO ready",
      "Aug 24 10:01:00 host-a falryn[1]: request accepted",
      "Aug 24 10:01:01 host-b worker[2]: DEBUG processing",
    ].join("\n");

    expect(formatShortJournal(source)).toBe(
      [
        "Aug 24 10:00 host-a falryn[1]",
        "59 [I] ready",
        "Aug 24 10:01 host-a falryn[1]",
        "00 [-] request accepted",
        "Aug 24 10:01 host-b worker[2]",
        "01 [D] processing",
      ].join("\n"),
    );
  });

  test("retains every journal event without a result-count cap", () => {
    const source = `${Array.from(
      { length: 80 },
      (_, index) =>
        `Aug 24 10:00:${String(index % 60).padStart(2, "0")} falryn-host falryn[736]: INFO event marker-${index + 1}`,
    ).join("\n")}\n`;
    const formatted = formatShortJournal(source);

    expect(formatted).not.toBeNull();
    expect(formatted).toContain("marker-1");
    expect(formatted).toContain("marker-80");
    expect(formatted?.split("\n")).toHaveLength(82);
  });

  test("refuses mixed or malformed input instead of guessing", () => {
    expect(
      formatShortJournal(
        [
          "Aug 24 10:00:00 falryn-host falryn[736]: INFO ready",
          "this is not a short journal record",
        ].join("\n"),
      ),
    ).toBeNull();
    expect(formatShortJournal("-- No entries --\n")).toBeNull();
  });
});
