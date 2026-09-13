param(
    [string]$Version = $(if ($env:LETTA_VERSION) { $env:LETTA_VERSION } else { "latest" }),
    [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$PackageName = "@letta-ai/letta-code"
$NodeMajor = 22
$NodeMinimumMinor = 19
$InstallRoot = if ($env:LETTA_INSTALL_ROOT) { $env:LETTA_INSTALL_ROOT } else { Join-Path $env:LOCALAPPDATA "letta" }
$BinDir = if ($env:LETTA_BIN_DIR) { $env:LETTA_BIN_DIR } else { Join-Path $InstallRoot "bin" }
$NpmSpec = $env:LETTA_NPM_SPEC
$NodeDir = Join-Path $InstallRoot "node"
$NpmPrefix = Join-Path $InstallRoot "npm"
$PackageDir = Join-Path $NpmPrefix "node_modules\@letta-ai\letta-code"
$PackageEntry = Join-Path $PackageDir "letta.js"
$PackageShim = Join-Path $NpmPrefix "letta.cmd"
$Launcher = Join-Path $BinDir "letta.cmd"

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message"
}

function Test-NodeCompatible {
    param([string]$NodePath)

    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath)) {
        return $false
    }

    try {
        $raw = (& $NodePath --version 2>$null).Trim().TrimStart("v")
        $parsed = [version]($raw -replace '-.*$', '')
        return $parsed.Major -gt $NodeMajor -or (
            $parsed.Major -eq $NodeMajor -and $parsed.Minor -ge $NodeMinimumMinor
        )
    } catch {
        return $false
    }
}

function Get-WindowsArchitecture {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) {
        $env:PROCESSOR_ARCHITEW6432
    } else {
        $env:PROCESSOR_ARCHITECTURE
    }

    switch ($architecture.ToUpperInvariant()) {
        "ARM64" { return "arm64" }
        "AMD64" { return "x64" }
        default { throw "Unsupported Windows architecture: $architecture" }
    }
}

function Install-ManagedNode {
    $arch = Get-WindowsArchitecture
    $baseUrl = "https://nodejs.org/dist/latest-v$NodeMajor.x"
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "letta-install-$PID"

    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    try {
        Write-Step "Downloading Node.js $NodeMajor for windows-$arch"
        $shasumsPath = Join-Path $tempDir "SHASUMS256.txt"
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -OutFile $shasumsPath

        $pattern = "node-v$NodeMajor\.[0-9]+\.[0-9]+-win-$arch\.zip"
        $manifestLine = Get-Content $shasumsPath | Where-Object { $_ -match "^[a-f0-9]{64}\s+$pattern$" } | Select-Object -First 1
        if (-not $manifestLine) {
            throw "No Node.js archive is available for windows-$arch"
        }

        $parts = $manifestLine -split '\s+'
        $expectedHash = $parts[0].ToLowerInvariant()
        $archive = $parts[1]
        $archivePath = Join-Path $tempDir $archive
        Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archive" -OutFile $archivePath

        $actualHash = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "Node.js checksum verification failed"
        }

        $extractDir = Join-Path $tempDir "extract"
        Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force
        $extracted = Get-ChildItem $extractDir -Directory | Select-Object -First 1
        if (-not $extracted -or -not (Test-Path (Join-Path $extracted.FullName "node.exe"))) {
            throw "Downloaded Node.js archive is incomplete"
        }

        New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
        $staged = Join-Path $InstallRoot ".node-new-$PID"
        Remove-Item -Recurse -Force $staged -ErrorAction SilentlyContinue
        Move-Item $extracted.FullName $staged
        Remove-Item -Recurse -Force $NodeDir -ErrorAction SilentlyContinue
        Move-Item $staged $NodeDir
    } finally {
        Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
    }
}

if (-not $NpmSpec -and $Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
    throw "Invalid version: $Version"
}

$managedNode = Join-Path $NodeDir "node.exe"
$managedNpm = Join-Path $NodeDir "npm.cmd"
$nodePath = $null
$npmPath = $null

if ((Test-NodeCompatible $managedNode) -and (Test-Path $managedNpm)) {
    $nodePath = $managedNode
    $npmPath = $managedNpm
    Write-Step "Using managed $(& $nodePath --version)"
} else {
    $systemNode = Get-Command node -ErrorAction SilentlyContinue
    $systemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $systemNpm) {
        $systemNpm = Get-Command npm -ErrorAction SilentlyContinue
    }

    if ($systemNode -and $systemNpm -and (Test-NodeCompatible $systemNode.Source)) {
        $nodePath = $systemNode.Source
        $npmPath = $systemNpm.Source
        Write-Step "Using $(& $nodePath --version) from PATH"
    } else {
        Install-ManagedNode
        $nodePath = $managedNode
        $npmPath = $managedNpm
        Write-Step "Installed $(& $nodePath --version)"
    }
}

$nodeBinDir = Split-Path $nodePath -Parent
$env:Path = "$nodeBinDir;$env:Path"
$env:NPM_CONFIG_UPDATE_NOTIFIER = "false"

New-Item -ItemType Directory -Force -Path $NpmPrefix, $BinDir | Out-Null
$installTarget = if ($NpmSpec) { $NpmSpec } else { "$PackageName@$Version" }

Write-Step "Installing Letta Code ($installTarget)"
& $npmPath install --global --prefix $NpmPrefix --no-audit --no-fund --loglevel=error $installTarget
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path $PackageEntry)) {
    throw "npm did not install the Letta Code entrypoint"
}
if (-not (Test-Path $PackageShim)) {
    throw "npm did not create the Letta Code command"
}

$launcherContent = @"
@echo off
set "PATH=$nodeBinDir;%PATH%"
set "LETTA_UPDATE_INSTALL_PREFIX=$NpmPrefix"
set "NPM_CONFIG_UPDATE_NOTIFIER=false"
set "LETTA_PACKAGE_MANAGER=npm"
call "$PackageShim" %*
exit /b %ERRORLEVEL%
"@
$launcherTemp = Join-Path $BinDir ".letta-new-$PID.cmd"
Set-Content -Path $launcherTemp -Value $launcherContent -Encoding ASCII
Move-Item -Force $launcherTemp $Launcher

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = if ($userPath) { $userPath -split ';' } else { @() }
$existingLetta = Get-Command letta.cmd -ErrorAction SilentlyContinue
$launcherIsActive = $existingLetta -and $existingLetta.Source -ieq $Launcher
$binOnUserPath = $pathEntries | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') }
$pathNeedsUpdate = -not $binOnUserPath -or -not $launcherIsActive

if ($pathNeedsUpdate) {
    if ($NoModifyPath) {
        Write-Warning "$Launcher is not the active letta command on PATH"
    } else {
        $remainingEntries = $pathEntries | Where-Object { $_.TrimEnd('\') -ine $BinDir.TrimEnd('\') }
        $newUserPath = (@($BinDir) + @($remainingEntries)) -join ';'
        [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
        Write-Step "Added $BinDir to the user PATH"
    }
}

$installedVersion = (& $Launcher --version 2>$null | Out-String).Trim()
if (-not $installedVersion) {
    throw "Letta Code was installed but failed its version check"
}

Write-Host ""
Write-Host "Letta Code $installedVersion installed successfully."
if ($pathNeedsUpdate) {
    Write-Host "Open a new terminal before running letta."
}
Write-Host "Run: letta"
