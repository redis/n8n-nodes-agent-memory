# Security Policy

## Supported Versions

`@redis/n8n-nodes-agent-memory` stays backwards compatible with very few
exceptions, so use the latest version for stability, performance and
security. Only the latest release receives fixes.

The node does not store credentials itself. Your Agent Memory API key lives in
n8n's credential store and is sent to your Agent Memory service as a bearer
token. Keep the service URL on HTTPS.

## Reporting a Vulnerability

If you believe you have found a security vulnerability, to ensure proper review and assessment, we kindly ask
vulnerability reports be submitted through the
[Redis Vulnerability Disclosure Program](https://redis.io/redis-responsible-vulnerability-disclosure/).
Alternatively reach out via email to security@redis.com.

