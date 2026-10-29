[CmdletBinding()]
param(
  [switch]$Setup,
  [switch]$Check,
  [switch]$SelfTest,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:PsqlPath = $null
$script:PnpmPath = $null
$script:PnpmCmdPath = $null

function Write-Info([string]$Message) {
  Write-Host $Message
}

function Stop-Workflow([string]$Message, [int]$ExitCode = 1) {
  throw [System.InvalidOperationException]::new("$ExitCode|$Message")
}

function Get-ExecutablePath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) {
    if ($command.Source) { return $command.Source }
    if ($command.Path) { return $command.Path }
  }
  return $null
}

function Get-PostgresExecutable([string]$Name) {
  $fromPath = Get-ExecutablePath $Name
  if ($fromPath) { return $fromPath }

  $fileName = "$Name.exe"
  $installRoot = Join-Path $env:ProgramFiles "PostgreSQL"
  if (Test-Path $installRoot) {
    $matches = @(Get-ChildItem -Path $installRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object {
        $candidate = Join-Path (Join-Path $_.FullName "bin") $fileName
        if (Test-Path $candidate) {
          $version = $null
          if ([Version]::TryParse($_.Name, [ref]$version)) {
            [pscustomobject]@{ Version = $version; Path = $candidate }
          }
        }
      } |
      Sort-Object Version -Descending)
    if ($matches.Count -gt 0) { return $matches[0].Path }
  }
  return $null
}

function Get-JsonFile([string]$Path) {
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    Stop-Workflow "Could not read project metadata at $Path."
  }
}

function Get-NodeVersionParts([string]$Version) {
  if ($Version -notmatch '^v?(\d+)\.(\d+)\.(\d+)') {
    Stop-Workflow "Could not understand the installed Node.js version."
  }
  return @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
}

function Compare-VersionParts([int[]]$Left, [int[]]$Right) {
  for ($index = 0; $index -lt 3; $index++) {
    if ($Left[$index] -lt $Right[$index]) { return -1 }
    if ($Left[$index] -gt $Right[$index]) { return 1 }
  }
  return 0
}

function Test-NodeEngine([string]$InstalledVersion, [string]$EngineRange) {
  if ($EngineRange -notmatch '^>=\s*(\d+\.\d+\.\d+)\s*<\s*(\d+\.\d+\.\d+)$') {
    Stop-Workflow "The package.json Node.js engine range is not understood: $EngineRange"
  }
  $minimumText = $Matches[1]
  $maximumText = $Matches[2]
  $minimum = Get-NodeVersionParts $minimumText
  $maximum = Get-NodeVersionParts $maximumText
  $installed = Get-NodeVersionParts $InstalledVersion
  return ((Compare-VersionParts $installed $minimum) -ge 0) -and
    ((Compare-VersionParts $installed $maximum) -lt 0)
}

function Assert-ToolVersions {
  $package = Get-JsonFile (Join-Path $script:ProjectRoot "package.json")
  $script:PnpmPath = Get-ExecutablePath "pnpm"
  $script:PnpmCmdPath = Get-ExecutablePath "pnpm.cmd"
  if (-not $script:PnpmPath) {
    Stop-Workflow "pnpm was not found. Enable Corepack, then run corepack prepare pnpm@$($package.packageManager -replace '^pnpm@','') --activate."
  }
  $nodePath = Get-ExecutablePath "node"
  if (-not $nodePath) { Stop-Workflow "Node.js was not found on PATH. Install the version required by package.json." }

  $nodeVersion = (& $nodePath --version 2>$null | Select-Object -First 1)
  if (-not $nodeVersion -or -not (Test-NodeEngine $nodeVersion ([string]$package.engines.node))) {
    Stop-Workflow "Node.js $nodeVersion does not satisfy package.json engines.node ($($package.engines.node))."
  }
  $expectedPnpm = ([string]$package.packageManager) -replace '^pnpm@', ''
  $pnpmVersion = (& $script:PnpmPath --version 2>$null | Select-Object -First 1)
  if ($pnpmVersion -ne $expectedPnpm) {
    Stop-Workflow "pnpm $pnpmVersion is installed; package.json requires exactly $expectedPnpm. Activate it with Corepack."
  }

  Write-Info "Node.js $nodeVersion and pnpm $pnpmVersion satisfy package.json."
}

