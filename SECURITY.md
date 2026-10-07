# Security

- Never commit secrets or production contact data.
- All operational `/v1/*` endpoints require `x-api-key`.
- Outbound email is approval-gated and suppression-aware.
- High-impact public claims, media responses and outreach must remain human-approved.
- Report suspected vulnerabilities privately to the repository owner.
