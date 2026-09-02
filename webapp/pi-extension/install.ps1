# Pi (pi.dev) one-shot installer for the model server — native Windows, no WSL.
#
# Idempotent. Self-corrects for common failure modes:
#   - self-signed / corporate-MITM TLS (session cert bypass on Windows
#     PowerShell 5.1, -SkipCertificateCheck on PowerShell 7+, npm
#     strict-ssl=false, NODE_TLS_REJECT_UNAUTHORIZED=0 persisted user-scope)
#   - missing or old Node (winget LTS first, then a no-admin zip install
#     into %LOCALAPPDATA%\Programs with a user-PATH entry)
#   - missing Pi CLI / Pi older than 0.75 (upgraded)
#   - re-runs cleanly: every step skips work that's already done
#   - no admin required on any path (winget may raise a UAC prompt; the
#     zip fallback never does)
#
# Usage (any PowerShell — Windows PowerShell 5.1 or PowerShell 7+): copy the
# one-liner from the Docs tab (Pi setup → 2b). On 5.1 the cert bypass MUST be
# a compiled ICertificatePolicy (Add-Type) — a scriptblock assigned to
# ServerCertificateValidationCallback fires on a thread with no runspace and
# kills the handshake with "The underlying connection was closed: An
# unexpected error occurred on a send."
#
# Piping to iex sidesteps the execution policy; to run a saved copy instead:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Everything Pi needs (MODELSERVER_BASE_URL, MODELSERVER_API_KEY,
# NODE_TLS_REJECT_UNAUTHORIZED) is persisted to your USER environment, so
# new terminals need nothing — just run `pi`.
#
# The webapp substitutes __MODELSERVER_BASE_URL__ with the canonical base
# URL when serving this script via /api/pi/install.ps1.

$ErrorActionPreference = 'Continue'

$BaseUrlDefault = '__MODELSERVER_BASE_URL__'
$BaseUrl = if ($env:MODELSERVER_BASE_URL) { $env:MODELSERVER_BASE_URL } else { $BaseUrlDefault }
$ExtDir   = Join-Path $env:USERPROFILE '.pi\agent\extensions\modelserver'
$Settings = Join-Path $env:USERPROFILE '.pi\agent\settings.json'
$IsPS7    = $PSVersionTable.PSVersion.Major -ge 6

# ---------- output helpers ----------
function Say      ($m) { Write-Host "  $m" }
function Log-Ok   ($m) { Write-Host "  " -NoNewline; Write-Host '[OK]  ' -ForegroundColor Green  -NoNewline; Write-Host $m }
function Log-Step ($m) { Write-Host "  " -NoNewline; Write-Host '[..]  ' -ForegroundColor Cyan   -NoNewline; Write-Host $m }
function Log-Warn ($m) { Write-Host "  " -NoNewline; Write-Host '[!]   ' -ForegroundColor Yellow -NoNewline; Write-Host $m -ForegroundColor Yellow }
function Log-Err  ($m) { Write-Host "  " -NoNewline; Write-Host '[X]   ' -ForegroundColor Red    -NoNewline; Write-Host $m -ForegroundColor Red }
function Section  ($t) {
    Write-Host ''
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * $t.Length)) -ForegroundColor DarkGray
}

# ---------- TLS bypass (self-signed server cert / corporate MITM) ----------
# Windows PowerShell 5.1 uses ServicePointManager for every Invoke-WebRequest;
# PowerShell 7+ ignores it, so requests there pass -SkipCertificateCheck.
# CRITICAL (5.1): the bypass must be a COMPILED ICertificatePolicy — a
# PowerShell scriptblock assigned to ServerCertificateValidationCallback is
# invoked on a background thread with no runspace, throws, and the request
# dies with "The underlying connection was closed: … on a send."
if (-not $IsPS7) {
    try {
        # Clear any scriptblock callback a previous attempt left in this
        # session — it overrides the policy below and re-breaks every request.
        [Net.ServicePointManager]::ServerCertificateValidationCallback = $null
        if (-not ('TrustAllCertsPolicy' -as [type])) {
            Add-Type -TypeDefinition @'
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) {
        return true;
    }
}
'@
        }
        [Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }
}

