import { isIP } from 'node:net';

function normalize(address) {
  if (address?.startsWith('::ffff:')) return address.slice(7);
  return address || 'unknown';
}

function ipv4Number(address) {
  return address.split('.').reduce((result, part) => (result * 256) + Number(part), 0) >>> 0;
}

function matchesCidr(address, cidr) {
  const [network, bitsText] = cidr.split('/');
  const normalizedAddress = normalize(address);
  if (isIP(network) !== isIP(normalizedAddress)) return false;
  if (isIP(network) === 4) {
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4Number(network) & mask) === (ipv4Number(normalizedAddress) & mask);
  }
  return (bitsText === undefined || bitsText === '128') && network === normalizedAddress;
}

// Only a configured reverse proxy may supply X-Forwarded-For.
export function resolveClientIp(request, trustedProxyCidrs) {
  const peer = normalize(request.socket.remoteAddress);
  if (!trustedProxyCidrs.some((cidr) => matchesCidr(peer, cidr))) return peer;
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return isIP(forwarded) ? forwarded : peer;
}
