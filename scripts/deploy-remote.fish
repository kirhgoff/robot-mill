#!/usr/bin/env fish

set remote_user kirhgoff
set remote_host 192.168.0.31
set remote_name peeper
set remote_repo /home/kirhgoff/Projects/robot-mill
set branch main
set compose_prefix ""

if test (hostname -s) = $remote_name
    echo "Run this from another machine, not from $remote_name."
    exit 1
end

for arg in $argv
    switch $arg
        case --telegram
            set compose_prefix "COMPOSE_PROFILES=telegram"
        case '*'
            set branch $arg
    end
end

ssh $remote_user@$remote_host "set -e; cd $remote_repo; git fetch origin; git checkout $branch; git pull --ff-only origin $branch; mkdir -p target-data; chmod 777 target-data; $compose_prefix docker compose up --build -d; docker compose ps; curl -fsS http://127.0.0.1:3100/health_check"