function Find-PostgresTools {
  $script:PsqlPath = Get-PostgresExecutable "psql"
  $pgIsReadyPath = Get-PostgresExecutable "pg_isready"
  if (-not $script:PsqlPath) {
    Stop-Workflow "psql was not found on PATH or under $env:ProgramFiles\PostgreSQL\<version>\bin. Install PostgreSQL command-line tools."
  }
  if ($pgIsReadyPath) {
    Write-Info "PostgreSQL tools found: psql and pg_isready."
  } else {
    Write-Info "psql found; optional pg_isready was not found. Connectivity will be checked with psql."
  }
}

function Read-EnvFile([string]$Path) {
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
      $key = $Matches[1]
      $value = $Matches[2].Trim()
      if ($value.Length -ge 2) {
        $first = $value[0]
        $last = $value[$value.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
          $value = $value.Substring(1, $value.Length - 2)
          if ($first -eq '"') {
            $value = $value.Replace('\n', "`n").Replace('\r', "`r").Replace('\"', '"').Replace('\\', '\')
          }
        } else {
          $value = ($value -replace '\s+#.*$', '').Trim()
        }
      }
      $values[$key] = $value
    }
  }
  return $values
}

function Get-DatabaseConnection([string]$DatabaseUrl) {
  if (-not $DatabaseUrl) { Stop-Workflow "DATABASE_URL is missing from .env." }
  try {
    $uri = [Uri]::new($DatabaseUrl)
  } catch {
    Stop-Workflow "DATABASE_URL in .env is not a valid PostgreSQL URL. Its value has not been displayed."
  }
  if ($uri.Scheme -notin @("postgres", "postgresql") -or -not $uri.Host -or -not $uri.AbsolutePath.Trim("/")) {
    Stop-Workflow "DATABASE_URL must use postgres:// or postgresql:// and include a host and database name."
  }
  $userInfo = $uri.UserInfo
  $separator = $userInfo.IndexOf(':')
  if ($separator -lt 0) {
    Stop-Workflow "DATABASE_URL must include a username and password. Its value has not been displayed."
  }
  $databasePort = 5432
  if (-not $uri.IsDefaultPort) { $databasePort = $uri.Port }
  return [pscustomobject]@{
    Host = $uri.Host
    Port = $databasePort
    Database = [Uri]::UnescapeDataString($uri.AbsolutePath.TrimStart('/'))
    User = [Uri]::UnescapeDataString($userInfo.Substring(0, $separator))
    Password = [Uri]::UnescapeDataString($userInfo.Substring($separator + 1))
  }
}

function ConvertTo-SqlLiteral([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Invoke-Psql {
  param(
    [Parameter(Mandatory = $true)]$Connection,
    [string]$Database,
    [string]$Command,
    [string]$InputSql,
    [switch]$Interactive
  )

  $environmentNames = @("PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGCONNECT_TIMEOUT")
  $oldEnvironment = @{}
  foreach ($name in $environmentNames) {
    $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    $env:PGHOST = [string]$Connection.Host
    $env:PGPORT = [string]$Connection.Port
    $env:PGUSER = [string]$Connection.User
    $env:PGPASSWORD = [string]$Connection.Password
    $env:PGDATABASE = if ($Database) { $Database } else { [string]$Connection.Database }
    $env:PGCONNECT_TIMEOUT = "5"

    $arguments = @("--no-password", "--no-psqlrc", "--set=ON_ERROR_STOP=1")
    if ($Interactive) {
      & $script:PsqlPath @arguments -c $Command
      return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = "" }
    }
    if ($InputSql) {
      $output = $InputSql | & $script:PsqlPath @arguments --no-align --tuples-only --file=- 2>&1
    } else {
      $output = & $script:PsqlPath @arguments --no-align --tuples-only -c $Command 2>&1
    }
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n") }
  } finally {
    foreach ($name in $environmentNames) {
      [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name], "Process")
    }
  }
}

