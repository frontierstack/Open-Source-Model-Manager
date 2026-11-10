# omp (https://omp.sh -- oh-my-pi) one-shot installer for the model server --
# native Windows, no WSL, no admin.
#
# IMPORTANT: this file must stay PURE ASCII. It is fetched with curl.exe on
# Windows PowerShell 5.1, whose console decodes stdout with the legacy OEM
# codepage - a UTF-8 em-dash mojibakes into a smart quote (0x94 -> U+201D),
# which PowerShell treats as a REAL string delimiter and the script shreds.
#
# Installs:
#   1. the omp CLI -- the official PREBUILT omp.exe (one self-contained
#      executable: no Node, npm or Bun) into %LOCALAPPDATA%\omp, on the user
#      PATH. omp's own installer (https://omp.sh/install.ps1) is run IN this
#      session so the TLS workarounds below apply to it too;
#   2. the modelserver extension into %USERPROFILE%\.omp\agent\extensions\
#      modelserver (TypeScript loaded by omp itself -- nothing to npm install);
#   3. %USERPROFILE%\.omp\agent\config.yml defaults: the model server's models
#      as the default / smol / slow roles, local-server auto-discovery off;
#   4. MODELSERVER_BASE_URL (+ MODELSERVER_API_KEY when set) in the USER
#      environment, so new terminals need nothing.
#
# Shell: omp uses Git Bash when it is installed, otherwise its own built-in
# bash-compatible shell -- Git for Windows is optional. A shellPath pointing at
# C:\Windows\System32\bash.exe (the WSL launcher shim, which swallows every
# command when no distro is installed) is removed.
#
# Usage: copy the one-liner from the Docs tab (omp setup -> 2b). To run a
# saved copy instead:  powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Env: OMP_INSTALL_REF=v18.14.1 (pin a release), OMP_INSTALL_FORCE=1
# (reinstall omp), OMP_INSTALL_REMOVE_PI=1 (remove an old Pi CLI/extension).
#
# The webapp substitutes __MODELSERVER_BASE_URL__ with the canonical base
# URL when serving this script via /api/omp/install.ps1.

$ErrorActionPreference = 'Continue'
# Invoke-WebRequest on 5.1 is drastically slower with the progress bar on.
$ProgressPreference = 'SilentlyContinue'

$BaseUrl = if ($env:MODELSERVER_BASE_URL) { $env:MODELSERVER_BASE_URL } else { '__MODELSERVER_BASE_URL__' }
$BaseUrl = $BaseUrl.TrimEnd('/')
$AgentDir      = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE '.omp\agent' }
$ExtensionDir  = Join-Path $AgentDir 'extensions\modelserver'
$ConfigPath    = Join-Path $AgentDir 'config.yml'
$OmpDir        = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'omp' }
$OmpMinVersion = [version]'18.18.6'
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
# directly and sidesteps the .NET TLS layer entirely. Returns the body as a
# string when no -OutFile is given.
function Invoke-Insecure {
    param([string]$Uri, [string]$OutFile, [hashtable]$Headers)
    if (-not $IsPowerShell7 -and (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
        $curlArgs = @('-skfL', '--retry', '2', '--connect-timeout', '15')
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
    $response = Invoke-WebRequest @requestParams
    if (-not $OutFile) { return [string]$response.Content }
}

function Get-Authed ([string]$Path, [string]$OutFile) {
    $h = @{ Authorization = "Bearer $($env:MODELSERVER_API_KEY)" }
    if ($OutFile) { Invoke-Insecure -Uri "$BaseUrl$Path" -Headers $h -OutFile $OutFile }
    else { return (Invoke-Insecure -Uri "$BaseUrl$Path" -Headers $h) }
}

# Add a directory to the persistent USER PATH (idempotent) + this session.
function Add-UserPath ([string]$directory) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';') -notcontains $directory) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $directory), 'User')
    }
    if (($env:Path -split ';') -notcontains $directory) { $env:Path = "$directory;$env:Path" }
}

function Get-OmpExe {
    $local = Join-Path $OmpDir 'omp.exe'
    if (Test-Path $local) { return $local }
    $cmd = Get-Command omp.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}
