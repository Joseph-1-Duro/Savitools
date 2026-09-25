# SaviTools API Reference

Developer infrastructure for the Stellar ecosystem.

## Base URLs

| Environment | URL | Notes |
|-------------|-----|-------|
| **Mainnet** | `https://api.savitools.com/api` | Production Stellar network |
| **Testnet** | `https://testnet-api.savitools.com/api` | Stellar testnet environment |
| **Local Development** | `http://localhost:3001/api` | Development server (default) |

## API Versioning

The API uses URI-based versioning. All endpoints are prefixed with `/v1` (or the version number). The current default version is `v1`.

Example: `GET /api/v1/health`

## Authentication

### Public vs Protected Endpoints

- **Public endpoints**: No authentication required (e.g., `/wallet/generate`, `/simulator/paths`)
- **Protected endpoints**: Require valid JWT authentication via HTTP-only cookies

### Getting an API Key

1. Register or login to create a session
2. Use the issued JWT cookie for subsequent requests

### Authentication Methods

#### HTTP Cookie (Recommended)
The API uses **HTTP-only cookies** to store JWT tokens automatically after authentication. When you call `POST /auth/login` or `POST /auth/register`, the response sets:
- `access_token` cookie (15-minute expiration)
- `refresh_token` cookie (7-day expiration)

All subsequent requests automatically include these cookies. No header configuration needed.

#### Header-Based Authentication (Optional)
If cookies are disabled, use:
```
Authorization: Bearer {accessToken}
```

### Cookie Refresh

To refresh an expired access token:
```bash
curl -X POST http://localhost:3001/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  --cookie "refresh_token=YOUR_REFRESH_TOKEN"
```

## Endpoint Catalog

### Health & Status

#### GET `/health`

Health check endpoint.

**Request:**
```bash
curl http://localhost:3001/api/v1/health
```

**Response (200):**
```json
{
  "status": "ok"
}
```

---

### Authentication

#### POST `/auth/register`

Register a new user with email and password.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123"
  }'
```

**Response (201):**
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": null
  }
}
```

**Errors:**
- `400`: User already exists or invalid email format

---

#### POST `/auth/login`

Login with email and password.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123"
  }'
```

**Response (200):**
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": null
  }
}
```

**Cookies Set:**
- `access_token` (15 min TTL)
- `refresh_token` (7 day TTL)

**Errors:**
- `401`: Invalid email or password

---

#### POST `/auth/forgot-password`

Request a password reset email (see Savitura/Savitools#196). The response is identical whether or not the account exists — the endpoint cannot be used to enumerate registered emails. Requests are rate-limited per IP and per email.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{ "email": "user@example.com" }'
```

**Response (200):**
```json
{
  "message": "If an account with that email exists, we have sent a link to reset your password."
}
```

The email contains a link to `/reset-password?token=…`. The token is stored hashed (SHA-256), is single-use, and expires after 30 minutes.

---

#### POST `/auth/reset-password`

Set a new password with a valid, unused, unexpired reset token. On success every active refresh-token family for the user is revoked, signing out all other sessions.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "RESET_TOKEN_FROM_EMAIL",
    "password": "NewSecurePassword123"
  }'
```

**Response (200):**
```json
{
  "message": "Password updated. You can now sign in with your new password."
}
```

**Errors:**
- `404`: Reset token is invalid (or already used)
- `410`: `RESET_TOKEN_EXPIRED`

---

#### POST `/auth/refresh`

Rotate refresh token and issue a new access token.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/auth/refresh \
  --cookie "refresh_token=YOUR_REFRESH_TOKEN"
```

**Response (200):**
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com"
  }
}
```

**Errors:**
- `401`: Invalid or expired refresh token

---

#### POST `/auth/logout`

Invalidate refresh token and clear auth cookies.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/auth/logout
```

**Response (200):**
```json
{
  "success": true
}
```

---

#### POST `/auth/fluxa`

Exchange a Fluxa API key for a SaviTools session and link accounts.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/auth/fluxa \
  -H "Content-Type: application/json" \
  -d '{
    "fluxaApiKey": "your-fluxa-api-key"
  }'
```

**Response (200):**
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": "fluxa-tenant-id"
  }
}
```

**Errors:**
- `400`: Invalid Fluxa API key

---

#### GET `/auth/me`

Get the current authenticated user.

**Request:**
```bash
curl http://localhost:3001/api/v1/auth/me \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**
```json
{
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "fluxaTenantId": null
  }
}
```

