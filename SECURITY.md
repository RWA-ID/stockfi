# Security policy

StockFi is a payment-adjacent API: buyers sign USDG authorizations that StockFi
settles through x402Fi's facilitator. Please report payment bugs privately.

**Do not open a public issue for a vulnerability.**

- GitHub: use **Security → Report a vulnerability** on this repository (private advisory).
- Email: contact@stockfi.trade

Especially in scope: a paid response returned without settlement, a settlement
without a response, a wrong amount or payee accepted, an authorization reused,
the upstream secret bypassed, any path that reaches a Longbow write or
transaction-building tool, or SSRF through configured data sources.

There is no bug bounty. We will acknowledge reports within 3 business days.