# One request helper that is insecure-TLS-tolerant on BOTH editions.
# On 5.1 prefer curl.exe (ships with Windows 10 1803+): it uses SChannel
# directly and sidesteps the whole .NET ServicePointManager minefield.
function Invoke-Insecure {
    param([string]$Uri, [string]$OutFile, [hashtable]$Headers)
    if (-not $IsPS7 -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        $cargs = @('-skfL', '--retry', '2')
        if ($Headers) { foreach ($k in $Headers.Keys) { $cargs += @('-H', "${k}: $($Headers[$k])") } }
        if ($OutFile) { $cargs += @('-o', $OutFile) }
        $out = & curl.exe @cargs $Uri 2>$null
        if ($LASTEXITCODE -ne 0) { throw "curl.exe failed (exit $LASTEXITCODE) for $Uri" }
        if (-not $OutFile) { return ($out -join "`n") }
        return
    }
    $p = @{ Uri = $Uri; UseBasicParsing = $true; ErrorAction = 'Stop' }
    if ($Headers) { $p.Headers = $Headers }
    if ($OutFile) { $p.OutFile = $OutFile }
    if ($IsPS7)   { $p.SkipCertificateCheck = $true }
    Invoke-WebRequest @p
}

# Refresh this session's PATH from the registry (an installer just changed it)
# and make sure npm's per-user global bin dir is visible.
function Refresh-Path {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
    $npmBin = Join-Path $env:APPDATA 'npm'
    if ($env:Path -notlike "*$npmBin*") { $env:Path = "$env:Path;$npmBin" }
}

# Add a directory to the persistent USER PATH (idempotent) + this session.
function Add-UserPath ([string]$dir) {
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $user) { $user = '' }
    if (($user -split ';') -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', ($user.TrimEnd(';') + ';' + $dir), 'User')
    }
    if (($env:Path -split ';') -notcontains $dir) { $env:Path = "$env:Path;$dir" }
}

function Get-NodeMajorMinor {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { return $null }
    $v = (& node -v) 2>$null
    if ($v -match '^v(\d+)\.(\d+)') { return @([int]$Matches[1], [int]$Matches[2]) }
    return $null
}

# Pi engines require Node >=22.19.0 — major>22 fine; on the 22 line minor>=19.
function Test-NodeOk {
    $mm = Get-NodeMajorMinor
    if (-not $mm) { return $false }
    return ($mm[0] -gt 22) -or ($mm[0] -eq 22 -and $mm[1] -ge 19)
}

# ---------- banner ----------
Write-Host ''
Write-Host '  Pi (pi.dev) installer — Windows (no WSL)' -ForegroundColor White
Write-Host "  $BaseUrl · $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray

$Failed = $false

# ---------- step 1: TLS / env groundwork ----------
Section '1/6 · TLS / environment'
[Environment]::SetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED', '0', 'User')
$env:NODE_TLS_REJECT_UNAUTHORIZED = '0'
Log-Ok 'NODE_TLS_REJECT_UNAUTHORIZED=0 (user env — tolerates the self-signed server cert)'
if ($IsPS7) { Log-Ok 'PowerShell 7+ detected — using -SkipCertificateCheck for downloads' }
else        { Log-Ok 'Windows PowerShell 5.1 — session certificate bypass active' }