function Get-ConnectionFailureMessage([string]$Output) {
  if ($Output -match '(?i)connection refused|could not connect to server|no route to host|timeout expired') {
    return "PostgreSQL did not accept a connection. Check that its Windows service is running and that DATABASE_URL uses the correct host and port (usually 127.0.0.1:5432)."
  }
  if ($Output -match '(?i)password authentication failed|authentication failed') {
    return "PostgreSQL rejected the configured username or password. The setup has not changed either credential."
  }
  if ($Output -match '(?i)database .* does not exist') {
    return "The configured PostgreSQL database does not exist."
  }
  if ($Output -match '(?i)role .* does not exist') {
    return "The configured PostgreSQL role does not exist."
  }
  if ($Output -match '(?i)could not translate host name') {
    return "PostgreSQL host lookup failed. Check the hostname in DATABASE_URL."
  }
  if ($Output -match '(?i)no pg_hba.conf entry|SSL error|certificate') {
    return "PostgreSQL rejected the connection policy or TLS settings. Check PostgreSQL's local connection policy."
  }
  return "The PostgreSQL check failed. Check the local PostgreSQL service and its authentication policy. No password or database URL was printed."
}

function Test-DatabaseConnection($Connection) {
  $result = Invoke-Psql -Connection $Connection -Command "SELECT current_setting('server_version_num');"
  if ($result.ExitCode -ne 0) {
    return [pscustomobject]@{ Success = $false; Version = ""; Message = (Get-ConnectionFailureMessage $result.Output) }
  }
  $versionLine = ($result.Output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
  if ($versionLine -notmatch '^\d+$') {
    return [pscustomobject]@{ Success = $false; Version = ""; Message = "psql connected but did not return a PostgreSQL server version." }
  }
  $major = [int][Math]::Floor(([double]$versionLine / 10000))
  return [pscustomobject]@{ Success = $true; Version = "$major (server_version_num $versionLine)"; Message = "" }
}

function Read-HiddenValue([string]$Prompt) {
  $secureValue = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Read-MatchingHiddenValues([string]$Prompt) {
  $first = Read-HiddenValue $Prompt
  $second = Read-HiddenValue "Enter it again to confirm"
  if ($first -cne $second) { Stop-Workflow "The values did not match. No password was changed." }
  return $first
}

function Test-LoopbackHost([string]$HostName) {
  return $HostName -in @("localhost", "127.0.0.1", "::1")
}

function Get-AdminState($AppConnection, [string]$AdminUser, [string]$AdminPassword) {
  $admin = [pscustomobject]@{
    Host = $AppConnection.Host
    Port = $AppConnection.Port
    User = $AdminUser
    Password = $AdminPassword
    Database = "postgres"
  }
  $roleLiteral = ConvertTo-SqlLiteral $AppConnection.User
  $databaseLiteral = ConvertTo-SqlLiteral $AppConnection.Database
  $query = "SELECT (EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$roleLiteral))::text || '|' || (EXISTS(SELECT 1 FROM pg_database WHERE datname=$databaseLiteral))::text;"
  $result = Invoke-Psql -Connection $admin -Database "postgres" -Command $query
  if ($result.ExitCode -ne 0) {
    Stop-Workflow "PostgreSQL administrator authentication or inspection failed. No existing password, database, or role was changed. Check the administrator login and local pg_hba.conf."
  }
  $state = ($result.Output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1).Trim()
  if ($state -notmatch '^(t|f)\|(t|f)$') {
    Stop-Workflow "Could not determine whether the requested local role and database already exist."
  }
  return [pscustomobject]@{
    Admin = $admin
    RoleExists = $Matches[1] -eq "t"
    DatabaseExists = $Matches[2] -eq "t"
  }
}

function Assert-LocalWebConfiguration($Values) {
  if ([string]$Values["HOST"] -notin @("", "127.0.0.1")) {
    Stop-Workflow "HOST must be 127.0.0.1 for this local launcher. Edit the existing .env manually; it was not changed."
  }
  if ([string]$Values["PORT"] -and [string]$Values["PORT"] -ne "3000") {
    Stop-Workflow "PORT must remain 3000 because the Vite development proxy targets 127.0.0.1:3000. Edit the existing .env manually; it was not changed."
  }
}

function Provision-MissingDatabaseObjects($AppConnection, [switch]$NewEnvironment) {
  if (-not (Test-LoopbackHost ([string]$AppConnection.Host))) {
    Stop-Workflow "Automatic role/database creation is limited to loopback PostgreSQL. No remote database was changed."
  }
  $authorization = Read-Host "Connect as a PostgreSQL administrator to create only missing local objects? Existing roles and databases will not be altered (y/N)"
  if ($authorization -notmatch '(?i)^y(?:es)?$') {
    Stop-Workflow "No database changes were made. Correct DATABASE_URL or rerun -Setup and explicitly authorize creation of missing local objects."
  }

  $adminUser = Read-Host "PostgreSQL administrator username (for example, postgres)"
  if (-not $adminUser.Trim()) { Stop-Workflow "An administrator username is required." }
  $adminPassword = Read-HiddenValue "PostgreSQL administrator password"
  $state = Get-AdminState $AppConnection $adminUser $adminPassword

  if ($state.RoleExists -and $state.DatabaseExists) {
    if ($NewEnvironment) {
      Stop-Workflow "The requested role and database both already exist. No database changes were made. Rerun setup and enter the existing role password."
    }
    Stop-Workflow "The requested role and database both already exist. No database changes were made. Correct the existing DATABASE_URL password manually and rerun setup."
  }
  if (-not $state.RoleExists -and $state.DatabaseExists) {
    Stop-Workflow "The database exists but the requested role does not. No changes were made because granting a new role access to an existing database could expose existing data. Choose a new database name or configure the existing owner manually."
  }

  $sql = ""
  if (-not $state.RoleExists) {
    $roleIdentifier = '"' + $AppConnection.User.Replace('"', '""') + '"'
    $sql += "CREATE ROLE $roleIdentifier LOGIN;`n"
  }
  if (-not $state.DatabaseExists) {
    $databaseIdentifier = '"' + $AppConnection.Database.Replace('"', '""') + '"'
    $ownerIdentifier = '"' + $AppConnection.User.Replace('"', '""') + '"'
    $sql += "CREATE DATABASE $databaseIdentifier OWNER $ownerIdentifier;`n"
  }
  $created = Invoke-Psql -Connection $state.Admin -Database "postgres" -InputSql $sql
  if ($created.ExitCode -ne 0) {
    Stop-Workflow "PostgreSQL did not create the missing role/database. No existing objects were changed. Review local PostgreSQL administrator permissions and try again."
  }

  if (-not $state.RoleExists) {
    Write-Info "The new local database role has no password yet. Set it in the following hidden PostgreSQL prompt."
    $setPassword = Invoke-Psql -Connection $state.Admin -Database "postgres" -Command "\password $($AppConnection.User)" -Interactive
    if ($setPassword.ExitCode -ne 0) {
      Stop-Workflow "Could not set the new role password. The newly created role/database were left in place; rerun setup after resolving this."
    }
    if ($NewEnvironment) {
      $AppConnection.Password = Read-MatchingHiddenValues "Enter the new application database password (it must match the password just set)"
    }
  } elseif ($state.DatabaseExists -eq $false) {
    Write-Info "Created the missing database owned by the existing role. Its password was not changed."
  }

  $check = Test-DatabaseConnection $AppConnection
  if (-not $check.Success) {
    Stop-Workflow "$($check.Message) No existing password was changed. Check that the password entered in psql matches the configured value."
  }
  Write-Info "PostgreSQL connection verified (server major $($check.Version))."
}

function Get-LocalDatabaseSettings {
  $hostName = Read-Host "Local PostgreSQL host [127.0.0.1]"
  if (-not $hostName.Trim()) { $hostName = "127.0.0.1" }
  if (-not (Test-LoopbackHost $hostName.Trim())) {
    Stop-Workflow "This launcher is for local development only. Use localhost, 127.0.0.1, or ::1 as the PostgreSQL host."
  }
  $portText = Read-Host "Local PostgreSQL port [5432]"
  if (-not $portText.Trim()) { $portText = "5432" }
  $port = 0
  if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
    Stop-Workflow "PostgreSQL port must be between 1 and 65535."
  }
  $database = Read-Host "Kudu database name [kudu]"
  if (-not $database.Trim()) { $database = "kudu" }
  $user = Read-Host "Kudu database role [kudu]"
  if (-not $user.Trim()) { $user = "kudu" }
  foreach ($identifier in @($database, $user)) {
    if ($identifier -notmatch '^[A-Za-z_][A-Za-z0-9_]{0,62}$') {
      Stop-Workflow "Database and role names must use 1-63 ASCII letters, digits, or underscores, and must begin with a letter or underscore."
    }
  }
  $databasePassword = Read-MatchingHiddenValues "Application database role password"
  return [pscustomobject]@{
    Host = $hostName.Trim()
    Port = $port
    Database = $database
    User = $user
    Password = $databasePassword
  }
}

function New-DatabaseUrl($Connection) {
  $hostText = [string]$Connection.Host
  if ($hostText.Contains(":") -and -not $hostText.StartsWith("[")) { $hostText = "[$hostText]" }
  $username = [Uri]::EscapeDataString([string]$Connection.User)
  $password = [Uri]::EscapeDataString([string]$Connection.Password)
  $database = [Uri]::EscapeDataString([string]$Connection.Database)
  return "postgresql://${username}:${password}@${hostText}:$($Connection.Port)/${database}"
}

function New-SessionSecret {
  $bytes = New-Object byte[] 48
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $generator.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  } finally {
    $generator.Dispose()
  }
}

