# BOSS Zhipin unread reply - PowerShell 5.1+ (Windows). Same behavior as reply-unread-safely.sh
#Requires -Version 5.1

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkipRulesJs = Join-Path $ScriptDir "evaluate-skip-rules.mjs"
$ExtractRollJson = Join-Path $ScriptDir "extract-roll-json.mjs"
$BuildSkipInput = Join-Path $ScriptDir "build-skip-input.mjs"
$AppendJsonl = Join-Path $ScriptDir "append-jsonl.mjs"
$FindUnreadRef = Join-Path $ScriptDir "find-unread-ref.mjs"
$ParseReadCandidate = Join-Path $ScriptDir "parse-read-candidate.mjs"
$ValidateOpenChat = Join-Path $ScriptDir "validate-open-chat.mjs"
$FormatOpenChatFailure = Join-Path $ScriptDir "format-open-chat-failure.mjs"
$ValidateGenerate = Join-Path $ScriptDir "validate-generate.mjs"
$ParseGeneratePreview = Join-Path $ScriptDir "parse-generate-preview.mjs"
$FormatPreviewFailure = Join-Path $ScriptDir "format-preview-failure.mjs"
$BuildSendPayload = Join-Path $ScriptDir "build-send-payload.mjs"
$ApplySendBundle = Join-Path $ScriptDir "apply-send-bundle.mjs"
$ComposeResultInput = Join-Path $ScriptDir "compose-result-input.mjs"
$FormatCandidateResult = Join-Path $ScriptDir "format-candidate-result.mjs"
$ParseSendResult = Join-Path $ScriptDir "parse-send-result.mjs"
$ValidateSend = Join-Path $ScriptDir "validate-send.mjs"
$CheckAgentHealth = Join-Path $ScriptDir "check-agent-health.mjs"
$ValidateBrowserSelection = Join-Path $ScriptDir "validate-browser-selection.mjs"
$DetectExpiredBanner = Join-Path $ScriptDir "detect-expired-banner.mjs"
$ParsePageMeta = Join-Path $ScriptDir "parse-page-meta.mjs"
$DetectAccessStop = Join-Path $ScriptDir "detect-access-stop.mjs"

# UTF-8 for child processes (roll/node) and PowerShell 5.1 native-command pipes.
try {
  # Encoding.UTF8 emits a BOM on native-command stdin, which makes JSON.parse fail.
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = $utf8NoBom
  [Console]::InputEncoding = $utf8NoBom
  $OutputEncoding = $utf8NoBom
}
catch {
  # ignore on hosts that disallow changing console encoding
}

$Agent = if ($env:ROLL_AGENT) { $env:ROLL_AGENT } else { "browser-use-agent" }
$BrowserInstance = if ($env:ROLL_BROWSER_INSTANCE) { $env:ROLL_BROWSER_INSTANCE } else { "" }
$Limit = 0
$DryRun = $false
$ClickUnreadFilter = $true
$ExchangeWechat = $true
$MinGap = 0
$MaxGap = 0
$BatchSize = 4
$BatchPause = 0
$MaxConsecutiveFailures = 2
$MaxEmptyReads = 2
$KeepWorkDir = $false
$NoJudge = $false
$ResultsFile = Join-Path ([System.IO.Path]::GetTempPath()) ("roll-zhipin-unread-reply-{0:yyyyMMdd-HHmmss}.jsonl" -f (Get-Date))
$UnreadFilterApplied = $false
$WorkDir = $null

function Show-Usage {
  Write-Host @"
Usage: .\reply-unread-safely.ps1 [options]

Windows / PowerShell entrypoint (same logic as reply-unread-safely.sh).
Requires: roll and node on PATH.

  -DryRun / --dry-run       Evaluate skip rules only
  -Limit 3 / --limit 3      Max candidates this run
  -BrowserInstance boss-a / --browser-instance boss-a
                            Target browser.instances id for every browser-use tool call
  -NoUnreadFilter           Skip clicking unread tab
  -NoExchangeWechat         Skip exchange-wechat after send
  -NoJudge / --no-judge     BREAK-GLASS: send recommended dual draft without learning feedback
  -KeepWorkDir              Do not delete temp workdir (debug)
  -Help

Exit: 0 ok | 1 usage | 2 captcha/access_restricted | 3 consecutive failures
"@
}