# ---------- step 2: ensure Node >= 22.19 ----------
Section '2/6 · Node >= 22.19'
if (Test-NodeOk) {
    Log-Ok "Node $(node -v) detected — OK"
} else {
    $mm = Get-NodeMajorMinor
    if ($mm) { Log-Warn "Node v$($mm[0]).$($mm[1]) too old (Pi needs Node >= 22.19); upgrading." }
    else     { Log-Step 'Node not installed; installing Node LTS' }

    $installed = $false

    # Path A: winget (system package manager; may raise one UAC prompt).
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Log-Step 'installing Node LTS via winget (a UAC prompt may appear)'
        try {
            winget install --id OpenJS.NodeJS.LTS -e --silent `
                --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        } catch { }
        Refresh-Path
        if (Test-NodeOk) { $installed = $true; Log-Ok "installed Node $(node -v) (winget)" }
        else { Log-Warn 'winget path did not produce Node >= 22.19; falling back to zip install' }
    }

    # Path B: official zip into %LOCALAPPDATA%\Programs — never needs admin.
    if (-not $installed) {
        $nodeVer = '22.20.0'
        $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
        $zipName = "node-v$nodeVer-win-$arch"
        $destRoot = Join-Path $env:LOCALAPPDATA 'Programs'
        $destDir  = Join-Path $destRoot $zipName
        Log-Step "downloading Node v$nodeVer ($arch) zip from nodejs.org (no admin needed)"
        $zipPath = Join-Path $env:TEMP "$zipName.zip"
        try {
            Invoke-Insecure -Uri "https://nodejs.org/dist/v$nodeVer/$zipName.zip" -OutFile $zipPath
            New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
            if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }
            Expand-Archive -Path $zipPath -DestinationPath $destRoot -Force
            Remove-Item $zipPath -ErrorAction SilentlyContinue
            Add-UserPath $destDir
            if (Test-NodeOk) { $installed = $true; Log-Ok "installed Node $(node -v) at $destDir" }
        } catch {
            Log-Err "Node zip install failed: $($_.Exception.Message)"
        }
    }

    if (-not $installed) {
        Log-Err 'Could not install Node >= 22.19 by any path. Install it from https://nodejs.org and re-run.'
        $Failed = $true
    }
}

# ---------- step 3: git (recommended — Pi uses it for repo work) ----------
if (-not $Failed) {
    Section '3/6 · git'
    if (Get-Command git -ErrorAction SilentlyContinue) {
        Log-Ok "git present: $((git --version) 2>$null)"
    } elseif (Get-Command winget -ErrorAction SilentlyContinue) {
        Log-Step 'installing Git for Windows via winget (a UAC prompt may appear)'
        try {
            winget install --id Git.Git -e --silent `
                --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
        } catch { }
        Refresh-Path
        if (Get-Command git -ErrorAction SilentlyContinue) { Log-Ok "installed $((git --version) 2>$null)" }
        else { Log-Warn 'git install did not complete — Pi works without it, but repo tasks need it (https://git-scm.com)' }
    } else {
        Log-Warn 'git not found and winget unavailable — Pi works without it, but repo tasks need it (https://git-scm.com)'
    }
}

# ---------- step 4: ensure Pi CLI ----------
if (-not $Failed) {
    Section '4/6 · Pi CLI'
    npm config set strict-ssl false 2>$null | Out-Null

    Refresh-Path
    $piVer = ''
    if (Get-Command pi -ErrorAction SilentlyContinue) {
        $piVer = ((& pi --version) 2>$null | Out-String).Trim()
    }
    # Pi <0.75 predates context-overflow auto-recovery, the Node 22.19 bump
    # and the TypeBox 1.x extension API — force-upgrade. Major-aware.
    $piNeedsUpgrade = $false
    if ($piVer -match '^(\d+)\.(\d+)') {
        $pMaj = [int]$Matches[1]; $pMin = [int]$Matches[2]
        if ($pMaj -eq 0 -and $pMin -lt 75) { $piNeedsUpgrade = $true }
    }
    if ($piVer -and -not $piNeedsUpgrade) {
        Log-Ok "Pi already installed: $piVer"
    } else {
        if ($piVer) { Log-Step "Pi $piVer is older than 0.75 — upgrading to latest" }
        Log-Step 'installing @earendil-works/pi-coding-agent (npm — global installs are per-user on Windows)'
        $npmLog = Join-Path $env:TEMP 'pi-npm-install.log'
        npm install -g --no-audit --no-fund '@earendil-works/pi-coding-agent@latest' *> $npmLog
        Refresh-Path
        if (Get-Command pi -ErrorAction SilentlyContinue) {
            $piVer = ((& pi --version) 2>$null | Out-String).Trim()
            Log-Ok "installed Pi $piVer"
            Remove-Item $npmLog -ErrorAction SilentlyContinue
        } else {
            Log-Err 'npm install -g @earendil-works/pi-coding-agent failed. Last npm output:'
            if (Test-Path $npmLog) { Get-Content $npmLog -Tail 25 | ForEach-Object { Say "    $_" } }
            Log-Err "Full log: $npmLog"
            Log-Err 'Common fixes:  npm cache clean --force   then   npm install -g npm@latest   and re-run.'
            if (-not $piVer) { $Failed = $true }
            else { Log-Warn "Existing pi found ($piVer); continuing with the extension install." }
        }
    }
}

