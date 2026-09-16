#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/production-common.sh"
validate_production_environment

backup_directory="$production_root/backups/production"
umask 077
mkdir -p "$backup_directory"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_file="$(mktemp "$backup_directory/pastagansa-production-${timestamp}.XXXXXX.dump")"
trap 'rm -f "$backup_file"' EXIT

"${production_compose[@]}" exec -T postgres \
  pg_dump --username pastagansa_admin --dbname pastagansa --format=custom \
  --no-owner --no-acl >"$backup_file"
if [[ ! -s "$backup_file" ]]; then
  echo "Production backup is empty." >&2
  exit 1
fi
trap - EXIT
echo "$backup_file"
