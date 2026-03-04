#!/bin/bash

# User Account Management Script
# Provides tools to list, reset passwords, and manage user accounts

set -e

# Path inside container (for docker exec commands)
CONTAINER_USERS_FILE="/models/.modelserver/users.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Dynamically detect the webapp container name
detect_webapp_container() {
    # Try common container name patterns
    local patterns=("modelserver-webapp-1" "modelserver_webapp_1" "opensourcemodelmanager-webapp-1" "opensourcemodelmanager_webapp_1")

    for pattern in "${patterns[@]}"; do
        if docker ps --format '{{.Names}}' | grep -q "^${pattern}$"; then
            echo "$pattern"
            return 0
        fi
    done

    # Fallback: search for any container with 'webapp' in the name from modelserver/opensourcemodelmanager project
    local container=$(docker ps --format '{{.Names}}' | grep -E "(modelserver|opensourcemodelmanager).*webapp" | head -1)
    if [ -n "$container" ]; then
        echo "$container"
        return 0
    fi

    echo ""
    return 1
}

# Get webapp container name
WEBAPP_CONTAINER=$(detect_webapp_container)

if [ -z "$WEBAPP_CONTAINER" ]; then
    echo -e "${RED}Error: Could not find webapp container. Make sure the server is running.${NC}"
    echo "Run './start.sh' to start the server first."
    exit 1
fi

show_menu() {
    echo ""
    echo "=========================================="
    echo "  User Account Management"
    echo "=========================================="
    echo -e "  ${GREEN}Container: $WEBAPP_CONTAINER${NC}"
    echo ""
    echo "1) List all users"
    echo "2) Reset user password"
    echo "3) Delete a user"
    echo "4) Delete ALL users"
    echo "5) Create admin user"
    echo "6) Exit"
    echo ""
}

list_users() {
    echo ""
    echo "Current users:"
    echo "----------------------------------------"

    # Use docker exec to read and parse users.json inside the container
    docker exec "$WEBAPP_CONTAINER" sh -c "
        if [ ! -f '$CONTAINER_USERS_FILE' ]; then
            echo 'No users found.'
            exit 0
        fi
        cat '$CONTAINER_USERS_FILE' | jq -r '.[] | \"\(.username) (\(.email)) - Role: \(.role) - Created: \(.createdAt)\"' 2>/dev/null || echo 'No users found or invalid JSON'
    "
}