# ---------- step 5: drop the modelserver extension ----------
if (-not $Failed) {
    Section '5/6 · modelserver extension'
    Say $ExtDir
    if (-not $env:MODELSERVER_API_KEY) {
        Log-Err 'MODELSERVER_API_KEY is not set. Re-run with:'
        Log-Err '    $env:MODELSERVER_API_KEY = "<your-bearer-key>"'
        Log-Err "    (then re-run the install one-liner from the Docs tab)"
        $Failed = $true
    } else {
        New-Item -ItemType Directory -Force -Path $ExtDir | Out-Null
        $authHeaders = @{ Authorization = "Bearer $($env:MODELSERVER_API_KEY)" }
        $extOk = $true
        foreach ($f in @('modelserver.ts', 'package.json')) {
            try {
                Invoke-Insecure -Uri "$BaseUrl/api/pi/extension/$f" -OutFile (Join-Path $ExtDir $f) -Headers $authHeaders | Out-Null
            } catch {
                Log-Err "Failed to download ${f}: $($_.Exception.Message)"
                $extOk = $false
            }
        }
        if ($extOk) {
            Log-Ok 'extension files dropped'
            # Pi 0.69+ uses the rebranded `typebox` package (1.x) — check for
            # the CURRENT dep so an old install still gets it on re-run.
            if (Test-Path (Join-Path $ExtDir 'node_modules\typebox')) {
                Log-Ok 'extension deps already present, skipping npm install'
            } else {
                Log-Step 'installing extension deps (Typebox)'
                Push-Location $ExtDir
                npm install --omit=dev --no-audit --no-fund 2>&1 | Out-Null
                Pop-Location
                if (Test-Path (Join-Path $ExtDir 'node_modules\typebox')) { Log-Ok 'extension deps installed' }
                else { Log-Err "npm install in $ExtDir failed"; $Failed = $true }
            }
        } else { $Failed = $true }
    }
}

# ---------- step 6: settings.json + persist env ----------
if (-not $Failed) {
    Section '6/6 · settings.json + user environment'
    New-Item -ItemType Directory -Force -Path (Split-Path $Settings) | Out-Null
    $writeSettings = $true
    if ((Test-Path $Settings) -and ((Get-Content $Settings -Raw -ErrorAction SilentlyContinue) -match '"modelserver"')) {
        Log-Ok "$Settings already references modelserver, leaving alone"
        $writeSettings = $false
    }
    if ($writeSettings) {
        # Absolute path with forward slashes — unambiguous for Pi on Windows
        # (no reliance on ~ expansion).
        $extEntry = ((Join-Path $ExtDir 'modelserver.ts') -replace '\\', '/')
        $settingsJson = @"
{
  "defaultProvider": "modelserver",
  "packages": [],
  "extensions": [
    "$extEntry"
  ]
}
"@
        # WriteAllText with an explicit BOM-less UTF8 — PS 5.1's
        # `Set-Content -Encoding UTF8` writes a BOM, which breaks JSON.parse
        # when Pi reads the file.
        [IO.File]::WriteAllText($Settings, $settingsJson, (New-Object System.Text.UTF8Encoding($false)))
        Log-Ok "wrote $Settings"
    }

    # Windows has no ~/.bashrc — persist everything to the USER environment so
    # every NEW terminal (PowerShell, cmd, Windows Terminal) has it.
    [Environment]::SetEnvironmentVariable('MODELSERVER_BASE_URL', $BaseUrl, 'User')
    $env:MODELSERVER_BASE_URL = $BaseUrl
    Log-Ok 'persisted MODELSERVER_BASE_URL (user env)'
    if ($env:MODELSERVER_API_KEY) {
        [Environment]::SetEnvironmentVariable('MODELSERVER_API_KEY', $env:MODELSERVER_API_KEY, 'User')
        Log-Ok 'persisted MODELSERVER_API_KEY (user env — stored under HKCU, remove with: [Environment]::SetEnvironmentVariable("MODELSERVER_API_KEY", $null, "User"))'
    }
}

# ---------- verification ----------
Section (& { if ($Failed) { 'Install FAILED — see errors above' } else { 'Install complete' } })
$nodeShown = if (Get-Command node -ErrorAction SilentlyContinue) { (node -v) } else { 'MISSING' }
$piShown   = if (Get-Command pi   -ErrorAction SilentlyContinue) { ((& pi --version) 2>$null | Out-String).Trim() } else { 'MISSING' }
Say "Node:       $nodeShown"
Say "Pi:         $piShown"
Say "Extension:  $ExtDir"
Say "Settings:   $Settings"
Say "Base URL:   $BaseUrl"
Write-Host ''
if (-not $Failed) {
    Say 'This shell is ready — run:'
    Say '  pi'
    Say '(new terminals pick everything up from the user environment automatically)'
} else {
    Say 'Fix the errors above and re-run — the installer is idempotent and skips finished steps.'
}
Write-Host ''
