import { BlockList, isIP } from "node:net";

export const CONNECTION_MAX_RELATIVE_URL_BYTES = 8 * 1024;

const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();

const IPV4_BLOCKS: Array<[network: string, prefix: number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const IPV6_BLOCKS: Array<[network: string, prefix: number]> = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
];

for (const [network, prefix] of IPV4_BLOCKS) blockedIpv4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of IPV6_BLOCKS) blockedIpv6.addSubnet(network, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family === 6) return !blockedIpv6.check(address, "ipv6");
  return false;
}

export function normalizeConnectionOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("connection destination must be a valid HTTPS origin");
  }
  if (url.protocol !== "https:") throw new Error("connection destination must use HTTPS");
  if (url.username || url.password)
    throw new Error("connection destination cannot contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("connection destination must be an origin without path, query, or fragment");
  }
  if (!url.hostname || isIP(url.hostname) !== 0) {
    throw new Error("connection destination must use a DNS hostname");
  }
  return url.origin;
}

export function buildConnectionTarget(
  origin: string,
  relativePath: string,
  maxBytes = CONNECTION_MAX_RELATIVE_URL_BYTES,
): URL {
  if (new TextEncoder().encode(relativePath).byteLength > maxBytes) {
    throw new Error("connection relative URL is too large");
  }
  if (!relativePath.startsWith("/") || relativePath.startsWith("//")) {
    throw new Error("connection target must be a root-relative path");
  }
  if (
    [...relativePath].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 || character === "\\";
    })
  ) {
    throw new Error("connection target cannot contain control characters or backslashes");
  }
  const normalizedOrigin = normalizeConnectionOrigin(origin);
  const target = new URL(relativePath, `${normalizedOrigin}/`);
  if (target.origin !== normalizedOrigin || target.username || target.password) {
    throw new Error("connection target must remain on the approved origin");
  }
  return target;
}
