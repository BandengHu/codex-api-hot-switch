<#
.SYNOPSIS
  Extract the build-time at-rest secret key from a running WorkBuddy process.

.DESCRIPTION
  WorkBuddy desktop 5.6.2+ encrypts local credential fields with an atRestSecretKey
  compiled into its native layer. That key has no copy on disk, in the registry or in
  the environment; it only exists inside the payload JSON living in the desktop main
  process memory, so we read the memory of that same-user process to recover it.

  Every candidate is validated against ExpectedKeyId (first 16 hex chars of
  sha256(sha256(secret))) so unrelated base64 strings are never mistaken for the key.

  stdout on success is a single line: WB_AT_REST_SECRET=<base64>
  Exit codes: 0 found, 2 not found, 3 no scannable WorkBuddy process.

.NOTES
  This file is intentionally ASCII-only so Windows PowerShell 5.1 parses it correctly
  without a BOM. User-facing Chinese wording lives in the TypeScript caller.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExpectedKeyId,
  [int[]]$ProcessId
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class WbAtRestKeyScan
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr bytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualQueryEx(IntPtr handle, IntPtr address, out MEMORY_BASIC_INFORMATION info, IntPtr length);

    const uint MEM_COMMIT = 0x1000;
    const uint MEM_PRIVATE = 0x20000;
    const int PROCESS_VM_READ = 0x10;
    const int PROCESS_QUERY_INFORMATION = 0x400;
    const int CHUNK_BYTES = 4 * 1024 * 1024;
    const int MAX_MATCH_TEXT_BYTES = 4096;

    static bool IsReadable(uint protect)
    {
        const uint PAGE_NOACCESS = 0x01;
        const uint PAGE_GUARD = 0x100;
        if ((protect & PAGE_GUARD) != 0) return false;
        if ((protect & PAGE_NOACCESS) != 0) return false;
        return (protect & 0xFF) != 0;
    }

    static int FindFrom(byte[] haystack, int length, byte[] needle, int from)
    {
        for (int i = from; i + needle.Length <= length; i++)
        {
            int j = 0;
            while (j < needle.Length && haystack[i + j] == needle[j]) j++;
            if (j == needle.Length) return i;
        }
        return -1;
    }

    public static List<string> Scan(int pid, byte[] needle, int maxHits, out long scannedBytes, out int regionCount)
    {
        scannedBytes = 0;
        regionCount = 0;
        List<string> hits = new List<string>();
        IntPtr handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) throw new Exception("OpenProcess failed, error " + Marshal.GetLastWin32Error());
        try
        {
            byte[] buffer = new byte[CHUNK_BYTES + needle.Length];
            byte[] chunk = new byte[CHUNK_BYTES];
            byte[] tail = new byte[needle.Length];
            int tailLength = 0;
            long address = 0;
            MEMORY_BASIC_INFORMATION info;
            IntPtr infoSize = (IntPtr)Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
            while (VirtualQueryEx(handle, (IntPtr)address, out info, infoSize) != IntPtr.Zero)
            {
                long regionBase = info.BaseAddress.ToInt64();
                long regionSize = info.RegionSize.ToInt64();
                if (regionSize <= 0) break;
                if (info.State == MEM_COMMIT && info.Type == MEM_PRIVATE && IsReadable(info.Protect))
                {
                    regionCount++;
                    long offset = 0;
                    while (offset < regionSize)
                    {
                        int want = (int)Math.Min((long)CHUNK_BYTES, regionSize - offset);
                        Array.Copy(tail, 0, buffer, 0, tailLength);
                        int copyTarget = tailLength;
                        IntPtr read;
                        if (!ReadProcessMemory(handle, (IntPtr)(regionBase + offset), chunk, (IntPtr)want, out read))
                        {
                            tailLength = 0;
                            break;
                        }
                        int got = read.ToInt32();
                        scannedBytes += got;
                        if (got <= 0)
                        {
                            tailLength = 0;
                            break;
                        }
                        Array.Copy(chunk, 0, buffer, copyTarget, got);
                        int total = copyTarget + got;
                        int searchFrom = 0;
                        while (searchFrom + needle.Length <= total)
                        {
                            int at = FindFrom(buffer, total, needle, searchFrom);
                            if (at < 0) break;
                            int textLength = 0;
                            while (at + textLength < total && textLength < MAX_MATCH_TEXT_BYTES && buffer[at + textLength] != 0) textLength++;
                            hits.Add(Encoding.UTF8.GetString(buffer, at, textLength));
                            if (hits.Count >= maxHits) return hits;
                            searchFrom = at + needle.Length;
                        }
                        int keep = Math.Min(needle.Length - 1, total);
                        Array.Copy(buffer, total - keep, tail, 0, keep);
                        tailLength = keep;
                        offset += got;
                    }
                }
                address = regionBase + regionSize;
            }
        }
        finally
        {
            CloseHandle(handle);
        }
        return hits;
    }
}
'@

function Get-KeyId([string]$Secret) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $key = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Secret))
    $keyHash = $sha.ComputeHash($key)
  } finally {
    $sha.Dispose()
  }
  $hex = -join ($keyHash | ForEach-Object { $_.ToString('x2') })
  return $hex.Substring(0, 16)
}

function Get-TargetProcessId {
  $main = @()
  $others = @()
  try {
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name='WorkBuddy.exe'" -ErrorAction Stop
    foreach ($process in $processes) {
      if ($process.CommandLine -match '--type=') {
        $others += [int]$process.ProcessId
      } else {
        $main += [int]$process.ProcessId
      }
    }
  } catch {
    $others = @(Get-Process -Name 'WorkBuddy' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  }
  return @($main + $others)
}

$needleText = '{"version":1,"atRestSecretKey":"'
$needles = @(
  [pscustomobject]@{ Name = 'utf8'; Bytes = [System.Text.Encoding]::UTF8.GetBytes($needleText) },
  [pscustomobject]@{ Name = 'utf16le'; Bytes = [System.Text.Encoding]::Unicode.GetBytes($needleText) }
)

if (-not $ProcessId -or $ProcessId.Count -eq 0) {
  $ProcessId = Get-TargetProcessId
}
if (-not $ProcessId -or $ProcessId.Count -eq 0) {
  [Console]::Error.WriteLine('no running WorkBuddy.exe process found')
  exit 3
}

foreach ($target in $ProcessId) {
  foreach ($needle in $needles) {
    $scannedBytes = 0
    $regionCount = 0
    try {
      $hits = [WbAtRestKeyScan]::Scan($target, $needle.Bytes, 8, [ref]$scannedBytes, [ref]$regionCount)
    } catch {
      Write-Verbose "pid $target [$($needle.Name)] scan failed: $($_.Exception.Message)"
      continue
    }
    Write-Verbose "pid $target [$($needle.Name)] regions=$regionCount scanned=$([math]::Round($scannedBytes / 1MB))MB hits=$($hits.Count)"
    foreach ($hit in $hits) {
      if ($hit -notmatch '"atRestSecretKey":"([^"]+)"') { continue }
      $secret = $Matches[1]
      $keyId = Get-KeyId $secret
      if ($keyId -eq $ExpectedKeyId) {
        Write-Output "WB_AT_REST_SECRET=$secret"
        exit 0
      }
      Write-Verbose "pid $target candidate keyId=$keyId does not match $ExpectedKeyId"
    }
  }
}

[Console]::Error.WriteLine("no at-rest key with keyId=$ExpectedKeyId found in WorkBuddy process memory")
exit 2
