# ============================================================================
# Mercury Code - Windows Installation Script (PowerShell)
# Interactive AI coding assistant powered by Mercury-2 from Inception Labs
# Run: powershell -ExecutionPolicy Bypass -File install.ps1
# ============================================================================

$ErrorActionPreference = "Stop"

# ── Colors ──────────────────────────────────────────────────────────────────

function Write-Info($msg)    { Write-Host "[INFO] " -ForegroundColor Cyan -NoNewline; Write-Host $msg }
function Write-Ok($msg)      { Write-Host "[OK]   " -ForegroundColor Green -NoNewline; Write-Host $msg }
function Write-Warn($msg)    { Write-Host "[WARN] " -ForegroundColor Yellow -NoNewline; Write-Host $msg }
function Write-Fail($msg)    { Write-Host "[FAIL] " -ForegroundColor Red -NoNewline; Write-Host $msg; exit 1 }

# ── Check Node.js ──────────────────────────────────────────────────────────

function Check-Node {
    try {
        $nodeVersion = (node --version 2>$null)
    } catch {
        Write-Fail "Node.js not found. Please install Node.js >= 18.17.0 from https://nodejs.org/"
    }

    if (-not $nodeVersion) {
        Write-Fail "Node.js not found. Please install Node.js >= 18.17.0 from https://nodejs.org/"
    }

    $version = $nodeVersion -replace '^v', ''
    Write-Info "Detected Node.js: v$version"

    $parts = $version.Split('.')
    $major = [int]$parts[0]
    $minor = [int]$parts[1]

    if ($major -lt 18 -or ($major -eq 18 -and $minor -lt 17)) {
        Write-Fail "Node.js version too old: v$version. Requires >= 18.17.0. Visit https://nodejs.org/"
    }

    Write-Ok "Node.js version check passed: v$version"
}

# ── Check npm ──────────────────────────────────────────────────────────────

function Check-Npm {
    try {
        $npmVersion = (npm --version 2>$null)
    } catch {
        Write-Fail "npm not found. It should be installed alongside Node.js."
    }

    if (-not $npmVersion) {
        Write-Fail "npm not found."
    }

    Write-Info "Detected npm: v$npmVersion"
}

# ── Install ────────────────────────────────────────────────────────────────

function Install-MercuryCode {
    $scriptDir = $PSScriptRoot
    if (-not $scriptDir) {
        $scriptDir = (Get-Location).Path
    }

    Write-Info "Installing Mercury Code globally from: $scriptDir"

    try {
        npm install -g $scriptDir 2>&1
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        Write-Ok "Mercury Code installed successfully!"
    } catch {
        Write-Fail "Installation failed: $_`nTry running PowerShell as Administrator."
    }
}

# ── Setup Config ───────────────────────────────────────────────────────────

function Setup-Config {
    $configDir = Join-Path $env:USERPROFILE ".mercury"

    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
        Write-Ok "Created config directory: $configDir"
    } else {
        Write-Info "Config directory exists: $configDir"
    }

    $configFile = Join-Path $configDir "config.json"
    if (-not (Test-Path $configFile)) {
        @'
{
  "model": "mercury-2",
  "max_tokens": 50000,
  "temperature": 0.75,
  "reasoning_effort": "medium",
  "stream": true
}
'@ | Out-File -FilePath $configFile -Encoding UTF8
        Write-Ok "Created default config: $configFile"
    }
}

# ── Verify ─────────────────────────────────────────────────────────────────

function Verify-Install {
    try {
        $ver = (mercury-code --version 2>$null)
        if ($ver) {
            Write-Ok "mercury-code command available: $ver"
        } else {
            Write-Warn "mercury-code not found in PATH. You may need to restart your terminal."
        }
    } catch {
        Write-Warn "mercury-code not found in PATH. Restart your terminal and try again."
    }
}

# ── Print Getting Started ──────────────────────────────────────────────────

function Print-GettingStarted {
    Write-Host ""
    Write-Host "  ====================================================" -ForegroundColor Cyan
    Write-Host "       Mercury Code - Installation Complete!           " -ForegroundColor Cyan
    Write-Host "  ====================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Quick Start:" -ForegroundColor White
    Write-Host ""
    Write-Host "    1. Set your API key:" -ForegroundColor Yellow
    Write-Host '       $env:INCEPTION_API_KEY = "your_key_here"' -ForegroundColor Green
    Write-Host ""
    Write-Host "       To persist, add to your PowerShell profile:" -ForegroundColor DarkGray
    Write-Host '       [Environment]::SetEnvironmentVariable("INCEPTION_API_KEY", "your_key", "User")' -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "    2. Start Mercury Code:" -ForegroundColor Yellow
    Write-Host "       mercury" -ForegroundColor Green
    Write-Host "       mercury-code -p `"Explain this repo`"" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Documentation: https://github.com/LHAMNS/Cloud-code-for-mercury-2" -ForegroundColor Cyan
    Write-Host ""
}

# ============================================================================
# Main
# ============================================================================

Write-Host ""
Write-Host "  Mercury Code Installer for Windows" -ForegroundColor Cyan
Write-Host "  Powered by Mercury-2 Diffusion Model" -ForegroundColor DarkGray
Write-Host ""

Check-Node
Check-Npm
Install-MercuryCode
Setup-Config
Verify-Install
Print-GettingStarted
