# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in SaviTools, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities.
2. Email security concerns to: **security@savitura.com**
3. Include a detailed description of the vulnerability.
4. If possible, provide steps to reproduce or a proof-of-concept.

We aim to acknowledge reports within 48 hours and will work with you to understand and address the issue promptly.

## Security Measures

SaviTools implements the following security measures:

### API Protection

- **CORS**: Restricted origins via `WEB_ORIGIN` environment variable
- **Rate Limiting**: Configurable via `THROTTLE_LIMIT` and `THROTTLE_TTL`
- **Input Validation**: All API inputs are validated using class-validator

### Webhook Security

- **HMAC-SHA256 Signing**: Outbound webhooks (Webhook Tester, contract-event replay, monitor alerts) are signed with a per-request secret or `WEBHOOK_SIGNING_SECRET`
- **Timestamp Verification**: The signature covers `<timestamp>.<body>`, so a captured request cannot be replayed verbatim. Reject timestamps older than the replay window (default 300s) or more than 60s in the future
- **Signature Header**: `X-SaviTools-Signature` with format `sha256=<hex>`, paired with `X-SaviTools-Timestamp` (integer Unix seconds)

### Authentication

- **JWT Tokens**: Secure session management with refresh token rotation
- **Password Hashing**: Argon2 for password storage

### Network Security

- **SSRF Protection**: Guards on outbound requests from Playground and Webhook modules
- **TLS**: All external API calls use HTTPS

## Security-Related Configuration

| Variable                  | Description                              |
| ------------------------- | ---------------------------------------- |
| `WEB_ORIGIN`              | Allowed CORS origin                      |
| `THROTTLE_TTL`            | Rate limit window (ms)                   |
| `THROTTLE_LIMIT`          | Max requests per window                  |
| `WEBHOOK_SIGNING_SECRET`  | HMAC key for webhook signatures          |
| `JWT_SECRET`              | Secret for JWT token signing             |

## Responsible Disclosure

We appreciate the security research community and will acknowledge researchers who report valid vulnerabilities (with permission) in our release notes.
