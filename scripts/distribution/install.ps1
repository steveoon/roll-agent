# Roll standalone installer. Compatible with Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param(
    [string]$Version = 'stable',
    [string]$InstallDir = '',
    [switch]$NoModifyPath
)
$ErrorActionPreference = 'Stop'
$Origin = 'https://roll.duliday.com'
$Locked = $false
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
function Assert-NoReparse([string]$Path) {
    if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing reparse point: $Path"
    }
}
function Write-Utf8([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}
function Set-AtomicFile([string]$Source, [string]$Destination) {
    if (Test-Path -LiteralPath $Destination) { [IO.File]::Replace($Source, $Destination, $null) }
    else { [IO.File]::Move($Source, $Destination) }
}
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
    if (![IO.Path]::IsPathRooted($InstallDir) -or $InstallDir -match '[\r\n]') { throw 'InstallDir must be an absolute path without line breaks' }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
    Assert-NoReparse $InstallDir
    if (!(Test-Path -LiteralPath $InstallDir)) { [IO.Directory]::CreateDirectory($InstallDir) | Out-Null }
    $Marker = Join-Path $InstallDir 'installation.json'
    if (Test-Path -LiteralPath $Marker) {
        $ExistingMarker = Get-Content -Raw -LiteralPath $Marker | ConvertFrom-Json
        if ($ExistingMarker.schemaVersion -ne 1 -or $ExistingMarker.channel -cne 'standalone') { throw 'Unrecognized installation metadata' }
    } elseif ((Get-ChildItem -Force -LiteralPath $InstallDir | Measure-Object).Count -ne 0) { throw 'InstallDir is not empty and is not a Roll standalone installation' }
    $Lock = Join-Path $InstallDir '.install-lock'
    # New-Item without -Force fails when the lock already exists; never remove another owner's lock.
    New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null
    $Locked = $true
    $Stage = Join-Path $Lock ([Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($Stage) | Out-Null
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $IndexPath = Join-Path $Stage 'index.txt'
    Get-Download "$Origin/releases/$Version/$Platform.txt" $IndexPath
    $Index = [IO.File]::ReadAllText($IndexPath)
    if ($Index -cnotmatch "\A([^`t`r`n]+)`t([0-9a-f]{64})`t([1-9][0-9]*)`t([^`t`r`n]+)`n\z") { throw 'Invalid release index' }
    $Release = $Matches[1]; $Sha = $Matches[2]; $Size = [UInt64]::Parse($Matches[3]); $Asset = $Matches[4]
    if (!(Test-Version $Release)) { throw 'Invalid release version' }
    if ($Version -ne 'stable' -and $Release -cne $Version) { throw 'Release version does not match request' }
    if ($Asset -cne "roll-$Release-$Platform.zip") { throw 'Invalid asset filename' }
    $ArchivePath = Join-Path $Stage 'archive.zip'
    Get-Download "$Origin/releases/$Release/$Asset" $ArchivePath
    if ((Get-Item -LiteralPath $ArchivePath).Length -ne $Size) { throw 'Asset size mismatch' }
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $ArchivePath).Hash.ToLowerInvariant() -cne $Sha) { throw 'Asset checksum mismatch' }
    $Candidate = Join-Path $Stage 'candidate'
    [IO.Directory]::CreateDirectory($Candidate) | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $Names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($Entry in $Zip.Entries) {
            $Name = $Entry.FullName
            if (!$Name -or $Name -match '(^/|\\|[\x00-\x1f:]|(^|/)\.\.(/|$))') { throw "Unsafe archive path: $Name" }
            foreach ($Component in $Name.TrimEnd('/').Split('/')) {
                if (!$Component -or $Component -eq '.' -or $Component -match '[. ]$|^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw "Unsafe Windows archive path: $Name" }
            }
            $UnixType = ($Entry.ExternalAttributes -shr 16) -band 0xF000
            if ($UnixType -ne 0 -and $UnixType -ne 0x8000 -and $UnixType -ne 0x4000) { throw 'Archive contains links or special files' }
            if (($Entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Archive contains a reparse point' }
            if (!$Names.Add($Name.TrimEnd('/'))) { throw 'Duplicate archive path' }
            $Destination = [IO.Path]::GetFullPath((Join-Path $Candidate $Name))
            if (!$Destination.StartsWith($Candidate + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes extraction root' }
        }
        foreach ($Entry in $Zip.Entries) {
            $Destination = Join-Path $Candidate $Entry.FullName
            if ($Entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($Destination) | Out-Null }
            else {
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination)) | Out-Null
                [IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $Destination, $false)
            }
        }
    } finally { $Zip.Dispose() }
    $Node = Join-Path $Candidate 'runtime\node.exe'
    $EntryPoint = Join-Path $Candidate 'app\bin\roll.js'
    foreach ($Required in @($Node, $EntryPoint, (Join-Path $Candidate 'runtime\node_modules\npm\bin\npm-cli.js'), (Join-Path $Candidate 'runtime\node_modules\npm\bin\npx-cli.js'))) {
        if (!(Test-Path -LiteralPath $Required -PathType Leaf)) { throw "Missing distribution file: $Required" }
    }
    $SavedEnv = @{}
    $EnvNames = @('HOME','USERPROFILE','LOCALAPPDATA','APPDATA','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','NODE_OPTIONS','NODE_PATH','ROLL_CONFIG_PATH','ROLL_CONFIG')
    foreach ($Name in $EnvNames) { $SavedEnv[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process') }
    $SmokeHome = Join-Path $Stage 'home'
    [IO.Directory]::CreateDirectory($SmokeHome) | Out-Null
    # Stop upward config discovery at the isolated cwd even when InstallDir is inside the user's home.
    Write-Utf8 (Join-Path $SmokeHome 'roll.config.yaml') "{}`n"
    try {
        foreach ($Name in $EnvNames) {
            if ($Name -like 'NODE_*' -or $Name -like 'ROLL_*') { [Environment]::SetEnvironmentVariable($Name, $null, 'Process') }
            else { [Environment]::SetEnvironmentVariable($Name, $SmokeHome, 'Process') }
        }
        $MetadataCheck = 'const fs=require("node:fs");const [root,v,p]=process.argv.slice(1);const d=JSON.parse(fs.readFileSync(root+"/distribution.json","utf8"));const a=JSON.parse(fs.readFileSync(root+"/app/package.json","utf8"));if(d.schemaVersion!==1||d.channel!=="standalone"||d.version!==v||d.platform!==p||typeof d.nodeVersion!=="string"||process.versions.node!==d.nodeVersion||a.version!==v||a.rollDistribution?.schemaVersion!==1||a.rollDistribution?.channel!=="standalone")process.exit(1);'
        # A JS file avoids PowerShell 5.1's lossy native argument passing for embedded quotes.
        $CheckPath = Join-Path $Stage 'check.cjs'
        Write-Utf8 $CheckPath ($MetadataCheck.Replace('slice(1)', 'slice(2)'))
        & $Node $CheckPath $Candidate $Release $Platform
        if ($LASTEXITCODE -ne 0) { throw 'Distribution metadata mismatch' }
        Push-Location $SmokeHome
        try {
            & $Node $EntryPoint --version
            if ($LASTEXITCODE -ne 0) { throw 'Candidate version check failed' }
            & $Node $EntryPoint agent health
            if ($LASTEXITCODE -ne 0) { throw 'Candidate health check failed' }
        } finally { Pop-Location }
    } finally {
        foreach ($Name in $EnvNames) { [Environment]::SetEnvironmentVariable($Name, $SavedEnv[$Name], 'Process') }
    }
    $BinDir = Join-Path $InstallDir 'bin'
    Assert-NoReparse $BinDir
    [IO.Directory]::CreateDirectory($BinDir) | Out-Null
    $Launcher = Join-Path $BinDir 'roll.cmd'
    # Derive the root from the batch file: embedding Unicode paths in a .cmd depends on the OEM code page.
    $LauncherContent = @'
@echo off
rem Roll standalone launcher v1
setlocal DisableDelayedExpansion
set "ROLL_ROOT=%~dp0.."
if not exist "%ROLL_ROOT%\current.txt" goto invalid
set "version="
set /p "version=" < "%ROLL_ROOT%\current.txt"
if not defined version goto invalid
rem Validate data using delayed expansion; never interpolate unchecked file contents into CMD syntax.
setlocal EnableDelayedExpansion
set "ROLL_UNSAFE_VERSION=!version!"
rem SET removes empty variables; do not run further substitutions once all characters are consumed.
for %%C in (0 1 2 3 4 5 6 7 8 9 A B C D E F G H I J K L M N O P Q R S T U V W X Y Z a b c d e f g h i j k l m n o p q r s t u v w x y z . + -) do if defined ROLL_UNSAFE_VERSION set "ROLL_UNSAFE_VERSION=!ROLL_UNSAFE_VERSION:%%C=!"
if defined ROLL_UNSAFE_VERSION goto invalid
set "ROLL_VERSION_VALID="
for %%D in (0 1 2 3 4 5 6 7 8 9) do if "!version:~0,1!"=="%%D" set "ROLL_VERSION_VALID=1"
if not defined ROLL_VERSION_VALID goto invalid
endlocal
"%ROLL_ROOT%\versions\%version%\runtime\node.exe" "%ROLL_ROOT%\versions\%version%\app\bin\roll.js" %*
exit /b %errorlevel%
:invalid
echo roll: invalid or missing installation pointer 1>&2
exit /b 1
'@
    $LauncherContent = $LauncherContent.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n"
    Assert-NoReparse $Launcher
    if ((Test-Path -LiteralPath $Launcher) -and [IO.File]::ReadAllText($Launcher) -cne $LauncherContent) { throw "Existing launcher is owned by another installation: $Launcher" }
    $Versions = Join-Path $InstallDir 'versions'
    $Destination = Join-Path $Versions $Release
    Assert-NoReparse $Versions; Assert-NoReparse $Destination
    [IO.Directory]::CreateDirectory($Versions) | Out-Null
    if (Test-Path -LiteralPath $Destination) {
        foreach ($Item in Get-ChildItem -Recurse -Force -LiteralPath $Destination) { Assert-NoReparse $Item.FullName }
        $CandidateFiles = @(Get-ChildItem -Recurse -Force -File -LiteralPath $Candidate)
        $InstalledFiles = @(Get-ChildItem -Recurse -Force -File -LiteralPath $Destination)
        if ($CandidateFiles.Count -ne $InstalledFiles.Count) { throw 'Existing version differs from verified release' }
        foreach ($File in $CandidateFiles) {
            $Other = Join-Path $Destination $File.FullName.Substring($Candidate.Length + 1)
            Assert-NoReparse $Other
            if (!(Test-Path -LiteralPath $Other -PathType Leaf) -or (Get-FileHash -LiteralPath $File.FullName).Hash -ne (Get-FileHash -LiteralPath $Other).Hash) { throw 'Existing version differs from verified release; refusing to overwrite' }
        }
    } else { [IO.Directory]::Move($Candidate, $Destination) }
    Write-Utf8 (Join-Path $Stage 'installation.json') "{`"schemaVersion`":1,`"channel`":`"standalone`"}`n"
    Set-AtomicFile (Join-Path $Stage 'installation.json') $Marker
    if (!(Test-Path -LiteralPath $Launcher)) { Write-Utf8 $Launcher $LauncherContent }
    Write-Utf8 (Join-Path $Stage 'current.txt') "$Release`n"
    Set-AtomicFile (Join-Path $Stage 'current.txt') (Join-Path $InstallDir 'current.txt')
    if (!$NoModifyPath) {
        $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (!(($UserPath -split ';') -contains $BinDir)) {
            try { [Environment]::SetEnvironmentVariable('Path', "$BinDir;$UserPath", 'User') }
            catch { Write-Warning "Roll is installed, but user PATH could not be updated. Add $BinDir to your user PATH." }
        }
        if (!(($env:Path -split ';') -contains $BinDir)) { $env:Path = "$BinDir;$env:Path" }
    }
    Write-Host "Roll $Release installed: $Launcher"
    $Selected = Get-Command roll -ErrorAction SilentlyContinue
    if ($Selected -and $Selected.Source -ne $Launcher) { Write-Host "Your current PATH selects another Roll: $($Selected.Source)" }
    Write-Host 'Update with roll update; install subagents with roll agent install <package>.'
} finally {
    if ($Locked) { Remove-Item -LiteralPath $Lock -Recurse -Force }
}
