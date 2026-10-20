#!/usr/bin/env bash
set -euo pipefail
# Publish to Docker Hub using existing Docker credentials, or a supplied token.
# Never prints passwords or tokens. Cross-platform images are pushed by buildx.
image='bdpgogoup/cloudbrowser'
release_tz="${RELEASE_TZ:-Asia/Shanghai}"
tag="${RELEASE_TAG:-$(TZ="$release_tz" date +%Y%m%d%H%M%S)}"
platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
builder="${BUILDER_NAME:-dockerbrowsermcp-release}"
dry_run=false
if [[ "${1:-}" == '--dry-run' ]]; then dry_run=true; shift; fi
if [[ $# -ne 0 || ! "$tag" =~ ^[0-9]{14}$ ]]; then
  printf '%s\n' 'Usage: bash scripts/publish-docker.sh [--dry-run]; RELEASE_TAG must be YYYYMMDDHHMMSS.' >&2
  exit 2
fi
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command=(docker buildx build --builder "$builder" --platform "$platforms" --tag "$image:$tag" --push "$repo_dir")
printf 'Image: %s:%s\nPlatforms: %s\nTimezone: %s\n' "$image" "$tag" "$platforms" "$release_tz"
if "$dry_run"; then printf '%q ' "${command[@]}"; printf '\n'; exit 0; fi
docker info >/dev/null
docker buildx version >/dev/null
if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container >/dev/null
fi
if [[ -n "${DOCKERHUB_TOKEN:-}" ]]; then
  printf '%s' "$DOCKERHUB_TOKEN" | docker login --username bdpgogoup --password-stdin
fi
# Pin the README inside the image to this release. Roll back an ordinary failed push.
readme_file="$repo_dir/README.md"
readme_backup="$(mktemp)"
readme_expected="$(mktemp)"
cp "$readme_file" "$readme_backup"
sed -E "s#bdpgogoup/cloudbrowser:[0-9]{14}#$image:$tag#g" "$readme_backup" > "$readme_expected"
cp "$readme_expected" "$readme_file"
published=false
finish() {
  result=$?
  if ! "$published"; then
    if cmp -s "$readme_file" "$readme_expected"; then
      cp "$readme_backup" "$readme_file"
    else
      printf '%s\n' 'README changed during release; automatic rollback skipped to preserve edits.' >&2
    fi
  fi
  rm -f "$readme_backup" "$readme_expected"
  exit "$result"
}
trap finish EXIT
# No token provided: use docker login credentials already held by Docker.
"${command[@]}"
published=true
printf '\nPublished: %s:%s\n' "$image" "$tag"
printf 'README deployment tag updated to %s\n\n' "$tag"
cat <<'DEPLOY'
docker run -d --init \
  --name cloudbrowser \
  --restart unless-stopped \
  --shm-size=1g \
  -e WEB_PASSWORD=CHANGE_ME \
  -v browser-mcp-data:/data \
DEPLOY
printf '  %s:%s\n' "$image" "$tag"
printf '\nView the generated HTTPS URL: docker logs cloudbrowser\n'