function Format-EnvValue([string]$Key, [string]$Value) {
  if ($Key -eq "KUDU_AUTH_PASSWORD_HASH") { return "'" + $Value + "'" }
  if ($Key -eq "POSTGRES_PASSWORD") { return "'" + $Value.Replace("'", "\'") + "'" }
  $escaped = $Value.Replace('\', '\\').Replace('"', '\"').Replace("`r", '\r').Replace("`n", '\n')
  return '"' + $escaped + '"'
}

function Set-EnvEntry([string]$Text, [string]$Key, [string]$Value) {
  $lines = [System.Collections.Generic.List[string]]::new()
  $found = $false
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match "^\s*$([Regex]::Escape($Key))\s*=") {
      $lines.Add("$Key=$(Format-EnvValue $Key $Value)")
      $found = $true
    } else {
      $lines.Add($line)
    }
  }
  if (-not $found) { $lines.Add("$Key=$(Format-EnvValue $Key $Value)") }
  return ($lines -join "`r`n")
}

function Invoke-SelfTest {
  $checks = 0
  if (-not (Test-NodeEngine "v24.22.1" ">=24.0.0 <25")) {
    Stop-Workflow "Self-test failed: accepted Node.js version range."
  }
  $checks++
  if (Test-NodeEngine "v25.0.0" ">=24.0.0 <25") {
    Stop-Workflow "Self-test failed: rejected Node.js version range."
  }
  $checks++

  $original = [pscustomobject]@{
    Host = "127.0.0.1"
    Port = 5432
    User = "kudu:local"
    Password = 'space @:/?#%+$ and "quotes"'
    Database = "kudu/data"
  }
  $roundTrip = Get-DatabaseConnection (New-DatabaseUrl $original)
  if ($roundTrip.User -cne $original.User -or
      $roundTrip.Password -cne $original.Password -or
      $roundTrip.Database -cne $original.Database -or
      $roundTrip.Host -cne $original.Host -or
      $roundTrip.Port -ne $original.Port) {
    Stop-Workflow "Self-test failed: PostgreSQL URL reserved-character round-trip."
  }
  $checks++

  $hashLine = Format-EnvValue "KUDU_AUTH_PASSWORD_HASH" 'scrypt$16384$8$1$test$hash'
  if ($hashLine -cne "'scrypt`$16384`$8`$1`$test`$hash'") {
    Stop-Workflow "Self-test failed: password hash dotenv quoting."
  }
  $checks++

  $updated = Set-EnvEntry "DATABASE_URL=`"placeholder`"`r`nPORT=`"3000`"" "PORT" "3001"
  if (($updated -split "`r?`n" | Where-Object { $_ -match '^PORT=' }).Count -ne 1 -or
      $updated -notmatch '(?m)^PORT="3001"$') {
    Stop-Workflow "Self-test failed: updating one dotenv entry."
  }
  $checks++

  Write-Info "PowerShell helper self-test passed ($checks checks; no database or workspace files touched)."
}