function Require-NextArg([string[]]$Argv, [int]$Index, [string]$Flag) {
  if ($Index + 1 -ge $Argv.Count -or [string]::IsNullOrWhiteSpace($Argv[$Index + 1]) -or $Argv[$Index + 1].StartsWith("-")) {
    Write-Error "$Flag requires a value"
    exit 1
  }
}

function Parse-Args([string[]]$Argv) {
  $i = 0
  while ($i -lt $Argv.Count) {
    switch ($Argv[$i]) {
      { $_ -in "-Help", "--help", "-h" } { Show-Usage; exit 0 }
      { $_ -in "-Agent", "--agent" } {
        Require-NextArg $Argv $i $_
        $script:Agent = $Argv[$i + 1]
        $i += 2
        continue
      }
      { $_ -in "-BrowserInstance", "--browser-instance" } {
        Require-NextArg $Argv $i $_
        $script:BrowserInstance = $Argv[$i + 1]
        $i += 2
        continue
      }
      { $_ -in "-Limit", "--limit" } {
        Require-NextArg $Argv $i $_
        $script:Limit = [int]$Argv[$i + 1]
        $i += 2
        continue
      }
      { $_ -in "-DryRun", "--dry-run" } { $script:DryRun = $true; $i++; continue }
      { $_ -in "-NoUnreadFilter", "--no-unread-filter" } { $script:ClickUnreadFilter = $false; $i++; continue }
      { $_ -in "-NoExchangeWechat", "--no-exchange-wechat" } { $script:ExchangeWechat = $false; $i++; continue }
      { $_ -in "-NoJudge", "--no-judge" } { $script:NoJudge = $true; $i++; continue }
      { $_ -in "-KeepWorkDir", "--keep-workdir" } { $script:KeepWorkDir = $true; $i++; continue }
      { $_ -in "-MinGap", "--min-gap" } {
        Require-NextArg $Argv $i $_
        $script:MinGap = [int]$Argv[$i + 1]
        $i += 2
        continue
      }
      { $_ -in "-MaxGap", "--max-gap" } {
        Require-NextArg $Argv $i $_
        $script:MaxGap = [int]$Argv[$i + 1]
        $i += 2
        continue
      }
      { $_ -in "-BatchSize", "--batch-size" } {
        Require-NextArg $Argv $i $_
        $script:BatchSize = [int]$Argv[$i + 1]
        $i += 2
        continue
      }
      { $_ -in "-BatchPause", "--batch-pause" } {
        Require-NextArg $Argv $i $_
        $script:BatchPause = [int]$Argv[$i + 1]
        $i += 2
        continue
      }
      { $_ -in "-ResultsFile", "--results-file" } {
        Require-NextArg $Argv $i $_
        $script:ResultsFile = $Argv[$i + 1]
        $i += 2
        continue
      }
      default {
        Write-Error "Unknown option: $($Argv[$i])"
        Show-Usage
        exit 1
      }
    }
  }
}

function Write-Log([string]$Message) {
  Write-Host "[reply-unread] $Message" -ForegroundColor DarkCyan
}

