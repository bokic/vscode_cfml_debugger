#!/usr/bin/env bash

set -e

# Change directory to the root of the repository
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== Building VS Code Extension VSIX Package ==="

# Check if node_modules exists, install if missing
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Clean and compile TypeScript files
echo "Compiling TypeScript..."
npm run compile

# Package into VSIX using @vscode/vsce
echo "Packaging extension into VSIX..."
npx -y @vscode/vsce package

echo "============================================="
VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -n 1)
if [ -n "$VSIX_FILE" ]; then
    echo "SUCCESS: Created $VSIX_FILE"
    echo "To install in VS Code, run:"
    echo "  code --install-extension $VSIX_FILE"
else
    echo "ERROR: Failed to find packaged .vsix file."
    exit 1
fi
