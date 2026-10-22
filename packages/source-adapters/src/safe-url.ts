import { isIP } from "node:net";
import { lookup as nodeLookup } from "node:dns/promises";

export class UnsafeSourceURLError extends Error {}

export type DNSLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const blockedIPv4Ranges: Array<[number, number]> = [
  [0x00000000, 0x00ffffff],
  [0x0a000000, 0x0affffff],
  [0x64400000, 0x647fffff],
  [0x7f000000, 0x7fffffff],
  [0xa9fe0000, 0xa9feffff],
  [0xac100000, 0xac1fffff],
  [0xc0000000, 0xc00000ff],
  [0xc0a80000, 0xc0a8ffff],
  [0xc6120000, 0xc613ffff],
  [0xc6336400, 0xc63364ff],
  [0xcb007100, 0xcb0071ff],
  [0xe0000000, 0xffffffff],
];

function ipv4Number(address: string) {
  return address.split(".").reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

export function isPublicIPAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !blockedIPv4Ranges.some(([start, end]) => value >= start && value <= end);
  }
  if (family === 6) {
    const normalized = address.toLowerCase().split("%")[0] ?? "";
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return false;
    if (normalized.startsWith("ff")) return false;
    if (normalized.startsWith("2001:db8")) return false;
    if (normalized.startsWith("::ffff:")) return isPublicIPAddress(normalized.slice(7));
    return true;
  }
  return false;
}

export async function assertSafePublicURL(
  input: URL,
  lookup: DNSLookup = async (hostname) => nodeLookup(hostname, { all: true, verbatim: true }),
): Promise<URL> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new UnsafeSourceURLError("only HTTP(S) sources are allowed");
  if (url.username || url.password) throw new UnsafeSourceURLError("source URLs cannot contain credentials");
  if (url.port && !["80", "443"].includes(url.port)) throw new UnsafeSourceURLError("nonstandard source ports are disabled");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await lookup(hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIPAddress(address))) {
    throw new UnsafeSourceURLError("source resolves to a non-public address");
  }
  return url;
}
