# Brings one host's broker back to a known-good running state, and says what it found.
#
#   .\install\Repair-Broker.ps1
#   .\install\Repair-Broker.ps1 -Pull
#
# The failure this exists for: a broker process that outlives its scheduled task. Stopping the task
# does not reliably kill the node process it started, and the orphan keeps the port, so the fresh
# instance exits on EADDRINUSE while stale code goes on serving. This stops the task, kills every
# process it can prove is this checkout's broker, reports the host's setup, starts the task again,
# and waits on the broker's own /sessions endpoint before saying the host is up.
#
# Kill by proof, never by name. A target is node running this repository's broker\index.ts, or node
# holding the configured port in LISTEN with a command line this account cannot read (the orphan,
# whose command line Windows hides from a process it will not open). Everything else lives: a node
# process whose readable command line names something else, a tool merely holding the entry path in
# its arguments, and any non-node application on the port, which is named in the output with its
# EADDRINUSE consequence and left to the operator. Each killed process is reported with its PID and
# what identified it. "Stop every node process" is the failure mode that takes out unrelated work,
# so a process name narrows a proof here and never supplies one.
#
# This mutates only the processes it proved and the scheduled task. Settings files, hooks, and ACLs
# are reported on and never written: repairing those is the installers' job.
param(
    [switch]$Pull,

    # Defaults to the repository this script lives in, two levels up from install/. Overridable so a
    # test or a second checkout can point this at its own tree.
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),

    [string]$TaskName = 'SapplefeldChannelsBroker',

    # Defaults to this account's state root, resolved in the runner rather than here: the resolver
    # throws when LOCALAPPDATA is unset, and a parameter default runs when a test dot-sources this
    # file for its functions.
    [string]$EnvFile,

    [int]$TimeoutSeconds = 30
)

. (Join-Path $PSScriptRoot 'Install-Functions.ps1')

<#
.SYNOPSIS
Writes one pass or fail line for a named check.
#>
function Write-ChannelCheck {
    param(
        [Parameter(Mandatory)][string]$Name,
        [bool]$Ok,
        [AllowEmptyString()][string]$Detail = ''
    )
    $mark = if ($Ok) { 'ok  ' } else { 'FAIL' }
    $suffix = if ($Detail) { ": $Detail" } else { '' }
    Write-Host "  [$mark] $Name$suffix"
}

<#
.SYNOPSIS
True when a process image name is node's.

.DESCRIPTION
Windows reports the image name with its extension through CIM and without it through Get-Process, so
both spellings read as node. This is never a reason to kill anything on its own; the two proofs below
are what select, and this narrows each of them.
#>
function Test-IsChannelNodeProcessName {
    param([AllowEmptyString()][string]$Name = '')
    if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
    return ($Name.ToLowerInvariant() -replace '\.exe$', '') -eq 'node'
}

<#
.SYNOPSIS
True when a process is node running this checkout's broker entry point: the command-line proof.

.DESCRIPTION
The primary proof, in one pure function over a name, a command line, and a path, so the rule that
selects processes to kill is the same rule a test can drive without a process anywhere near it.

Both halves are required. Containment alone matches any process that merely carries the path in its
arguments, so an editor or a grep opened on broker\index.ts would be killed by a repair pass; the
node name is what keeps a tool holding the path alive. Start-Broker.ps1 invokes node with the full
entry path, so the broker this hunts always satisfies both.

The name alone selects nothing: a node process running anything else does not match here, and
Win32_Process reports a null command line for a process this account cannot read, which is false
here too.