**Errors:**
- `401`: Not authenticated

---

### Wallet & Keypair Generation

#### POST `/wallet/generate`

Generate a new Stellar keypair (public key + secret).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/wallet/generate
```

**Response (201):**
```json
{
  "publicKey": "GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C",
  "secret": "SBUQ54DRQG5Q3QLQHJEZ5ODSLGE...TRUNCATED"
}
```

---

#### POST `/wallet/fund`

Fund a testnet account via Friendbot (10 XLM).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/wallet/fund \
  -H "Content-Type: application/json" \
  -d '{
    "publicKey": "GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C"
  }'
```

**Response (200):**
```json
{
  "success": true,
  "amount": "10.0000000",
  "currency": "XLM",
  "transactionHash": "6c1e1f6..."
}
```

**Errors:**
- `400`: Invalid public key or funding failed (rate-limited, etc.)

---

#### GET `/wallet/balances?publicKey=GBZR...`

Get asset balances for a Stellar account.

**Request:**
```bash
curl "http://localhost:3001/api/v1/wallet/balances?publicKey=GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C"
```

**Response (200):**
```json
{
  "balances": [
    {
      "asset_type": "native",
      "balance": "9.9999800",
      "asset_code": "XLM"
    },
    {
      "asset_type": "credit_alphanum4",
      "asset_code": "USDC",
      "asset_issuer": "GA...",
      "balance": "100.0000000",
      "limit": "922337203685.4775807"
    }
  ]
}
```

**Errors:**
- `400`: Invalid public key or account not found

---

#### POST `/wallet/payment`

Send a payment from a sandbox wallet.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/wallet/payment \
  -H "Content-Type: application/json" \
  -d '{
    "sourceSecret": "SBUQ54DRQG5Q3QLQHJEZ5ODSLGE...",
    "destination": "GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C",
    "asset": "XLM",
    "amount": "5.00"
  }'
```

**Response (200):**
```json
{
  "transactionHash": "6c1e1f6fe...",
  "success": true,
  "amount": "5.0000000",
  "destination": "GBZR7..."
}
```

**Errors:**
- `400`: Invalid parameters or insufficient balance

---

### Simulator (Payment Paths & Fees)

#### GET `/simulator/paths?direction=...&source_asset_*=...&destination_asset_*=...&amount=...&network=...`

Find payment paths between two assets.

**Query Parameters:**
- `direction` (required): `strict_send` or `strict_receive`
- `source_asset_type` (required): `native` | `credit_alphanum4` | `credit_alphanum12`
- `source_asset_code` (optional): Asset code (e.g., `USDC`)
- `source_asset_issuer` (optional): Asset issuer public key
- `destination_asset_type` (required): Asset type for destination
- `destination_asset_code` (optional): Destination asset code
- `destination_asset_issuer` (optional): Destination asset issuer
- `amount` (required): Amount to send/receive
- `network` (optional, default `mainnet`): `mainnet` or `testnet`

**Request:**
```bash
curl "http://localhost:3001/api/v1/simulator/paths?direction=strict_send&source_asset_type=native&destination_asset_type=credit_alphanum4&destination_asset_code=USDC&destination_asset_issuer=GA...&amount=100&network=testnet"
```

**Response (200):**
```json
{
  "paths": [
    {
      "path": [
        {
          "asset_type": "native"
        }
      ],
      "destination_amount": "99.5000000",
      "source_amount": "100.0000000"
    }
  ],
  "direction": "strict_send"
}
```

**Errors:**
- `400`: Invalid parameters or no paths found

---

#### POST `/simulator/estimate`

Compute destination_min or send_max for a selected path with slippage.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/simulator/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "path": [...],
    "sendAmount": "100.0",
    "slippagePercent": 1.5
  }'
```

**Response (200):**
```json
{
  "sourceAmount": "100.0000000",
  "destinationAmount": "98.5000000"
}
```

**Errors:**
- `400`: Invalid path or amount

---

#### POST `/simulator/path-send`

Find paths for a strict send payment (you control the amount sent).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/simulator/path-send \
  -H "Content-Type: application/json" \
  -d '{
    "sourceAsset": {...},
    "destinationAsset": {...},
    "sendAmount": "100.0",
    "network": "testnet"
  }'
