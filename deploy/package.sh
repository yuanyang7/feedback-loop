#!/usr/bin/env bash
# Build the payload to copy to the NAS.
#
# There is nothing to cross-compile: every production dependency is pure
# JavaScript, so node_modules built on an arm64 Mac runs unchanged on the
# amd64 NAS. That fact is what makes a container unnecessary here — check it
# still holds if a dependency is ever added.
#
#   ./deploy/package.sh            -> dist-synology/feedback-loop.tar.gz
#
# Then: copy it to the NAS, extract to /volume1/feedback-loop/app.
set -euo pipefail

GH_VERSION="${GH_VERSION:-2.63.2}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/dist-synology"
stage="$out/app"

rm -rf "$out"
mkdir -p "$stage"

echo "==> building"
cd "$root"
npm ci --silent
npm run build >/dev/null

echo "==> pruning to production dependencies"
# tsx and typescript have no business on a host that runs unattended, and the
# launcher runs dist/ when tsx is absent. This also has to happen *before* the
# portability check below: the dev tree contains fsevents, which is macOS-only
# and would fail a check it has no business being part of.
npm ci --omit=dev --silent

# Anything compiled is built for this machine's architecture and would not run
# on the NAS. Fail loudly rather than shipping a payload that dies at 3am with
# a confusing error.
if find node_modules \( -name '*.node' -o -name '*.so' -o -name '*.dylib' \) -print -quit | grep -q .; then
  echo "error: a production dependency ships a native binary, so this payload is" >&2
  echo "       not portable across architectures. Build it on the NAS instead." >&2
  npm ci --silent
  exit 1
fi

echo "==> staging"
cp -R dist bin package.json package-lock.json "$stage/"
cp -R deploy "$stage/deploy"
cp -R node_modules "$stage/node_modules"
# Put the dev toolchain back, so running this does not leave the checkout
# unable to typecheck or test.
npm ci --silent

echo "==> fetching gh ${GH_VERSION} (linux amd64)"
mkdir -p "$stage/vendor"
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C "$out" "gh_${GH_VERSION}_linux_amd64/bin/gh"
mv "$out/gh_${GH_VERSION}_linux_amd64/bin/gh" "$stage/vendor/gh"
rm -rf "$out/gh_${GH_VERSION}_linux_amd64"
chmod +x "$stage/vendor/gh"

echo "==> packing"
tar -czf "$out/feedback-loop.tar.gz" -C "$out" app
du -sh "$out/feedback-loop.tar.gz"
echo
echo "Copy $out/feedback-loop.tar.gz to the NAS and extract it so that"
echo "/volume1/feedback-loop/app/bin/feedback-loop.mjs exists."