Both paths are lowercased and their separators normalized before the containment test, so an entry
path invoked with forward slashes still matches the same file. The path carries the repository root,
so a second checkout's broker on the same machine does not match this one's.
#>
function Test-IsChannelBrokerCommandLine {
    param(
        [AllowEmptyString()][string]$Name = '',
        [AllowEmptyString()][string]$CommandLine = '',
        [Parameter(Mandatory)][string]$BrokerEntryPath
    )
    if (-not (Test-IsChannelNodeProcessName -Name $Name)) { return $false }
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $needle = ($BrokerEntryPath -replace '/', '\').ToLowerInvariant()
    $haystack = ($CommandLine -replace '/', '\').ToLowerInvariant()
    return $haystack.Contains($needle)
}

<#
.SYNOPSIS
Filters process descriptors down to the ones the command-line proof selects.

.DESCRIPTION
Takes descriptors carrying a ProcessId, a Name, and a CommandLine rather than live process objects,
which is what lets a test hand it a table of made-up processes.
#>
function Select-ChannelBrokerProcess {
    param(
        [AllowNull()][AllowEmptyCollection()][object[]]$Process,
        [Parameter(Mandatory)][string]$BrokerEntryPath
    )
    $selected = foreach ($candidate in @($Process)) {
        if ($null -eq $candidate) { continue }
        if (Test-IsChannelBrokerCommandLine -Name ([string]$candidate.Name) `
                -CommandLine ([string]$candidate.CommandLine) -BrokerEntryPath $BrokerEntryPath) {
            $candidate
        }
    }
    # Returned bare so the callers' @() collects the enumerated items; a comma-wrapped return
    # would nest the array and hand a foreach one element holding every descriptor at once.
    return @($selected)
}

<#
.SYNOPSIS
True when the process holding the broker port may be killed on the port proof.

.DESCRIPTION
The port proof exists to catch a broker orphan, and an orphan is node either running this checkout's
entry point or running with a command line this account cannot read, which is what Win32_Process
reports for a process it cannot open. Those two are killed.

Everything else holding the port is named and left alive, the same refusal Install-Elevated.ps1's
Restart-ChannelBroker makes before an install's restart. A node process whose readable command line
names something else is refused with the rest of them: a readable foreign command line is
affirmative proof of a bystander, and the broker port's default is a popular one for local
development servers. An unnameable holder is refused for the mirror-image reason, that a repair which
cannot say what it is about to kill has no proof at all.

A process that holds nothing is never seen by this function, so nothing is ever killed for being
called node.
#>
function Test-IsChannelBrokerPortHolder {
    param(
        [AllowEmptyString()][string]$Name = '',
        [AllowEmptyString()][string]$CommandLine = '',
        [Parameter(Mandatory)][string]$BrokerEntryPath
    )
    if (-not (Test-IsChannelNodeProcessName -Name $Name)) { return $false }
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $true }
    return Test-IsChannelBrokerCommandLine -Name $Name -CommandLine $CommandLine -BrokerEntryPath $BrokerEntryPath
}

<#
.SYNOPSIS
The port the broker is configured to listen on: broker.env's CHANNEL_BROKER_PORT, else the default.

.DESCRIPTION
The default matches broker/config.ts's own. A missing file, a missing key, or a value that is not a
positive integer all fall back to it, because the alternative is repairing a port the broker was
never on: killing whatever holds it and then polling an endpoint nothing answers.
#>
function Get-ChannelBrokerPort {
    param(
        [Parameter(Mandatory)][string]$EnvFile,
        [int]$Default = 8787
    )
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $Default }
    $values = Get-ChannelEnvFile -Path $EnvFile
    if (-not $values.Contains('CHANNEL_BROKER_PORT')) { return $Default }
    $parsed = 0
    if ([int]::TryParse(([string]$values['CHANNEL_BROKER_PORT']).Trim(), [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }
    return $Default
}

<#
.SYNOPSIS
Runs git in the repository and returns its exit code and combined output.

.DESCRIPTION
$ErrorActionPreference is Continue for the duration of the call: git writes ordinary progress to
stderr, and under the runner's Stop preference Windows PowerShell 5.1 turns redirected native stderr
into a terminating NativeCommandError. A repair pass reports what git said and keeps going.
#>
function Invoke-ChannelGit {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string[]]$Arguments
    )
    $ErrorActionPreference = 'Continue'
    $output = & git -C $RepoRoot @Arguments 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output.Trim() }
}

<#
.SYNOPSIS
Fast-forwards the checkout, reporting the commit before and after.

.DESCRIPTION
A dirty tree or a history that will not fast-forward is reported and the run continues to the health
pass unpulled: the operator ran this to get the broker back, and merging or stashing on their behalf
is a decision this script does not get to make.
#>
function Update-ChannelCheckout {
    param([Parameter(Mandatory)][string]$RepoRoot)

    $before = Invoke-ChannelGit -RepoRoot $RepoRoot -Arguments @('rev-parse', 'HEAD')
    if ($before.ExitCode -ne 0) {
        Write-Host "  not a git checkout, or git is unavailable: $($before.Output)"
        return
    }
    Write-Host "  before: $($before.Output)"

    $status = Invoke-ChannelGit -RepoRoot $RepoRoot -Arguments @('status', '--porcelain')
    if ($status.ExitCode -ne 0) {
        Write-Host "  cannot read the working tree state; not pulling: $($status.Output)"
        return
    }
    if ($status.Output) {
        Write-Host '  working tree has local changes; not pulling.'
        return
    }

    $pull = Invoke-ChannelGit -RepoRoot $RepoRoot -Arguments @('pull', '--ff-only')
    if ($pull.ExitCode -ne 0) {
        Write-Host "  pull refused (not a fast-forward); continuing on the current commit: $($pull.Output)"
        return
    }

    $after = Invoke-ChannelGit -RepoRoot $RepoRoot -Arguments @('rev-parse', 'HEAD')
    Write-Host "  after:  $($after.Output)"
}

<#
.SYNOPSIS
Kills every process proven to be this checkout's broker, and reports each PID and its proof.

.DESCRIPTION
Two proofs, and only these two: the command line names this repository's broker entry point, and the
process holds the configured port in LISTEN and passes Test-IsChannelBrokerPortHolder. The orphan
this script exists for usually answers to both, so targets are collected by PID first and killed
once, carrying every reason that named them.

Win32_Process is enumerated and filtered in PowerShell rather than through a WQL filter, so the two
predicates above are the only places a kill is decided.

Returns the PIDs actually killed.
#>
function Stop-ChannelBrokerProcess {
    param(
        [Parameter(Mandatory)][string]$BrokerEntryPath,
        [Parameter(Mandatory)][int]$Port
    )

    $descriptors = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
        ForEach-Object {
            [pscustomobject]@{ ProcessId = $_.ProcessId; Name = $_.Name; CommandLine = $_.CommandLine }
        })
    $byProcessId = @{}
    foreach ($descriptor in $descriptors) { $byProcessId[[string]$descriptor.ProcessId] = $descriptor }

    $targets = [ordered]@{}
    foreach ($match in @(Select-ChannelBrokerProcess -Process $descriptors -BrokerEntryPath $BrokerEntryPath)) {
        $targets[[string]$match.ProcessId] = @("its command line names $BrokerEntryPath")
    }
    $refused = @{}
    foreach ($listener in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
        $key = [string]$listener.OwningProcess
        $holder = $byProcessId[$key]
        $holderName = if ($holder) { [string]$holder.Name } else { '' }
        $holderCommandLine = if ($holder) { [string]$holder.CommandLine } else { '' }
        if (-not $holder) {
            # The CIM enumeration is one snapshot, and the listener list is another: a broker that
            # started between the two is missing from the first. Asked for by PID, it is still
            # nameable, and a name with no command line is the orphan row of the table.
            $live = Get-Process -Id ([int]$key) -ErrorAction SilentlyContinue
            if ($live) { $holderName = [string]$live.Name }
        }
        if (-not (Test-IsChannelBrokerPortHolder -Name $holderName -CommandLine $holderCommandLine `
                -BrokerEntryPath $BrokerEntryPath)) {
            # A dual-stack listener answers on two address families and appears once per family.
            if ($refused.ContainsKey($key)) { continue }
            $refused[$key] = $true
            $named = if ($holderName) { "'$holderName'" } else { 'a process this account cannot identify' }
            Write-Host "  PID $key ($named) holds port $Port and is not this checkout's broker; leaving it alive."
            Write-Host "  The task start will fail with EADDRINUSE until that process gives up port $Port."
            continue
        }
        $reason = "it holds port $Port in LISTEN"
        # The @() wraps the whole if: an if used as an expression enumerates its output, so a
        # one-element array would otherwise collapse to a string and += would concatenate text
        # instead of appending a reason.
        $reasons = @(if ($targets.Contains($key)) { $targets[$key] } else { })
        if ($reasons -notcontains $reason) { $reasons += $reason }
        $targets[$key] = $reasons
    }

    if ($targets.Count -eq 0) {
        Write-Host '  no broker process to kill.'
        return @()
    }

    $killed = @()
    foreach ($key in @($targets.Keys)) {
        $processId = [int]$key
        $proof = @($targets[$key]) -join ', and '
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Host "  killed PID $processId ($proof)."
            $killed += $processId
        } catch {
            Write-Host "  PID $processId ($proof) was not killed: $($_.Exception.Message)"
        }
    }
    # Returned bare: the callers wrap with @(), and a comma-wrapped return would nest the array
    # inside theirs, turning the summary's join into "System.Object[]".
    return $killed
}

