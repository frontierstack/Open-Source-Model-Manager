# Pi (pi.dev) one-shot installer for the model server -- native Windows, no WSL.
#
# IMPORTANT: this file must stay PURE ASCII. It is fetched with curl.exe on
# Windows PowerShell 5.1, whose console decodes stdout with the legacy OEM
# codepage - a UTF-8 em-dash mojibakes into a smart quote (0x94 -> U+201D),
# which PowerShell treats as a REAL string delimiter and the script shreds.
#
# Idempotent. Self-corrects for common failure modes:
#   - self-signed / corporate-MITM TLS (curl.exe/SChannel downloads on
#     Windows PowerShell 5.1, -SkipCertificateCheck on PowerShell 7+, npm
#     strict-ssl=false, NODE_TLS_REJECT_UNAUTHORIZED=0 persisted user-scope)
#   - execution policy: Restricted blocks the npm.ps1/pi.ps1 shims Node and
#     npm generate, so step 1 sets CurrentUser -> RemoteSigned (no admin);
#     the installer ALSO always invokes the .cmd shims directly, so it
#     completes even when group policy forbids the change
#   - missing or old Node (winget LTS first, then a no-admin zip install
#     into %LOCALAPPDATA%\Programs with a user-PATH entry)
#   - missing Pi CLI / Pi older than 0.75 (upgraded)
#   - re-runs cleanly: every step skips work that's already done
#   - no admin required on any path (winget may raise a UAC prompt; the
#     zip fallback never does)
#
# Usage: copy the one-liner from the Docs tab (Pi setup -> 2b). To run a
# saved copy instead:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Everything Pi needs (MODELSERVER_BASE_URL, MODELSERVER_API_KEY,
# NODE_TLS_REJECT_UNAUTHORIZED) is persisted to your USER environment, so
# new terminals need nothing -- just run `pi`.
#
# The webapp substitutes __MODELSERVER_BASE_URL__ with the canonical base
# URL when serving this script via /api/pi/install.ps1.

$ErrorActionPreference = 'Continue'
# Invoke-WebRequest on 5.1 is drastically slower with the progress bar on.
$ProgressPreference = 'SilentlyContinue'

$BaseUrl = if ($env:MODELSERVER_BASE_URL) { $env:MODELSERVER_BASE_URL } else { '__MODELSERVER_BASE_URL__' }
$ExtensionDir  = Join-Path $env:USERPROFILE '.pi\agent\extensions\modelserver'
$SettingsPath  = Join-Path $env:USERPROFILE '.pi\agent\settings.json'
$IsPowerShell7 = $PSVersionTable.PSVersion.Major -ge 6

# ---------- output helpers ----------
function Say      ($message) { Write-Host "  $message" }
function Log-Ok   ($message) { Write-Host '  ' -NoNewline; Write-Host '[OK]  ' -ForegroundColor Green  -NoNewline; Write-Host $message }
function Log-Step ($message) { Write-Host '  ' -NoNewline; Write-Host '[..]  ' -ForegroundColor Cyan   -NoNewline; Write-Host $message }
function Log-Warn ($message) { Write-Host '  ' -NoNewline; Write-Host '[!]   ' -ForegroundColor Yellow -NoNewline; Write-Host $message -ForegroundColor Yellow }
function Log-Err  ($message) { Write-Host '  ' -NoNewline; Write-Host '[X]   ' -ForegroundColor Red    -NoNewline; Write-Host $message -ForegroundColor Red }
function Section  ($title) {
    Write-Host ''
    Write-Host "  $title" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * $title.Length)) -ForegroundColor DarkGray
}

# ---------- TLS bypass (self-signed server cert / corporate MITM) ----------
# Windows PowerShell 5.1 routes Invoke-WebRequest through ServicePointManager;
# PowerShell 7+ ignores it (requests there pass -SkipCertificateCheck).
# The 5.1 bypass must be a COMPILED ICertificatePolicy -- a scriptblock
# assigned to ServerCertificateValidationCallback fires on a thread with no
# runspace and kills every request with "The underlying connection was
# closed: An unexpected error occurred on a send."
if (-not $IsPowerShell7) {
    try {
        # Clear any scriptblock callback a previous attempt left in this
        # session -- it overrides the policy below and re-breaks requests.
        [Net.ServicePointManager]::ServerCertificateValidationCallback = $null
        if (-not ('TrustAllCertsPolicy' -as [type])) {
            Add-Type -TypeDefinition @'
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint servicePoint, X509Certificate certificate, WebRequest request, int problem) {
        return true;
    }
}
'@
        }
        [Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
}