function Write-JsonFile([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Write-TextFile([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Read-TextFile([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
}

function Append-ResultObject($Row) {
  $line = $Row | ConvertTo-Json -Compress -Depth 8
  $null = $line | & node $script:AppendJsonl $script:ResultsFile 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "failed to append JSONL result"
  }
}

function Convert-NativeCommandOutput {
  param([Parameter(ValueFromPipeline = $true)]$Item)
  process {
    if ($Item -is [System.Management.Automation.ErrorRecord]) {
      if ($null -ne $Item.Exception -and $null -ne $Item.Exception.Message) {
        return [string]$Item.Exception.Message
      }
      return [string]$Item.ToString()
    }
    if ($null -ne $Item) {
      return [string]$Item
    }
  }
}

function Invoke-NodeStdinResult([string]$MjsPath, [string]$StdinText, [string[]]$NodeArgs = @()) {
  if ($null -eq $StdinText) { $StdinText = "" }
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $raw =
      if ($NodeArgs.Count -gt 0) {
        $StdinText | & node $MjsPath @NodeArgs 2>&1
      }
      else {
        $StdinText | & node $MjsPath 2>&1
      }
    $nodeExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }

    # Node helpers often exit 0 with empty stdout (exit-code-only validators). Normalize so
    # callers can always call string methods like .Trim() on Windows PS.
    $chunks = @($raw | Convert-NativeCommandOutput)
    $text = (($chunks | Where-Object { $null -ne $_ }) -join [Environment]::NewLine)

    return [pscustomobject]@{
      Text = $text
      ExitCode = $nodeExit
    }
  }
  finally {
    $ErrorActionPreference = $prev
  }
}

function Invoke-NodeStdin([string]$MjsPath, [string]$StdinText, [string[]]$NodeArgs = @()) {
  $result = Invoke-NodeStdinResult -MjsPath $MjsPath -StdinText $StdinText -NodeArgs $NodeArgs
  return [string]$result.Text
}

function Invoke-NodeStdinExit([string]$MjsPath, [string]$StdinText, [string[]]$NodeArgs = @()) {
  $result = Invoke-NodeStdinResult -MjsPath $MjsPath -StdinText $StdinText -NodeArgs $NodeArgs
  return [int]$result.ExitCode
}

function Format-SendResultLine(
  [string]$Mode,
  [string]$LineTs,
  [string]$LineName,
  [string]$LineCid,
  [string]$LinePreparedId,
  [string]$LineSendResult,
  [int]$ExchangedFlag = 0
) {
  $sendResultPath = Join-Path $script:WorkDir "send-result.json"
  Write-JsonFile $sendResultPath $LineSendResult
  $bundlePath = Join-Path $script:WorkDir "send-bundle.json"
  $payload = (& node $script:ComposeResultInput $bundlePath $sendResultPath 2>$null).Trim()
  if (-not $payload) {
    return ""
  }
  return (Invoke-NodeStdin $script:FormatCandidateResult $payload @(
    $Mode, $LineTs, $LineName, $LineCid, $LinePreparedId, [string]$ExchangedFlag
  )).Trim()
}

function Invoke-RollCapture {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$RollArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ("roll-stderr-{0}.log" -f ([guid]::NewGuid().ToString("N")))
  try {
    $rollCommand = if ($env:ROLL_CURRENT_CLI -and (Test-Path -LiteralPath $env:ROLL_CURRENT_CLI -PathType Leaf)) {
      $env:ROLL_CURRENT_CLI
    }
    else {
      "roll"
    }
    $raw = & $rollCommand @RollArgs 2> $stderrPath
    $rollExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
    $chunks = @($raw | Convert-NativeCommandOutput)
    if ($rollExit -ne 0 -and (Test-Path -LiteralPath $stderrPath -PathType Leaf)) {
      $stderrText = [System.IO.File]::ReadAllText($stderrPath)
      if (-not [string]::IsNullOrWhiteSpace($stderrText)) {
        [Console]::Error.WriteLine($stderrText.TrimEnd())
      }
    }
    return ($chunks -join [Environment]::NewLine)
  }
  finally {
    if (Test-Path -LiteralPath $stderrPath -PathType Leaf) {
      Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
    $ErrorActionPreference = $prev
  }
}

function Extract-RollJson([string]$RollOutput) {
  return (Invoke-NodeStdin $script:ExtractRollJson $RollOutput).Trim()
}

function Add-BrowserInstanceToJsonFile([string]$File) {
  if ([string]::IsNullOrWhiteSpace($script:BrowserInstance)) {
    return
  }
  $payloadRaw = Read-TextFile $File
  if ([string]::IsNullOrWhiteSpace($payloadRaw)) {
    $payloadRaw = "{}"
  }
  $payload = $payloadRaw | ConvertFrom-Json
  $payload | Add-Member -NotePropertyName browserInstance -NotePropertyValue $script:BrowserInstance -Force
  Write-JsonFile $File ($payload | ConvertTo-Json -Compress -Depth 16)
}

function Invoke-RollJsonFile([string]$Tool, [string]$File, [switch]$SkipBrowserInstance) {
  if (-not $SkipBrowserInstance) {
    Add-BrowserInstanceToJsonFile $File
  }
  return Invoke-RollCapture -RollArgs @("run", $script:Agent, $Tool, "--input-file", $File, "--json")
}

function Invoke-RollNoInput([string]$Tool) {
  $baseDir = if ($script:WorkDir -and (Test-Path $script:WorkDir)) {
    $script:WorkDir
  }
  else {
    [System.IO.Path]::GetTempPath()
  }
  $inputFile = Join-Path $baseDir ("input-{0}.json" -f ([guid]::NewGuid().ToString("N")))
  Write-JsonFile $inputFile "{}"
  return Invoke-RollJsonFile $Tool $inputFile
}

function Get-RandomGap {
  if ($script:MaxGap -le $script:MinGap) { return $script:MinGap }
  return Get-Random -Minimum $script:MinGap -Maximum ($script:MaxGap + 1)
}

function Ensure-AgentHealthy {
  $env:REPLY_AGENT = $script:Agent
  $health = Invoke-RollCapture -RollArgs @("agent", "health", "--json")
  $code = Invoke-NodeStdinExit $script:CheckAgentHealth $health @()
  if ($code -ne 0) {
    Write-Log "starting agent $($script:Agent)..."
    $null = Invoke-RollCapture -RollArgs @("agent", "start", $script:Agent)
    Start-Sleep -Seconds 2
  }
}

function Ensure-BrowserInstanceSelection {
  $status = Invoke-RollNoInput "browser_status"
  $previous = $env:ROLL_BROWSER_INSTANCE
  $env:ROLL_BROWSER_INSTANCE = $script:BrowserInstance
  try {
    $validation = Invoke-NodeStdinResult $script:ValidateBrowserSelection $status
    $message = ([string]$validation.Text).Trim()
    $code = [int]$validation.ExitCode
  }
  finally {
    $env:ROLL_BROWSER_INSTANCE = $previous
  }

  if ($code -ne 0) {
    if (-not [string]::IsNullOrWhiteSpace($message)) {
      Write-Error $message
    }
    else {
      Write-Error "browser instance selection validation failed"
    }
    exit 1
  }

  if (-not [string]::IsNullOrWhiteSpace($script:BrowserInstance)) {
    Write-Log "browserInstance -> $($script:BrowserInstance)"
  }
}

function Ensure-ChatList {
  $out = Invoke-RollNoInput "zhipin_open_chat_page"
  Stop-IfRiskPage -Out $out -Stage "open_chat_page"
}

function Apply-UnreadFilterIfNeeded {
  if (-not $script:ClickUnreadFilter) { return }
  if ($script:UnreadFilterApplied) {
    Write-Log "unread filter already active, skip click"
    return
  }
  Ensure-ChatList
  $snapFile = Join-Path $script:WorkDir "snapshot.json"
  Write-JsonFile $snapFile '{"interactiveOnly":true,"maxNodes":500}'
  $snap = Invoke-RollJsonFile "browser_snapshot" $snapFile
  Stop-IfRiskPage -Out $snap -Stage "unread_filter"
  $ref = ""
  try {
    $ref = (Invoke-NodeStdin $script:FindUnreadRef $snap).Trim()
  }
  catch {
    $ref = ""
  }

  if ($ref) {
    Write-Log "click unread filter $ref (current SPA document)"
    $clickFile = Join-Path $script:WorkDir "click-unread.json"
    Write-JsonFile $clickFile (@{ ref = $ref } | ConvertTo-Json -Compress)
    [void](Extract-RollJson (Invoke-RollJsonFile "click_ref" $clickFile))
    $script:UnreadFilterApplied = $true
    Start-Sleep -Seconds 1
  }
  else {
    Write-Log "warn: unread ref not found; relying on onlyUnread read_messages"
  }
}

function Invalidate-UnreadFilterAfterReload {
  if ($script:ClickUnreadFilter) {
    $script:UnreadFilterApplied = $false
    Write-Log "unread filter state invalidated after force reload"
  }
}

function Ensure-UnreadListReady {
  # Preserve the steady-state page-drift guard even when the unread filter is already active.
  Ensure-ChatList
  if ($script:ClickUnreadFilter) {
    Apply-UnreadFilterIfNeeded
  }
}

function Get-NextUnread {
  $readFile = Join-Path $script:WorkDir "read.json"
  Write-JsonFile $readFile '{"onlyUnread":true,"limit":1,"autoScroll":false}'
  $out = Invoke-RollJsonFile "zhipin_read_messages" $readFile
  Stop-IfRiskPage -Out $out -Stage "read_messages"
  $code = Invoke-NodeStdinExit $script:ParseReadCandidate $out @()
  if ($code -ne 0) { return $null }
  $json = (Invoke-NodeStdin $script:ParseReadCandidate $out).Trim()
  if (-not $json) { return $null }
  return $json | ConvertFrom-Json
}

function Test-PageBlockers([string]$SnapText) {
  return (Invoke-NodeStdin $script:DetectExpiredBanner $SnapText).Trim()
}

function Stop-IfRiskPage {
  param(
    [string]$Out,
    [string]$Stage = "tool",
    [string]$Name = "",
    [string]$Cid = ""
  )
  $detectedRaw = (Invoke-NodeStdin $script:DetectAccessStop $Out).Trim()
  if (-not $detectedRaw -or -not $detectedRaw.StartsWith("{")) {
    return
  }
  $detected = $detectedRaw | ConvertFrom-Json
  if (-not $detected.stop) {
    return
  }
  $reason = if ($detected.reason) { [string]$detected.reason } else { "access_restricted" }
  $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  Append-ResultObject @{
    ts = $ts
    name = $Name
    conversationId = $Cid
    ok = $false
    stage = $Stage
    reason = $reason
  }
  Write-Log "STOP: $reason ($Stage) — do not reload or retry"
  exit 2
}

function Back-ToList {
  Ensure-UnreadListReady
}

function Process-One([string]$Cid, [string]$Name, [string]$Preview) {
  $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

  $cFile = Join-Path $script:WorkDir "c.json"
  Write-JsonFile $cFile (@{ conversationId = $Cid } | ConvertTo-Json -Compress)
  Write-Log "zhipin_open_chat $Name (list click)"
  $openOut = Invoke-RollJsonFile "zhipin_open_chat" $cFile
  Stop-IfRiskPage -Out $openOut -Stage "open_chat" -Name $Name -Cid $Cid

  $openCode = Invoke-NodeStdinExit $script:ValidateOpenChat $openOut @($Cid)
  if ($openCode -ne 0) {
    $initialOpenPath = Join-Path $script:WorkDir "open-chat-initial.out"
    $reloadPath = Join-Path $script:WorkDir "open-chat-reload.out"
    $retryOpenPath = Join-Path $script:WorkDir "open-chat-retry.out"
    Write-TextFile $initialOpenPath $openOut

    Write-Log "warn: open_chat failed for $Name; force-reloading chat page and retrying once"
    $reloadFile = Join-Path $script:WorkDir "reload-chat.json"
    Write-JsonFile $reloadFile (@{ forceReload = $true; expectedConversationId = $Cid } | ConvertTo-Json -Compress)
    $reloadOut = Invoke-RollJsonFile "zhipin_open_chat_page" $reloadFile
    Write-TextFile $reloadPath $reloadOut
    Stop-IfRiskPage -Out $reloadOut -Stage "open_chat_page" -Name $Name -Cid $Cid
    Invalidate-UnreadFilterAfterReload

    Write-Log "retry zhipin_open_chat $Name after force reload"
    $openOut = Invoke-RollJsonFile "zhipin_open_chat" $cFile
    Write-TextFile $retryOpenPath $openOut
    Stop-IfRiskPage -Out $openOut -Stage "open_chat" -Name $Name -Cid $Cid
    $openCode = Invoke-NodeStdinExit $script:ValidateOpenChat $openOut @($Cid)
    if ($openCode -ne 0) {
      $failureLine = [string](& node $script:FormatOpenChatFailure `
          $ts $Name $Cid $initialOpenPath $reloadPath $retryOpenPath 2>$null)
      $failureLine = $failureLine.Trim()
      if ($LASTEXITCODE -eq 0 -and $failureLine) {
        Append-ResultObject ($failureLine | ConvertFrom-Json)
      }
      else {
        Append-ResultObject @{
          ts = $ts; name = $Name; conversationId = $Cid; ok = $false
          stage = "open_chat"; recoveryAttempted = $true
        }
      }
      return 1
    }
    Write-Log "open_chat recovered after force reload: $Name"
  }

  $snapFile = Join-Path $script:WorkDir "snap-preflight.json"
  Write-JsonFile $snapFile '{"interactiveOnly":false,"maxNodes":250}'
  $snap = Invoke-RollJsonFile "browser_snapshot" $snapFile
  $pageUrl = ""
  $pageTitle = ""
  $meta = @{ captcha = $false; blocked = $false; url = ""; title = "" }
  try {
    $metaJson = Invoke-NodeStdin $script:ParsePageMeta $snap
    $meta = $metaJson | ConvertFrom-Json
    $pageUrl = [string]$meta.url
    $pageTitle = [string]$meta.title
  }
  catch {
    Write-Log "warn: could not parse snapshot page metadata"
  }

  if ($meta.captcha -eq $true) {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "preflight"; reason = "captcha" }
    Write-Log "STOP: captcha (url/title)"
    exit 2
  }
  if ($meta.blocked -eq $true) {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "preflight"; reason = "access_restricted" }
    Write-Log "STOP: access_restricted (url/title)"
    exit 2
  }

  if ((Test-PageBlockers $snap) -eq "expired") {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "preflight"; reason = "position_expired" }
    Write-Log "skip ${Name}: position expired"
    Back-ToList
    return 0
  }

  $infoFile = Join-Path $script:WorkDir "info.json"
  Write-JsonFile $infoFile '{"maxMessages":100}'
  Write-Log "zhipin_get_candidate_info (current chat, no re-open)"
  $infoOut = Invoke-RollJsonFile "zhipin_get_candidate_info" $infoFile
  Stop-IfRiskPage -Out $infoOut -Stage "get_candidate_info" -Name $Name -Cid $Cid
  $infoRaw = Extract-RollJson $infoOut
  if (-not $infoRaw) { $infoRaw = "{}" }
  $infoRawPath = Join-Path $script:WorkDir "info-raw.json"
  Write-JsonFile $infoRawPath $infoRaw

  $previewPath = Join-Path $script:WorkDir "preview.txt"
  $skipInputPath = Join-Path $script:WorkDir "skip-input.json"
  Write-TextFile $previewPath $Preview
  $null = & node $script:BuildSkipInput $infoRawPath $previewPath $pageUrl $pageTitle $skipInputPath 2>&1
  if ($LASTEXITCODE -ne 0) {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "skip_build" }
    return 1
  }

  $skipInputRaw = [System.IO.File]::ReadAllText($skipInputPath, [System.Text.UTF8Encoding]::new($false))
  $skipEvaluation = Invoke-NodeStdinResult $SkipRulesJs $skipInputRaw
  $skipResult = [string]$skipEvaluation.Text
  if ($skipEvaluation.ExitCode -ne 0 -or -not $skipResult) {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "skip_eval" }
    return 1
  }
  $skipObj = $skipResult | ConvertFrom-Json
  if ($skipObj.stop) {
    $stopReason = if ($skipObj.reason) { [string]$skipObj.reason } else { "captcha" }
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "preflight"; reason = $stopReason }
    exit 2
  }
  if ($skipObj.skip) {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "skip"; reason = $skipObj.reason }
    Write-Log "skip ${Name}: $($skipObj.reason)"
    Back-ToList
    return 0
  }

  if ($script:DryRun) {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $true; stage = "dry_run"; would = "reply+exchange" }
    Write-Log "dry-run would reply: $Name"
    Back-ToList
    return 0
  }

  $gpFile = Join-Path $script:WorkDir "gp.json"
  Write-JsonFile $gpFile '{"maxMessages":100}'
  Write-Log "zhipin_generate_reply_preview (current chat, no re-open)"
  $previewOut = Invoke-RollJsonFile "zhipin_generate_reply_preview" $gpFile
  Stop-IfRiskPage -Out $previewOut -Stage "preview" -Name $Name -Cid $Cid
  $previewMetaRaw = (Invoke-NodeStdin $script:ParseGeneratePreview $previewOut @()).Trim()
  if (-not $previewMetaRaw -or -not $previewMetaRaw.StartsWith("{")) {
    Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "preview" }
    Back-ToList
    return 1
  }
  $previewMeta = $previewMetaRaw | ConvertFrom-Json
  $preparedId = [string]$previewMeta.preparedReplyId
  $hasDual = [bool]$previewMeta.hasDualDraft
  if ([string]::IsNullOrWhiteSpace($preparedId)) {
    $failureLine = (Invoke-NodeStdin $script:FormatPreviewFailure $previewMetaRaw @($ts, $Name, $Cid)).Trim()
    if ($failureLine -and $failureLine.StartsWith("{")) {
      Append-ResultObject ($failureLine | ConvertFrom-Json)
    }
    else {
      Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "preview" }
    }
    Back-ToList
    return 1
  }

  if ($hasDual -and $script:NoJudge) {
    Write-Log "BREAK-GLASS: --no-judge -> send recommended option; learning is skipped but a terminal outcome is recorded"
  }

  $hasDualFlag = if ($hasDual) { "1" } else { "0" }
  $noJudgeFlag = if ($script:NoJudge) { "1" } else { "0" }
  $sendBundleRaw = (Invoke-NodeStdin $script:BuildSendPayload "" @($preparedId, $hasDualFlag, $noJudgeFlag)).Trim()
  if (-not $sendBundleRaw -or -not $sendBundleRaw.StartsWith("{")) {
    Write-Log "send payload validation failed; message was not sent: $sendBundleRaw"
    Append-ResultObject @{
      ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "send_build"; preparedReplyId = $preparedId; hasDualDraft = $hasDual
    }
    Back-ToList
    return 1
  }
  $sendBundlePath = Join-Path $script:WorkDir "send-bundle.json"
  Write-JsonFile $sendBundlePath $sendBundleRaw
  $spFile = Join-Path $script:WorkDir "sp.json"
  $applyCode = Invoke-NodeStdinExit $script:ApplySendBundle $sendBundleRaw @($spFile)
  if ($applyCode -ne 0) {
    Append-ResultObject @{
      ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "send_build"; preparedReplyId = $preparedId; hasDualDraft = $hasDual
    }
    Back-ToList
    return 1
  }

  $sendOut = Invoke-RollJsonFile "zhipin_send_prepared_reply" $spFile
  Stop-IfRiskPage -Out $sendOut -Stage "send" -Name $Name -Cid $Cid
  $sendResultRaw = (Invoke-NodeStdin $script:ParseSendResult $sendOut).Trim()
  if (-not $sendResultRaw -or -not $sendResultRaw.StartsWith("{")) {
    $sendResultRaw = '{"ok":false}'
  }
  $sendResult = $sendResultRaw | ConvertFrom-Json
  if (-not $sendResult.ok) {
    $failedLine = Format-SendResultLine "send_failed" $ts $Name $Cid $preparedId $sendResultRaw 0
    if ($failedLine) {
      Append-ResultObject ($failedLine | ConvertFrom-Json)
    }
    else {
      Append-ResultObject @{ ts = $ts; name = $Name; conversationId = $Cid; ok = $false; stage = "send"; preparedReplyId = $preparedId }
    }
    Back-ToList
    return 1
  }

  Write-Log "sent: $Name"

  if ($script:ExchangeWechat) {
    $wxFile = Join-Path $script:WorkDir "wx.json"
    Write-JsonFile $wxFile "{}"
    Write-Log "zhipin_exchange_wechat (current chat)"
    $wxOut = Invoke-RollJsonFile "zhipin_exchange_wechat" $wxFile
    Stop-IfRiskPage -Out $wxOut -Stage "exchange_wechat" -Name $Name -Cid $Cid
    [void](Extract-RollJson $wxOut)
  }

  $successLine = Format-SendResultLine "sent" $ts $Name $Cid $preparedId $sendResultRaw $(if ($script:ExchangeWechat) { 1 } else { 0 })
  if ($successLine) {
    $successResult = $successLine | ConvertFrom-Json
    if ($successResult.feedbackQueued -eq $true) {
      Write-Log "feedback queued for retry: $Name ($($successResult.feedbackStatus))"
    }
    elseif ($successResult.feedbackGap -eq $true) {
      $source = if ($successResult.decisionSource) { $successResult.decisionSource } else { "unknown" }
      $status = if ($successResult.feedbackStatus) { $successResult.feedbackStatus } else { "missing" }
      $reason = if ($successResult.fallbackReason) {
        $successResult.fallbackReason
      }
      elseif ($successResult.feedbackError) {
        $successResult.feedbackError
      }
      else {
        "feedback_not_closed"
      }
      Write-Log "WARN: feedback gap: ${Name}; source=${source}; status=${status}; reason=${reason}"
    }
    elseif ($successResult.learningSkipped -eq $true) {
      $source = if ($successResult.decisionSource) { $successResult.decisionSource } else { "unknown" }
      $reason = if ($successResult.fallbackReason) {
        $successResult.fallbackReason
      }
      elseif ($successResult.decisionReason) {
        $successResult.decisionReason
      }
      else {
        "learning_not_expected"
      }
      Write-Log "learning feedback skipped: ${Name}; source=${source}; reason=${reason}"
    }
    Append-ResultObject $successResult
  }
  else {
    Append-ResultObject @{
      ts = $ts; name = $Name; conversationId = $Cid; ok = $true
      preparedReplyId = $preparedId; exchangedWechat = $script:ExchangeWechat
    }
  }
  Back-ToList
  return 10
}

Parse-Args -Argv $args

if ((-not $env:ROLL_CURRENT_CLI -or -not (Test-Path -LiteralPath $env:ROLL_CURRENT_CLI -PathType Leaf)) -and -not (Get-Command roll -ErrorAction SilentlyContinue)) {
  Write-Error "roll CLI not found in PATH"
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node not found in PATH"
  exit 1
}

$helpers = @(
  $ExtractRollJson, $BuildSkipInput, $AppendJsonl, $SkipRulesJs,
  $FindUnreadRef, $ParseReadCandidate, $ValidateOpenChat, $FormatOpenChatFailure,
  $ParseGeneratePreview, $FormatPreviewFailure, $BuildSendPayload, $ApplySendBundle, $ComposeResultInput,
  $FormatCandidateResult,
  $ParseSendResult,
  $ValidateSend, $CheckAgentHealth, $ValidateBrowserSelection, $DetectExpiredBanner, $ParsePageMeta,
  $DetectAccessStop
)
foreach ($helper in $helpers) {
  if (-not (Test-Path $helper)) {
    Write-Error "missing helper script: $helper"
    exit 1
  }
}

$env:REPLY_AGENT = $Agent
$WorkDir = Join-Path ([System.IO.Path]::GetTempPath()) ("roll-zhipin-reply." + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

try {
  [System.IO.File]::WriteAllText($ResultsFile, "", [System.Text.UTF8Encoding]::new($false))
  Write-Log "results -> $ResultsFile"
  Write-Log "workdir -> $WorkDir"

  Ensure-AgentHealthy
  Ensure-BrowserInstanceSelection
  Ensure-UnreadListReady

  $processed = 0
  $consecutiveFail = 0
  $batchCount = 0
  $emptyReads = 0

  while ($true) {
    if ($Limit -gt 0 -and $processed -ge $Limit) {
      Write-Log "reached limit $Limit"
      break
    }

    # A force reload rebuilds the SPA and invalidates the previously clicked unread filter.
    Ensure-UnreadListReady
    $next = Get-NextUnread
    if (-not $next) {
      $emptyReads++
      if ($emptyReads -ge $MaxEmptyReads) {
        Write-Log "no unread (empty reads: $emptyReads)"
        break
      }
      Start-Sleep -Seconds 2
      continue
    }
    $emptyReads = 0

    Write-Log "[$($processed + 1)] $($next.name) ($($next.conversationId))"
    $rc = Process-One $next.conversationId $next.name $next.preview

    if ($rc -eq 2) { exit 2 }
    $processed++

    if ($rc -eq 1) {
      $consecutiveFail++
      if ($consecutiveFail -ge $MaxConsecutiveFailures) {
        Write-Log "STOP: $MaxConsecutiveFailures consecutive failures"
        exit 3
      }
    }
    elseif ($rc -eq 10) {
      $consecutiveFail = 0
      $batchCount++
      if ($batchCount -ge $BatchSize) {
        if ($BatchPause -gt 0) {
          Write-Log "batch pause ${BatchPause}s"
          Start-Sleep -Seconds $BatchPause
        }
        $batchCount = 0
      }
      else {
        $gap = Get-RandomGap
        if ($gap -gt 0) {
          Write-Log "sleep ${gap}s"
          Start-Sleep -Seconds $gap
        }
      }
    }
    else {
      $consecutiveFail = 0
    }
  }

  Write-Log "done; handled=$processed; see $ResultsFile"
}
finally {
  if ($script:KeepWorkDir) {
    Write-Log "kept workdir for debugging: $WorkDir"
  }
  elseif ($WorkDir -and (Test-Path $WorkDir)) {
    Remove-Item -Recurse -Force $WorkDir -ErrorAction SilentlyContinue
  }
}
