import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

const BLOCKED_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data.ec2.internal',
  '169.254.169.254',
  '100.100.100.200',
  '192.0.0.192',
  'fd00:ec2::254',
]);

function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(normalized) === 4) {
    const octets = normalized.split('.').map(Number);
    return octets[0] === 0
      || (octets[0] === 169 && octets[1] === 254)
      || normalized === '100.100.100.200'
      || normalized === '192.0.0.192';
  }
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === 'fd00:ec2::254') return true;
    if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isBlockedAddress(mapped[1]);
    const hexadecimalMapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexadecimalMapped) {
      const upper = Number.parseInt(hexadecimalMapped[1], 16);
      const lower = Number.parseInt(hexadecimalMapped[2], 16);
      return isBlockedAddress(`${upper >>> 8}.${upper & 0xff}.${lower >>> 8}.${lower & 0xff}`);
    }
  }
  return false;
}

export interface CustomEndpointAddress {
  address: string;
  family?: number;
}

export type CustomEndpointResolver = (hostname: string) => Promise<CustomEndpointAddress[]>;

interface ResolvedCustomEndpoint {
  url: string;
  hostname: string;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

/**
 * Validate a user-configured OpenAI-compatible endpoint without breaking the
 * core local-model use case. Loopback and RFC1918 hosts are intentionally
 * allowed; credential-bearing URLs, non-HTTP schemes, and cloud metadata/link
 * local destinations are not.
 */
export function normalizeCustomEndpointUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Endpoint URL must be an absolute HTTP or HTTPS URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Endpoint URL protocol must be http or https.');
  }
  if (url.username || url.password) {
    throw new Error('Endpoint URL must not contain embedded credentials.');
  }
  if (url.search || url.hash) {
    throw new Error('Endpoint URL must not contain a query string or fragment.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || BLOCKED_HOSTNAMES.has(hostname) || isBlockedAddress(hostname)) {
    throw new Error('Endpoint URL targets a blocked metadata or link-local address.');
  }
  // IPv6 link-local space fe80::/10. Private ULA and loopback remain allowed.
  if (/^fe[89ab][0-9a-f]:/i.test(hostname)) {
    throw new Error('Endpoint URL targets a blocked metadata or link-local address.');
  }
  url.hostname = hostname;
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

/**
 * Re-resolve custom hostnames immediately before each outbound request. This
 * blocks metadata aliases and DNS changes from bypassing the persisted URL
 * checks while retaining loopback/RFC1918/ULA endpoints for local models.
 */
export async function assertCustomEndpointDestinationSafe(
  value: string,
  resolver: CustomEndpointResolver = async hostname => (
    lookup(hostname, { all: true, verbatim: true })
  ),
): Promise<void> {
  await resolveCustomEndpoint(value, resolver);
}

async function resolveCustomEndpoint(
  value: string,
  resolver: CustomEndpointResolver = async hostname => (
    lookup(hostname, { all: true, verbatim: true })
  ),
): Promise<ResolvedCustomEndpoint> {
  const normalized = normalizeCustomEndpointUrl(value);
  const hostname = new URL(normalized).hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isBlockedAddress(hostname)) throw new Error('Endpoint URL resolves to a blocked metadata or link-local address.');
    return {
      url: normalized,
      hostname,
      addresses: [{ address: hostname, family: literalFamily as 4 | 6 }],
    };
  }
  let addresses: CustomEndpointAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new Error('Endpoint hostname could not be resolved safely.');
  }
  const normalizedAddresses = addresses.map(entry => ({
    address: entry.address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0],
    family: (entry.family || isIP(entry.address)) as 0 | 4 | 6,
  }));
  if (
    normalizedAddresses.length === 0
    || normalizedAddresses.some(entry => !entry.family || isBlockedAddress(entry.address))
  ) {
    throw new Error('Endpoint URL resolves to a blocked metadata or link-local address.');
  }
  return {
    url: normalized,
    hostname,
    addresses: normalizedAddresses as Array<{ address: string; family: 4 | 6 }>,
  };
}

function requestBody(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('Custom endpoint request body type is not supported.');
}

/**
 * Perform an HTTP(S) request whose TCP connection is pinned to the exact DNS
 * result set that passed the metadata/link-local checks. The URL hostname is
 * deliberately left unchanged so Host, TLS SNI, and certificate validation
 * retain their normal security semantics. Native http(s) does not follow
 * redirects, preventing a validated endpoint from redirecting into a blocked
 * network location.
 */
export async function fetchPinnedCustomEndpoint(
  value: string,
  init: RequestInit = {},
  resolver?: CustomEndpointResolver,
): Promise<Response> {
  const resolved = await resolveCustomEndpoint(value, resolver);
  const url = new URL(resolved.url);
  const expectedHostname = resolved.hostname.toLowerCase().replace(/\.$/, '');
  const pinnedLookup: LookupFunction = (requestedHostname, options, callback) => {
    const actualHostname = requestedHostname.toLowerCase().replace(/\.$/, '');
    if (actualHostname !== expectedHostname) {
      callback(Object.assign(new Error('Custom endpoint attempted an unexpected hostname lookup.'), { code: 'EHOSTUNREACH' }), '', 0);
      return;
    }
    if ((options as { all?: boolean }).all) {
      callback(null, resolved.addresses.map(address => ({ ...address })));
      return;
    }
    const selected = resolved.addresses[0];
    callback(null, selected.address, selected.family);
  };
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const body = requestBody(init.body);
  const makeRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(init.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }

    const request = makeRequest(url, {
      method: init.method ?? 'GET',
      headers,
      lookup: pinnedLookup,
      signal: init.signal ?? undefined,
    }, response => {
      try {
        const status = response.statusCode ?? 502;
        if (status < 200 || status > 599) {
          response.destroy();
          reject(new Error(`Custom endpoint returned an invalid HTTP status (${status}).`));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, rawValue] of Object.entries(response.headers)) {
          if (Array.isArray(rawValue)) {
            for (const entry of rawValue) responseHeaders.append(name, entry);
          } else if (rawValue !== undefined) {
            responseHeaders.set(name, String(rawValue));
          }
        }
        const hasNullBody = init.method?.toUpperCase() === 'HEAD'
          || status === 204 || status === 205 || status === 304;
        if (hasNullBody) response.resume();
        resolve(new Response(
          hasNullBody ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>,
          {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders,
          },
        ));
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}
