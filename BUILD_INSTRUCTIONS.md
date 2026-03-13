# Build Instructions for Mercury Code

## 1. Backup the Project (optional but recommended)
```bash
# From the project root directory:
# Create a backup directory (you can choose any name you like)
mkdir -p backup-$(date +%Y-%m-%d)
# Copy the entire repository into the backup folder
cp -a . backup-$(date +%Y-%m-%d)/
```
> This creates a complete copy of the source code, preserving all files and directories.

## 2. Prerequisites
- **Node.js** (v18.20.8 or newer) must be installed and available on your PATH.
- **npm** (comes with Node) is required to install the packaging tool.
- **Git** (optional) – only needed if you want to clone the repository again.

## 3. Install the packaging tool
The project uses **@yao-pkg/pkg** (a fork of `vercel/pkg`) to bundle the code into a standalone executable.
```bash
# From the project root:
npm install --no-save @yao-pkg/pkg@5
```
> The `--no-save` flag keeps the dependency out of `package.json` – it is only needed for the build.

## 4. Build the binaries
The repository ships a helper script `scripts/build-binaries.js` that will:
1. Create a temporary CommonJS entry point for `pkg`.
2. Build binaries for the selected platforms (Windows, macOS, Linux).
3. Place the resulting files in the `dist/` directory.
4. Create zip/tar.gz archives for easy distribution.

You can run the script with Node directly (no extra sandbox needed):
```bash
node scripts/build-binaries.js   # builds for all platforms
# Or limit to a specific platform:
node scripts/build-binaries.js --windows   # only Windows binaries
node scripts/build-binaries.js --macos     # only macOS binaries
node scripts/build-binaries.js --linux     # only Linux binaries
```
> The script will automatically install `@yao-pkg/pkg` if it is missing.

## 5. Locate the built executable
After a successful run you will find the following files in `dist/`:
- `mercury-code-v<version>-win-x64.exe`
- `mercury-code-v<version>-win-arm64.exe`
- `mercury-code-v<version>-macos-x64`
- `mercury-code-v<version>-macos-arm64`
- `mercury-code-v<version>-linux-x64`
- `mercury-code-v<version>-linux-arm64`

Corresponding archives (`.zip` for Windows, `.tar.gz` for Unix) are also generated.

## 6. Test the executable
```bash
# On Windows:
mercury-code-v<version>-win-x64.exe -h
# On macOS / Linux:
./mercury-code-v<version>-linux-x64 -h
```
You should see the help output of the Mercury Code CLI.

## 7. Clean up (optional)
If you no longer need the temporary build artifacts you can delete the `dist/` folder:
```bash
rm -rf dist
```

---
**Note:** The above commands must be executed in a regular terminal on your machine. The sandboxed environment used for this chat does not allow executing shell commands or writing files outside the workspace, so the actual binary generation must be performed locally.
