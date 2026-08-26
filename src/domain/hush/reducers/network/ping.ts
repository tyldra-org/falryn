/** Complete ping projection for Darwin and iputils output. */

import { shortestText } from "../../text-format.ts";
import { buildLines } from "../build/shared.ts";

export function formatPingOutput(text: string): string | null {
  const lines = buildLines(text);
  const heading = parseHeading(lines[0] ?? "");
  if (heading === null) return null;

  const output = [heading];
  let sawPacketSummary = false;
  for (const line of lines.slice(1)) {
    if (/^--- .+ ping statistics ---$/u.test(line)) continue;

    const reply = /^(\d+) bytes from (.+): icmp_seq=(\d+) ttl=(\d+) time=([<\d.]+) ms$/u.exec(line);
    if (reply !== null) {
      output.push(
        `reply seq=${reply[3]} from=${reply[2]} bytes=${reply[1]} ttl=${reply[4]} time=${reply[5]}ms`,
      );
      continue;
    }

    const packets =
      /^(\d+) packets transmitted, (\d+)(?: packets)? received, ([\d.]+)% packet loss(?:, time (\d+)ms)?$/u.exec(
        line,
      );
    if (packets !== null) {
      output.push(
        `sent=${packets[1]} received=${packets[2]} loss=${packets[3]}%${packets[4] === undefined ? "" : ` time=${packets[4]}ms`}`,
      );
      sawPacketSummary = true;
      continue;
    }

    const roundTrip =
      /^(?:round-trip|rtt) min\/avg\/max\/(stddev|mdev) = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms$/u.exec(
        line,
      );
    if (roundTrip !== null) {
      output.push(
        `rtt min=${roundTrip[2]} avg=${roundTrip[3]} max=${roundTrip[4]} ${roundTrip[1]}=${roundTrip[5]}ms`,
      );
      continue;
    }

    output.push(line);
  }
  return sawPacketSummary ? shortestText(text, output.join("\n")) : null;
}

function parseHeading(line: string): string | null {
  const darwin = /^PING (\S+) \(([^)]+)\): (\d+) data bytes$/u.exec(line);
  if (darwin !== null) return `ping ${darwin[1]} ip=${darwin[2]} data=${darwin[3]}B`;

  const linux = /^PING (\S+) \(([^)]+)\) (\d+)\((\d+)\) bytes of data\.$/u.exec(line);
  return linux === null
    ? null
    : `ping ${linux[1]} ip=${linux[2]} data=${linux[3]}B wire=${linux[4]}B`;
}