# One download helper that tolerates the self-signed cert on BOTH editions.
# On 5.1 prefer curl.exe (ships with Windows 10 1803+): it talks SChannel
# directly and sidesteps the .NET TLS layer entirely.
function Invoke-Insecure {
    param([string]$Uri, [string]$OutFile, [hashtable]$Headers)
    if (-not $IsPowerShell7 -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        $curlArgs = @('-skfL', '--retry', '2')
        if ($Headers) { foreach ($headerName in $Headers.Keys) { $curlArgs += @('-H', "${headerName}: $($Headers[$headerName])") } }
        if ($OutFile) { $curlArgs += @('-o', $OutFile) }
        $curlOutput = & curl.exe @curlArgs $Uri 2>$null
        if ($LASTEXITCODE -ne 0) { throw "curl.exe failed (exit $LASTEXITCODE) for $Uri" }
        if (-not $OutFile) { return ($curlOutput -join "`n") }
        return
    }
    $requestParams = @{ Uri = $Uri; UseBasicParsing = $true; ErrorAction = 'Stop' }
    if ($Headers)        { $requestParams.Headers = $Headers }
    if ($OutFile)        { $requestParams.OutFile = $OutFile }
    if ($IsPowerShell7)  { $requestParams.SkipCertificateCheck = $true }
    Invoke-WebRequest @requestParams
}

# Refresh this session's PATH from the registry (an installer just changed
# it) and make sure npm's per-user global bin dir is visible.
function Update-SessionPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
    $npmGlobalBin = Join-Path $env:APPDATA 'npm'
    if ($env:Path -notlike "*$npmGlobalBin*") { $env:Path = "$env:Path;$npmGlobalBin" }
}

# Add a directory to the persistent USER PATH (idempotent) + this session.
function Add-UserPath ([string]$directory) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';') -notcontains $directory) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $directory), 'User')
    }
    if (($env:Path -split ';') -notcontains $directory) { $env:Path = "$env:Path;$directory" }
}

function Get-NodeVersionParts {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
    $versionText = (& node -v) 2>$null
    if ($versionText -match '^v(\d+)\.(\d+)') { return @([int]$Matches[1], [int]$Matches[2]) }
    return $null
}

# Pi engines require Node >=22.19.0 -- major>22 fine; on 22 minor>=19.
function Test-NodeVersionOk {
    $versionParts = Get-NodeVersionParts
    if (-not $versionParts) { return $false }
    return ($versionParts[0] -gt 22) -or ($versionParts[0] -eq 22 -and $versionParts[1] -ge 19)
}

# Node/npm generate BOTH .cmd and .ps1 shims, and PowerShell prefers the
# .ps1 -- which a Restricted execution policy refuses to load. Resolving the
# .cmd explicitly makes every invocation policy-proof.
function Get-NpmCommand {
    $npmCmdShim = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($npmCmdShim) { return $npmCmdShim.Source }
    $anyNpm = Get-Command npm -ErrorAction SilentlyContinue
    if ($anyNpm) { return $anyNpm.Source }
    return $null
}
function Get-PiCommand {
    $piCmdShim = Get-Command pi.cmd -ErrorAction SilentlyContinue
    if ($piCmdShim) { return $piCmdShim.Source }
    $anyPi = Get-Command pi -ErrorAction SilentlyContinue
    if ($anyPi) { return $anyPi.Source }
    return $null
}
function Get-PiVersion {
    $piCommand = Get-PiCommand
    if (-not $piCommand) { return '' }
    try { return ((& $piCommand --version) 2>$null | Out-String).Trim() } catch { return '' }
}

# ---------- banner ----------
Write-Host ''
Write-Host '  Pi (pi.dev) installer -- Windows (no WSL)' -ForegroundColor White
Write-Host "  $BaseUrl - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray

