#!/usr/bin/env sh
set -eu

dir_has_entries() {
  [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

if [ "${KB1_HOME:-/data/kb1}" = "/data/kb1" ] && dir_has_entries /data/kb2 && ! dir_has_entries /data/kb1; then
  export KB1_HOME=/data/kb2
  printf 'Using existing legacy Docker KB-2 home at /data/kb2. Set KB1_HOME to override.\n' >&2
fi

exec "$@"
