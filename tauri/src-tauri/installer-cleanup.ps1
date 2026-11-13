param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Normalize-Directory([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd(
    [System.IO.Path]::DirectorySeparatorChar,
    [System.IO.Path]::AltDirectorySeparatorChar
  )
}

function Test-InstallProcess($Process, [string]$InstallPrefix, [string]$ServerRoot) {
  $executablePath = [string]$Process.ExecutablePath
  $commandLine = [string]$Process.CommandLine
  $runsInstalledBinary =
    $executablePath -and
    $executablePath.StartsWith($InstallPrefix, [System.StringComparison]::OrdinalIgnoreCase)
  $runsInstalledMcp =
    $Process.Name -eq "node.exe" -and
    $commandLine -and
    $commandLine.IndexOf($ServerRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  return $runsInstalledBinary -or $runsInstalledMcp
}

function Get-InstallProcesses([string]$InstallPrefix, [string]$ServerRoot) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  $excluded = @($PID)
  if ($current -and $current.ParentProcessId) {
    $excluded += [int]$current.ParentProcessId
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($current.ParentProcessId)"
    if ($parent -and $parent.ParentProcessId) {
      $excluded += [int]$parent.ParentProcessId
    }
  }

  return @(
    Get-CimInstance Win32_Process | Where-Object {
      $excluded -notcontains [int]$_.ProcessId -and
      (Test-InstallProcess $_ $InstallPrefix $ServerRoot)
    }
  )
}

try {
  $install = Normalize-Directory $InstallDir
  $installPrefix = "$install\"
  $serverRoot = Join-Path $install "resources\server"
  $targets = Get-InstallProcesses $installPrefix $serverRoot

  if ($DryRun) {
    $targets | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine |
      ConvertTo-Json -Depth 3
    exit 0
  }

  foreach ($target in ($targets | Sort-Object ProcessId -Descending)) {
    Stop-Process -Id ([int]$target.ProcessId) -Force -ErrorAction SilentlyContinue
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $remaining = Get-InstallProcesses $installPrefix $serverRoot
    if ($remaining.Count -eq 0) {
      exit 0
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  $remaining |
    Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine |
    ConvertTo-Json -Depth 3
  exit 1
} catch {
  Write-Output $_.Exception.Message
  exit 2
}
