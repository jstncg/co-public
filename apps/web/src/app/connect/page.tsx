"use client";

import { useEffect, useState } from "react";
import { kyoConnectURL, worldFromFragment } from "../../lib/kyo-connect";

/**
 * HTTPS is tappable in iMessage; custom schemes are not reliably linkified. This tiny bridge
 * keeps the credential in the fragment (never in server logs), then hands it to the TestFlight
 * app. It is connection plumbing, not onboarding.
 */
export default function ConnectKyo() {
  const [destination, setDestination] = useState<string>();
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    const world = worldFromFragment(window.location.hash);
    if (!world) {
      setInvalid(true);
      return;
    }
    const appURL = kyoConnectURL(world);
    setDestination(appURL);
    window.location.assign(appURL);
  }, []);

  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
    <section style={{ maxWidth: 420, textAlign: "center" }}>
      <p className="wordmark">co</p>
      {invalid ? <>
        <h1>This link isn&apos;t valid.</h1>
        <p>Go back to the message from co and use the newest link.</p>
      </> : <>
        <h1>Opening Kyo…</h1>
        <p>If nothing happens, make sure the TestFlight app is installed.</p>
        {destination ? <a href={destination}>Open Kyo</a> : null}
      </>}
    </section>
  </main>;
}
