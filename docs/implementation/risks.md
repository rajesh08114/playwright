# Risks and limitations

- Checks are deterministic and page-level: each case navigates to a route and inspects it. Multi-step user journeys are not executed.
- Visual baselines depend on browser version, OS fonts, and GPU rasterisation. Approve baselines on the platform that will compare against them.
- Discovery follows anchors, `target.routes`, and `sitemap.xml`. Routes reachable only through script-driven navigation without anchors must be listed in `target.routes`.
- Axe-core finds a subset of accessibility issues; a passing accessibility case is not a conformance claim.
- Screenshots and traces can contain sensitive page content. Redaction covers console and network text only; use `policy.maskSelectors` for page regions.
- `node:sqlite` is still flagged experimental by Node.js (the warning is suppressed); the store is behind the `Store` interface if it needs replacing.
- A run marked `running` whose process died is not detected automatically; resume it with `resume --force`.
