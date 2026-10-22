import { describe, expect, it, vi } from "vitest";
import type { GmailClient } from "@co/google-workspace";
import { HttpStatusError } from "./http-status-error";
import {
  activateGmailAwareness,
  beginGmailAuthorization,
  disconnectGmailAwareness,
  ingestGmailPush,
} from "./gmail-awareness-service";

const userId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const enabled = {
  FEATURE_AMBIENT_AWARENESS: "true",
  FEATURE_GMAIL_AWARENESS: "true",
  GOOGLE_CONNECTOR_UID: "google/co",
  GMAIL_PUBSUB_TOPIC: "projects/co-prod/topics/gmail-awareness",
  GMAIL_PUSH_AUDIENCE: "https://co.example/api/webhooks/gmail",
  GMAIL_PUSH_SERVICE_ACCOUNT: "gmail-push@co-prod.iam.gserviceaccount.com",
};

describe("Gmail awareness service", () => {
  it("fails closed unless both the source and ambient policy are enabled", async () => {
    await expect(
      activateGmailAwareness({} as never, userId, {
        ...enabled,
        FEATURE_AMBIENT_AWARENESS: "false",
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("uses an authenticated tenant subject and accepts only HTTPS callbacks", async () => {
    const authorize = vi.fn(async () => "https://connect.example/authorize");
    await expect(
      beginGmailAuthorization(userId, "https://co.example/settings?gmail=connected", enabled, {
        authorize,
      }),
    ).resolves.toEqual({ authorization_url: "https://connect.example/authorize" });
    expect(authorize).toHaveBeenCalledWith(
      "google/co",
      userId,
      "https://co.example/settings?gmail=connected",
    );
    await expect(
      beginGmailAuthorization(userId, "http://localhost/callback", enabled, { authorize }),
    ).rejects.toThrow(/HTTPS/u);
    await expect(
      beginGmailAuthorization(userId, "https://attacker.example/callback", enabled, { authorize }),
    ).rejects.toThrow(/application origin/u);
  });

  it("registers the watch cursor in the authenticated user's namespace", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        source_id: sourceId,
        email_address: "person@example.com",
        history_id: "42",
        expires_at: "2026-09-07T19:00:00Z",
      },
      error: null,
    }));
    const watch = vi.fn(async () => ({
      emailAddress: "person@example.com",
      historyId: "42",
      expiresAt: "2026-09-07T19:00:00Z",
    }));
    const response = await activateGmailAwareness({ rpc } as never, userId, enabled, {
      client: { watch } as unknown as GmailClient,
      token: async () => "access-token",
    });
    expect(rpc).toHaveBeenCalledWith("register_gmail_context_source", {
      p_user_id: userId,
      p_email_address: "person@example.com",
      p_history_id: "42",
      p_watch_expires_at: "2026-09-07T19:00:00Z",
      p_access_mode: "snippet",
    });
    expect(response.source_id).toBe(sourceId);
  });

  it("stops an orphaned provider watch when durable registration fails", async () => {
    const failure = new Error("database unavailable");
    const stop = vi.fn(async () => {});
    await expect(
      activateGmailAwareness(
        { rpc: vi.fn(async () => ({ data: null, error: failure })) } as never,
        userId,
        enabled,
        {
          client: {
            watch: vi.fn(async () => ({
              emailAddress: "person@example.com",
              historyId: "42",
              expiresAt: "2026-09-07T19:00:00Z",
            })),
            stop,
          } as unknown as GmailClient,
          token: async () => "access-token",
        },
      ),
    ).rejects.toBe(failure);
    expect(stop).toHaveBeenCalledWith("access-token");
  });

  it("deletes local evidence even when flags are off and external revocation fails", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const log = vi.fn();
    const result = await disconnectGmailAwareness(
      { rpc } as never,
      userId,
      sourceId,
      {
        ...enabled,
        FEATURE_AMBIENT_AWARENESS: "false",
        FEATURE_GMAIL_AWARENESS: "false",
      },
      {
        token: async () => {
          throw new Error("connector unavailable");
        },
        revoke: async () => {
          throw new Error("connector unavailable");
        },
        log,
      },
    );
    expect(rpc).toHaveBeenCalledWith("delete_gmail_context_source", {
      p_external_revocation: "deferred",
      p_user_id: userId,
      p_source_id: sourceId,
    });
    expect(result).toEqual({
      deleted: true,
      external_revocation: "deferred",
      source_id: sourceId,
    });
    expect(log).toHaveBeenCalledWith("gmail.token_revoke_failed", { source_id: sourceId });
  });

  it("verifies, durably queues, and dispatches a push without exposing content", async () => {
    const rpc = vi.fn(async () => ({
      data: { accepted: true, user_id: userId, source_id: sourceId },
      error: null,
    }));
    const verifyPush = vi.fn(async () => {});
    const dispatch = vi.fn(async () => {});
    const log = vi.fn();
    const data = Buffer.from(
      JSON.stringify({
        emailAddress: "person@example.com",
        historyId: "43",
      }),
    ).toString("base64url");
    const result = await ingestGmailPush(
      { rpc } as never,
      "Bearer signed-google-token",
      {
        message: {
          data,
          messageId: "pubsub-1",
          publishTime: "2026-09-01T19:00:00Z",
        },
        subscription: "projects/co-prod/subscriptions/gmail-awareness",
      },
      enabled,
      { verifyPush, dispatch, log },
    );
    expect(verifyPush).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("enqueue_gmail_sync", {
      p_email_address: "person@example.com",
      p_history_id: "43",
      p_pubsub_message_id: "pubsub-1",
      p_published_at: "2026-09-01T19:00:00Z",
    });
    expect(dispatch).toHaveBeenCalledWith(
      {
        userId,
        sourceId,
        resourceVersion: "gmail-awareness.v1",
      },
      `gmail-sync:${sourceId}:pubsub-1`,
    );
    expect(result).toEqual({ accepted: true, dispatched: true });
    expect(JSON.stringify(log.mock.calls)).not.toContain("person@example.com");
  });

  it("authenticates the push before loading its untrusted envelope", async () => {
    const loadEnvelope = vi.fn(async () => {
      throw new Error("the body must not be loaded");
    });
    await expect(
      ingestGmailPush({} as never, null, loadEnvelope, enabled, {
        verifyPush: async () => {
          throw new HttpStatusError(401, "unauthorized");
        },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(loadEnvelope).not.toHaveBeenCalled();
  });
});
