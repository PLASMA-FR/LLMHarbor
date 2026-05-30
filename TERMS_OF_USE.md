# Terms of Use — LLMHarbor

**Last updated: May 2026**

LLMHarbor is an open-source, self-hosted routing proxy. You are responsible for your own use of this tool and your upstream provider accounts.

## Provider Accounts

LLMHarbor supports multiple LLM provider integrations including direct API keys, browser OAuth flows, and local endpoints. Each provider has its own terms of service and usage policies.

## Antigravity (Google OAuth)

**Paid Antigravity accounts may be banned by Google for using this tool.** If you connect an Antigravity/Google OAuth account through LLMHarbor, Google may flag or suspend the account because:

- The bundled OAuth client used by LLMHarbor is shared across many users and not a Google-verified first-party application.
- The device-code OAuth flow may not match expected usage patterns for normal consumer accounts.
- Repeated token refreshes and automated model discovery requests can resemble bot-like activity.

**Advice: Use a free Google account — not your primary or work account — when connecting Antigravity OAuth through LLMHarbor.** Free accounts are less likely to be permanently suspended for OAuth pattern violations. Do not connect a Google Workspace account or an account tied to paid Google services.

LLMHarbor is not affiliated with, endorsed by, or sponsored by Google LLC.

## Free-Tier Providers

- **Google AI Studio (free tier)**: Rate limits and availability are subject to Google's policies.
- **OpenAI (free tier)**: API access requires an OpenAI account with acceptable usage history.
- **OpenRouter (free tier)**: Model availability and quotas are controlled by OpenRouter.

LLMHarbor is not responsible for account bans, rate limit changes, or service disruptions from upstream providers.

## Your Responsibility

By using LLMHarbor, you agree that:

1. You are responsible for complying with each provider's terms of service.
2. You will not use LLMHarbor to exceed fair-use limits or circumvent paid access requirements.
3. You accept that upstream providers may change their OAuth policies, rate limits, or API availability at any time without notice.
4. LLMHarbor contributors are not liable for any account suspension, data loss, or service interruption caused by upstream provider decisions.

## Changes to These Terms

These terms may be updated as provider integrations evolve. Check the source repository for the most recent version.