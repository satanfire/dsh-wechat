# Security policy

The currently maintained preview is 0.3.x, with support limited to the Harness runtime version declared in package.json. This is a personal, single-owner integration, not a multi-tenant server.

For a vulnerability, use GitHub's private vulnerability reporting if available: https://github.com/satanfire/dsh-wechat/security/advisories/new. If private reporting is unavailable, open an Issue asking for a private contact channel without posting exploit details or sensitive data. No response-time SLA is promised.

Include the plugin/Harness/Node versions, the affected boundary, and a minimal reproduction with fake credentials. Never upload bot tokens, QR codes, context tokens, signed media URLs, credentials storage, raw store.json, or private chat logs.

The Host runs plugin code in-process. The bridge relies on Harness Connection authentication and tool authorization; it is not an additional sandbox. Phone approval is single-use and requires a verified WeChat turn. Review the full concrete operation before approving. Oversized/unverified operations fall back to Web.

Known boundaries: local state contains private message content; unknown delivery is not automatically repeated; provider deduplication and indefinite context validity are unverified; the offline recovery script must run with the Harness profile process stopped. Read the README before changing state or clearing locks.
