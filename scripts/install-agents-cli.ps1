# koda CLI Installer for Windows PowerShell
# Installs the koda AI Agent Management CLI

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  koda CLI Installer (Windows)"           -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
try {
    $nodeVersion = node --version
    Write-Host "Node.js version: $nodeVersion" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "Error: Node.js is not installed." -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/" -ForegroundColor Yellow
    exit 1
}

# Define installation directory
$InstallDir = "$env:USERPROFILE\bin"
$CLIDir = "$InstallDir\open-model-agents-cli"

# Create installation directory if it doesn't exist
Write-Host ">>> Creating installation directory: $InstallDir" -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $CLIDir | Out-Null

# Download CLI files from API endpoint
Write-Host ">>> Downloading CLI files..." -ForegroundColor Yellow

# Disable SSL certificate validation for self-signed certs
add-type @"
    using System.Net;
    using System.Security.Cryptography.X509Certificates;
    public class TrustAllCertsPolicy : ICertificatePolicy {
        public bool CheckValidationResult(
            ServicePoint srvPoint, X509Certificate certificate,
            WebRequest request, int certificateProblem) {
            return true;
        }
    }
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Get the API base URL (should be passed via environment or parameter)
$ApiBaseUrl = $env:KODA_API_URL
if (-not $ApiBaseUrl) {
    # Try to get from command line argument
    if ($args.Length -gt 0) {
        $ApiBaseUrl = $args[0]
    } else {
        Write-Host "Error: API URL not provided" -ForegroundColor Red
        Write-Host "Usage: install-agents-cli.ps1 <api-url>" -ForegroundColor Yellow
        Write-Host "Example: install-agents-cli.ps1 https://10.0.0.109:3001" -ForegroundColor Yellow
        exit 1
    }
}

# Download package.json
try {
    $packageJson = Invoke-RestMethod -Uri "$ApiBaseUrl/api/cli/files/package.json" -Method Get
    $packageJson | ConvertTo-Json | Out-File "$CLIDir\package.json" -Encoding UTF8
} catch {
    Write-Host "Error downloading package.json: $_" -ForegroundColor Red
    exit 1
}

# Download koda.js
try {
    $kodaJs = Invoke-RestMethod -Uri "$ApiBaseUrl/api/cli/files/koda.js" -Method Get
    # Create bin directory
    New-Item -ItemType Directory -Force -Path "$CLIDir\bin" | Out-Null
    $kodaJs | Out-File "$CLIDir\bin\koda.js" -Encoding UTF8
} catch {
    Write-Host "Error downloading koda.js: $_" -ForegroundColor Red
    exit 1
}

# Install dependencies
Write-Host ">>> Installing dependencies..." -ForegroundColor Yellow
Push-Location $CLIDir
try {
    npm install --production 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed"
    }
} catch {
    Write-Host "Error installing dependencies: $_" -ForegroundColor Red
    Pop-Location
    exit 1
}
Pop-Location

# Create batch wrapper for Windows
Write-Host ">>> Creating launcher scripts..." -ForegroundColor Yellow

# Create koda.cmd (Windows batch file)
$kodaBatch = @"
@echo off
node "$CLIDir\bin\koda.js" %*
"@
$kodaBatch | Out-File "$InstallDir\koda.cmd" -Encoding ASCII

# Create koda.ps1 (PowerShell wrapper)
$kodaPowerShell = @"
node "$CLIDir\bin\koda.js" `$args
"@
$kodaPowerShell | Out-File "$InstallDir\koda.ps1" -Encoding UTF8

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Installation Complete!"                   -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "The CLI has been installed to: $InstallDir" -ForegroundColor Green
Write-Host ""

# Check if install directory is in PATH and auto-add if needed
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$InstallDir*") {
    Write-Host ">>> Adding $InstallDir to PATH..." -ForegroundColor Yellow

    try {
        # Add to user PATH (no admin required)
        $newPath = $currentPath + ";$InstallDir"
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")

        # Update current session PATH
        $env:Path = $newPath

        Write-Host "✓ Added to PATH successfully" -ForegroundColor Green
        Write-Host ""
        Write-Host "Note: You may need to restart PowerShell for the change to take effect." -ForegroundColor Yellow
        Write-Host ""
    } catch {
        Write-Host "Could not automatically add to PATH: $_" -ForegroundColor Red
        Write-Host ""
        Write-Host "Please manually add $InstallDir to your PATH:" -ForegroundColor Yellow
        Write-Host "  1. Open System Properties > Environment Variables" -ForegroundColor White
        Write-Host "  2. Edit the 'Path' variable under User variables" -ForegroundColor White
        Write-Host "  3. Add: $InstallDir" -ForegroundColor White
        Write-Host ""
    }
} else {
    Write-Host "✓ PATH is already configured correctly" -ForegroundColor Green
    Write-Host ""
}

Write-Host "To get started:" -ForegroundColor Cyan
Write-Host "  1. Restart PowerShell (if needed)" -ForegroundColor White
Write-Host "  2. Run: koda" -ForegroundColor White
Write-Host "  3. Authenticate: /auth" -ForegroundColor White
Write-Host "  4. Analyze project: /init" -ForegroundColor White
Write-Host "  5. Get help: /help" -ForegroundColor White
Write-Host ""
Write-Host "You'll need API credentials from $ApiBaseUrl (API Keys tab)" -ForegroundColor Yellow
Write-Host ""
