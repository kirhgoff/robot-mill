#!/usr/bin/env bash
tmux attach -t "pi-${1:?usage: attach.sh <project>}"