<#
.SYNOPSIS
Reports each piece of this host's broker setup as pass or fail, and returns the facts the summary
prints.

.DESCRIPTION
Reports without repairing. Every failure here is install state, which the installers own; this pass
exists so an operator reading one screen knows whether to re-run an installer or look at the log.
#>
function Get-ChannelHostHealth {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$TaskName
    )

    $stateRoot = Split-Path -Parent $EnvFile
    Write-ChannelCheck -Name 'state root' -Ok (Test-Path -LiteralPath $stateRoot) -Detail $stateRoot

    $hostName = ''
    # The binary the task actually runs: Start-Broker.ps1 uses broker.env's CHANNEL_NODE_EXE when it
    # is set and only falls back to PATH, so checking a bare node would vouch for a different binary.
    $nodeExe = 'node'
    $envExists = Test-Path -LiteralPath $EnvFile
    Write-ChannelCheck -Name 'broker.env' -Ok $envExists -Detail $EnvFile
    if ($envExists) {
        $values = Get-ChannelEnvFile -Path $EnvFile
        if ($values.Contains('CHANNEL_HOST_NAME')) { $hostName = ([string]$values['CHANNEL_HOST_NAME']).Trim() }
        Write-ChannelCheck -Name 'host name' -Ok ([bool]$hostName) -Detail $hostName

        $tokenFile = ''
        if ($values.Contains('CHANNEL_DISCORD_TOKEN_FILE')) {
            $tokenFile = ([string]$values['CHANNEL_DISCORD_TOKEN_FILE']).Trim()
        }
        if ($tokenFile) {
            Write-ChannelCheck -Name 'bot token file' -Ok (Test-Path -LiteralPath $tokenFile) -Detail $tokenFile
        } else {
            Write-ChannelCheck -Name 'bot token file' -Ok $false -Detail 'broker.env names none'
        }

        if ($values.Contains('CHANNEL_NODE_EXE') -and -not [string]::IsNullOrWhiteSpace($values['CHANNEL_NODE_EXE'])) {
            $nodeExe = ([string]$values['CHANNEL_NODE_EXE']).Trim()
        }
    }

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-ChannelCheck -Name 'scheduled task' -Ok ([bool]$task) -Detail $TaskName

    $node = Get-Command $nodeExe -ErrorAction SilentlyContinue
    Write-ChannelCheck -Name 'node' -Ok ([bool]$node) -Detail $(if ($node) { $node.Source } else { $nodeExe })

    $head = Invoke-ChannelGit -RepoRoot $RepoRoot -Arguments @('rev-parse', 'HEAD')
    $commit = if ($head.ExitCode -eq 0) { $head.Output } else { 'unknown' }
    Write-ChannelCheck -Name 'HEAD commit' -Ok ($head.ExitCode -eq 0) -Detail $commit

    $behind = 'unknown'
    $fetch = Invoke-ChannelGit -RepoRoot $RepoRoot -Arguments @('fetch', '--quiet')
    if ($fetch.ExitCode -eq 0) {
        $count = Invoke-ChannelGit -RepoRoot $RepoRoot -Arguments @('rev-list', '--count', 'HEAD..@{upstream}')
        if ($count.ExitCode -eq 0) { $behind = $count.Output }
    }
    if ($behind -eq '0') {
        Write-ChannelCheck -Name 'up to date with origin' -Ok $true
    } elseif ($behind -eq 'unknown') {
        Write-ChannelCheck -Name 'up to date with origin' -Ok $false -Detail 'could not compare against the upstream branch'
    } else {
        Write-ChannelCheck -Name 'up to date with origin' -Ok $false -Detail "origin is $behind commit(s) ahead; re-run with -Pull"
    }

    return [pscustomobject]@{ HostName = $hostName; HeadCommit = $commit; CommitsBehind = $behind }
}