```

**Response (200):**
```json
{
  "paths": [...],
  "direction": "strict_send"
}
```

---

#### POST `/simulator/path-receive`

Find paths for a strict receive payment (you control the amount received).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/simulator/path-receive \
  -H "Content-Type: application/json" \
  -d '{
    "sourceAsset": {...},
    "destinationAsset": {...},
    "receiveAmount": "100.0",
    "network": "testnet"
  }'
```

**Response (200):**
```json
{
  "paths": [...],
  "direction": "strict_receive"
}
```

---

#### GET `/simulator/fee?operations=1&network=testnet`

Estimate transaction fee based on current network fee stats.

**Query Parameters:**
- `operations` (optional, default `1`): Number of operations in the transaction
- `network` (optional, default `testnet`): `mainnet` or `testnet`

**Request:**
```bash
curl "http://localhost:3001/api/v1/simulator/fee?operations=3&network=testnet"
```

**Response (200):**
```json
{
  "baseFee": 100,
  "totalFee": 300,
  "operations": 3,
  "network": "testnet"
}
```

---

### Composer (Transaction Building)

#### GET `/composer/operations`

List all supported operation types with field schemas.

**Request:**
```bash
curl http://localhost:3001/api/v1/composer/operations
```

**Response (200):**
```json
{
  "operations": [
    {
      "type": "payment",
      "description": "Send an asset to another account",
      "fields": [
        {
          "name": "destination",
          "type": "string",
          "description": "Destination account public key",
          "required": true
        },
        {
          "name": "asset",
          "type": "object",
          "description": "Asset to send"
        },
        {
          "name": "amount",
          "type": "string",
          "description": "Amount to send"
        }
      ]
    },
    {
      "type": "path_payment_strict_send",
      "description": "Send an asset via a specific path",
      "fields": [...]
    }
  ]
}
```

---

#### POST `/composer/build`

Build a multi-op transaction and return unsigned XDR envelope.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/composer/build \
  -H "Content-Type: application/json" \
  -d '{
    "sourceAccount": {
      "publicKey": "GBZR7...",
      "sequence": "1234567890"
    },
    "fee": "300",
    "operations": [
      {
        "type": "payment",
        "destination": "GBUQWP...",
        "asset": "native",
        "amount": "10.00"
      }
    ],
    "network": "testnet"
  }'
```

**Response (200):**
```json
{
  "xdr": "AAAAAgAAAAB+Ht3sW...",
  "hash": "5fa...",
  "envelope_type": "ENVELOPE_TYPE_TX"
}
```

**Errors:**
- `400`: Invalid transaction parameters

---

#### POST `/composer/simulate`

Dry-run an XDR transaction against Horizon; returns fee and result codes.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/composer/simulate \
  -H "Content-Type: application/json" \
  -d '{
    "xdr": "AAAAAgAAAAB+Ht3sW...",
    "network": "testnet"
  }'
```

**Response (200):**
```json
{
  "resultXdr": "...",
  "fee": "300",
  "resultCode": "txSUCCESS",
  "operationResults": [
    {
      "code": "opSUCCESS"
    }
  ]
}
```

**Errors:**
- `400`: Invalid XDR or simulation failed

---

### Inspector (Transaction & XDR Inspection)

#### GET `/inspector/tx/:hash`

Fetch, decode, and inspect a Stellar transaction by hash.

**Query Parameters:**
- `network` (optional, default `testnet`): `testnet` or `mainnet`

**Request:**
```bash
curl "http://localhost:3001/api/v1/inspector/tx/5fa1f6d8a7c..."
```

**Response (200):**
```json
{
  "hash": "5fa1f6d8a7c...",
  "ledger": 12345,
  "createdAt": "2024-06-21T12:34:56Z",
  "sourceAccount": "GBZR7...",
  "sequenceNumber": "1234567890",
  "feeCharged": "300",
  "maxFee": "300",
  "memo": null,
  "memoType": "none",
  "timeBounds": null,
  "signatures": ["..."],
  "success": true,
  "resultCode": "tx_success",
  "resultExplanation": "The transaction was code-path complete and succeeded.",
  "operationCount": 1,
  "operations": [
    {
      "type": "payment",
      "fields": {
        "destination": "GBUQWP...",
        "amount": "10.00",
        "asset": "XLM"
      },
      "index": 0,
      "resultCode": "op_success",
      "resultExplanation": "The payment operation succeeded.",
      "success": true,
      "effects": []
    }
  ],
  "rawJson": {},
  "network": "testnet",
  "composerPayload": {}
}
```

**Errors:**
- `404`: Transaction not found

