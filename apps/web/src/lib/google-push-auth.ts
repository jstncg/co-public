import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpStatusError } from "./http-status-error";

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export async function verifyGooglePushToken(input: {
  authorization: string | null;
  audience: string;
  serviceAccount: string;
}) {
  if (!input.authorization?.startsWith("Bearer ")) {
    throw new HttpStatusError(401, "Google push token is unavailable");
  }
  const token = input.authorization.slice("Bearer ".length);
  const { payload } = await jwtVerify(token, googleKeys, {
    audience: input.audience,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });
  if (
    payload.email !== input.serviceAccount ||
    payload.email_verified !== true ||
    payload.sub === undefined
  ) {
    throw new HttpStatusError(401, "Google push identity does not match");
  }
  return { subject: payload.sub };
}
