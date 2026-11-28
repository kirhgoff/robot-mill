# robot-mill

A self-hosted agent farm on mimi.local: Telegram or Linear in, reviewed PRs out.

The design and PR plan are in [HANDOFF.md](HANDOFF.md). The code lives in `mill/`.

## Install

On mimi, as the `millwright` macOS user: `scripts/setup-wizard.sh` walks through the manual steps and runs `install.sh`, which installs the tools, links the skills and loads the LaunchAgents. Re-running `install.sh` changes nothing.
