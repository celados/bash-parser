#!/usr/bin/env bash
# The Go test runs in the upstream package to access its private test tables.
set -euo pipefail
cd "$(dirname "$0")/.."
root=$PWD
commit=6f0102cc00b2024fdffb1f6b8a15d0d586cd5324
src=.scratch/mvdan
mkdir -p "$src"
if ! git -C "$src" rev-parse --verify "$commit^{commit}" >/dev/null 2>&1; then
  git init -q "$src"
  git -C "$src" fetch --depth=1 https://github.com/mvdan/sh.git "$commit"
fi
scratch=$(mktemp -d "$root/.scratch/corpus.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT
git -C "$src" archive "$commit" | tar -x -C "$scratch"
cp scripts/extract.go "$scratch/syntax/corpus_test.go"
(cd "$scratch" && BASH_PARSER_CORPUS="$root/scripts/corpus.json" MVDAN_COMMIT="$commit" go test ./syntax -run '^TestCorpus$' -count=1)
bunx --no-install vp fmt scripts/corpus.json
