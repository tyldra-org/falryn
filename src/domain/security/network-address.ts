/**
 * Whether a resolved address is publicly routable (#1175). Loopback, private,
 * link-local, shared, documentation, benchmarking, multicast, reserved and
 * unspecified space is not, and neither is any IPv6 form that embeds such an
 * IPv4 address. Unparseable input is never public.
 *
 * Pure; no resolution happens here.
 */
import { isIPv4, isIPv6 } from "node:net";

const V4_NON_PUBLIC: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4(address: string): number {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function publicV4(address: string): boolean {
  const value = v4(address);
  return !V4_NON_PUBLIC.some(([base, prefix]) => {
    const size = 2 ** (32 - prefix);
    const start = v4(base);
    return value >= start && value < start + size;
  });
}

/** Eight 16-bit groups, with any dotted IPv4 tail folded in. */
function groups(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (tail?.[1] !== undefined) {
    if (!isIPv4(tail[1])) return null;
    const value = v4(tail[1]);
    text =
      text.slice(0, -tail[1].length) +
      Math.floor(value / 65_536).toString(16) +
      ":" +
      (value % 65_536).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) =>
    part === undefined || part === ""
      ? []
      : part.split(":").map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const all = [...head, ...Array<number>(Math.max(0, missing)).fill(0), ...rest];
  return all.length === 8 && all.every((group) => group >= 0 && group <= 0xffff) ? all : null;
}

function embeddedV4(high: number, low: number): string {
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function publicV6(address: string): boolean {
  const g = groups(address);
  if (g === null) return false;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, x = 0, y = 0] = g;
  const zeroPrefix = a === 0 && b === 0 && c === 0 && d === 0 && e === 0;
  // Unspecified, loopback and deprecated IPv4-compatible space.
  if (zeroPrefix && f === 0) return false;
  // IPv4-mapped addresses are judged by the address they carry.
  if (zeroPrefix && f === 0xffff) return publicV4(embeddedV4(x, y));
  // NAT64 and 6to4 embed an IPv4 destination too.
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0)
    return publicV4(embeddedV4(x, y));
  if (a === 0x2002) return publicV4(embeddedV4(b, c));
  if ((a & 0xfe00) === 0xfc00) return false; // unique local
  if ((a & 0xffc0) === 0xfe80 || (a & 0xffc0) === 0xfec0) return false; // link and site local
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2001 && b === 0) return false; // Teredo tunnels hide their destination
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // discard prefix
  return true;
}

export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return publicV4(address);
  if (isIPv6(address)) return publicV6(address);
  return false;
}
