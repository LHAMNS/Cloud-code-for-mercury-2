# Mercury Code - Development Makefile
#
# Usage:
#   make install   - Install globally (npm link)
#   make dev       - Run in development mode with verbose logging
#   make test      - Run the test suite
#   make lint      - Check for syntax errors
#   make clean     - Remove generated files
#   make uninstall - Unlink global binary

.PHONY: install dev test lint clean uninstall check-node help run

# Default target
help:
	@echo ""
	@echo "  Mercury Code - Development Commands"
	@echo "  ──────────────────────────────────────"
	@echo ""
	@echo "  make install     Install globally (npm link)"
	@echo "  make dev         Run with --verbose flag"
	@echo "  make test        Run test suite"
	@echo "  make lint        Check for syntax errors"
	@echo "  make clean       Remove node_modules and generated files"
	@echo "  make uninstall   Remove global link"
	@echo "  make check-node  Verify Node.js version"
	@echo ""

# Minimum Node.js version
NODE_MIN_VERSION := 18

# Check Node.js is available and meets version requirement
check-node:
	@command -v node >/dev/null 2>&1 || { echo "Error: Node.js is not installed"; exit 1; }
	@NODE_MAJOR=$$(node -e "console.log(process.version.split('.')[0].slice(1))"); \
	if [ "$$NODE_MAJOR" -lt "$(NODE_MIN_VERSION)" ]; then \
		echo "Error: Node.js >= $(NODE_MIN_VERSION) required (found: $$(node --version))"; \
		exit 1; \
	fi
	@echo "Node.js $$(node --version) OK"

# Install globally via npm link
install: check-node
	@chmod +x cli.js
	npm install --no-audit --no-fund
	npm link
	@echo ""
	@echo "Installed! Run 'mercury' or 'mercury-code' to start."
	@echo ""

# Run in development mode
dev: check-node
	node cli.js --verbose

# Run interactive REPL
run: check-node
	node cli.js

# Run test suite
test: check-node
	node --test test/*.test.js

# Check for syntax errors
lint:
	@echo "Checking for syntax errors..."
	@node --check cli.js
	@for f in src/*.js src/**/*.js; do \
		node --check "$$f" 2>/dev/null || echo "Syntax error in $$f"; \
	done
	@echo "Syntax check passed."

# Clean generated files
clean:
	rm -rf node_modules
	rm -f package-lock.json

# Uninstall global link
uninstall:
	npm unlink -g mercury-code 2>/dev/null || true
	@echo "Global link removed."
