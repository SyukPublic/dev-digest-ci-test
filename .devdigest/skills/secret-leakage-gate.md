# Secret Leakage Gate

Flag any committed credential in the diff. Treat as CRITICAL:
- Stripe keys (`sk_live_`, `sk_test_`), AWS keys (`AKIA…`), `service_role` JWTs.
- `NEXT_PUBLIC_*` env vars holding anything secret (they ship to the browser).
Recommend rotation + moving the value to a secret store.