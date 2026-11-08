import { lookup, type LookupOptions } from 'node:dns';
import { get as httpGet, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { get as httpsGet } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  nonPublic.addSubnet(address, prefix, 'ipv6');
}
const globalUnicast = new BlockList();
globalUnicast.addSubnet('2000::', 3, 'ipv6');
const fakeDnsRange = new BlockList();
fakeDnsRange.addSubnet('198.18.0.0', 15, 'ipv4');
const dnsResult = z.object({ Status: z.literal(0), Answer: z.array(z.object({ type: z.number(), data: z.string() })).default([]) });

function publicAddress(address: string, family: number, local: BlockList) {
  if (local.check(address, family === 6 ? 'ipv6' : 'ipv4')) return false;
  if (family === 4) return !nonPublic.check(address, 'ipv4');
  return family === 6 && globalUnicast.check(address, 'ipv6') && !nonPublic.check(address, 'ipv6');
}

const denied = () => new Error('工具素材地址必须解析到公网，不能访问本机、内网或保留地址。');

async function resolvePublicDns(hostname: string, family: LookupOptions['family'], signal: AbortSignal) {
  const families = family === 4 || family === 'IPv4' ? [4] : family === 6 || family === 'IPv6' ? [6] : [4, 6];
  const answers = await Promise.allSettled(families.map(async addressFamily => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    const type = addressFamily === 4 ? 1 : 28;
    url.search = new URLSearchParams({ name: hostname, type: String(type) }).toString();
    const response = await fetch(url, { redirect: 'error', signal, headers: { Accept: 'application/dns-json' } });
    if (!response.ok) { await response.body?.cancel(); throw denied(); }
    const { Answer } = dnsResult.parse(await response.json());
    return Answer.filter(record => record.type === type && isIP(record.data) === addressFamily).map(record => ({ address: record.data, family: addressFamily }));
  }));
  return answers.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

// The socket consumes these exact addresses. A separate preflight lookup
// would let a second DNS answer redirect the actual connection to a private IP.
function publicLookup(local: BlockList, publicDnsSignal?: AbortSignal): LookupFunction {
  return (hostname, options, callback) => {
    const deliver = (addresses: { address: string; family: number }[]) => {
      if (!addresses.length || addresses.some(({ address, family }) => !publicAddress(address, family, local))) {
        callback(denied(), '', 0); return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    lookup(hostname, { all: true, family: options.family }, (error, addresses) => {
      // Some proxy clients return synthetic addresses here. Resolve those
      // names publicly and still pass only vetted addresses to the socket.
      if (publicDnsSignal && !error && addresses.length && addresses.every(({ address, family }) => family === 4 && fakeDnsRange.check(address, 'ipv4'))) {
        void resolvePublicDns(hostname, options.family, publicDnsSignal).then(deliver, () => deliver([]));
      } else deliver(error ? [] : addresses);
    });
  };
}

interface PublicHttpOptions { headers?: OutgoingHttpHeaders; publicDnsFallback?: boolean }

function requestPublicHttp(url: URL, signal: AbortSignal, options: PublicHttpOptions): Promise<IncomingMessage> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('工具素材地址需要不含用户名和密码的 HTTP(S) URL。');
  const local = new BlockList();
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const { address, family } of interfaces ?? []) local.addAddress(address, family === 'IPv6' ? 'ipv6' : 'ipv4');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  if (family && !publicAddress(host, family, local)) throw denied();
  const get = url.protocol === 'https:' ? httpsGet : httpGet;
  return new Promise((resolve, reject) => {
    get(url, { agent: false, lookup: publicLookup(local, options.publicDnsFallback ? signal : undefined), signal, headers: { ...options.headers, 'Accept-Encoding': 'identity' } }, response => {
      response.once('error', reject);
      resolve(response);
    }).once('error', reject);
  });
}

export async function openPublicHttp(raw: string, signal: AbortSignal, options: PublicHttpOptions = {}) {
  let url = new URL(raw);
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await requestPublicHttp(url, signal, options);
    const status = response.statusCode ?? 0;
    if (status >= 200 && status < 300) return { response, url: url.href };
    response.destroy();
    if (![301, 302, 303, 307, 308].includes(status)) throw new Error('工具素材下载返回 HTTP ' + status + '。');
    const location = response.headers.location;
    if (!location || redirects >= 5) throw new Error('工具素材下载重定向无效或次数过多。');
    url = new URL(location, url);
  }
}

export async function downloadPublicToolMedia(raw: string, signal: AbortSignal): Promise<IncomingMessage> {
  return (await openPublicHttp(raw, signal)).response;
}
