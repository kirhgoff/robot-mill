# robot-mill

Being rewritten as an agent farm on mimi.local. The brief and PR plan are in `HANDOFF.md`.

- Checks: `mise run check` runs tsc and knip on `mill/`, plus typos, betterleaks, actionlint, zizmor, shellcheck and agnix. CI runs the same.
- `mise run setup` installs dependencies and git hooks.
- Webhook endpoints are public through Cloudflare Tunnel, so signature verification is in review scope. The localhost MCP server stays unauthenticated.
- Install on mimi: run `scripts/setup-wizard.sh` (stage 1 from Kirill's account, the rest as `millwright`). It runs `install.sh`, which is idempotent, refuses any user but `$MILL_USER` (default `millwright`), and is tested by `install.test.sh` in a temp `HOME` with stubbed tools. Never run `install.sh` outside that harness on a personal account.
- Secrets live in `~/.config/mill/mill.env` (template: `mill/mill.env.example`); `main.ts serve` loads it and refuses to start with required keys missing.
