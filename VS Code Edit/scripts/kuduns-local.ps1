[CmdletBinding()]
param([switch]$Setup, [switch]$Check, [switch]$SelfTest, [switch]$NoBrowser)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$oldBrowser = $env:KUDU_OPEN_BROWSER
Push-Location $root
try {
  $selectedModes = @($Setup.IsPresent, $Check.IsPresent, $SelfTest.IsPresent) | Where-Object { $_ }
  if (@($selectedModes).Count -gt 1) {
    throw "Choose only one of -Setup, -Check or -SelfTest."
  }
  $nodeVersion = & node --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw "Install Node.js 24 before continuing." }
  $pnpmVersion = & pnpm --version
  if ($LASTEXITCODE -ne 0 -or $pnpmVersion.Trim() -ne "10.26.1") { throw "Install pnpm 10.26.1 before continuing." }
  if ($Setup) {
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Production build failed." }
  }
  if ($Setup -or $Check -or $SelfTest) {
    & pnpm local:check
    if ($LASTEXITCODE -ne 0) { throw "Local SQLite runtime check failed. No existing database was changed." }
    Write-Host "KuduNS Local is ready. PostgreSQL, Docker, database credentials and operator login are not required."
  } else {
    if (-not (Test-Path "backend/node_modules/better-sqlite3")) { throw "Run .\scripts\kuduns.ps1 -Setup first." }
    if ($NoBrowser) { $env:KUDU_OPEN_BROWSER = "0" }
    & pnpm dev
    if ($LASTEXITCODE -ne 0) { throw "KuduNS Local stopped with an error. Review the output above." }
  }
} catch {
  Write-Error $_.Exception.Message
  exit 1
} finally {
  $env:KUDU_OPEN_BROWSER = $oldBrowser
  Pop-Location
}
exit 0