---

#### GET `/inspector/tx/:hash/export`

Export a transaction breakdown as CSV (UTF-8 BOM included for Excel compatibility).

**Query Parameters:**
- `network` (optional, default `testnet`): `testnet` or `mainnet`

**Request:**
```bash
curl "http://localhost:3001/api/v1/inspector/tx/5fa1f6d8a7c.../export?network=testnet"
```

**Response (200):** `text/csv` attachment
```
hash,network,ledger,created_at,source_account,sequence_number,fee_charged,max_fee,memo,memo_type,success,result_code,result_explanation,operation_index,operation_type,operation_label,operation_source,operation_result_code,operation_success,operation_effects,operation_fields
```

**Errors:**
- `404`: Transaction not found

---

#### GET `/inspector/account/:publicKey/txs`

Get the last 20 transactions for a Stellar account.

**Query Parameters:**
- `network` (optional, default `testnet`): `testnet` or `mainnet`

**Request:**
```bash
curl "http://localhost:3001/api/v1/inspector/account/GBZR7.../txs"
```

**Response (200):**
```json
[
  {
    "hash": "5fa1f6d8a7c...",
    "createdAt": "2024-06-21T12:34:56Z",
    "operationCount": 1,
    "feeCharged": "300",
    "success": true,
    "resultCode": "tx_success"
  }
]
```

**Errors:**
- `404`: Account not found

---

#### POST `/inspector/decode-xdr`

Decode raw Stellar XDR envelope (offline, no Horizon network call required).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/inspector/decode-xdr \
  -H "Content-Type: application/json" \
  -d '{
    "xdr": "AAAAAgAAAAB+Ht3sW...",
    "network": "testnet"
  }'
```

**Response (200):**
```json
{
  "hash": "5fa1f6d8a7c...",
  "ledger": 0,
  "createdAt": "",
  "sourceAccount": "GBZR7...",
  "sequenceNumber": "1234567890",
  "feeCharged": "0",
  "maxFee": "300",
  "memo": null,
  "memoType": "none",
  "timeBounds": null,
  "signatures": ["..."],
  "success": true,
  "resultCode": "tx_success",
  "resultExplanation": "Transaction decoded from XDR — not yet submitted.",
  "operationCount": 1,
  "operations": [
    {
      "type": "payment",
      "fields": {
        "destination": "GBUQWP...",
        "amount": "10.00",
        "asset": "XLM"
      },
      "index": 0,
      "resultCode": null,
      "resultExplanation": null,
      "success": true,
      "effects": []
    }
  ],
  "rawJson": null,
  "network": "testnet",
  "composerPayload": {}
}
```

**Errors:**
- `400`: Invalid XDR

---

### Network

#### GET `/network/status?network=mainnet`

Get current Stellar network status and fees.

**Query Parameters:**
- `network` (optional, default `mainnet`): `mainnet` or `testnet`

**Request:**
```bash
curl "http://localhost:3001/api/v1/network/status?network=testnet"
```

**Response (200):**
```json
{
  "network": "testnet",
  "baseFee": 100,
  "baseReserve": 0.5,
  "protocolVersion": 21,
  "timestamp": "2024-06-21T12:34:56Z"
}
```

---

#### GET `/network/status/history?network=mainnet`

Get last 60 minutes of network status history.

**Query Parameters:**
- `network` (optional, default `mainnet`): `mainnet` or `testnet`

**Request:**
```bash
curl "http://localhost:3001/api/v1/network/status/history?network=testnet"
```

**Response (200):**
```json
{
  "network": "testnet",
  "history": [
    {
      "timestamp": "2024-06-21T11:34:56Z",
      "baseFee": 100,
      "baseReserve": 0.5
    },
    {
      "timestamp": "2024-06-21T12:34:56Z",
      "baseFee": 100,
      "baseReserve": 0.5
    }
  ]
}
```

---

### Contracts (Soroban)

#### POST `/contracts/deploy`

Deploy a Soroban smart contract from a WASM file.

**Request (multipart/form-data):**
```bash
curl -X POST http://localhost:3001/api/v1/contracts/deploy \
  -F "file=@contract.wasm" \
  -F "args=[\"arg1\",\"arg2\"]"
