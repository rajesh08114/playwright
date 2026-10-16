# Discovery milestone

`testswarm discover` launches an isolated Chromium context, starts at the configured path, follows same-origin links up to a bounded route budget, and records titles, headings, forms, and interactive elements. It never follows external origins and does not submit forms.

The result distinguishes browser-observed routes from future source-derived observations and includes confidence and warnings. The same service is exposed as `testswarm_discover` over MCP.
