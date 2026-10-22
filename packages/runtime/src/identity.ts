/**
 * Canonicalize phone-shaped connector handles without pretending to perform
 * full international number validation. Unknown/non-phone handles are kept
 * verbatim so a connector identity is never guessed into another person.
 */
export function canonicalPhoneIdentity(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  const withoutScheme = raw.replace(/^tel:/i, "");
  if (!/^[+\d().\s-]+$/.test(withoutScheme)) return raw;
  const digits = withoutScheme.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return raw;
  if (withoutScheme.trim().startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits;
}

/**
 * Provider payloads are an authority boundary, not a human-entry surface.  A
 * connector must therefore supply the counterparty in explicit E.164 form;
 * we do not guess a country code from a provider-controlled string.
 */
export function canonicalProviderPhoneIdentity(value: string): string {
  const raw = value.trim();
  return /^\+[1-9]\d{6,14}$/.test(raw) ? raw : "";
}

/**
 * Member identities carry authority, so ambiguous local/international numbers
 * are rejected. North-American 10/11 digit inputs are normalized; every other
 * member identity must already include an explicit country code.
 */
export function canonicalMemberPeerId(value: string): string {
  const canonical = canonicalPhoneIdentity(value);
  if (!/^\+[1-9]\d{6,14}$/.test(canonical)) {
    throw new Error(`Member peer must be an explicit phone number with country code: ${value}`);
  }
  return canonical;
}
