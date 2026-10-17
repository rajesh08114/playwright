# Risks and limitations

- Route checks are page-level. Multi-step behaviour is covered only by the journeys you configure (or approve from `plan-ai`); TestSwarm does not infer business rules on its own.
- Model-proposed journeys can be wrong or shallow. They are validated for structure, not for meaning; review them before relying on them.
- Scripted login cannot pass MFA or CAPTCHA; record a storage state manually for those apps.
- Visual baselines depend on browser version, OS fonts, and GPU rasterisation. Approve baselines on the platform that will compare against them.
- Discovery follows anchors, `target.routes`, and `sitemap.xml`. Routes reachable only through script-driven navigation without anchors must be listed in `target.routes`.
- Axe-core finds a subset of accessibility issues; a passing accessibility case is not a conformance claim.
- Screenshots and traces can contain sensitive page content. Redaction covers console and network text only; use `policy.maskSelectors` for page regions.
- `node:sqlite` is still flagged experimental by Node.js (the warning is suppressed); the store is behind the `Store` interface if it needs replacing.
- A run is reported stale after 2 minutes without a heartbeat; a process paused (not dead) for longer can be resumed twice, so prefer `cancel` before `resume` when unsure.
