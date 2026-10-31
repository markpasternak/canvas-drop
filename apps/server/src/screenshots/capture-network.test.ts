import { describe, expect, it } from "vitest";
import { captureLaunchArgs, EGRESS_BLACKHOLE_HOST } from "./capture-network.js";

describe("captureLaunchArgs (audit #8)", () => {
  it("path mode: only the instance's loopback address skips the black-hole proxy", () => {
    const args = captureLaunchArgs({
      urlMode: "path",
      baseUrl: "https://canvases.example.com",
      port: 3000,
    });
    expect(args).toContain(`--proxy-server=http://${EGRESS_BLACKHOLE_HOST}:9`);
    expect(args).toContain("--proxy-bypass-list=<-loopback>;127.0.0.1:3000");
    expect(args).toContain(`--host-resolver-rules=MAP ${EGRESS_BLACKHOLE_HOST} ~NOTFOUND`);
    expect(args).toContain("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  });

  it("subdomain mode: canvas hosts resolve to loopback and go direct; nothing else does", () => {
    const args = captureLaunchArgs({
      urlMode: "subdomain",
      baseUrl: "https://canvases.example.com",
      port: 3000,
    });
    expect(args).toContain(
      `--host-resolver-rules=MAP *.canvases.example.com 127.0.0.1:3000, MAP ${EGRESS_BLACKHOLE_HOST} ~NOTFOUND`,
    );
    expect(args).toContain("--proxy-bypass-list=<-loopback>;127.0.0.1:3000;*.canvases.example.com");
  });
});