<#
.SYNOPSIS
Polls the broker's own /sessions endpoint until it answers 200 or the budget runs out.

.DESCRIPTION
The real readiness signal, the same one the installer waits on: a started task says only that
powershell launched, and the broker's own port bind is what fails when an orphan still holds it. A
timeout is reported rather than thrown, because the summary that follows is the point of the run.
#>
function Wait-ChannelBrokerAnswer {
    param(
        [Parameter(Mandatory)][int]$Port,
        [int]$TimeoutSeconds = 30
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ($true) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/sessions"
            if ($response.StatusCode -eq 200) {
                # A 200 is the readiness signal on its own. The count is read afterwards and only
                # reported, so a body this cannot parse costs a number in the summary rather than
                # the whole readiness verdict. Wrapped in @() because Windows PowerShell 5.1
                # collapses a one-element array to a scalar, which has no Count and would report a
                # single live session as no sessions.
                $count = $null
                try { $count = @((ConvertFrom-Json $response.Content).sessions).Count } catch { }
                return [pscustomobject]@{ Ready = $true; SessionCount = $count }
            }
        } catch {
            # Not up yet, or not up at all. The deadline below decides which.
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            return [pscustomobject]@{ Ready = $false; SessionCount = $null }
        }
        Start-Sleep -Seconds 1
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $ErrorActionPreference = 'Stop'

    if (-not $EnvFile) { $EnvFile = Join-Path (Get-ChannelStateRoot) 'broker.env' }
    $brokerEntry = Join-Path $RepoRoot 'broker\index.ts'
    # The entry path is the primary proof, so a $RepoRoot that does not hold one is a repair that
    # matches no process at all and reports a clean run over an orphan still serving stale code.
    if (-not (Test-Path -LiteralPath $brokerEntry)) {
        throw "Repair-Broker: broker entry point not found at '$brokerEntry'. Is `$RepoRoot correct?"
    }
    $port = Get-ChannelBrokerPort -EnvFile $EnvFile

    Write-Host "Repairing the broker in '$RepoRoot' on port $port."

    if ($Pull) {
        Write-Host ''
        Write-Host 'Pull:'
        Update-ChannelCheckout -RepoRoot $RepoRoot
    }

    Write-Host ''
    Write-Host 'Stop:'
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null
    Write-Host "  requested a stop of scheduled task '$TaskName'."
    $killed = @(Stop-ChannelBrokerProcess -BrokerEntryPath $brokerEntry -Port $port)

    Write-Host ''
    Write-Host 'Checks:'
    $health = Get-ChannelHostHealth -RepoRoot $RepoRoot -EnvFile $EnvFile -TaskName $TaskName

    Write-Host ''
    Write-Host 'Start:'
    $readiness = [pscustomobject]@{ Ready = $false; SessionCount = $null }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        # A disabled task, or one registered under another account, refuses the start. Reported as a
        # line rather than raised: the summary below is what the operator ran this for.
        try {
            Start-ScheduledTask -TaskName $TaskName
            Write-Host "  started scheduled task '$TaskName'; waiting up to $TimeoutSeconds seconds for the broker to answer."
            $readiness = Wait-ChannelBrokerAnswer -Port $port -TimeoutSeconds $TimeoutSeconds
        } catch {
            Write-Host "  scheduled task '$TaskName' would not start: $($_.Exception.Message)"
        }
    } else {
        Write-Host "  scheduled task '$TaskName' is not registered; nothing to start. Run install\Install-All.ps1."
    }

    $taskState = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State
    if (-not $taskState) { $taskState = 'not registered' }
    $killedText = if ($killed.Count -gt 0) { $killed -join ', ' } else { 'none' }
    $readyText = if ($readiness.Ready) {
        "answering on http://127.0.0.1:$port/sessions"
    } else {
        "no answer on http://127.0.0.1:$port/sessions within $TimeoutSeconds seconds"
    }
    $sessionText = if ($null -ne $readiness.SessionCount) { [string]$readiness.SessionCount } else { 'unknown' }

    Write-Host ''
    Write-Host 'Summary:'
    Write-Host "  host       : $(if ($health.HostName) { $health.HostName } else { 'unknown' })"
    Write-Host "  commit     : $($health.HeadCommit)"
    Write-Host "  task state : $taskState"
    Write-Host "  killed     : $killedText"
    Write-Host "  readiness  : $readyText"
    Write-Host "  sessions   : $sessionText"

    if (-not $readiness.Ready) {
        Write-Host ''
        $logPath = Join-Path (Split-Path -Parent $EnvFile) 'broker.log'
        Write-Host "The broker is not answering. Read '$logPath' for why it will not start."
    }
}
