param(
  [ValidateSet("x64", "arm64")]
  [string]$Arch = "x64",
  [string]$OutRoot = "vendor/windows-sandbox",
  [switch]$CopyToAllWindowsArchitectures
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$source = Join-Path $repoRoot "native/windows-sandbox/LettaWindowsSandbox.cs"
$manifest = Join-Path $repoRoot "native/windows-sandbox/LettaWindowsSandbox.manifest"

if (-not (Test-Path $source)) {
  throw "Windows sandbox helper source not found: $source"
}
if (-not (Test-Path $manifest)) {
  throw "Windows sandbox helper manifest not found: $manifest"
}

function Find-CSharpCompiler {
  $pathCompiler = Get-Command "csc.exe" -ErrorAction SilentlyContinue
  if ($pathCompiler) {
    return $pathCompiler.Source
  }

  $systemRoot = $env:SystemRoot
  if (-not $systemRoot) { $systemRoot = $env:WINDIR }
  if (-not $systemRoot) { $systemRoot = "C:\Windows" }

  $candidates = @(
    (Join-Path $systemRoot "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
    (Join-Path $systemRoot "Microsoft.NET/Framework/v4.0.30319/csc.exe"),
    (Join-Path $systemRoot "Microsoft.NET/Framework64/v4.8/csc.exe"),
    (Join-Path $systemRoot "Microsoft.NET/Framework/v4.8/csc.exe")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Unable to find csc.exe on PATH or in .NET Framework directories"
}

# The helper is pure managed C# plus P/Invoke declarations. AnyCPU keeps one
# helper source/build path usable for both Windows x64 and arm64 package slots.
$platform = "anycpu"
$compiler = Find-CSharpCompiler
$targetDir = Join-Path $repoRoot (Join-Path $OutRoot "win32-$Arch")
$outExe = Join-Path $targetDir "letta-windows-sandbox.exe"
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

Write-Host "Building Windows sandbox helper"
Write-Host "  compiler: $compiler"
Write-Host "  source:   $source"
Write-Host "  manifest: $manifest"
Write-Host "  output:   $outExe"

& $compiler `
  /nologo `
  /target:exe `
  "/platform:$platform" `
  "/win32manifest:$manifest" `
  "/out:$outExe" `
  $source

if ($LASTEXITCODE -ne 0) {
  throw "csc.exe failed with exit code $LASTEXITCODE"
}

if ($CopyToAllWindowsArchitectures) {
  foreach ($targetArch in @("x64", "arm64")) {
    $copyDir = Join-Path $repoRoot (Join-Path $OutRoot "win32-$targetArch")
    $copyExe = Join-Path $copyDir "letta-windows-sandbox.exe"
    New-Item -ItemType Directory -Force -Path $copyDir | Out-Null
    Copy-Item -Force $outExe $copyExe
    Write-Host "Copied helper to $copyExe"
  }
}
