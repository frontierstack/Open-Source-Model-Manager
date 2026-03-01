#!/bin/bash

# Reset All User Accounts Script
# This script will delete all user accounts from the system

set -e

echo "=========================================="
echo "  Reset All User Accounts"
echo "=========================================="
echo ""
echo "WARNING: This will delete ALL user accounts!"
echo "This action cannot be undone."
echo ""
read -p "Are you sure you want to continue? (type 'YES' to confirm): " CONFIRM

if [ "$CONFIRM" != "YES" ]; then
    echo "Aborted."
    exit 1
fi

echo ""
echo "Deleting all user accounts..."

# Remove the users.json file (host path)
USERS_FILE="/home/webapp/lmstudio/models/.modelserver/users.json"

if [ -f "$USERS_FILE" ]; then
    rm -f "$USERS_FILE"
    echo "✓ All user accounts have been deleted"
    echo "✓ Users file removed: $USERS_FILE"
else
    echo "✓ No users file found - nothing to delete"
fi

# Also clear sessions
echo ""
echo "Clearing active sessions..."
docker exec modelserver-webapp-1 rm -rf /models/.modelserver/sessions/* 2>/dev/null || true
echo "✓ Sessions cleared"

echo ""
echo "=========================================="
echo "  Reset Complete"
echo "=========================================="
echo ""
echo "All user accounts have been removed."
echo "Users will need to register again at https://localhost:3001"
echo ""
