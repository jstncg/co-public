import { gmailAwarenessScopes } from "@co/contracts";

export function googleWorkspaceSubject(userId: string) {
  return { id: userId, issuer: "co", type: "user" as const };
}

export function gmailAwarenessTokenParams(userId: string) {
  return {
    scopes: [...gmailAwarenessScopes],
    subject: googleWorkspaceSubject(userId),
  };
}
