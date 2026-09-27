import { expect, test } from "bun:test";
import { isPublicAddress } from "./network-address.ts";

test("only publicly routable addresses are public, including embedded IPv4 forms", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: true });
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.5.4",
    "172.31.255.255",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2002:c0a8:0101::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1%en0",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "100::1",
    "not-an-address",
    "",
  ])
    expect({ address, public: isPublicAddress(address) }).toEqual({ address, public: false });
  // Embedded public addresses stay public.
  expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
  expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
  // 172.15 and 172.32 sit just outside the private /12.
  expect(isPublicAddress("172.15.255.255")).toBe(true);
  expect(isPublicAddress("172.32.0.0")).toBe(true);
});
