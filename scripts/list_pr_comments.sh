#!/bin/bash
# Usage: ./list_pr_comments.sh <PR_NUMBER> [--json]
#   --json   Emit review (inline) comments as a JSON array to stdout instead of
#            human-readable text. Useful for feeding into other tools, e.g.
#            remote-diff.ts's --comments flag.
# Requires REPO and GH_TOKEN env vars to be set (see gh-guide skill setup script)

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <PR_NUMBER> [--json]"
  exit 1
fi

PR_NUMBER="$1"
MODE="${2:-text}"

if [ "$MODE" = "--json" ]; then
  # Structured output: just the inline review comments, since those are the
  # ones that map to specific file/line locations in a diff.
  gh api "repos/$REPO/pulls/$PR_NUMBER/comments" \
    --jq '[.[] | {path: .path, line: .line, original_line: .original_line, side: .side, author: .user.login, body: .body}]'
  exit 0
fi

echo "=== Issue comments on PR #$PR_NUMBER ==="
gh api "repos/$REPO/issues/$PR_NUMBER/comments" \
  --jq '.[] | "[\(.user.login)] \(.created_at)\n\(.body)\n---"'

echo ""
echo "=== Review comments (inline code comments) on PR #$PR_NUMBER ==="
gh api "repos/$REPO/pulls/$PR_NUMBER/comments" \
  --jq '.[] | "[\(.user.login)] \(.path):\(.line // .original_line)\n\(.body)\n---"'

echo ""
echo "=== Review summaries on PR #$PR_NUMBER ==="
gh api "repos/$REPO/pulls/$PR_NUMBER/reviews" \
  --jq '.[] | select(.body != "") | "[\(.user.login)] state=\(.state)\n\(.body)\n---"'
