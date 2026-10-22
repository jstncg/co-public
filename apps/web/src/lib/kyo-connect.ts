const relationshipPath = /^\/w\/[0-9a-f]{20}$/;

/** The world credential stays in the URL fragment, which browsers do not send to this server. */
export function worldFromFragment(fragment: string): string | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  try {
    const world = new URL(decoded);
    if (world.protocol !== "https:") return null;
    if (world.username || world.password || world.search || world.hash) return null;
    if (!relationshipPath.test(world.pathname)) return null;
    return world.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function kyoConnectURL(world: string): string {
  const query = new URLSearchParams({ world });
  return `kyo://connect?${query.toString()}`;
}

export function iMessageBootstrapURL(origin: string, world: string): string {
  const base = new URL("/connect", origin);
  base.hash = encodeURIComponent(world);
  return base.toString();
}
