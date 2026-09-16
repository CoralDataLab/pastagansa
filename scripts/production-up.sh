#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/production-common.sh"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 init|upgrade" >&2
  exit 1
fi
case "$1" in
  init|upgrade) ;;
  *)
    echo "Usage: $0 init|upgrade" >&2
    exit 1
    ;;
esac
validate_production_environment

if [[ "$1" == init ]]; then
  if docker volume inspect pastagansa-production-postgres-data >/dev/null 2>&1; then
    echo "Production database volume already exists; refusing first-install mode." >&2
    exit 1
  fi
else
  if ! docker volume inspect pastagansa-production-postgres-data >/dev/null 2>&1; then
    echo "Production database volume is absent; refusing upgrade mode." >&2
    exit 1
  fi
  if [[ "$("${production_compose[@]}" ps --status running --services postgres)" != postgres ]]; then
    echo "Production PostgreSQL must be running to make and verify a backup before upgrading." >&2
    exit 1
  fi
  backup_file="$("$production_root/scripts/production-backup.sh")"
  echo "Pre-upgrade backup: $backup_file"
  "$production_root/scripts/production-restore-drill.sh" "$backup_file"
fi

"${production_compose[@]}" up --build -d --wait
web_port="$(awk -F= '$1 == "WEB_PORT" { print $2 }' "$production_environment_file" | tail -1)"
web_port="${web_port:-3101}"
curl --fail --silent --show-error "http://127.0.0.1:${web_port}/acceso" >/dev/null
"${production_compose[@]}" ps

if [[ "$1" == init ]]; then
  "$production_root/scripts/production-first-use-check.sh"
fi
echo "Production stack is ready on loopback port ${web_port}; verify HTTPS and off-host backups before issuing real invoices."
