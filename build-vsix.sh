#!/usr/bin/env bash

set -e

# Change directory to the root of the repository
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building VS Code Extension VSIX Package ==="

# Determine version dynamically from git tag, commit count, and working state
LATEST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
    BASE_VERSION=$(node -p "require('./package.json').version")
    COMMITS_COUNT=$(git rev-list --count HEAD 2>/dev/null || echo "0")
else
    BASE_VERSION="${LATEST_TAG#v}"
    COMMITS_COUNT=$(git rev-list "${LATEST_TAG}..HEAD" --count 2>/dev/null || echo "0")
fi

VERSION="$BASE_VERSION"

# Append commit count if there are commits after tag (e.g. ~12)
if [ "$COMMITS_COUNT" -gt 0 ]; then
    VERSION="${VERSION}~${COMMITS_COUNT}"
fi

# Append -dirty if working directory has uncommitted changes
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    VERSION="${VERSION}-dirty"
fi

echo "Target Version: $VERSION"

# Check if node_modules exists, install if missing
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Clean and compile TypeScript files
echo "Compiling TypeScript..."
npm run compile

# Package into VSIX using @vscode/vsce with dynamic version
echo "Packaging extension into VSIX (version $VERSION)..."
npx -y @vscode/vsce package "$VERSION" --no-update-package-json

echo "============================================="
VSIX_FILE="vscode-cfml-debugger-${VERSION}.vsix"
if [ -f "$VSIX_FILE" ]; then
    echo "SUCCESS: Created $VSIX_FILE"
    echo "To install in VS Code, run:"
    echo "  code --install-extension $VSIX_FILE"
else
    echo "ERROR: Failed to find packaged .vsix file."
    exit 1
fi
