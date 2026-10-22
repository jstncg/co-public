import { describe, expect, it } from "vitest";
import { iMessageBootstrapURL, kyoConnectURL, worldFromFragment } from "./kyo-connect";

describe("Kyo relationship handoff", () => {
  const world = "https://rail.example/w/0123456789abcdefabcd";

  it("keeps the relationship credential in the fragment", () => {
    const bootstrap = iMessageBootstrapURL("https://app.example", world);
    const parsed = new URL(bootstrap);
    expect(parsed.pathname).toBe("/connect");
    expect(parsed.search).toBe("");
    expect(worldFromFragment(parsed.hash)).toBe(world);
  });

  it("builds the registered app URL without losing the nested URL", () => {
    const appURL = new URL(kyoConnectURL(world));
    expect(appURL.protocol).toBe("kyo:");
    expect(appURL.hostname).toBe("connect");
    expect(appURL.searchParams.get("world")).toBe(world);
  });

  it("rejects anything broader than one HTTPS world credential", () => {
    expect(worldFromFragment("#http%3A%2F%2Frail.example%2Fw%2F0123456789abcdefabcd")).toBeNull();
    expect(worldFromFragment("#https%3A%2F%2Frail.example%2Fw%2Fshort")).toBeNull();
    expect(worldFromFragment("#https%3A%2F%2Frail.example%2Fw%2F0123456789abcdefabcd%3Fx%3D1")).toBeNull();
  });
});
