import { describe, expect, test } from "bun:test";

import { formatPingOutput } from "./ping.ts";

describe("Hush ping formatting", () => {
  test("keeps every Darwin reply, packet counter, and latency fact", () => {
    const replies = Array.from(
      { length: 80 },
      (_, index) =>
        `64 bytes from 192.0.2.80: icmp_seq=${index} ttl=57 time=${(12 + index / 100).toFixed(2)} ms`,
    );
    const formatted = formatPingOutput(
      [
        "PING example.test (192.0.2.80): 56 data bytes",
        ...replies,
        "--- example.test ping statistics ---",
        "80 packets transmitted, 80 packets received, 0.0% packet loss",
        "round-trip min/avg/max/stddev = 12.000/12.395/12.790/0.231 ms",
      ].join("\n"),
    );
    expect(formatted).toContain("ping example.test ip=192.0.2.80 data=56B");
    expect(formatted).toContain("reply seq=0");
    expect(formatted).toContain("reply seq=79");
    expect(formatted).toContain("sent=80 received=80 loss=0.0%");
    expect(formatted).toContain("stddev=0.231ms");
    expect(formatted).not.toContain("omitted");
  });

  test("keeps Linux timeouts and mdev alongside every received reply", () => {
    expect(
      formatPingOutput(
        [
          "PING linux.example.test (192.0.2.81) 56(84) bytes of data.",
          "64 bytes from 192.0.2.81: icmp_seq=1 ttl=56 time=18.2 ms",
          "Request timeout for icmp_seq 2",
          "64 bytes from 192.0.2.81: icmp_seq=3 ttl=56 time=19.1 ms",
          "--- linux.example.test ping statistics ---",
          "3 packets transmitted, 2 received, 33.3333% packet loss, time 2002ms",
          "rtt min/avg/max/mdev = 18.200/18.650/19.100/0.450 ms",
        ].join("\n"),
      ),
    ).toContain("Request timeout for icmp_seq 2");
  });

  test("declines incomplete output without a packet summary", () => {
    expect(formatPingOutput("PING example.test (192.0.2.80): 56 data bytes")).toBeNull();
  });
});