```

**Response (200):**
```json
{
  "contractId": "CABC...",
  "deployTransactionHash": "5fa1f6d...",
  "wasmHash": "9e5551...",
  "network": "testnet"
}
```

**Errors:**
- `400`: Invalid WASM file or deployment failed

---

#### POST `/contracts/:contractId/invoke`

Invoke a contract function.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/contracts/CABC.../invoke \
  -H "Content-Type: application/json" \
  -d '{
    "functionName": "transfer",
    "args": ["GBU...", "100.00"]
  }'
```

**Response (200):**
```json
{
  "result": "...",
  "transactionHash": "5fa1f6d..."
}
```

**Errors:**
- `400`: Invalid contract ID or parameters

---

#### GET `/contracts/:contractId/info`

Get contract metadata from the network.

**Request:**
```bash
curl http://localhost:3001/api/v1/contracts/CABC.../info
```

**Response (200):**
```json
{
  "contractId": "CABC...",
  "wasmHash": "9e5551...",
  "createdLedger": 12345,
  "createdAt": "2024-06-21T12:34:56Z"
}
```

**Errors:**
- `404`: Contract not found

---

### Webhooks

#### GET `/webhooks/templates`

List all supported webhook event types with schemas and sample payloads.

**Request:**
```bash
curl http://localhost:3001/api/v1/webhooks/templates
```

**Response (200):**
```json
{
  "templates": [
    {
      "eventType": "transaction.submitted",
      "description": "Emitted when a transaction is submitted",
      "schema": {...},
      "examplePayload": {...}
    }
  ]
}
```

---

#### GET `/webhooks/signing`

Whether outbound webhook signing is enabled and the exact signature wire format receivers
should expect. Public — reveals configuration only, no secrets.

**Request:**
```bash
curl http://localhost:3001/api/v1/webhooks/signing
```

**Response (200):**
```json
{
  "enabled": true,
  "algorithm": "hmac-sha256",
  "signatureHeader": "X-SaviTools-Signature",
  "timestampHeader": "X-SaviTools-Timestamp",
  "replayWindowSeconds": 300,
  "signedPayloadFormat": "<timestamp>.<body>",
  "signatureFormat": "sha256=<hex>",
  "signedPayloadEncoding": "utf-8",
  "maxSkewSeconds": 60,
  "perRequestSecretSupported": true
}
```

`enabled` is `true` when `WEBHOOK_SIGNING_SECRET` is configured. When enabled (or when a
per-request `secret` is supplied to `/webhooks/send` or the replay endpoint), every outbound
request carries `X-SaviTools-Timestamp: <unix seconds>` and
`X-SaviTools-Signature: sha256=<hex>`, where the hex is HMAC-SHA256 over the UTF-8 bytes of
`<timestamp>.<body>` with the exact body bytes sent. Receivers should recompute that HMAC with
the shared secret, compare in constant time, and reject signatures whose timestamp is older
than `replayWindowSeconds` (replay) or more than `maxSkewSeconds` in the future (clock skew).
The reference implementation lives in `apps/api/src/modules/webhook/signature.ts` (`signBody` /
`verifySignature`).

There is no body-only signature format. Deliveries recorded before the timestamped contract
landed carry the legacy `X-Webhook-Signature`; replaying such an entry strips the stale headers
and re-signs it, and the history entry is returned with `"legacySignature": true`.

---

#### POST `/webhooks/send`

Send a webhook payload to a target endpoint. Requires authentication.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/webhooks/send \
  -H "Content-Type: application/json" \
  --cookie "savitools_access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "endpointUrl": "https://example.com/webhook",
    "eventType": "transaction.submitted",
    "payload": {...},
    "secret": "shared-signing-secret"
  }'
```

**Response (201):** a `WebhookHistoryEntry` (see `/webhooks/history`). When a `secret` is in
play, the entry carries the exact signing inputs:

```json
{
  "id": "1f0c...",
  "eventType": "transaction.submitted",
  "endpointUrl": "https://example.com/webhook",
  "method": "POST",
  "requestHeaders": {
    "Content-Type": "application/json",
    "X-Webhook-Event": "transaction.submitted",
    "X-SaviTools-Signature": "[REDACTED]",
    "X-SaviTools-Timestamp": "1717243200"
  },
  "payload": {...},
  "signature": {
    "timestamp": "1717243200",
    "body": "{\"event\":\"transaction.submitted\"}",
    "signature": "sha256=8fdd98..."
  },
  "responseStatus": 200,
  "latencyMs": 250
}
```

`signature.body` is byte-for-byte the request body that was sent and signed, so a receiver (or
the Webhook Tester UI) can recompute the identical HMAC from `signature.timestamp` and
`signature.body` without guessing the serialisation. The signature value in
`requestHeaders` is redacted before storage; `signature.signature` carries the value that went
on the wire.

**Errors:**
- `400`: Invalid webhook payload or an unsafe destination
- `502`: Request payload exceeds the size limit, or the destination failed

---

#### GET `/webhooks/history`

Get the last 50 webhook send attempts. Requires authentication.

**Request:**
```bash
curl http://localhost:3001/api/v1/webhooks/history \
  --cookie "savitools_access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**
