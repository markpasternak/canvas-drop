# Outbound Connections

Use `canvasdrop.connections.fetch` when a canvas needs data from a third-party
HTTP API that cannot be called directly from the browser—for example, an API
that does not allow browser CORS or requires a fixed `User-Agent` or API key.

Connections is a controlled request forwarder, not a Lambda runtime. Canvas
Drop never runs canvas-supplied server code. An instance administrator creates
a reusable profile for one exact HTTPS origin, chooses the allowed standard
methods, stores any protected headers, and grants the profile to individual
canvases. The protected values remain encrypted on the server.

## Fetch through a profile

Suppose an administrator created the profile key `stocks`, approved
`https://api.example.com`, allowed `GET`, fixed its `User-Agent`, and granted it
to your canvas:

```js
const symbol = "ACME";
const response = await canvasdrop.connections.fetch(
  "stocks",
  `/v2/quote?symbol=${encodeURIComponent(symbol)}`,
  { headers: { accept: "application/json" } },
);

if (!response.ok) {
  // This is the upstream's status and bounded response body, not a platform error.
  throw new Error(`Stock provider returned ${response.status}`);
}
const quote = await response.json();
```

The signature is:

```ts
connections.fetch(
  profile: string,
  path: string,
  init?: {
    method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
    headers?: RequestInit["headers"];
    body?: RequestInit["body"];
    signal?: RequestInit["signal"];
  },
): Promise<Response>
```

`path` must start with one `/`. Absolute URLs and protocol-relative paths are
rejected in the SDK before a request is sent. The path and query are appended to
the profile's exact origin. Canvas code cannot change its scheme, hostname, or
port.

Only a method the administrator selected for that profile is accepted. Request
bodies work for `POST`, `PUT`, `PATCH`, and `DELETE`; `GET` and `HEAD` do not send
one. `headers` accepts the normal browser `HeadersInit` shapes. Canvas cookies,
authorization, forwarding, hop-by-hop, compression, and host headers are never
passed through. A protected profile header wins over a caller header with the
same name.

## Responses and errors

The promise resolves to a native `Response` for every response the approved
upstream returned, including `4xx` and `5xx`. Check `response.ok` or
`response.status` just as you would with `fetch`.

Canvas Drop policy and transport failures throw `CanvasdropError` instead. The
stable codes include:

| Code | Status | Meaning |
| --- | --- | --- |
| `CONNECTION_NOT_GRANTED` | 404 | The profile is not attached to this canvas. |
| `CONNECTION_DISABLED` | 503 | An administrator disabled the profile. |
| `CONNECTION_KEY_UNAVAILABLE` | 503 | The external encryption key needed for protected headers is unavailable. |
| `METHOD_NOT_ALLOWED` | 405 | The method is unsupported or not approved for this profile. |
| `DESTINATION_BLOCKED` | 403 | Origin, DNS answer, redirect, or content encoding crossed the connection boundary. |
| `REQUEST_TOO_LARGE` | 413 | URL, headers, or body exceeded a request limit. |
| `RESPONSE_TOO_LARGE` | 502 | The upstream response exceeded the buffer limit. |
| `CONNECTION_RATE_LIMIT` | 429 | A connection-specific request bucket is spent. |
| `CONNECTION_LIMIT` | 429 | A per-canvas or process-wide in-flight limit is full. |
| `UPSTREAM_TIMEOUT` | 504 | The total DNS, request, redirect, and response deadline expired. |
| `UPSTREAM_UNAVAILABLE` | 502 | DNS or the approved upstream failed. |

The normal canvas gates still run first: identity, canvas access, password,
lifecycle, Public-link static-only, the broad runtime rate limit, and the
Backend master switch. Detaching a grant, disabling its profile or Backend,
revoking access, adding a password, expiring/archiving/disabling/deleting the
canvas blocks the next request.

## Fixed safety bounds

The first release is deliberately small and buffered:

| Boundary | Default |
| --- | --- |
| Relative URL | 8 KiB |
| Caller headers | 32 headers, 16 KiB total |
| Request body | 256 KiB |
| Response body | 2 MiB |
| Total deadline | 10 seconds |
| Redirects | 3, exact-origin only; DNS is revalidated at every hop |
| Rate | 60/min per actor + canvas + profile; 600/min per profile |
| In flight | 5 per canvas; 50 in the server process |

The operator can set these read-only deployment values through the
`CANVAS_DROP_CONNECTIONS_*` environment variables. Multi-process coordination
is not part of this first release.

## Security boundary

Canvas Drop accepts only HTTPS DNS origins—no IP literals, credentials, path,
query, or fragment in the profile. Every DNS answer must be public. Mixed
public/private answers are rejected, and the chosen public address is pinned to
the TLS socket while the approved hostname remains the certificate, SNI, and
`Host` name. Redirects must retain the exact origin and are re-resolved before
the next socket is opened. Responses are identity-encoded, bounded, `no-store`,
and expose only safe headers; cookies, redirects, CORS, server, and hop-by-hop
headers are removed.

Protected header names are visible only to administrators as “configured”; the
values are never returned by an API or loaded into the dashboard. Owners,
editors, and `list_canvas_connections` over MCP see only the profile key, label,
origin, allowed methods, and availability.

One residual trust boundary remains: the approved upstream receives the
protected value and can deliberately reflect it in its own response body. Use a
least-privilege credential scoped to that upstream and profile. Operators should
also restrict the Canvas Drop server's network egress as defense in depth.

Public-link visitors can never use Connections. If an audience needs this
backend, use Restricted or Whole org access and grant people or teams as needed.