$InstallFailed = $false

# ---------- step 1: TLS + execution policy groundwork ----------
Section '1/6 - TLS / execution policy'
[Environment]::SetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED', '0', 'User')
$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
Log-Ok 'NODE_TLS_REJECT_UNAUTHORIZED=0 (user env -- tolerates the self-signed server cert)'
if ($IsPowerShell7) { Log-Ok 'PowerShell 7+ detected -- using -SkipCertificateCheck for downloads' }
else                { Log-Ok 'Windows PowerShell 5.1 -- downloads go through curl.exe / compiled cert policy' }

# Restricted (the Windows default) refuses to load npm.ps1/pi.ps1, so `pi`
# would fail in every future shell. RemoteSigned still runs local scripts.
# CurrentUser scope needs no admin; if group policy forbids it we continue
# anyway -- the installer itself only calls the .cmd shims.
try {
    $currentPolicy = Get-ExecutionPolicy -Scope CurrentUser
    if ($currentPolicy -in @('Undefined', 'Restricted', 'AllSigned')) {
        Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force -ErrorAction Stop
        Log-Ok "execution policy (CurrentUser): $currentPolicy -> RemoteSigned (lets the npm/pi shims run)"
    } else {
        Log-Ok "execution policy (CurrentUser): $currentPolicy -- OK"
    }
} catch {
    Log-Warn "could not set execution policy ($($_.Exception.Message)) -- continuing; use pi.cmd if 'pi' is refused"
}

# ---------- step 2: ensure Node >= 22.19 ----------
Section '2/6 - Node >= 22.19'
if (Test-NodeVersionOk) {
    Log-Ok "Node $(node -v) detected -- OK"
} else {
    $versionParts = Get-NodeVersionParts
    if ($versionParts) { Log-Warn "Node v$($versionParts[0]).$($versionParts[1]) too old (Pi needs Node >= 22.19); upgrading." }
    else               { Log-Step 'Node not installed; installing Node LTS' }

    $nodeInstalled = $false

    # Path A: winget (system package manager; may raise one UAC prompt).
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Log-Step 'installing Node LTS via winget (a UAC prompt may appear)'
        $wingetOutput = @()
        try {
            $wingetOutput = winget install --id OpenJS.NodeJS.LTS -e --silent `
                --accept-package-agreements --accept-source-agreements 2>&1
        } catch { }
        Update-SessionPath
        if (Test-NodeVersionOk) {
            $nodeInstalled = $true
            Log-Ok "installed Node $(node -v) (winget)"
        } else {
            Log-Warn 'winget did not produce Node >= 22.19; falling back to zip install. winget said:'
            $wingetOutput | Select-Object -Last 4 | ForEach-Object { Say "    $_" }
        }
    }

    # Path B: official zip into %LOCALAPPDATA%\Programs -- never needs admin.
    if (-not $nodeInstalled) {
        $nodeVersion  = '22.20.0'
        $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $nodeDistName = "node-v$nodeVersion-win-$architecture"
        $programsDir  = Join-Path $env:LOCALAPPDATA 'Programs'
        $nodeInstallDir = Join-Path $programsDir $nodeDistName
        $nodeZipPath  = Join-Path $env:TEMP "$nodeDistName.zip"
        Log-Step "downloading Node v$nodeVersion ($architecture) zip from nodejs.org (no admin needed)"
        try {
            Invoke-Insecure -Uri "https://nodejs.org/dist/v$nodeVersion/$nodeDistName.zip" -OutFile $nodeZipPath
            New-Item -ItemType Directory -Force -Path $programsDir | Out-Null
            if (Test-Path $nodeInstallDir) { Remove-Item -Recurse -Force $nodeInstallDir }
            Expand-Archive -Path $nodeZipPath -DestinationPath $programsDir -Force
            Remove-Item $nodeZipPath -ErrorAction SilentlyContinue
            Add-UserPath $nodeInstallDir
            if (Test-NodeVersionOk) {
                $nodeInstalled = $true
                Log-Ok "installed Node $(node -v) at $nodeInstallDir"
            }
        } catch {
            Log-Err "Node zip install failed: $($_.Exception.Message)"
        }
    }

    if (-not $nodeInstalled) {
        Log-Err 'Could not install Node >= 22.19 by any path. Install it from https://nodejs.org and re-run.'
        $InstallFailed = $true
    }
}

# ---------- step 3: git (recommended -- Pi uses it for repo work) ----------
if (-not $InstallFailed) {
    Section '3/6 - git'
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Log-Ok "git present: $((git --version) 2>$null)"
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        Log-Step 'installing Git for Windows via winget (a UAC prompt may appear)'
        try {
            winget install --id Git.Git -e --silent `
                --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        } catch { }
        Update-SessionPath
        if (Get-Command git -ErrorAction SilentlyContinue) { Log-Ok "installed $((git --version) 2>$null)" }
        else { Log-Warn 'git install did not complete -- Pi works without it, but repo tasks need it (https://git-scm.com)' }
    } else {
        Log-Warn 'git not found and winget unavailable -- Pi works without it, but repo tasks need it (https://git-scm.com)'
    }
}