```json
[
  {
    "id": "1f0c...",
    "eventType": "transaction.submitted",
    "endpointUrl": "https://example.com/webhook",
    "method": "POST",
    "requestHeaders": {"X-SaviTools-Timestamp": "1717243200"},
    "payload": {...},
    "statusCode": 200,
    "responseStatus": 200,
    "responseBody": "ok",
    "latencyMs": 250,
    "timestamp": 1717243200000
  }
]
```

Entries recorded under the legacy body-only signing format are returned with
`"legacySignature": true`.

---

#### POST `/webhooks/replay/:id`

Replay a previous webhook send attempt. Requires authentication.

The stored secret-shaped headers are redacted and cannot be reconstructed, so the replay is
signed afresh with the deployment-wide `WEBHOOK_SIGNING_SECRET` (or sent unsigned if none is
configured). Any recorded signing header is dropped first, so the replay never carries a
timestamp that disagrees with the signature beside it.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/webhooks/replay/1f0c... \
  --cookie "savitools_access_token=YOUR_ACCESS_TOKEN"
```

**Response (201):** a new `WebhookHistoryEntry`, as returned by `/webhooks/send`.

**Errors:**
- `404`: Webhook attempt not found

---

### Playground (API Proxy & Key Management)

#### GET `/playground/spec/:provider`

Fetch and cache an OpenAPI spec for a provider (requires authentication).

**Request:**
```bash
curl http://localhost:3001/api/v1/playground/spec/stripe \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**
```json
{
  "provider": "stripe",
  "spec": {...}
}
```

**Errors:**
- `404`: Provider spec not found
- `401`: Not authenticated

---

#### POST `/playground/proxy`

Proxy a request to the target API with server-side auth (requires authentication).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/playground/proxy \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "provider": "stripe",
    "method": "GET",
    "path": "/v1/customers",
    "params": {}
  }'
```

**Response (200):**
```json
{
  "statusCode": 200,
  "body": {...}
}
```

---

#### POST `/playground/keys`

Save an encrypted API key (requires authentication).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/playground/keys \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "provider": "stripe",
    "key": "sk_live_..."
  }'
```

**Response (201):**
```json
{
  "id": "key-123",
  "provider": "stripe",
  "keyMasked": "sk_live_...***"
}
```

---

#### GET `/playground/keys`

List stored API keys (masked, requires authentication).

**Request:**
```bash
curl http://localhost:3001/api/v1/playground/keys \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**
```json
{
  "keys": [
    {
      "id": "key-123",
      "provider": "stripe",
      "keyMasked": "sk_live_...***"
    }
  ]
}
```

---

#### PUT `/playground/keys/:id`

Update a stored API key (requires authentication).

**Request:**
```bash
curl -X PUT http://localhost:3001/api/v1/playground/keys/key-123 \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "key": "sk_live_new..."
  }'
```

**Response (200):**
```json
{
  "id": "key-123",
  "keyMasked": "sk_live_...***"
}
```

---

#### DELETE `/playground/keys/:id`

Delete a stored API key (requires authentication).

**Request:**
```bash
curl -X DELETE http://localhost:3001/api/v1/playground/keys/key-123 \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (204):**
No content

---

### Workspaces (User State Persistence)

#### GET `/workspaces/:tool`

Get persisted tool state for the current user (requires authentication).

**Path Parameters:**
- `tool`: `sandbox` | `inspector` | `webhooks` | `composer`

**Request:**
```bash
curl http://localhost:3001/api/v1/workspaces/composer \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**
```json
{
  "tool": "composer",
  "data": {...}
}
```

**Errors:**
- `400`: Invalid tool name
- `401`: Not authenticated

---

#### PUT `/workspaces/:tool`

Save tool state for the current user (requires authentication).

**Request:**
```bash
curl -X PUT http://localhost:3001/api/v1/workspaces/composer \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "data": {...}
  }'
