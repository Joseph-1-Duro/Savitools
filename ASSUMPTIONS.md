# Assumptions

## Soroban Event Stream Inspector (issue #78)

1. **"All 15 ScVal types" means every variant the SDK exposes.** `@stellar/stellar-sdk`
   13.3.0 defines 22 `xdr.ScValType` variants; the decoder covers all of them. A test
   asserts the count is 22 so a future SDK bump that adds a variant fails loudly instead
   of silently falling through to the typed fallback.

2. **Wide integers are returned as decimal strings, bytes as hex.** `i128`/`u128`/`i256`/
   `u256`/`u64`/`i64`/`timepoint`/`duration` cannot round-trip through JSON as BigInt, and
   `Number` loses precision past 2^53. Consumers get exact decimal strings. `raw` always
   carries the original base64 for anyone who needs the bytes.

3. **Replay signs each event as its own POST**, matching the issue's "sends each event as
   a POST" — not one batched payload. The wire format matches the rest of the repo
   (Webhook Tester, event replay, and monitor alerts share `apps/api/src/modules/webhook/signature.ts`):
   `X-SaviTools-Signature: sha256=<hex>` plus `X-SaviTools-Timestamp: <unix seconds>`, where
   the hex is HMAC-SHA256 over the UTF-8 bytes of `<timestamp>.<body>` with the exact body
   bytes sent. A verifier rejects signatures older than 300 s (replay window) or more than
   60 s in the future (sender clock skew).

4. **The signing secret resolves as per-request secret, then `WEBHOOK_SIGNING_SECRET`.**
   `WebhookService.sendWebhook` and `EventsService.replayEvents` sign with the caller-supplied
   `secret` when present, otherwise with `WEBHOOK_SIGNING_SECRET`; when neither is set the
   webhook goes out unsigned. Monitor alerts always sign with the per-webhook DB secret,
   never the env var. `GET /webhooks/signing` reports whether the env secret is configured
   and the exact wire format, so operators can confirm what receivers will see.

5. **Events are not persisted.** Query → decode → return; the UI holds them in component
   state. The issue describes no storage, and Soroban RPC is itself the retention layer
   (~24h).

6. **Read endpoints are public; replay is authenticated.** `CONTRACT_ADMIN_EMAILS` guards
   deploy/invoke because those spend `DEPLOYER_SECRET_KEY`. Reading events spends nothing,
   and since an empty allowlist denies everyone by design, gating reads would ship the tool
   unusable. Replay sends outbound traffic, so it requires `JwtAuthGuard`.

7. **The RPC `type` filter is a parameter, not a constant.** The issue pins `type: 'contract'`
   but also asks for a `contract | system | diagnostic` badge, which is only meaningful if
   the type can vary. It defaults to `'contract'` and is overridable.

8. **Filter logic is duplicated between API and web, deliberately.** The API copy is
   authoritative and carries the test table; `apps/web/src/lib/contract-events.ts` mirrors it
   so the UI filters instantly with no round-trip. The repo already duplicates the SSRF guard
   on the same reasoning. Drift risk is the accepted cost.

9. **`ContractsModule` now imports `AuthModule`.** It used `JwtAuthGuard` on deploy/invoke
   without importing the module that provides it — `MonitorModule` is the correct pattern.
   The new `EventsController` needs it for replay, and importing it also closes that
   pre-existing gap.

10. **Decoder validation used constructed ScVal fixtures, not a deployed fixture contract.**
     The acceptance criterion asks for "a contract that emits one event of each type in a
     test transaction", which would require deploying and funding from CI. In-process
     fixtures exercise the identical decode path deterministically and offline. This was
    additionally validated against live testnet: 200 real events decoded in 451 ms with
    zero decode failures.


## Unified outbound signing contract (issue #204)

11. **The Webhook Tester signed a different payload than it sent.** It signed
    `dto.payload` re-serialised as `<body>`, but the body handed to `fetch` came from the
    pretty-printed editor text, so the bytes a receiver verified were not the bytes it
    received. The signed value is now the single `body` string that goes on the wire, and
    `WebhookHistoryEntry.signature` reports that exact body plus the timestamp so the UI and
    any receiver can recompute the same HMAC without re-deriving the serialisation.

12. **The legacy `X-Timestamp` ISO header was dropped rather than kept alongside the signing
    timestamp.** Two timestamps on one request, in different formats, is how a receiver ends
    up checking the wrong one. The signing timestamp in `X-SaviTools-Timestamp` is
    authoritative; `WebhookHistoryEntry.timestamp` still records the local send time for the
    UI's own display.

13. **Replaying a recorded delivery re-signs rather than replaying its headers.** Recorded
    secret-shaped headers are already redacted, so a stored signature can never be
    reproduced; the legacy pair and any stale `X-SaviTools-Timestamp` are stripped and the
    delivery is signed afresh with the deployment-wide secret. Entries recorded under the
    body-only format are flagged `legacySignature` on read so the UI can say the replay no
    longer matches the original bytes.

14. **`GET /webhooks/signing` is public.** It returns configuration and the wire format, never
    a secret, so a receiver can confirm the contract before traffic is pointed at the
    deployment. The README and API reference already documented this endpoint before it
    existed; it is implemented here.

15. **The browser re-implements the contract in `apps/web/src/lib/webhook-signature.ts`.** The
    Webhook Tester must reproduce the API's bytes to be useful as a verification aid, and it
    cannot import API code. Both sides assert the same known-answer vector, so a divergence
    fails one of the two suites rather than surfacing as a signature that only the UI believes.

