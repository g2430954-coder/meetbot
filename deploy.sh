#!/bin/bash

echo "🚀 GHOST-meet | Rapid Deploy Engine"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Save credentials so they don't ask again
git config --global credential.helper store

# 2. Sync changes
echo "📦 Staging changes..."
git add .

# 3. Commit
echo "💾 Locking kernel updates..."
git commit -m "Upgrade Anti-Ban Stealth & Realistic Human Identity Engine"

# 4. Push
echo "📡 Pushing to GitHub (If asked for password, use your PAT Token)..."
git push origin main

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ DEPLOY SIGNAL SENT!"
echo "Now check Render for auto-deploy status."