# ---------- step 4: ensure Pi CLI ----------
if (-not $InstallFailed) {
    Section '4/6 - Pi CLI'
    $npmCommand = Get-NpmCommand
    if (-not $npmCommand) {
        Log-Err 'npm not found even though Node installed -- open a NEW terminal and re-run.'
        $InstallFailed = $true
    } else {
        & $npmCommand config set strict-ssl false 2>$null | Out-Null

        Update-SessionPath
        $piVersion = Get-PiVersion
        # Pi <0.75 predates context-overflow auto-recovery, the Node 22.19
        # bump and the TypeBox 1.x extension API -- force-upgrade. Major-aware.
        $piNeedsUpgrade = $false
        if ($piVersion -match '^(\d+)\.(\d+)') {
            $piMajor = [int]$Matches[1]; $piMinor = [int]$Matches[2]
            if ($piMajor -eq 0 -and $piMinor -lt 75) { $piNeedsUpgrade = $true }
        }
        if ($piVersion -and -not $piNeedsUpgrade) {
            Log-Ok "Pi already installed: $piVersion"
        } else {
            if ($piVersion) { Log-Step "Pi $piVersion is older than 0.75 -- upgrading to latest" }
            Log-Step 'installing @earendil-works/pi-coding-agent (npm -- global installs are per-user on Windows)'
            $npmLogPath = Join-Path $env:TEMP 'pi-npm-install.log'
            & $npmCommand install -g --no-audit --no-fund '@earendil-works/pi-coding-agent@latest' *> $npmLogPath
            Update-SessionPath
            $piVersion = Get-PiVersion
            if ($piVersion) {
                Log-Ok "installed Pi $piVersion"
                Remove-Item $npmLogPath -ErrorAction SilentlyContinue
            } else {
                Log-Err 'npm install -g @earendil-works/pi-coding-agent failed. Last npm output:'
                if (Test-Path $npmLogPath) { Get-Content $npmLogPath -Tail 25 | ForEach-Object { Say "    $_" } }
                Log-Err "Full log: $npmLogPath"
                Log-Err 'Common fixes:  npm cache clean --force   then   npm install -g npm@latest   and re-run.'
                $InstallFailed = $true
            }
        }
    }
}

