import type { Config } from "@canvas-drop/shared";

/**
 * Where the capture browser's proxy points. `.invalid` never resolves (RFC 6761), and
 * the resolver rules below also refuse it, so every proxied request fails.
 */
export const EGRESS_BLACKHOLE_HOST = "egress-blocked.invalid";

/**
 * Chromium launch flags that confine the screenshot browser to this instance (audit
 * run-1, #8). `captureCanvas`'s `page.route` gate only sees that one page's requests;
 * a canvas's WebSocket, service-worker fetch or popup could get past it. Here the
 * network stack itself is fenced:
 *  - every request goes to a proxy that cannot be reached, except the instance's own
 *    address (`--proxy-bypass-list`); `<-loopback>` drops Chromium's implicit loopback
 *    bypass, so other local ports are fenced too;
 *  - in subdomain mode `*.{baseHost}` resolves to the loopback server, so a capture
 *    loads the canvas's real URL with the right Host without leaving the box;
 *  - WebRTC may not send UDP outside the proxy, which would otherwise get around it.
 */
export function captureLaunchArgs(config: Pick<Config, "urlMode" | "baseUrl" | "port">): string[] {
  const loopback = `127.0.0.1:${config.port}`;
  const resolverRules = [`MAP ${EGRESS_BLACKHOLE_HOST} ~NOTFOUND`];
  const direct = [loopback];
  if (config.urlMode === "subdomain") {
    const baseHost = new URL(config.baseUrl).hostname;
    resolverRules.unshift(`MAP *.${baseHost} ${loopback}`);
    direct.push(`*.${baseHost}`);
  }
  return [
    `--host-resolver-rules=${resolverRules.join(", ")}`,
    `--proxy-server=http://${EGRESS_BLACKHOLE_HOST}:9`,
    `--proxy-bypass-list=<-loopback>;${direct.join(";")}`,
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ];
}