reset_password() {
    echo ""
    read -p "Enter username: " USERNAME

    if [ -z "$USERNAME" ]; then
        echo -e "${RED}Error: Username cannot be empty${NC}"
        return
    fi

    read -sp "Enter new password: " PASSWORD
    echo ""
    read -sp "Confirm new password: " PASSWORD_CONFIRM
    echo ""

    if [ "$PASSWORD" != "$PASSWORD_CONFIRM" ]; then
        echo -e "${RED}Error: Passwords do not match${NC}"
        return
    fi

    if [ ${#PASSWORD} -lt 6 ]; then
        echo -e "${RED}Error: Password must be at least 6 characters${NC}"
        return
    fi

    # Use Node.js to update the password with bcrypt
    docker exec "$WEBAPP_CONTAINER" node -e "
        const fs = require('fs');
        const bcrypt = require('bcryptjs');
        const path = '/models/.modelserver/users.json';

        try {
            const users = JSON.parse(fs.readFileSync(path, 'utf8'));
            const userIndex = users.findIndex(u => u.username.toLowerCase() === '$USERNAME'.toLowerCase());

            if (userIndex === -1) {
                console.error('User not found');
                process.exit(1);
            }

            const salt = bcrypt.genSaltSync(10);
            const passwordHash = bcrypt.hashSync('$PASSWORD', salt);

            users[userIndex].passwordHash = passwordHash;
            users[userIndex].updatedAt = new Date().toISOString();

            fs.writeFileSync(path, JSON.stringify(users, null, 2));
            console.log('Password reset successfully');
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    "

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Password reset successfully for user: $USERNAME${NC}"
    else
        echo -e "${RED}✗ Failed to reset password${NC}"
    fi
}

delete_user() {
    echo ""
    read -p "Enter username to delete: " USERNAME

    if [ -z "$USERNAME" ]; then
        echo -e "${RED}Error: Username cannot be empty${NC}"
        return
    fi

    read -p "Are you sure you want to delete user '$USERNAME'? (yes/no): " CONFIRM

    if [ "$CONFIRM" != "yes" ]; then
        echo "Cancelled."
        return
    fi

    docker exec "$WEBAPP_CONTAINER" node -e "
        const fs = require('fs');
        const path = '/models/.modelserver/users.json';

        try {
            const users = JSON.parse(fs.readFileSync(path, 'utf8'));
            const filtered = users.filter(u => u.username.toLowerCase() !== '$USERNAME'.toLowerCase());

            if (filtered.length === users.length) {
                console.error('User not found');
                process.exit(1);
            }

            fs.writeFileSync(path, JSON.stringify(filtered, null, 2));
            console.log('User deleted successfully');
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    "

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ User deleted: $USERNAME${NC}"
    else
        echo -e "${RED}✗ Failed to delete user${NC}"
    fi
}

delete_all_users() {
    echo ""
    echo -e "${RED}WARNING: This will delete ALL user accounts and sessions!${NC}"
    echo "This action cannot be undone."
    echo ""
    read -p "Type 'DELETE ALL' to confirm: " CONFIRM

    if [ "$CONFIRM" != "DELETE ALL" ]; then
        echo "Cancelled."
        return
    fi

    # Use docker exec to delete users file inside the container
    docker exec "$WEBAPP_CONTAINER" sh -c "
        if [ -f '$CONTAINER_USERS_FILE' ]; then
            rm -f '$CONTAINER_USERS_FILE'
            echo 'All user accounts deleted'
        else
            echo 'No users file found.'
        fi
    "

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ All user accounts deleted${NC}"
    fi

    # Also clear active sessions
    echo ""
    echo "Clearing active sessions..."
    docker exec "$WEBAPP_CONTAINER" rm -rf /models/.modelserver/sessions/* 2>/dev/null || true
    echo -e "${GREEN}✓ Sessions cleared${NC}"

    echo ""
    echo "Users will need to register again at https://localhost:3001"
}

create_admin() {
    echo ""
    read -p "Enter admin username: " USERNAME
    read -p "Enter admin email: " EMAIL
    read -sp "Enter admin password: " PASSWORD
    echo ""
    read -sp "Confirm password: " PASSWORD_CONFIRM
    echo ""

    if [ "$PASSWORD" != "$PASSWORD_CONFIRM" ]; then
        echo -e "${RED}Error: Passwords do not match${NC}"
        return
    fi

    docker exec "$WEBAPP_CONTAINER" node -e "
        const fs = require('fs');
        const bcrypt = require('bcryptjs');
        const crypto = require('crypto');
        const path = '/models/.modelserver/users.json';

        try {
            let users = [];
            if (fs.existsSync(path)) {
                users = JSON.parse(fs.readFileSync(path, 'utf8'));
            }

            // Check if user exists
            if (users.find(u => u.username.toLowerCase() === '$USERNAME'.toLowerCase())) {
                console.error('Username already exists');
                process.exit(1);
            }

            if (users.find(u => u.email.toLowerCase() === '$EMAIL'.toLowerCase())) {
                console.error('Email already exists');
                process.exit(1);
            }

            const salt = bcrypt.genSaltSync(10);
            const passwordHash = bcrypt.hashSync('$PASSWORD', salt);

            const user = {
                id: crypto.randomUUID(),
                username: '$USERNAME',
                email: '$EMAIL',
                passwordHash: passwordHash,
                role: 'admin',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };

            users.push(user);

            // Create directory if needed
            const dir = require('path').dirname(path);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(path, JSON.stringify(users, null, 2));
            console.log('Admin user created successfully');
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    "

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Admin user created: $USERNAME${NC}"
    else
        echo -e "${RED}✗ Failed to create admin user${NC}"
    fi
}

# Main loop
while true; do
    show_menu
    read -p "Select an option (1-6): " CHOICE

    case $CHOICE in
        1) list_users ;;
        2) reset_password ;;
        3) delete_user ;;
        4) delete_all_users ;;
        5) create_admin ;;
        6) echo "Goodbye!"; exit 0 ;;
        *) echo -e "${RED}Invalid option${NC}" ;;
    esac
done
