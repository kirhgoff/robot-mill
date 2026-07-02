#!/usr/bin/env fish

set remote_user kirhgoff
set remote_host 192.168.0.31
set remote_name peeper
set remote_repo /home/kirhgoff/Projects/robot-mill
set branch main
set profiles
set compose_prefix ""

if test (hostname -s) = $remote_name
    echo "Run this from another machine, not from $remote_name."
    exit 1
end

for arg in $argv
    switch $arg
        case --telegram
            set -a profiles telegram
        case --discord
            set -a profiles discord
        case --web
            set -a profiles web
        case '*'
            set branch $arg
    end
end

if test (count $profiles) -gt 0
    set compose_prefix "COMPOSE_PROFILES="(string join , $profiles)
end

set remote_cmd "set -e; cd $remote_repo; git fetch origin; git checkout $branch; git pull --ff-only origin $branch; mkdir -p data/workspace data/pi-home data/agent-sessions data/target; chmod 777 data/workspace data/pi-home data/agent-sessions data/target; $compose_prefix docker compose up --build -d; docker compose ps; ./host-runner/start.sh; ./health-monitor/start.sh; ./linear-connector/start.sh; curl -fsS http://127.0.0.1:3100/health_check; for i in 1 2 3 4 5; do curl -fsS http://127.0.0.1:3200/health_check && break; sleep 1; done; curl -fsS http://127.0.0.1:3200/health_check"

ssh $remote_user@$remote_host "$remote_cmd"
