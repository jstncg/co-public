# Kyo iOS

The release build has one intake: the member gives Co a phone number and verifies the six-digit
code sent over iMessage/SMS. The number joins the app credential and transport mapping, so messages
dual-written from that number resolve to the same canonical member. Someone who starts in iMessage
can instead open the private relationship link Co sends; both paths enter Justin's existing shell.

There is deliberately no profile questionnaire. Supabase anonymous auth is the private app-session
bootstrap; phone verification is the member-facing identity step. Never ship the service-role key,
phone-mapping pepper, challenge secret, or Sendblue credentials in the app.

## TestFlight build

The production public client configuration is versioned in `Config/Runtime.xcconfig`, so a fresh
clone can build a connected app without creating a private config file. Archive and upload with:

```sh
UPLOAD=1 ./testflight.sh
```

All three values may still be supplied as environment variables when intentionally targeting a
different deployment. They override the versioned defaults for that archive only.

The production client can point `KYO_API_BASE_URL` directly at the authenticated `co-api` Supabase
Edge Function, for example `https://<project-ref>.supabase.co/functions/v1/co-api`. This removes a
separate web deployment from the native onboarding path. Deploy it with:

```sh
supabase functions deploy co-api --no-verify-jwt
```

The function requires `CO_PHONE_MAPPING_PEPPER`, `CO_PHONE_LINK_CHALLENGE_SECRET`,
`CO_MESSAGE_HANDOFF_NUMBER` and the selected server-side rail secrets as Supabase project secrets:
`CO_RAIL=sendblue` with `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET_KEY`, and
`SENDBLUE_FROM_NUMBER`, or `CO_RAIL=linq` with `LINQ_API_KEY` and `LINQ_FROM_NUMBER`. The mapping
pepper must exactly match the live transport receiver. Anonymous sign-ins must be enabled in the
matching Supabase project.

For a build launched directly from Xcode, run `xcodegen generate`, choose the Kyo scheme, and build.
`Config/Runtime.local.xcconfig` remains available as an optional gitignored override for development
against another deployment. It must contain public client values only; service credentials remain
server-only. The unusual `https:/$()/` spelling is the xcconfig-safe form of `https://`.

An ordinary Debug launch follows the same honest startup decision as TestFlight: resume a private
relationship link, otherwise use the bundled public runtime configuration, otherwise say that the
line is unavailable. It never substitutes another person's fixture data.

Add `-kyoFixtures` only when intentionally reviewing the offline design data. Add
`-kyoPhoneOnboardingPreview` to inspect the phone screen without sending a code. With the three
runtime values configured, an ordinary launch exercises phone verification and canonical data.

The center Kyo action has two honest states. Before the private relationship link arrives it opens
the verified iMessage line. After the member opens Co's relationship link, it opens Justin's in-app
thread against `/w/<slug>/chat`; those turns use the rail's same tenant, history, engine, and durable
transcript. There is no app-only localhost conversation.