```

**Response (200):**
```json
{
  "tool": "composer",
  "data": {...}
}
```

---

### Monitors (Account & Contract Watches)

#### POST `/monitor/watches`

Create a watch for an account or contract (requires authentication).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/monitor/watches \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "address": "GBZR7WLLV5OZVUQ4WAWCKVCOVWGZFZVHG5GMRFYVZJZ2AFSGHFKDQ4C",
    "type": "account",
    "label": "My Account",
    "network": "testnet"
  }'
```

**Response (201):**
```json
{
  "id": "watch-123",
  "address": "GBZR7...",
  "type": "account",
  "label": "My Account"
}
```

---

#### GET `/monitor/watches`

Get all watches for the current user (requires authentication).

**Request:**
```bash
curl http://localhost:3001/api/v1/monitor/watches \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**
```json
{
  "watches": [
    {
      "id": "watch-123",
      "address": "GBZR7...",
      "type": "account",
      "label": "My Account"
    }
  ]
}
```

---

#### DELETE `/monitor/watches/:id`

Delete a watch (requires authentication).

**Request:**
```bash
curl -X DELETE http://localhost:3001/api/v1/monitor/watches/watch-123 \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (204):**
No content

---

#### POST `/monitor/watches/:id/alerts`

Create an alert for a watch (requires authentication).

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/monitor/watches/watch-123/alerts \
  -H "Content-Type: application/json" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -d '{
    "conditionType": "balance_threshold",
    "threshold": "100.00",
    "channel": "email",
    "destination": "user@example.com"
  }'
```

**Response (201):**
```json
{
  "id": "alert-456",
  "watchId": "watch-123",
  "conditionType": "balance_threshold"
}
```

---

#### GET `/monitor/search`

Search watch events across the current user's watches (requires authentication). Accepts the same filters as the CSV export endpoint.

**Query Parameters:**
- `watchId` (optional): Restrict to a single watch
- `eventType` (optional): `transaction`, `payment`, or `contract`
- `q` (optional): Free-text search across event payloads (hashes, accounts, assets)
- `from` (optional): ISO date — events at or after this time
- `to` (optional): ISO date — events at or before this time
- `page` (optional, default `1`)
- `limit` (optional, default `25`, max `100`)

**Request:**
```bash
curl "http://localhost:3001/api/v1/monitor/search?eventType=payment&q=GBZR7...&limit=50" \
  --cookie "access_token=YOUR_ACCESS_TOKEN"
