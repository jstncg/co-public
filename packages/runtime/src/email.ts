import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { id, stableId } from "./id.ts";
import type { SqliteStore } from "./store.ts";
import type { EmailConfig, EmailProviderName, JsonObject } from "./types.ts";

type Row = Record<string, unknown>;

export type EmailChallengeStatus = "pending" | "sent" | "delivery_uncertain" | "delivery_failed" | "verified" | "expired" | "locked" | "cancelled";
export type VerifiedEmailStatus = "active" | "revoked";

export interface EmailDeliveryInput {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export interface EmailDeliveryResult {
  provider: EmailProviderName;
  messageId: string;
}

export interface EmailDeliveryAdapter {
  readonly provider: EmailProviderName;
  configured(): boolean;
  send(input: EmailDeliveryInput): Promise<EmailDeliveryResult>;
}

export class EmailProviderError extends Error {
  readonly uncertain: boolean;

  constructor(message: string, uncertain: boolean) {
    super(message);
    this.name = "EmailProviderError";
    this.uncertain = uncertain;
  }
}

export class EmailVerificationError extends Error {
  readonly httpStatus: number;
  readonly challengeId?: string;
  readonly uncertain: boolean;

  constructor(httpStatus: number, message: string, challengeId?: string, uncertain = false) {
    super(message);
    this.name = "EmailVerificationError";
    this.httpStatus = httpStatus;
    this.uncertain = uncertain;
    if (challengeId) this.challengeId = challengeId;
  }
}

export interface EmailChallengeRecord {
  id: string;
  tenantId: string;
  requestKey: string;
  email: string;
  emailHash: string;
  purpose: string;
  codeDigest: string;
  status: EmailChallengeStatus;
  attempts: number;
  maxAttempts: number;
  expiresAt: string;
  resendAfter: string;
  provider: EmailProviderName;
  providerMessageId?: string;
  deliveryError?: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
}

export interface VerifiedEmailIdentity {
  id: string;
  tenantId: string;
  email: string;
  emailHash: string;
  status: VerifiedEmailStatus;
  sourceChallengeId: string;
  verifiedAt: string;
  updatedAt: string;
  revokedAt?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optional(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function bounded(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new EmailVerificationError(400, `${field} must be a non-empty string`);
  if (normalized.length > maximum) throw new EmailVerificationError(400, `${field} exceeds ${maximum} characters`);
  return normalized;
}

export function normalizeEmail(value: string): string {
  const email = value.trim().normalize("NFKC").toLowerCase();
  if (email.length > 254 || email.includes("\r") || email.includes("\n")) throw new EmailVerificationError(400, "Email address is invalid");
  const at = email.lastIndexOf("@");
  if (at < 1 || at > 64 || at !== email.indexOf("@")) throw new EmailVerificationError(400, "Email address is invalid");
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    throw new EmailVerificationError(400, "Email address is invalid");
  }
  return email;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function emailHash(email: string): string {
  return createHash("sha256").update(email).digest("hex");
}

function codeDigest(secret: string, challengeId: string, email: string, code: string): string {
  return createHmac("sha256", secret).update(`${challengeId}\n${email}\n${code}`).digest("hex");
}

function secureMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function generatedCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export class ResendEmailAdapter implements EmailDeliveryAdapter {
  readonly provider = "resend" as const;
  private readonly config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  configured(): boolean {
    return this.config.provider === "resend" && Boolean(this.config.apiKey && this.config.from);
  }

  async send(input: EmailDeliveryInput): Promise<EmailDeliveryResult> {
    if (!this.config.apiKey || !this.config.from || this.config.provider !== "resend") throw new EmailProviderError("Resend email delivery is not configured", false);
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/emails`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey.slice(0, 256),
        },
        body: JSON.stringify({ from: this.config.from, to: [input.to], subject: input.subject, text: input.text }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new EmailProviderError(`Resend request outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      const ambiguousStatus = response.ok || response.status === 409 || response.status === 429 || response.status >= 500;
      throw new EmailProviderError(
        `Resend response body failed after HTTP ${response.status}: ${error instanceof Error ? error.message : String(error)}`,
        ambiguousStatus,
      );
    }
    const parsed = (() => {
      try { return object(raw ? JSON.parse(raw) : {}); } catch { return {}; }
    })();
    if (!response.ok) {
      const detail = typeof parsed.message === "string" ? parsed.message : `HTTP ${response.status}`;
      throw new EmailProviderError(`Resend send failed: ${detail.slice(0, 300)}`, response.status === 409 || response.status === 429 || response.status >= 500);
    }
    if (typeof parsed.id !== "string" || !parsed.id) throw new EmailProviderError("Resend returned no message ID", true);
    return { provider: "resend", messageId: parsed.id };
  }
}

export class DisabledEmailAdapter implements EmailDeliveryAdapter {
  readonly provider = "none" as const;
  configured(): boolean { return false; }
  async send(): Promise<EmailDeliveryResult> { throw new EmailProviderError("Email delivery is not configured", false); }
}

export function createEmailAdapter(config: EmailConfig): EmailDeliveryAdapter {
  return config.provider === "resend" ? new ResendEmailAdapter(config) : new DisabledEmailAdapter();
}

export class EmailVerificationManager {
  private readonly store: SqliteStore;
  private readonly config: EmailConfig;
  private readonly delivery: EmailDeliveryAdapter;
  private readonly currentTime: () => Date;
  private readonly createCode: () => string;

