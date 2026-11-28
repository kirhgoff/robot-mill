# robot-mill

Being rewritten as an agent farm on mimi.local. The brief and PR plan are in `HANDOFF.md`.

- Checks: `mise run check` runs tsc and knip on `mill/`, plus typos, betterleaks, actionlint, zizmor, shellcheck and agnix. CI runs the same.
- `mise run setup` installs dependencies and git hooks.
- Webhook endpoints are public through Cloudflare Tunnel, so signature verification is in review scope. The localhost MCP server stays unauthenticated.