function Get-OmpVersion {
    $exe = Get-OmpExe
    if (-not $exe) { return $null }
    try {
        $text = ((& $exe --version) 2>$null | Out-String).Trim()
        if ($text -match 'omp/(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    } catch { }
    return $null
}

# ---------- banner ----------
Write-Host ''
Write-Host '  omp (oh-my-pi) installer -- Windows (no WSL)' -ForegroundColor White
Write-Host "  $BaseUrl - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor DarkGray

$InstallFailed = $false

if (-not $env:MODELSERVER_API_KEY) {
    Log-Err 'MODELSERVER_API_KEY is not set. In this window run:'
    Log-Err '    $env:MODELSERVER_API_KEY = "<your-bearer-key>"'
    Log-Err 'then paste the Docs-tab one-liner again.'
    return
}

# ---------- step 1: server ----------
Section '1/5 - model server'
if ($IsPowerShell7) { Log-Ok 'PowerShell 7+ -- downloads use -SkipCertificateCheck' }
else                { Log-Ok 'Windows PowerShell 5.1 -- downloads go through curl.exe / compiled cert policy' }
$modelsJson = $null
try {
    $modelsJson = Get-Authed '/v1/models'
    Log-Ok 'model server reachable, key accepted'
} catch {
    Log-Err "GET $BaseUrl/v1/models failed: $($_.Exception.Message)"
    Log-Err 'Check MODELSERVER_BASE_URL and that the key is a BEARER-mode key (API Keys tab).'
    return
}

# ---------- step 2: omp CLI ----------
Section '2/5 - omp CLI'
Add-UserPath $OmpDir
$ompVersion = Get-OmpVersion
if ($ompVersion -and $ompVersion -ge $OmpMinVersion -and -not $env:OMP_INSTALL_FORCE -and -not $env:OMP_INSTALL_REF) {
    Log-Ok "omp $ompVersion already installed ($(Get-OmpExe))"
} else {
    if ($ompVersion) { Log-Step "omp $ompVersion present -- installing $(if ($env:OMP_INSTALL_REF) { $env:OMP_INSTALL_REF } else { 'the latest release' })" }
    Log-Step 'downloading omp.exe (prebuilt, checksum-verified; ~270 MB, a few minutes)'
    try {
        $ompInstaller = Invoke-Insecure -Uri 'https://omp.sh/install.ps1'
        if (-not $ompInstaller) { throw 'empty response from https://omp.sh/install.ps1' }
        $installerBlock = [scriptblock]::Create($ompInstaller)
        # -Binary: never route through a local Bun/source build. Run in THIS
        # session so the TLS policy above covers its downloads.
        if ($env:OMP_INSTALL_REF) { & $installerBlock -Binary -Ref $env:OMP_INSTALL_REF | Out-Host }
        else                      { & $installerBlock -Binary | Out-Host }
    } catch {
        Log-Err "the omp installer failed: $($_.Exception.Message)"
        Log-Err 'Manual install:  irm https://omp.sh/install.ps1 | iex'
    }
    $ompVersion = Get-OmpVersion
    if ($ompVersion) { Log-Ok "omp $ompVersion -> $(Get-OmpExe)" }
    else { Log-Err 'omp.exe is not available -- cannot continue.'; $InstallFailed = $true }
}
$OmpExe = Get-OmpExe

# omp auto-discovers only %ProgramFiles%\Git\bin\bash.exe. Its installer
# writes shellPath = the first bash.exe on PATH, which without Git for Windows
# is the WSL launcher shim in System32 (it swallows every command when no
# Linux distro is installed). So: a real Git Bash elsewhere (PortableGit) gets
# written to shellPath; the WSL shim is removed so omp uses its built-in shell.
$programFilesBash = if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Git\bin\bash.exe' } else { $null }
$gitBash = @($programFilesBash, (Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'PortableGit\bin\bash.exe')) |
    Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$ompSettings = Join-Path $AgentDir 'settings.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
try {
    $settingsObject = if (Test-Path $ompSettings) { [IO.File]::ReadAllText($ompSettings) | ConvertFrom-Json } else { New-Object PSObject }
    $currentShell = [string]$settingsObject.shellPath
    $isShim = $currentShell -match '\\(System32|Sysnative)\\bash\.exe$'
    $wanted = $null
    if ($gitBash -and $gitBash -ne $programFilesBash) { $wanted = $gitBash }
    if ($wanted -and ($isShim -or -not $currentShell -or -not (Test-Path $currentShell))) {
        $settingsObject | Add-Member -NotePropertyName shellPath -NotePropertyValue $wanted -Force
        New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
        [IO.File]::WriteAllText($ompSettings, ($settingsObject | ConvertTo-Json -Depth 8), $utf8NoBom)
        Log-Ok "shellPath -> $wanted (Git Bash)"
    } elseif ($isShim) {
        $settingsObject.PSObject.Properties.Remove('shellPath')
        [IO.File]::WriteAllText($ompSettings, ($settingsObject | ConvertTo-Json -Depth 8), $utf8NoBom)
        Log-Ok 'removed shellPath -> WSL launcher shim (omp uses its built-in shell instead)'
    }
} catch { Log-Warn "could not check shellPath in ${ompSettings}: $($_.Exception.Message)" }
if ($gitBash) { Log-Ok "shell: Git Bash ($gitBash)" }
else          { Log-Ok "shell: omp's built-in bash-compatible shell (install Git for Windows for full Git Bash)" }

# ---------- step 3: the modelserver extension ----------
Section '3/5 - modelserver extension'
Say $ExtensionDir
if (-not $InstallFailed) {
    try {
        New-Item -ItemType Directory -Force -Path $ExtensionDir | Out-Null
        foreach ($file in @('modelserver.ts', 'package.json')) {
            $tmp = Join-Path $ExtensionDir "$file.tmp"
            Get-Authed "/api/omp/extension/$file" $tmp
            Move-Item -Force -LiteralPath $tmp -Destination (Join-Path $ExtensionDir $file)
        }
        # A Pi-era install left node_modules + a lockfile here; omp needs neither.
        Remove-Item -Recurse -Force (Join-Path $ExtensionDir 'node_modules') -ErrorAction SilentlyContinue
        Remove-Item -Force (Join-Path $ExtensionDir 'package-lock.json') -ErrorAction SilentlyContinue
        Log-Ok 'extension files installed (no dependencies to fetch -- omp bundles them)'
    } catch {
        Log-Err "extension download failed: $($_.Exception.Message)"
        $InstallFailed = $true
    }
}

# ---------- step 4: config.yml ----------
Section '4/5 - omp config'
$fast = ''; $strong = ''; $pair = $null; $modelIds = @()
try {
    $models = $modelsJson | ConvertFrom-Json
    foreach ($m in $models.data) {
        $id = [string]$m.id
        if ($id -match '^/models/([^/]+)/') { $id = $Matches[1] }
        if ($id -and $id -ne 'auto') { $modelIds += $id }
    }
} catch { }
try {
    $pair = (Get-Authed '/api/omp/pair') | ConvertFrom-Json
    if ($pair.primary)   { $fast = [string]$pair.primary }
    if ($pair.secondary) { $strong = [string]$pair.secondary }
} catch { }
if (-not $fast -and $modelIds.Count) { $fast = $modelIds[0] }
if (-not $strong) { $strong = $fast }

# Set a top-level YAML block (replaces an existing one, keeps every other key).
# Written directly rather than with `omp config set`: Windows PowerShell 5.1
# strips the double quotes inside a JSON argument passed to a native exe, so
# omp received an unparseable value and refused it.
function Set-YamlBlock ([string]$Path, [string]$Key, [string[]]$BlockLines) {
    $lines = @()
    if (Test-Path $Path) { $lines = @([IO.File]::ReadAllLines($Path)) }
    $out = New-Object System.Collections.Generic.List[string]
    $skipping = $false
    foreach ($line in $lines) {
        if ($line -match ('^' + [regex]::Escape($Key) + ':')) { $skipping = $true; continue }
        if ($skipping -and ($line -match '^\s' -or $line -eq '')) { continue }
        $skipping = $false
        $out.Add($line)
    }
    $out.Add("${Key}:")
    foreach ($l in $BlockLines) { $out.Add($l) }
    New-Item -ItemType Directory -Force -Path (Split-Path $Path) | Out-Null
    [IO.File]::WriteAllText($Path, (($out -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
}

if (-not $InstallFailed) {
    $currentDefault = ''
    if (Test-Path $ConfigPath) {
        $inRoles = $false
        foreach ($line in [IO.File]::ReadAllLines($ConfigPath)) {
            if ($line -match '^modelRoles:') { $inRoles = $true; continue }
            if ($inRoles -and $line -match '^\S') { break }
            if ($inRoles -and $line -match '^\s+default:\s*(.+)$') { $currentDefault = $Matches[1].Trim().Trim('"', "'"); break }
        }
    }
    try {
        if (-not $fast) {
            Log-Warn 'no model is loaded on the server -- load one, then re-run (or pick it with /model inside omp)'
        } elseif ($currentDefault -and -not $currentDefault.StartsWith('modelserver/')) {
            Log-Ok "config.yml already defaults to $currentDefault -- left alone (choose modelserver models with /model)"
        } else {
            # default = the everyday (fast) model: the server moves substantial
            # tasks to the stronger model itself when two models are paired.
            Set-YamlBlock $ConfigPath 'modelRoles' @("  default: modelserver/$fast", "  smol: modelserver/$fast", "  slow: modelserver/$strong")
            Log-Ok "modelRoles: default/smol -> $fast, slow -> $strong"
        }
        $hasDisabled = (Test-Path $ConfigPath) -and ([IO.File]::ReadAllText($ConfigPath) -match '(?m)^disabledProviders:')
        if (-not $hasDisabled) {
            Set-YamlBlock $ConfigPath 'disabledProviders' @('  - ollama', '  - llama.cpp', '  - lm-studio')
            Log-Ok 'local-server auto-discovery off (ollama, llama.cpp, lm-studio)'
        } else {
            Log-Ok 'disabledProviders already set -- left alone'
        }
    } catch {
        Log-Warn "could not update ${ConfigPath}: $($_.Exception.Message) -- pick the model with /model inside omp"
    }
    if ($OmpExe) {
        $env:PI_CODING_AGENT_DIR = $AgentDir
        $check = ((& $OmpExe config get modelRoles) 2>$null | Out-String).Trim()
        if ($check -and $check -notmatch 'modelserver/') { Log-Warn "omp reads modelRoles as: $check" }
    }
    Say $ConfigPath
}

# ---------- step 5: user environment ----------
Section '5/5 - user environment'
# Windows has no ~/.bashrc -- persist to the USER environment so every NEW
# terminal (PowerShell, cmd, Windows Terminal) has it.
[Environment]::SetEnvironmentVariable('MODELSERVER_BASE_URL', $BaseUrl, 'User')
$env:MODELSERVER_BASE_URL = $BaseUrl
Log-Ok 'persisted MODELSERVER_BASE_URL (user env)'
[Environment]::SetEnvironmentVariable('MODELSERVER_API_KEY', $env:MODELSERVER_API_KEY, 'User')
Log-Ok 'persisted MODELSERVER_API_KEY (user env -- remove with: [Environment]::SetEnvironmentVariable("MODELSERVER_API_KEY", $null, "User"))'
# The Pi-era installer persisted NODE_TLS_REJECT_UNAUTHORIZED=0 for every Node
# program; the omp extension relaxes TLS itself for a private/localhost server
# (MODELSERVER_INSECURE_TLS=1 for a public self-signed one), so drop it.
if ([Environment]::GetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED', 'User') -eq '0') {
    [Environment]::SetEnvironmentVariable('NODE_TLS_REJECT_UNAUTHORIZED', $null, 'User')
    Log-Ok 'removed the Pi-era NODE_TLS_REJECT_UNAUTHORIZED=0 from the user env (no longer needed)'
}

# ---------- old Pi (pi.dev) ----------
$oldPiExt = Join-Path $env:USERPROFILE '.pi\agent\extensions\modelserver'
$oldPi = Get-Command pi.cmd -ErrorAction SilentlyContinue
if ((Test-Path $oldPiExt) -or $oldPi) {
    if ($env:OMP_INSTALL_REMOVE_PI) {
        Remove-Item -Recurse -Force $oldPiExt -ErrorAction SilentlyContinue
        $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if ($oldPi -and $npmCmd) { & $npmCmd.Source uninstall -g @earendil-works/pi-coding-agent *> $null }
        Log-Ok 'removed the old Pi CLI / modelserver Pi extension'
    } else {
        Log-Warn 'an old Pi (pi.dev) install is still here -- omp replaces it. Remove it with:'
        Log-Warn '    npm.cmd uninstall -g @earendil-works/pi-coding-agent'
        Log-Warn "    Remove-Item -Recurse -Force $oldPiExt"
        Log-Warn '  (or re-run this installer with $env:OMP_INSTALL_REMOVE_PI = "1")'
    }
}

# ---------- verification ----------
if ($InstallFailed) { Section 'Install FAILED -- see errors above' }
else                { Section 'Install complete' }
$ompSummary = if ($ompVersion) { "$ompVersion ($OmpExe)" } else { 'MISSING' }
Say "omp:        $ompSummary"
Say "Extension:  $ExtensionDir"
Say "Config:     $ConfigPath"
Say "Base URL:   $BaseUrl"
Say "Models:     $($modelIds.Count) on the server$(if ($fast) { " -- default modelserver/$fast" })"

# The extension registers the handover tools (ask_assistant / await_assistant)
# from /api/omp/pair at startup. When the pair is not usable the agent has no
# way to delegate, which looks exactly like the models "choosing" not to -- so
# report the real state.
$pairSummary = 'unknown (could not reach the server)'
if ($pair) {
    if ($pair.enabled) { $pairSummary = "ACTIVE -- $($pair.secondary) leads, $($pair.primary) assists (mode $($pair.mode))" }
    else               { $pairSummary = "NOT ACTIVE -- $($pair.detail)" }
}
Say "Two models: $pairSummary"
Write-Host ''
if (-not $InstallFailed) {
    Say 'This window is ready -- run:'
    Say '  omp'
    Say '  omp -p "Reply with OK"    (one-shot check)'
    Say '(new terminals pick everything up from the user environment automatically)'
} else {
    Say 'Fix the errors above and re-run -- the installer is idempotent and skips finished steps.'
}
Write-Host ''