  constructor(store: SqliteStore, config: EmailConfig, delivery: EmailDeliveryAdapter = createEmailAdapter(config), options: { now?: () => Date; generateCode?: () => string } = {}) {
    this.store = store;
    this.config = config;
    this.delivery = delivery;
    this.currentTime = options.now ?? (() => new Date());
    this.createCode = options.generateCode ?? generatedCode;
  }

  get status(): JsonObject {
    return { provider: this.delivery.provider, configured: this.delivery.configured(), verificationConfigured: Boolean(this.delivery.configured() && this.config.otpSecret) };
  }

  async request(input: { tenantId: string; email: string; purpose?: string; idempotencyKey: string }): Promise<EmailChallengeRecord> {
    if (!this.delivery.configured()) throw new EmailVerificationError(503, "Email delivery is not configured");
    if (!this.config.otpSecret) throw new EmailVerificationError(503, "Email verification secret is not configured");
    const email = normalizeEmail(input.email);
    const hash = emailHash(email);
    const purpose = bounded(input.purpose ?? "contact", "purpose", 128);
    const requestKey = bounded(input.idempotencyKey, "idempotencyKey", 256);
    const existing = this.byRequestKey(input.tenantId, requestKey);
    if (existing) {
      if (existing.emailHash !== hash || existing.purpose !== purpose) throw new EmailVerificationError(409, "Email verification idempotency key was reused with different content");
      if (existing.status === "pending") {
        const pendingAgeMs = this.currentTime().getTime() - Date.parse(existing.updatedAt);
        if (pendingAgeMs < 35_000) {
          throw new EmailVerificationError(409, "Email delivery is still in progress", existing.id);
        }
        const uncertain = this.setDelivery(existing, "delivery_uncertain", undefined, "Process ended before delivery was confirmed");
        throw new EmailVerificationError(503, "Email delivery outcome is uncertain; wait before requesting another code", uncertain.id);
      }
      return existing;
    }

    const current = this.currentTime();
    const latest = this.store.db.prepare("SELECT * FROM email_verification_challenges WHERE tenant_id=? AND email_hash=? ORDER BY created_at DESC LIMIT 1")
      .get(input.tenantId, hash) as Row | undefined;
    if (latest && Date.parse(String(latest.resend_after)) > current.getTime()) {
      const seconds = Math.max(1, Math.ceil((Date.parse(String(latest.resend_after)) - current.getTime()) / 1_000));
      throw new EmailVerificationError(429, `Wait ${seconds} seconds before requesting another code`);
    }
    this.enforceRequestRate(input.tenantId, hash, current);

    const challengeId = id("evc");
    const code = this.createCode();
    if (!/^\d{6}$/.test(code)) throw new Error("Email verification code generator returned an invalid code");
    const createdAt = current.toISOString();
    const expiresAt = new Date(current.getTime() + this.config.verificationTtlMinutes * 60_000).toISOString();
    const resendAfter = new Date(current.getTime() + this.config.resendCooldownSeconds * 1_000).toISOString();
    const digest = codeDigest(this.config.otpSecret, challengeId, email, code);
    this.store.transaction(() => {
      this.store.db.prepare(`UPDATE email_verification_challenges SET status='cancelled',updated_at=?
        WHERE tenant_id=? AND email_hash=? AND status IN ('pending','sent','delivery_uncertain')`).run(createdAt, input.tenantId, hash);
      this.store.db.prepare(`INSERT INTO email_verification_challenges(
        id,tenant_id,request_key,email,email_hash,purpose,code_digest,status,attempts,max_attempts,expires_at,resend_after,provider,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        challengeId, input.tenantId, requestKey, email, hash, purpose, digest, "pending", 0, this.config.maxVerificationAttempts,
        expiresAt, resendAfter, this.delivery.provider, createdAt, createdAt,
      );
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `email-verification:${challengeId}`, type: "email.verification.delivery_started", correlationId: challengeId,
        payload: { challengeId, emailHash: hash, maskedEmail: maskEmail(email), purpose, provider: this.delivery.provider, expiresAt },
      });
    });

    try {
      const sent = await this.delivery.send({
        to: email,
        subject: "Your Co verification code",
        text: `Your Co verification code is ${code}. It expires in ${this.config.verificationTtlMinutes} minutes. If you did not request this code, you can ignore this email.`,
        idempotencyKey: `email-verification/${challengeId}`,
      });
      return this.setDelivery(this.requireChallenge(input.tenantId, challengeId), "sent", sent.messageId);
    } catch (error) {
      const providerError = error instanceof EmailProviderError ? error : new EmailProviderError(error instanceof Error ? error.message : String(error), true);
      const status = providerError.uncertain ? "delivery_uncertain" : "delivery_failed";
      const challenge = this.setDelivery(this.requireChallenge(input.tenantId, challengeId), status, undefined, providerError.message);
      throw new EmailVerificationError(providerError.uncertain ? 503 : 502, providerError.uncertain
        ? "Email delivery outcome is uncertain; the code may still arrive"
        : "Email delivery failed", challenge.id, providerError.uncertain);
    }
  }

  verify(tenantId: string, challengeId: string, code: string): VerifiedEmailIdentity {
    if (!this.config.otpSecret) throw new EmailVerificationError(503, "Email verification secret is not configured");
    const challenge = this.requireChallenge(tenantId, challengeId);
    const existingIdentity = this.identityByEmailHash(tenantId, challenge.emailHash);
    if (challenge.status === "verified" && existingIdentity) return existingIdentity;
    if (challenge.status === "locked") throw new EmailVerificationError(423, "Verification challenge is locked");
    if (challenge.status === "cancelled") throw new EmailVerificationError(409, "Verification challenge was replaced by a newer request");
    if (challenge.status === "delivery_failed") throw new EmailVerificationError(409, "Verification email was not delivered");
    if (challenge.status !== "sent" && challenge.status !== "delivery_uncertain") throw new EmailVerificationError(409, `Verification challenge is ${challenge.status}`);
    const current = this.currentTime();
    if (Date.parse(challenge.expiresAt) <= current.getTime()) {
      this.transitionChallenge(challenge, "expired", current.toISOString(), "email.verification.expired");
      throw new EmailVerificationError(410, "Verification code has expired");
    }
    if (!/^\d{6}$/.test(code)) throw new EmailVerificationError(400, "Verification code must contain exactly six digits");
    const matches = secureMatch(challenge.codeDigest, codeDigest(this.config.otpSecret, challenge.id, challenge.email, code));
    if (!matches) {
      const attempts = challenge.attempts + 1;
      const locked = attempts >= challenge.maxAttempts;
      const updatedAt = current.toISOString();
      this.store.transaction(() => {
        this.store.db.prepare("UPDATE email_verification_challenges SET attempts=?,status=?,updated_at=? WHERE tenant_id=? AND id=?")
          .run(attempts, locked ? "locked" : challenge.status, updatedAt, tenantId, challenge.id);
        this.store.appendEvent({
          tenantId, stream: `email-verification:${challenge.id}`, type: locked ? "email.verification.locked" : "email.verification.rejected", correlationId: challenge.id,
          payload: { challengeId: challenge.id, attempts, attemptsRemaining: Math.max(0, challenge.maxAttempts - attempts) },
        });
      });
      throw new EmailVerificationError(locked ? 423 : 401, locked ? "Verification challenge is locked" : "Verification code is incorrect");
    }

    const verifiedAt = current.toISOString();
    const identityId = existingIdentity?.id ?? stableId("email", `${tenantId}:${challenge.emailHash}`);
    this.store.transaction(() => {
      const changed = this.store.db.prepare(`UPDATE email_verification_challenges SET status='verified',verified_at=?,updated_at=?
        WHERE tenant_id=? AND id=? AND status IN ('sent','delivery_uncertain')`).run(verifiedAt, verifiedAt, tenantId, challenge.id);
      if (changed.changes !== 1) throw new EmailVerificationError(409, "Verification challenge changed while it was being verified");
      this.store.db.prepare(`INSERT INTO verified_email_identities(id,tenant_id,email,email_hash,status,source_challenge_id,verified_at,updated_at,revoked_at)
        VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(tenant_id,email_hash) DO UPDATE SET
        email=excluded.email,status='active',source_challenge_id=excluded.source_challenge_id,verified_at=excluded.verified_at,updated_at=excluded.updated_at,revoked_at=NULL`).run(
        identityId, tenantId, challenge.email, challenge.emailHash, "active", challenge.id, verifiedAt, verifiedAt,
      );
      this.store.appendEvent({
        tenantId, stream: `email-identity:${identityId}`, type: "email.identity.verified", correlationId: challenge.id,
        payload: { identityId, challengeId: challenge.id, emailHash: challenge.emailHash, maskedEmail: maskEmail(challenge.email), purpose: challenge.purpose },
      });
    });
    return this.requireIdentity(tenantId, identityId);
  }

  async sendToIdentity(input: { tenantId: string; identityId: string; subject: string; content: string; idempotencyKey: string; sourceEventId?: string }): Promise<JsonObject> {
    if (!this.delivery.configured()) throw new EmailVerificationError(503, "Email delivery is not configured");
    const identity = this.requireIdentity(input.tenantId, input.identityId);
    if (identity.status !== "active") throw new EmailVerificationError(409, "Verified email identity is revoked");
    const subject = bounded(input.subject, "subject", 998);
    if (/[\r\n]/.test(subject)) throw new EmailVerificationError(400, "subject may not contain newlines");
    const content = bounded(input.content, "content", 100_000);
    const idempotencyKey = bounded(input.idempotencyKey, "idempotencyKey", 256);
    const intentId = stableId("evt", `email-delivery:${input.tenantId}:${idempotencyKey}`);
    const subjectHash = createHash("sha256").update(subject).digest("hex");
    const contentHash = createHash("sha256").update(content).digest("hex");
    const priorIntent = this.store.getEvent(input.tenantId, intentId);
    if (priorIntent) {
      const prior = object(priorIntent.payload);
      if (prior.identityId !== identity.id || prior.subjectHash !== subjectHash || prior.contentHash !== contentHash) {
        throw new EmailVerificationError(409, "Email delivery idempotency key was reused with different content");
      }
      const accepted = this.store.listEvents(input.tenantId, { correlationId: intentId, limit: 20 }).find((event) => event.type === "email.accepted");
      if (accepted) return object(accepted.payload) as JsonObject;
      const failed = this.store.listEvents(input.tenantId, { correlationId: intentId, limit: 20 }).find((event) => event.type === "email.delivery_failed");
      if (failed) throw new EmailProviderError("Prior email delivery was definitively rejected; it was not repeated automatically", false);
      throw new EmailVerificationError(503, "Prior email delivery outcome is uncertain; it was not retried automatically");
    }
    this.store.appendEvent({
      id: intentId, tenantId: input.tenantId, stream: `email-identity:${identity.id}`, type: "email.delivery_started", correlationId: intentId,
      ...(input.sourceEventId ? { causationId: input.sourceEventId } : {}),
      payload: { identityId: identity.id, emailHash: identity.emailHash, maskedEmail: maskEmail(identity.email), subjectHash, contentHash, provider: this.delivery.provider },
    });
    try {
      const sent = await this.delivery.send({ to: identity.email, subject, text: content, idempotencyKey: `verified-email/${intentId}` });
      const event = this.store.appendEvent({
        tenantId: input.tenantId, stream: `email-identity:${identity.id}`, type: "email.accepted", correlationId: intentId, causationId: intentId,
        payload: { identityId: identity.id, maskedEmail: maskEmail(identity.email), provider: sent.provider, providerMessageId: sent.messageId },
      });
      return event.payload;
    } catch (error) {
      const providerError = error instanceof EmailProviderError
        ? error
        : new EmailProviderError(error instanceof Error ? error.message : String(error), true);
      this.store.appendEvent({
        tenantId: input.tenantId, stream: `email-identity:${identity.id}`,
        type: providerError.uncertain ? "email.delivery_uncertain" : "email.delivery_failed",
        correlationId: intentId, causationId: intentId,
        payload: {
          identityId: identity.id, maskedEmail: maskEmail(identity.email), provider: this.delivery.provider,
          outcome: providerError.uncertain ? "uncertain" : "failed", action: "not retried automatically",
        },
      });
      throw providerError;
    }
  }

  getChallenge(tenantId: string, challengeId: string): EmailChallengeRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM email_verification_challenges WHERE tenant_id=? AND id=?").get(tenantId, challengeId) as Row | undefined;
    return row ? this.challengeFromRow(row) : undefined;
  }

  listIdentities(tenantId: string, status: VerifiedEmailStatus = "active"): VerifiedEmailIdentity[] {
    return (this.store.db.prepare("SELECT * FROM verified_email_identities WHERE tenant_id=? AND status=? ORDER BY updated_at DESC").all(tenantId, status) as Row[])
      .map((row) => this.identityFromRow(row));
  }

  getIdentity(tenantId: string, identityId: string): VerifiedEmailIdentity | undefined {
    const row = this.store.db.prepare("SELECT * FROM verified_email_identities WHERE tenant_id=? AND id=?").get(tenantId, identityId) as Row | undefined;
    return row ? this.identityFromRow(row) : undefined;
  }

  revokeIdentity(tenantId: string, identityId: string): VerifiedEmailIdentity {
    const identity = this.requireIdentity(tenantId, identityId);
    if (identity.status === "revoked") return identity;
    const current = this.currentTime().toISOString();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE verified_email_identities SET status='revoked',revoked_at=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(current, current, tenantId, identityId);
      this.store.appendEvent({ tenantId, stream: `email-identity:${identityId}`, type: "email.identity.revoked", payload: { identityId, emailHash: identity.emailHash, maskedEmail: maskEmail(identity.email) } });
    });
    return this.requireIdentity(tenantId, identityId);
  }

  challengeJson(challenge: EmailChallengeRecord): JsonObject {
    return {
      challengeId: challenge.id, status: challenge.status, maskedEmail: maskEmail(challenge.email), purpose: challenge.purpose,
      attemptsRemaining: Math.max(0, challenge.maxAttempts - challenge.attempts), expiresAt: challenge.expiresAt, resendAfter: challenge.resendAfter,
      provider: challenge.provider,
    };
  }

  identityJson(identity: VerifiedEmailIdentity): JsonObject {
    return {
      identityId: identity.id, maskedEmail: maskEmail(identity.email), status: identity.status,
      verifiedAt: identity.verifiedAt, updatedAt: identity.updatedAt, sourceChallengeId: identity.sourceChallengeId,
    };
  }

  private enforceRequestRate(tenantId: string, hash: string, current: Date): void {
    const count = (since: Date): number => Number((this.store.db.prepare(`SELECT COUNT(*) AS count FROM email_verification_challenges
      WHERE tenant_id=? AND email_hash=? AND created_at>=?`).get(tenantId, hash, since.toISOString()) as { count: number }).count);
    if (count(new Date(current.getTime() - 60 * 60_000)) >= this.config.maxRequestsPerHour) throw new EmailVerificationError(429, "Hourly email verification limit reached");
    if (count(new Date(current.getTime() - 24 * 60 * 60_000)) >= this.config.maxRequestsPerDay) throw new EmailVerificationError(429, "Daily email verification limit reached");
  }

  private setDelivery(challenge: EmailChallengeRecord, status: "sent" | "delivery_uncertain" | "delivery_failed", providerMessageId?: string, deliveryError?: string): EmailChallengeRecord {
    const updatedAt = this.currentTime().toISOString();
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE email_verification_challenges SET status=?,provider_message_id=?,delivery_error=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(status, providerMessageId ?? null, deliveryError?.slice(0, 500) ?? null, updatedAt, challenge.tenantId, challenge.id);
      this.store.appendEvent({
        tenantId: challenge.tenantId, stream: `email-verification:${challenge.id}`, type: `email.verification.${status}`, correlationId: challenge.id,
        payload: { challengeId: challenge.id, status, provider: challenge.provider, providerMessageId: providerMessageId ?? null },
      });
    });
    return this.requireChallenge(challenge.tenantId, challenge.id);
  }

  private transitionChallenge(challenge: EmailChallengeRecord, status: EmailChallengeStatus, updatedAt: string, eventType: string): void {
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE email_verification_challenges SET status=?,updated_at=? WHERE tenant_id=? AND id=?")
        .run(status, updatedAt, challenge.tenantId, challenge.id);
      this.store.appendEvent({ tenantId: challenge.tenantId, stream: `email-verification:${challenge.id}`, type: eventType, correlationId: challenge.id, payload: { challengeId: challenge.id } });
    });
  }

  private byRequestKey(tenantId: string, requestKey: string): EmailChallengeRecord | undefined {
    const row = this.store.db.prepare("SELECT * FROM email_verification_challenges WHERE tenant_id=? AND request_key=?").get(tenantId, requestKey) as Row | undefined;
    return row ? this.challengeFromRow(row) : undefined;
  }

  private identityByEmailHash(tenantId: string, hash: string): VerifiedEmailIdentity | undefined {
    const row = this.store.db.prepare("SELECT * FROM verified_email_identities WHERE tenant_id=? AND email_hash=?").get(tenantId, hash) as Row | undefined;
    return row ? this.identityFromRow(row) : undefined;
  }

  private requireChallenge(tenantId: string, challengeId: string): EmailChallengeRecord {
    const challenge = this.getChallenge(tenantId, challengeId);
    if (!challenge) throw new EmailVerificationError(404, "Email verification challenge not found");
    return challenge;
  }

  private requireIdentity(tenantId: string, identityId: string): VerifiedEmailIdentity {
    const identity = this.getIdentity(tenantId, identityId);
    if (!identity) throw new EmailVerificationError(404, "Verified email identity not found");
    return identity;
  }

  private challengeFromRow(row: Row): EmailChallengeRecord {
    const providerMessageId = optional(row.provider_message_id); const deliveryError = optional(row.delivery_error); const verifiedAt = optional(row.verified_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), requestKey: String(row.request_key), email: String(row.email), emailHash: String(row.email_hash),
      purpose: String(row.purpose), codeDigest: String(row.code_digest), status: String(row.status) as EmailChallengeStatus,
      attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts), expiresAt: String(row.expires_at), resendAfter: String(row.resend_after),
      provider: String(row.provider) as EmailProviderName, ...(providerMessageId ? { providerMessageId } : {}), ...(deliveryError ? { deliveryError } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(verifiedAt ? { verifiedAt } : {}),
    };
  }

  private identityFromRow(row: Row): VerifiedEmailIdentity {
    const revokedAt = optional(row.revoked_at);
    return {
      id: String(row.id), tenantId: String(row.tenant_id), email: String(row.email), emailHash: String(row.email_hash),
      status: String(row.status) as VerifiedEmailStatus, sourceChallengeId: String(row.source_challenge_id),
      verifiedAt: String(row.verified_at), updatedAt: String(row.updated_at), ...(revokedAt ? { revokedAt } : {}),
    };
  }
}
