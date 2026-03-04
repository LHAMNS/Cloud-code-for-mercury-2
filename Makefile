# Mercury Code - Development & Release Makefile
#
# Development:
#   make install     Install globally (npm link)
#   make dev         Run in development mode
#   make test        Run the test suite
#   make lint        Check for syntax errors
#
# Release:
#   make build       Build standalone binaries for all platforms
#   make build-win   Build Windows binaries only
#   make build-mac   Build macOS binaries only
#   make build-linux Build Linux binaries only
#   make release     Full release (test + build + archives + checksums)
#   make publish     Publish to npm registry
#   make clean       Remove build artifacts

.PHONY: install dev test lint clean uninstall check-node help run build build-win build-mac build-linux release publish

# Default target
help:
	@echo ""
	@echo "  Mercury Code - Development & Release Commands"
	@echo "  ────────────────────────────────────────────────"
	@echo ""
	@echo "  Development:"
	@echo "    make install      Install globally (npm link)"
	@echo "    make dev          Run with --verbose flag"
	@echo "    make test         Run test suite (464 tests)"
	@echo "    make lint         Check for syntax errors"
	@echo ""
	@echo "  Release:"
	@echo "    make build        Build binaries for all platforms"
	@echo "    make build-win    Build Windows binaries only"
	@echo "    make build-mac    Build macOS binaries only"
	@echo "    make build-linux  Build Linux binaries only"
	@echo "    make release      Full release pipeline"
	@echo "    make publish      Publish to npm"
	@echo ""
	@echo "  Other:"
	@echo "    make clean        Remove dist/ and node_modules/"
	@echo "    make uninstall    Remove global link"
	@echo "    make check-node   Verify Node.js version"
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

# ── Release targets ───────────────────────────────────────────────────────────

# Build standalone binaries for all platforms
build: check-node
	node scripts/build-binaries.js

# Platform-specific builds
build-win: check-node
	node scripts/build-binaries.js --windows

build-mac: check-node
	node scripts/build-binaries.js --macos

build-linux: check-node
	node scripts/build-binaries.js --linux

# Full release pipeline
release: test build
	@echo ""
	@echo "Release artifacts are in dist/"
	@echo "To publish to npm: make publish"
	@echo "To create a GitHub release: git tag v$$(node -e 'console.log(require("./package.json").version)') && git push origin --tags"
	@echo ""

# Publish to npm
publish: test
	npm publish --access public

# Clean generated files
clean:
	rm -rf node_modules dist _pkg_entry.cjs
	rm -f package-lock.json

# Uninstall global link
uninstall:
	npm unlink -g mercury-code 2>/dev/null || true
	@echo "Global link removed."
