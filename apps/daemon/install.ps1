$ErrorActionPreference = "Stop"

$releaseBase = if ($env:LETTA_DAEMON_RELEASE_BASE) {
  $env:LETTA_DAEMON_RELEASE_BASE.TrimEnd("/")
} else {
  "https://github.com/letta-ai/letta-code/releases/latest/download"
}

if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "x86_64")) {
  throw "Letta Daemon currently supports Windows x64."
}

$asset = "letta-daemon-win-x64.exe"
$temporaryDirectory = Join-Path $env:TEMP ("letta-daemon-" + [guid]::NewGuid())
$installerPath = Join-Path $temporaryDirectory $asset
$checksumsPath = Join-Path $temporaryDirectory "SHA256SUMS"
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
  Write-Host "Downloading $asset..."
  & curl.exe -fsSL "$releaseBase/$asset" -o $installerPath
  if ($LASTEXITCODE -ne 0) { throw "Failed to download $asset." }
  & curl.exe -fsSL "$releaseBase/SHA256SUMS" -o $checksumsPath
  if ($LASTEXITCODE -ne 0) { throw "Failed to download SHA256SUMS." }

  $checksumPattern = "^(?<hash>[A-Fa-f0-9]{64})\s+\*?$([regex]::Escape($asset))$"
  $expected = Get-Content $checksumsPath | ForEach-Object {
    if ($_ -match $checksumPattern) { $Matches["hash"].ToLowerInvariant() }
  } | Select-Object -First 1
  if (-not $expected) { throw "The release does not contain a valid checksum for $asset." }

  $actual = (Get-FileHash -Algorithm SHA256 $installerPath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { throw "Checksum verification failed for $asset." }

  $signature = Get-AuthenticodeSignature $installerPath
  if ($signature.Status -ne "Valid") {
    throw "The installer signature is not valid: $($signature.StatusMessage)"
  }
  if ($signature.SignerCertificate.Subject -notmatch "(?i)Letta") {
    throw "The installer was not signed by the expected Letta publisher."
  }

  $process = Start-Process -FilePath $installerPath -ArgumentList "/S" -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "The installer exited with code $($process.ExitCode)." }
  Write-Host "Installed Letta Daemon."
} finally {
  Remove-Item -Recurse -Force $temporaryDirectory -ErrorAction SilentlyContinue
}