```

**Response (200):**
```json
{
  "items": [
    {
      "id": "...",
      "watchId": "...",
      "eventType": "payment",
      "payload": {},
      "occurredAt": "2026-08-31T12:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 50,
  "total": 1
}
```

---

#### GET `/monitor/search/export`

Export monitor search results as CSV (requires authentication). Accepts the exact same query parameters as `GET /monitor/search`. The response is a `text/csv` attachment with a UTF-8 BOM; large result sets are streamed in chunks and capped at `10000` rows.

**Request:**
```bash
curl "http://localhost:3001/api/v1/monitor/search/export?eventType=payment&limit=10000" \
  --cookie "access_token=YOUR_ACCESS_TOKEN" \
  -o monitor-search.csv
```

**Response (200):** `text/csv` attachment
```
event_type,occurred_at,amount,asset,from,to,transaction_hash,paging_token,watch_id,payload
```

---

### SDK Generation

#### POST `/sdkgen/generate`

Generate SDK code from a provider spec.

**Request:**
```bash
curl -X POST http://localhost:3001/api/v1/sdkgen/generate \
  -H "Content-Type: application/json" \
  -d '{
    "spec": "fluxa",
    "language": "typescript",
    "endpoint": "https://api.example.com"
  }'
```

**Response (200):**
```json
{
  "code": "// Generated TypeScript SDK\nimport axios from 'axios';\n..."
}
```

---

## Error Reference

### Common HTTP Status Codes

| Code | Meaning | When It Occurs |
|------|---------|----------------|
| `200` | OK | Successful GET, POST, or PUT request |
| `201` | Created | Successful resource creation (POST) |
| `204` | No Content | Successful DELETE request |
| `400` | Bad Request | Invalid request parameters or validation failed |
| `401` | Unauthorized | Missing or invalid authentication token |
| `404` | Not Found | Resource does not exist |
| `422` | Unprocessable Entity | Semantic error in request (e.g., invalid WASM) |
| `500` | Internal Server Error | Unexpected server error |

### SaviTools-Specific Errors

#### `400 Bad Request - Invalid Public Key`
**Meaning:** The Stellar public key provided is malformed or invalid.
**Suggested Resolution:** Verify the public key format (starts with `G`, 56 characters). Use `/wallet/generate` if unsure.

#### `400 Bad Request - Insufficient Balance`
**Meaning:** The source account doesn't have enough native asset to cover the transaction fee and amount.
**Suggested Resolution:** Use `/wallet/fund` to add testnet funds, or send a smaller amount.

#### `401 Unauthorized - Invalid Credentials`
**Meaning:** Email/password combination is incorrect.
**Suggested Resolution:** Double-check your email and password. Register a new account if needed.

#### `401 Unauthorized - Expired Token`
**Meaning:** Your access token has expired (default 15 minutes).
**Suggested Resolution:** Call `POST /auth/refresh` with your refresh token to get a new access token.

#### `404 Not Found - Transaction Not Found`
**Meaning:** The specified transaction hash doesn't exist on the network.
**Suggested Resolution:** Verify the transaction hash is correct and the network (mainnet/testnet) is correct.

#### `422 Unprocessable Entity - Invalid WASM`
**Meaning:** The uploaded file is not a valid Soroban WASM binary.
**Suggested Resolution:** Ensure the file is a compiled `.wasm` file from a Soroban contract.

### Stellar/Horizon Pass-Through Errors

SaviTools proxies some errors directly from the Stellar Horizon API. These errors include:

- **`op_no_trust`**: Destination account doesn't have a trustline for the asset
- **`op_line_full`**: Destination account's limit for the asset is at max
- **`op_underfunded`**: Source account doesn't have enough funds
- **`tx_bad_seq`**: Transaction sequence number is incorrect
- **`tx_bad_auth`**: Transaction hasn't been signed by the required signers

**Example Horizon Error Response:**
```json
{
  "type": "https://stellar.org/horizon-errors/transaction-failed",
  "title": "Transaction Failed",
  "status": 400,
  "detail": "...",
  "extras": {
    "envelope_xdr": "...",
    "result_xdr": "...",
    "result_codes": {
      "transaction": "tx_failed",
      "operations": ["op_no_trust"]
    }
  }
}
```

For a complete list, refer to the [Stellar Horizon API documentation](http://web.archive.org/web/20210613121751/https://developers.stellar.org/api/errors/).

---

## Caching Behavior

### Redis-Cached Endpoints

| Endpoint | TTL | Purpose | Cache Key |
|----------|-----|---------|-----------|
| `GET /network/status` | 60s | Network fees & reserves | `network:status:{network}` |
| `GET /network/status/history` | 300s | Historical fee data | `network:history:{network}` |
| `GET /simulator/paths` | 120s | Payment path results | `paths:{source}:{dest}:{amount}` |
| `GET /playground/spec/:provider` | 3600s | OpenAPI specs | `spec:cache:{provider}` |
| `GET /webhooks/templates` | 86400s | Webhook schema definitions | `webhook:templates` |

### Cache Busting

In development, to clear all cached data:

```bash
# If you have Redis CLI access:
redis-cli FLUSHDB

# Or via the API (clear specific cache):
DELETE /api/v1/admin/cache/network:status:mainnet
```

### Cache Headers

Responses include standard HTTP cache headers:
```
Cache-Control: public, max-age=60
ETag: "abc123..."
Last-Modified: Mon, 21 Jun 2026 12:34:56 GMT
```

---

## Rate Limiting

**Current Status:** No rate limiting is enforced in development/testing. Production deployment will include:
- 100 requests/minute per IP for public endpoints
- 1000 requests/minute per user for authenticated endpoints
- Custom limits for resource-intensive operations (e.g., `/composer/simulate`)

---

## CORS & Security

- **CORS Origin:** Controlled by `WEB_ORIGIN` environment variable (default: `http://localhost:3000`)
- **HTTPS:** Enforced in production; cookies marked with `Secure` flag
- **CSRF Protection:** HTTP-only cookies prevent client-side token theft
- **Input Validation:** All inputs are validated and sanitized server-side

---

## Support & Feedback

- **API Status:** [Check Stellar Horizon Status](https://dashboard.stellar.org/)
- **Bug Reports:** [GitHub Issues](https://github.com/Savitura/Savitools/issues)
- **Questions:** Refer to [Stellar Docs](https://developers.stellar.org/)
