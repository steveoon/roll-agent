# Roll standalone installer. Compatible with Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param(
    [string]$Version = 'stable',
    [string]$InstallDir = '',
    [switch]$NoModifyPath
)
$ErrorActionPreference = 'Stop'
$Origin = 'https://roll.duliday.com'
$Semver = '(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?'
function Test-Version([string]$Value) {
    if ($Value -cnotmatch "\A$Semver\z") { return $false }
    $Core = ($Value -split '\+', 2)[0]
    if ($Core.Contains('-')) {
        foreach ($Part in ($Core.Substring($Core.IndexOf('-') + 1) -split '\.')) {
            if ($Part -match '^0[0-9]+$') { return $false }
        }
    }
    return $true
}
function Get-Download([string]$Url, [string]$Destination) {
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 900
}
# Only short, flat bootstrap files are handled by PowerShell/.NET Framework.
$Bootstrap = $null
$BootstrapOwned = $false
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS and Linux' }
    if ($Version -ne 'stable' -and !(Test-Version $Version)) { throw 'Invalid version' }
    if ([Environment]::OSVersion.Version -lt [Version]'10.0') { throw 'Windows 10 / Server 2016 or newer is required' }
    $Architecture = $env:PROCESSOR_ARCHITEW6432
    if (!$Architecture) { $Architecture = $env:PROCESSOR_ARCHITECTURE }
    switch ($Architecture) {
        'AMD64' { $Platform = 'win32-x64' }
        'ARM64' { $Platform = 'win32-arm64' }
        default { throw "Unsupported architecture: $Architecture" }
    }
    if (!$InstallDir) {
        if (!$env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required' }
        $InstallDir = Join-Path $env:LOCALAPPDATA 'Roll'
    }
    if (![IO.Path]::IsPathRooted($InstallDir) -or $InstallDir -match '[\r\n\x00]') { throw 'InstallDir must be an absolute path without line breaks' }
    # Do not normalize the full installation path with legacy System.IO APIs.
    $Bootstrap = Join-Path ([IO.Path]::GetTempPath()) ('roll-' + [Guid]::NewGuid().ToString('N').Substring(0, 12))
    if ($Bootstrap.Length -gt 200) { $Bootstrap = $null; throw 'TEMP path is too long for Windows PowerShell bootstrap; use a shorter user TEMP directory.' }
    New-Item -ItemType Directory -Path $Bootstrap -ErrorAction Stop | Out-Null
    $BootstrapOwned = $true
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Write-Host 'Roll installer: downloading release index'
    $IndexPath = Join-Path $Bootstrap 'index.txt'
    Get-Download "$Origin/releases/$Version/$Platform.txt" $IndexPath
    $Index = [IO.File]::ReadAllText($IndexPath)
    if ($Index -cnotmatch "\A([^`t`r`n]+)`t([0-9a-f]{64})`t([1-9][0-9]*)`t([^`t`r`n]+)`n\z") { throw 'Invalid release index' }
    $Release = $Matches[1]; $Sha = $Matches[2]; $Size = [UInt64]::Parse($Matches[3]); $Asset = $Matches[4]
    if ($Size -gt 1073741824) { throw 'Release archive exceeds size limit' }
    if (!(Test-Version $Release)) { throw 'Invalid release version' }
    if ($Version -ne 'stable' -and $Release -cne $Version) { throw 'Release version does not match request' }
    if ($Asset -cne "roll-$Release-$Platform.zip") { throw 'Invalid asset filename' }
    $ArchivePath = Join-Path $Bootstrap 'archive.zip'
    Write-Host "Roll installer: downloading $Asset"
    Get-Download "$Origin/releases/$Release/$Asset" $ArchivePath
    if ((Get-Item -LiteralPath $ArchivePath).Length -ne $Size) { throw 'Asset size mismatch' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant() -cne $Sha) { throw 'Asset checksum mismatch' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $Required = @{'runtime/node.exe' = 'node.exe'; 'app/bin/install-bootstrap.cjs' = 'install.cjs'}
        $Found = @{}
        foreach ($Entry in $Zip.Entries) {
            # Ordinal case-insensitive collision detection; only exact canonical names are accepted.
            if ($Required.ContainsKey($Entry.FullName)) {
                $Name = $Entry.FullName
                if (!(@($Required.Keys) -ccontains $Name) -or $Found.ContainsKey($Name)) { throw 'Duplicate or noncanonical bootstrap entry' }
                $UnixType = ($Entry.ExternalAttributes -shr 16) -band 0xF000
                if ($UnixType -ne 0 -and $UnixType -ne 0x8000) { throw 'Archive contains links or special files in bootstrap' }
                if (($Entry.ExternalAttributes -band ([int][IO.FileAttributes]::ReparsePoint -bor [int][IO.FileAttributes]::Directory)) -ne 0) { throw 'Bootstrap contains a reparse point' }
                if ($Entry.Length -le 0 -or $Entry.Length -gt 268435456) { throw 'Invalid bootstrap file size' }
                $Found[$Name] = $Entry
            }
        }
        if ($Found.Count -ne 2) { throw 'This release lacks the Node installation helper; install the current stable release instead.' }
        foreach ($Name in $Required.Keys) {
            [IO.Compression.ZipFileExtensions]::ExtractToFile($Found[$Name], (Join-Path $Bootstrap $Required[$Name]), $false)
        }
    } finally { $Zip.Dispose() }
    $RequestPath = Join-Path $Bootstrap 'request.json'
    $ResultPath = Join-Path $Bootstrap 'result.json'
    $Request = @{schemaVersion=1;installRoot=$InstallDir;archive=$ArchivePath;sha256=$Sha;size=$Size;version=$Release;platform=$Platform;resultPath=$ResultPath}
    [IO.File]::WriteAllText($RequestPath, ($Request | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    $SavedNodeOptions = $env:NODE_OPTIONS
    $SavedNodePath = $env:NODE_PATH
    try {
        $env:NODE_OPTIONS = $null
        $env:NODE_PATH = $null
        & (Join-Path $Bootstrap 'node.exe') (Join-Path $Bootstrap 'install.cjs') $RequestPath
        if ($LASTEXITCODE -ne 0) { throw "Roll installation helper failed (exit $LASTEXITCODE); see the preceding diagnostic." }
    } finally { $env:NODE_OPTIONS = $SavedNodeOptions; $env:NODE_PATH = $SavedNodePath }
    $Result = [IO.File]::ReadAllText($ResultPath) | ConvertFrom-Json
    if ($Result.schemaVersion -ne 1 -or $Result.version -cne $Release -or !$Result.launcher) { throw 'Invalid installer result' }
    $BinDir = Split-Path -Parent $Result.launcher
    if (!$NoModifyPath) {
        $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (!(($UserPath -split ';') -contains $BinDir)) {
            try { [Environment]::SetEnvironmentVariable('Path', "$BinDir;$UserPath", 'User') }
            catch { Write-Warning "Roll is installed, but user PATH could not be updated. Add $BinDir to your user PATH." }
        }
        if (!(($env:Path -split ';') -contains $BinDir)) { $env:Path = "$BinDir;$env:Path" }
    }
    Write-Host "Roll $Release installed: $($Result.launcher)"
    $Selected = Get-Command roll -ErrorAction SilentlyContinue
    if ($Selected -and $Selected.Source -ne $Result.launcher) { Write-Host "Your current PATH selects another Roll: $($Selected.Source)" }
    Write-Host 'Update with roll update; install subagents with roll agent install <package>.'
} finally {
    if ($BootstrapOwned -and (Test-Path -LiteralPath $Bootstrap)) {
        try { Remove-Item -LiteralPath $Bootstrap -Recurse -Force }
        catch { Write-Warning "Bootstrap cleanup deferred: $Bootstrap" }
    }
}
