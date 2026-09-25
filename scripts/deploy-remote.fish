#!/usr/bin/env fish

set remote_repo /home/kirhgoff/Projects/robot-mill
set branch main
set telegram_enabled 0

set ssh_target peeper
if set -q ROBOT_MILL_SSH
    set ssh_target $ROBOT_MILL_SSH
end

if test (hostname -s) = peeper
    echo "Run this from another machine, not from peeper."
    exit 1
end

for arg in $argv
    switch $arg
        case --telegram
            set telegram_enabled 1
        case '*'
            set branch $arg
    end
end

set compose_prefix ""
if test $telegram_enabled -eq 1
    set compose_prefix "COMPOSE_PROFILES=telegram"
end

set remote_cmd "set -e; cd $remote_repo; git fetch origin; git checkout $branch; git pull --ff-only origin $branch; mkdir -p data/workspace data/pi-home data/agent-sessions data/target data/telegram; chmod 777 data/workspace data/pi-home data/agent-sessions data/target data/telegram; $compose_prefix docker compose up --build -d; docker compose ps; scripts/start-host.sh host-runner; scripts/start-host.sh linear-connector; scripts/start-host.sh health-monitor; ( crontab -l 2>/dev/null | grep -v 'robot-mill/scripts/boot.sh'; echo @reboot $remote_repo/scripts/boot.sh ) | crontab -; for pair in 3100:/health_check 3200:/health_check 3300:/health 3400:/health_check; do port=\${pair%%:*}; route=\${pair#*:}; ok=0; for i in 1 2 3 4 5; do curl -fsS \"http://127.0.0.1:\$port\$route\" >/dev/null && ok=1 && break; sleep 1; done; if [ \$ok -eq 1 ]; then echo \"port \$port ok\"; else echo \"port \$port FAILED\" >&2; fi; done"

ssh $ssh_target "$remote_cmd"
