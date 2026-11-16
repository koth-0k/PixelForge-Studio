param(
  [string]$BuildRoot = (Join-Path $env:LOCALAPPDATA 'PixelForgeStudio'),
  [string]$InstallerOutputDirectory = ''
)

$ErrorActionPreference = 'Stop'
$SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$BuildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
$InstallerName = 'PixelForge Studio Setup 1.0.0.exe'
if ([string]::IsNullOrWhiteSpace($InstallerOutputDirectory)) {
  $InstallerOutputDirectory = Join-Path $SourceRoot 'release'
} else {
  $InstallerOutputDirectory = [System.IO.Path]::GetFullPath($InstallerOutputDirectory)
}
$InstallerDestination = Join-Path $InstallerOutputDirectory $InstallerName
$BlockmapDestination = "$InstallerDestination.blockmap"
if ((Test-Path -LiteralPath $InstallerDestination) -or (Test-Path -LiteralPath $BlockmapDestination)) {
  throw "Refusing to overwrite an existing installer candidate in '$InstallerOutputDirectory'. Choose a new output directory."
}
$Excluded = @('node_modules', 'node_modules.interrupted', 'release', 'dist', 'dist-electron', '.git')
$copyArgs = @($SourceRoot, $BuildRoot, '/E', '/COPY:DAT', '/R:1', '/W:1', '/XD') + $Excluded
& robocopy @copyArgs
if ($LASTEXITCODE -ge 8) { throw "Source sync to '$BuildRoot' failed (robocopy exit $LASTEXITCODE)." }

$lockFile = Join-Path $BuildRoot 'package-lock.json'
$lockHash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash
$stamp = Join-Path $BuildRoot '.pixelforge-lock-hash'
$requiredFiles = @(
  (Join-Path $BuildRoot 'node_modules\typescript\bin\tsc'),
  (Join-Path $BuildRoot 'node_modules\vite\bin\vite.js'),
  (Join-Path $BuildRoot 'node_modules\electron\dist\electron.exe'),
  (Join-Path $BuildRoot 'node_modules\@esbuild\win32-x64\esbuild.exe')
)
$installedHash = if (Test-Path -LiteralPath $stamp) { (Get-Content -LiteralPath $stamp -Raw).Trim() } else { '' }
$dependenciesReady = ($requiredFiles | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -eq 0

Push-Location $BuildRoot
try {
  Write-Host "Node: $(& node --version)"
  Write-Host "npm:  $(& npm.cmd --version)"
  if (-not $dependenciesReady -or $installedHash -ne $lockHash) {
    Write-Host 'Installing exact lockfile dependencies in the local build directory...'
    & npm.cmd ci --prefer-offline --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)." }
    Set-Content -LiteralPath $stamp -Value $lockHash -NoNewline
  }

  $installer = Join-Path $BuildRoot "release\$InstallerName"
  if ((Test-Path -LiteralPath $installer) -or (Test-Path -LiteralPath "$installer.blockmap")) {
    throw "Refusing to overwrite an existing installer candidate in '$BuildRoot\release'. Use a new build root."
  }
  & npm.cmd run dist:win
  if ($LASTEXITCODE -ne 0) { throw "Windows build failed (exit $LASTEXITCODE)." }

  if (-not (Test-Path -LiteralPath $installer)) { throw "Build completed without producing '$installer'." }
  foreach ($name in @('dist', 'dist-electron')) {
    & robocopy (Join-Path $BuildRoot $name) (Join-Path $SourceRoot $name) /E /COPY:DAT /R:1 /W:1
    if ($LASTEXITCODE -ge 8) { throw "Copying '$name' back to the source project failed (robocopy exit $LASTEXITCODE)." }
  }
  if (-not (Test-Path -LiteralPath $InstallerOutputDirectory)) { New-Item -ItemType Directory -Path $InstallerOutputDirectory | Out-Null }
  Copy-Item -LiteralPath $installer -Destination $InstallerDestination
  $blockmap = "$installer.blockmap"
  if (Test-Path -LiteralPath $blockmap) { Copy-Item -LiteralPath $blockmap -Destination $BlockmapDestination }
  Write-Host "Windows installer ready: $InstallerDestination"
}
finally {
  Pop-Location
}