# ---------- step 5: drop the modelserver extension ----------
if (-not $InstallFailed) {
    Section '5/6 - modelserver extension'
    Say $ExtensionDir
    if (-not $env:MODELSERVER_API_KEY) {
        Log-Err 'MODELSERVER_API_KEY is not set. Set it and re-run:'
        Log-Err '    $env:MODELSERVER_API_KEY = "<your-bearer-key>"'
        Log-Err '    (then re-run the install one-liner from the Docs tab)'
        $InstallFailed = $true
    } else {
        New-Item -ItemType Directory -Force -Path $ExtensionDir | Out-Null
        $authHeaders = @{ Authorization = "Bearer $($env:MODELSERVER_API_KEY)" }
        $downloadsOk = $true
        foreach ($extensionFile in @('modelserver.ts', 'package.json')) {
            try {
                Invoke-Insecure -Uri "$BaseUrl/api/pi/extension/$extensionFile" `
                    -OutFile (Join-Path $ExtensionDir $extensionFile) -Headers $authHeaders | Out-Null
            } catch {
                Log-Err "Failed to download ${extensionFile}: $($_.Exception.Message)"
                $downloadsOk = $false
            }
        }
        if (-not $downloadsOk) {
            Log-Err 'Check the bearer key is valid and the server is reachable, then re-run.'
            $InstallFailed = $true
        } else {
            Log-Ok 'extension files dropped'
            # Pi 0.69+ uses the rebranded `typebox` package (1.x) -- check
            # for the CURRENT dep so an old install gets it on re-run.
            if (Test-Path (Join-Path $ExtensionDir 'node_modules\typebox')) {
                Log-Ok 'extension deps already present, skipping npm install'
            } else {
                Log-Step 'installing extension deps (Typebox)'
                Push-Location $ExtensionDir
                & (Get-NpmCommand) install --omit=dev --no-audit --no-fund 2>&1 | Out-Null
                Pop-Location
                if (Test-Path (Join-Path $ExtensionDir 'node_modules\typebox')) { Log-Ok 'extension deps installed' }
                else { Log-Err "npm install in $ExtensionDir failed"; $InstallFailed = $true }
            }
        }
    }
}

# ---------- step 6: settings.json + persist env ----------
if (-not $InstallFailed) {
    Section '6/6 - settings.json + user environment'
    New-Item -ItemType Directory -Force -Path (Split-Path $SettingsPath) | Out-Null
    $existingSettings = if (Test-Path $SettingsPath) { Get-Content $SettingsPath -Raw -ErrorAction SilentlyContinue } else { '' }
    if ($existingSettings -match '"modelserver"') {
        Log-Ok "$SettingsPath already references modelserver, leaving alone"
    } else {
        # Absolute path with forward slashes -- unambiguous for Pi on
        # Windows (no reliance on ~ expansion).
        $extensionEntry = ((Join-Path $ExtensionDir 'modelserver.ts') -replace '\\', '/')
        $settingsJson = @"
{
  "defaultProvider": "modelserver",
  "packages": [],
  "extensions": [
    "$extensionEntry"
  ]
}
"@
        # BOM-less UTF8 -- PS 5.1's `Set-Content -Encoding UTF8` writes a
        # BOM, which breaks JSON.parse when Pi reads the file.
        [IO.File]::WriteAllText($SettingsPath, $settingsJson, (New-Object System.Text.UTF8Encoding($false)))
        Log-Ok "wrote $SettingsPath"
    }

    # Windows has no ~/.bashrc -- persist everything to the USER environment
    # so every NEW terminal (PowerShell, cmd, Windows Terminal) has it.
    [Environment]::SetEnvironmentVariable('MODELSERVER_BASE_URL', $BaseUrl, 'User')
    $env:MODELSERVER_BASE_URL = $BaseUrl
    Log-Ok 'persisted MODELSERVER_BASE_URL (user env)'
    if ($env:MODELSERVER_API_KEY) {
        [Environment]::SetEnvironmentVariable('MODELSERVER_API_KEY', $env:MODELSERVER_API_KEY, 'User')
        Log-Ok 'persisted MODELSERVER_API_KEY (user env -- remove with: [Environment]::SetEnvironmentVariable("MODELSERVER_API_KEY", $null, "User"))'
    }
}

# ---------- verification ----------
if ($InstallFailed) { Section 'Install FAILED -- see errors above' }
else                { Section 'Install complete' }
$nodeSummary = if (Get-Command node -ErrorAction SilentlyContinue) { (node -v) } else { 'MISSING' }
$piSummary   = Get-PiVersion
if (-not $piSummary) { $piSummary = 'MISSING' }
Say "Node:       $nodeSummary"
Say "Pi:         $piSummary"
Say "Extension:  $ExtensionDir"
Say "Settings:   $SettingsPath"
Say "Base URL:   $BaseUrl"
Write-Host ''
if (-not $InstallFailed) {
    Say 'This shell is ready -- run:'
    Say '  pi'
    Say '(new terminals pick everything up from the user environment automatically)'
} else {
    Say 'Fix the errors above and re-run -- the installer is idempotent and skips finished steps.'
}
Write-Host ''