function Write-NewEnvironmentFile($Connection, [string]$PasswordHash, [string]$SessionSecret) {
  $envPath = Join-Path $script:ProjectRoot ".env"
  if (Test-Path $envPath) {
    Stop-Workflow ".env appeared during setup; it was not overwritten. Review it and rerun the setup check."
  }
  $examplePath = Join-Path $script:ProjectRoot ".env.example"
  $content = Get-Content -LiteralPath $examplePath -Raw
  $values = @{
    DATABASE_URL = New-DatabaseUrl $Connection
    HOST = "127.0.0.1"
    PORT = "3000"
    KUDU_IMPORT_DIRECTORY = "./imports"
    KUDU_IMPORT_HOST_DIRECTORY = "./imports"
    KUDU_AUTH_PASSWORD_HASH = $PasswordHash
    SESSION_SECRET = $SessionSecret
    KUDU_COOKIE_SECURE = "false"
    POSTGRES_DB = [string]$Connection.Database
    POSTGRES_USER = [string]$Connection.User
    POSTGRES_PASSWORD = [string]$Connection.Password
  }
  foreach ($key in $values.Keys) { $content = Set-EnvEntry $content $key ([string]$values[$key]) }
  $encoding = [System.Text.UTF8Encoding]::new($false)
  try {
    $stream = [System.IO.File]::Open($envPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try {
      $writer = [System.IO.StreamWriter]::new($stream, $encoding)
      try { $writer.Write($content) } finally { $writer.Dispose() }
    } finally {
      if ($stream) { $stream.Dispose() }
    }
  } catch {
    Stop-Workflow "Could not create .env safely. Check file permissions; any existing .env was left unchanged."
  }
  Write-Info "Created .env from .env.example with local-only settings. Secret values were not printed."
}

function New-OperatorHash {
  Write-Info "Create the Kudu operator password. The existing command hides password input; its generated hash will be captured directly into .env."
  $output = & $script:PnpmPath --filter @kudu/backend auth:hash-password
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { Stop-Workflow "Operator password creation failed. No hash was saved." }
  $hash = $null
  foreach ($line in $output) {
    if ([string]$line -match '^KUDU_AUTH_PASSWORD_HASH=(.+)$') { $hash = $Matches[1] }
  }
  if (-not $hash -or $hash -notmatch '^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$') {
    Stop-Workflow "The existing password-hash command did not return the expected scrypt hash. No .env file was created."
  }
  return $hash
}

function Assert-AuthConfiguration($Values) {
  $hash = [string]$Values["KUDU_AUTH_PASSWORD_HASH"]
  $sessionSecret = [string]$Values["SESSION_SECRET"]
  if ($hash -notmatch '^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$') {
    Stop-Workflow "KUDU_AUTH_PASSWORD_HASH in .env is missing or invalid. Create a hash with pnpm --filter @kudu/backend auth:hash-password and add it without changing other existing .env values."
  }
  if ([Text.Encoding]::UTF8.GetByteCount($sessionSecret) -lt 32) {
    Stop-Workflow "SESSION_SECRET in .env must contain at least 32 bytes. Add a cryptographically random value without replacing an existing secret automatically."
  }
}

function Test-TcpListener([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(350)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-PortOwner([int]$Port) {
  try {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Select-Object -First 1
    if ($connection) {
      $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
      if ($process) { return "$($process.ProcessName) (PID $($process.Id))" }
      return "PID $($connection.OwningProcess)"
    }
  } catch {}
  return "unknown process"
}

function Test-ServicePorts([switch]$Strict) {
  foreach ($port in @(3000, 5173)) {
    if (Test-TcpListener $port) {
      $owner = Get-PortOwner $port
      if ($Strict) {
        Stop-Workflow "Port $port is already in use by $owner. Stop that process or configure a free port before launching Kudu; no duplicate server was started."
      }
      Write-Info "Port $port is already in use by $owner."
    } else {
      Write-Info "Port $port is available."
    }
  }
}

function Invoke-Setup {
  Write-Info "Installing the locked workspace dependencies (pnpm install --frozen-lockfile)..."
  & $script:PnpmPath install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { Stop-Workflow "Frozen dependency installation failed. Setup stopped before database migration." }

  $envPath = Join-Path $script:ProjectRoot ".env"
  $newEnvironment = -not (Test-Path $envPath)
  if ($newEnvironment) {
    Write-Info "No .env exists. This setup will create it once, after configuration is verified. Existing files are never overwritten."
    $connection = Get-LocalDatabaseSettings
  } else {
    Write-Info "An existing .env was found and will not be overwritten."
    $values = Read-EnvFile $envPath
    $connection = Get-DatabaseConnection ([string]$values["DATABASE_URL"])
  }

  $databaseCheck = Test-DatabaseConnection $connection
  if (-not $databaseCheck.Success) {
    Write-Info $databaseCheck.Message
    if ($databaseCheck.Message -match 'did not accept a connection|host lookup failed') {
      Stop-Workflow $databaseCheck.Message
    }
    Provision-MissingDatabaseObjects $connection -NewEnvironment:$newEnvironment
    $databaseCheck = Test-DatabaseConnection $connection
    if (-not $databaseCheck.Success) { Stop-Workflow $databaseCheck.Message }
  }
  Write-Info "PostgreSQL connection verified (server major $($databaseCheck.Version))."

  if ($newEnvironment) {
    $passwordHash = New-OperatorHash
    $sessionSecret = New-SessionSecret
    Write-NewEnvironmentFile $connection $passwordHash $sessionSecret
    $values = Read-EnvFile $envPath
  } else {
    Assert-AuthConfiguration $values
    Assert-LocalWebConfiguration $values
    if ([string]$values["KUDU_COOKIE_SECURE"] -ne "false") {
      Write-Info "Warning: KUDU_COOKIE_SECURE is not false. Browser sign-in over local HTTP may not work; the existing setting was preserved."
    }
  }

  $importsValue = [string]$values["KUDU_IMPORT_DIRECTORY"]
  if (-not $importsValue) { $importsValue = "./imports" }
  $importsPath = if ([IO.Path]::IsPathRooted($importsValue)) { $importsValue } else { Join-Path $script:ProjectRoot $importsValue }
  New-Item -ItemType Directory -Path $importsPath -Force | Out-Null

  $databaseName = $connection.Database
  $confirmation = Read-Host "Apply pending forward-only Kudu migrations to '$databaseName'? Review migration SQL first; the database will not be dropped or recreated (y/N)"
  if ($confirmation -notmatch '(?i)^y(?:es)?$') {
    Stop-Workflow ".env and dependencies are ready, but migrations were not run. Rerun .\scripts\kuduns.ps1 -Setup when ready."
  }
  Write-Info "Applying database migrations with the existing pnpm db:migrate command..."
  & $script:PnpmPath db:migrate
  if ($LASTEXITCODE -ne 0) {
    Stop-Workflow "Database migration failed. The application will not be started. Review the migration error and rerun -Setup after correcting it."
  }
  Write-Info "Setup completed. Start Kudu with .\scripts\kuduns.ps1."
}

function Assert-ReadyForDailyLaunch {
  $package = Get-JsonFile (Join-Path $script:ProjectRoot "package.json")
  if (-not (Test-Path (Join-Path $script:ProjectRoot ".env"))) {
    Stop-Workflow "No .env was found. Run .\scripts\kuduns.ps1 -Setup first."
  }
  if (-not (Test-Path (Join-Path $script:ProjectRoot "node_modules"))) {
    Stop-Workflow "Workspace dependencies are missing. Run .\scripts\kuduns.ps1 -Setup first."
  }
  $values = Read-EnvFile (Join-Path $script:ProjectRoot ".env")
  Assert-AuthConfiguration $values
  Assert-LocalWebConfiguration $values
  if ([string]$values["KUDU_COOKIE_SECURE"] -ne "false") {
    Write-Info "Warning: KUDU_COOKIE_SECURE is not false. Browser sign-in over local HTTP may not work; the existing setting was preserved."
  }
  if (-not $values["DATABASE_URL"]) { Stop-Workflow "DATABASE_URL is missing from .env." }
  $connection = Get-DatabaseConnection ([string]$values["DATABASE_URL"])
  $databaseCheck = Test-DatabaseConnection $connection
  if (-not $databaseCheck.Success) { Stop-Workflow $databaseCheck.Message }
  Write-Info "Configuration and PostgreSQL connection verified (server major $($databaseCheck.Version))."
  return $package
}

function Invoke-Check {
  $null = Assert-ReadyForDailyLaunch
  Test-ServicePorts
  Write-Info "Checks passed. No files or database objects were changed."
}

function Wait-ForFrontend([int]$TimeoutSeconds = 120) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:5173/" -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Invoke-DailyLaunch {
  $null = Assert-ReadyForDailyLaunch
  Test-ServicePorts -Strict
  Write-Info "Starting the existing pnpm dev workflow. Press Ctrl+C to stop Kudu."
  if ($script:PnpmCmdPath) {
    $command = '""' + $script:PnpmCmdPath + '" dev"'
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList @("/d", "/s", "/c", $command) -WorkingDirectory $script:ProjectRoot -NoNewWindow -PassThru
  } else {
    $process = Start-Process -FilePath $script:PnpmPath -ArgumentList @("dev") -WorkingDirectory $script:ProjectRoot -NoNewWindow -PassThru
  }
  try {
    $readyMessagePrinted = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    while (-not $process.HasExited) {
      if (-not $readyMessagePrinted -and (Test-TcpListener 5173)) {
        $readyMessagePrinted = $true
        if (Wait-ForFrontend 120) {
          Write-Info "Frontend ready at http://127.0.0.1:5173/"
          if (-not $NoBrowser) {
            Start-Process "http://127.0.0.1:5173/" | Out-Null
          }
        } else {
          Write-Info "The frontend port opened but did not return a ready page within 120 seconds. Server output remains visible above."
        }
      }
      if (-not $readyMessagePrinted -and [DateTime]::UtcNow -ge $deadline) {
        Write-Info "The frontend has not become ready within 120 seconds. Server output remains visible above."
        $readyMessagePrinted = $true
      }
      Start-Sleep -Milliseconds 500
      $process.Refresh()
    }
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      Stop-Workflow "The pnpm dev workflow exited with code $($process.ExitCode). Review the visible server output."
    }
  } finally {
    if ($process -and -not $process.HasExited) {
      Write-Info "Stopping the Kudu development process tree..."
      & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
      if (-not $process.HasExited) {
        try { $process.Kill() } catch {}
      }
      $process.Dispose()
    }
  }
}

try {
  $selectedModeCount = 0
  foreach ($modeSelected in @($Setup.IsPresent, $Check.IsPresent, $SelfTest.IsPresent)) {
    if ($modeSelected) { $selectedModeCount++ }
  }
  if ($selectedModeCount -gt 1) {
    Stop-Workflow "Choose only one of -Setup, -Check, or -SelfTest."
  }
  if ($SelfTest) {
    Invoke-SelfTest
    exit 0
  }
  Push-Location $script:ProjectRoot
  try {
    Assert-ToolVersions
    Find-PostgresTools
    if ($Setup) {
      Invoke-Setup
    } elseif ($Check) {
      Invoke-Check
    } else {
      Invoke-DailyLaunch
    }
  } finally {
    Pop-Location
  }
  exit 0
} catch {
  $message = $_.Exception.Message
  $exitCode = 1
  if ($message -match '^(\d+)\|(.*)$') {
    $exitCode = [int]$Matches[1]
    $message = $Matches[2]
  }
  Write-Error $message
  exit $exitCode
}
