#!/bin/bash

# Koda Refactoring Tools Demo
# This script demonstrates the new refactoring capabilities

cat << "EOF"
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║           Koda CLI - Refactoring Tools Demo                 ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

This demo showcases the new code refactoring features in Koda CLI:

  1. Extract Function - Extract code blocks into reusable functions
  2. Rename Symbol - Rename variables, functions, and classes
  3. Move Code - Move functions/classes between files

EOF

echo "Press Enter to continue..."
read

# Create a demo directory
DEMO_DIR="/tmp/koda-refactor-demo"
mkdir -p "$DEMO_DIR"
cd "$DEMO_DIR"

echo ""
echo "📁 Creating demo project..."
echo ""

# Create sample files
cat > app.js << 'JSEOF'
const express = require('express');
const app = express();

function processOrder(order) {
    // Lines 6-12: Extract this to validateOrder()
    const hasProduct = order.product && order.product.length > 0;
    const hasQuantity = order.quantity && order.quantity > 0;
    const hasPrice = order.price && order.price > 0;
    const hasCustomer = order.customer && order.customer.name;

    const isValid = hasProduct && hasQuantity && hasPrice && hasCustomer;
    console.log('Order validation:', isValid);

    if (!isValid) {
        return { error: 'Invalid order' };
    }

    // Lines 17-20: Move this to utils.js as calculateTotal()
    const subtotal = order.price * order.quantity;
    const tax = subtotal * 0.1;
    const total = subtotal + tax;
    console.log('Total:', total);

    return { valid: true, total };
}

// Rename this function from calc to calculateDiscount
function calc(amount, percent) {
    return amount * (percent / 100);
}

app.post('/order', (req, res) => {
    const result = processOrder(req.body);
    const discount = calc(result.total, 10);
    res.json({ ...result, discount });
});

app.listen(3000);
JSEOF

cat > utils.js << 'JSEOF'
// Utility functions will go here

function formatCurrency(amount) {
    return '$' + amount.toFixed(2);
}

module.exports = { formatCurrency };
JSEOF

echo "✓ Created app.js with code that needs refactoring"
echo "✓ Created utils.js for utility functions"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Demo 1: Extract Function"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The processOrder() function has complex validation logic"
echo "spanning lines 6-12. Let's extract it into a separate function."
echo ""
echo "Command:"
echo "  /refactor extract app.js 6 12 validateOrder"
echo ""
echo "This will:"
echo "  • Analyze the code to detect parameters (order)"
echo "  • Create a new validateOrder() function"
echo "  • Replace the original code with a function call"
echo "  • Detect and handle the return value (isValid)"
echo ""

echo "Press Enter to see the result..."
read

echo "After extraction:"
cat << 'RESULT'
function processOrder(order) {
    const isValid = validateOrder(order);

    if (!isValid) {
        return { error: 'Invalid order' };
    }
    // ... rest of function
}

function validateOrder(order) {
    const hasProduct = order.product && order.product.length > 0;
    const hasQuantity = order.quantity && order.quantity > 0;
    const hasPrice = order.price && order.price > 0;
    const hasCustomer = order.customer && order.customer.name;

    const isValid = hasProduct && hasQuantity && hasPrice && hasCustomer;
    console.log('Order validation:', isValid);
}
RESULT

echo ""
echo "✓ Code is now more modular and easier to test!"
echo ""

echo "Press Enter to continue..."
read

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Demo 2: Rename Symbol"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The function 'calc' is poorly named. Let's rename it to"
echo "'calculateDiscount' for better clarity."
echo ""
echo "Command:"
echo "  /refactor rename app.js calc calculateDiscount"
echo ""
echo "This will:"
echo "  • Find all references to 'calc' using AST parsing"
echo "  • Show locations of each reference"
echo "  • Rename all occurrences (function declaration and calls)"
echo ""

echo "Press Enter to see the result..."
read

echo "Found 2 occurrence(s) at:"
echo "  • Line 27, Column 9  - function declaration"
echo "  • Line 33, Column 21 - function call"
echo ""
echo "After renaming:"
cat << 'RESULT'
function calculateDiscount(amount, percent) {
    return amount * (percent / 100);
}

app.post('/order', (req, res) => {
    const result = processOrder(req.body);
    const discount = calculateDiscount(result.total, 10);
    res.json({ ...result, discount });
});
RESULT

echo ""
echo "✓ Code is now more readable and self-documenting!"
echo ""

echo "Press Enter to continue..."
read

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Demo 3: Move Code Between Files"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Lines 17-20 calculate the order total. This is utility logic"
echo "that should be in utils.js, not in the route handler."
echo ""
echo "First, we'd extract it to a function, then move it:"
echo ""
echo "Command 1:"
echo "  /refactor extract app.js 17 20 calculateTotal"
echo ""
echo "Command 2:"
echo "  /refactor move app.js utils.js calculateTotal"
echo ""
echo "This will:"
echo "  • Extract the calculateTotal function from app.js"
echo "  • Move it to utils.js"
echo "  • Add 'export { calculateTotal }' to utils.js"
echo "  • Add import statement to app.js"
echo ""

echo "Press Enter to see the result..."
read

echo "After moving:"
echo ""
echo "app.js:"
cat << 'RESULT'
import { calculateTotal } from './utils';
const express = require('express');
const app = express();

function processOrder(order) {
    // ... validation code ...

    const total = calculateTotal(order.price, order.quantity);

    return { valid: true, total };
}
RESULT

echo ""
echo "utils.js:"
cat << 'RESULT'
function formatCurrency(amount) {
    return '$' + amount.toFixed(2);
}

function calculateTotal(price, quantity) {
    const subtotal = price * quantity;
    const tax = subtotal * 0.1;
    const total = subtotal + tax;
    console.log('Total:', total);
}

export { formatCurrency, calculateTotal };
RESULT

echo ""
echo "✓ Utility functions are now properly organized!"
echo ""

echo "Press Enter to continue..."
read

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Additional Features"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "✓ Diff Preview - See changes before applying them"
echo "✓ Smart Parameter Detection - Automatically determines function parameters"
echo "✓ Return Value Handling - Detects and preserves return statements"
echo "✓ Working Set Integration - Updates files in your working set"
echo "✓ AST-Based Analysis - Accurate parsing with Babel"
echo "✓ Multi-Language Support - JavaScript, TypeScript, JSX, TSX"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Getting Started"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "1. Add files to working set:"
echo "   /add-file src/app.js"
echo ""
echo "2. Analyze code quality:"
echo "   /quality src/app.js"
echo ""
echo "3. Refactor code:"
echo "   /refactor extract src/app.js 10 20 myFunction"
echo "   /refactor rename src/app.js oldName newName"
echo "   /refactor move src/app.js src/utils.js myFunction"
echo ""
echo "4. Review and confirm changes"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Demo files created in: $DEMO_DIR"
echo ""
echo "Try the refactoring commands yourself:"
echo "  cd $DEMO_DIR"
echo "  koda"
echo "  /add-file app.js"
echo "  /refactor extract app.js 6 12 validateOrder"
echo ""
echo "For more information, see: REFACTORING.md"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
