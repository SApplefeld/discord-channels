# The elevated half of a host install, run once by Install-All.ps1 through a UAC prompt. Everything
# here needs Administrators; everything that must NOT run elevated (broker.env, the token file, the
# ACLs, the settings merge) lives in Install-Host.ps1, because a file created by an elevated shell
# is owned by Administrators and the broker's credential guard reads that owner shift as a planted
# token file.
#
#   .\install\Install-Elevated.ps1 -User NEO-CLAUDE\NEO -EnvFile <state root>\broker.env
#
# Idempotent: the scheduled task is updated in place, the managed-settings file is merged rather
# than clobbered, and the profile block replaces only its own marked region.
#
# -User and -EnvFile are passed explicitly by the orchestrator rather than defaulted here, because
# this script runs as whoever answered the UAC prompt: the ACLs from Install-Host.ps1 grant the
# account that ran it, and a task registered under a different principal starts a broker that cannot
# read its own token file.
# Not marked Mandatory, because a test dot-sources this file to reach the functions and a Mandatory
# script parameter would hang the probe on a prompt; the runner below validates them instead.
param(
    [string]$User,
    [string]$EnvFile,
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

. (Join-Path $PSScriptRoot 'Install-Functions.ps1')

<#
.SYNOPSIS
Merges channelsEnabled and this project's allowlist entry into the machine's managed-settings file.

.DESCRIPTION
Merges rather than overwrites: allowedChannelPlugins replaces Anthropic's own allowlist entirely
once set, so any other plugin the operator has already allowlisted must survive this install, and
any unrelated managed key even more so. The entry itself is matched structurally, so a re-run adds
nothing.

-Path exists so a test can drive this against a temp file instead of Program Files.
#>
function Install-ChannelManagedSettings {
    param(
        [string]$Path = 'C:\Program Files\ClaudeCode\managed-settings.json'
    )

    $settings = [ordered]@{}
    if (Test-Path -LiteralPath $Path) {
        try {
            $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop
        } catch {
            throw "Install-ChannelManagedSettings: '$Path' exists but is not parseable JSON " +
                "($($_.Exception.Message)). Fix or remove it and re-run; merging over a file " +
                "that cannot be read would clobber whatever it was meant to say."
        }
        $settings = ConvertTo-OrderedHashtable $parsed
        if ($null -eq $settings) { $settings = [ordered]@{} }
    }

    $settings['channelsEnabled'] = $true
    $plugins = @()
    if ($settings.Contains('allowedChannelPlugins')) { $plugins = @($settings['allowedChannelPlugins']) }
    $present = $plugins | Where-Object {
        $_.marketplace -eq 'sapplefeld-channels' -and $_.plugin -eq 'relay'
    }
    if (-not $present) {
        $plugins += [ordered]@{ marketplace = 'sapplefeld-channels'; plugin = 'relay' }
    }
    $settings['allowedChannelPlugins'] = @($plugins)

    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    # Depth well past any plausible policy nesting: ConvertTo-Json silently stringifies anything
    # deeper than -Depth, which would clobber a foreign managed key this merge promises to preserve.
    Set-Utf8NoBomFile -Path $Path -Content (ConvertTo-Json $settings -Depth 32)
}

<#
.SYNOPSIS
Installs the wrapper dot-source and the cchat alias into the machine-wide PowerShell profile.

.DESCRIPTION
The block lives between region markers so a re-run, or an install from a moved checkout, replaces
exactly its own lines and never touches operator content around them. Machine-wide
($PSHOME\profile.ps1, AllUsersAllHosts) rather than per-user, so every account on the host can
launch a watched session; the wrapper's own guards still refuse a launch for an account whose
settings were never installed.

-ProfilePath exists so a test can drive this against a temp file instead of System32.
#>
function Install-ChannelProfileBlock {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$ProfilePath = (Join-Path $PSHOME 'profile.ps1')
    )

    $wrapper = Join-Path $RepoRoot 'wrapper\Enter-ClaudeSession.ps1'
    $begin = '# region sapplefeld-channels'
    $end = '# endregion sapplefeld-channels'
    $block = @(
        $begin
        "if (Test-Path -LiteralPath '$wrapper') {"
        "    . '$wrapper'"
        '    Set-Alias -Name cchat -Value Enter-ClaudeSession'
        '}'
        $end
    ) -join "`r`n"

    $existing = ''
    if (Test-Path -LiteralPath $ProfilePath) {
        $existing = Get-Content -LiteralPath $ProfilePath -Raw
    }

    # -cmatch, because [regex]::Replace below is case-sensitive: a case-insensitive guard would
    # accept a hand-edited marker the replace then fails to find, leaving the stale block in place
    # silently.
    $pattern = '(?s)' + [regex]::Escape($begin) + '.*?' + [regex]::Escape($end)
    if ($existing -cmatch $pattern) {
        $content = [regex]::Replace($existing, $pattern, $block.Replace('$', '$$'))
    } elseif ([string]::IsNullOrWhiteSpace($existing)) {
        $content = $block + "`r`n"
    } else {
        $content = $existing.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
    }
    Set-Utf8NoBomFile -Path $ProfilePath -Content $content
}

<#
.SYNOPSIS
Bounces the broker so it runs the code and config this install just wrote.

.DESCRIPTION
Nothing else restarts a running broker: the scheduled task only fires at logon, so without this a
re-install leaves the old broker serving from memory indefinitely. Stops the task, then clears a
broker that is still holding the port anyway (one started by hand rather than by the task; only a
node.exe listener is killed, anything else on the port fails the install for a human to look at),
then starts the task. Readiness is the caller's job: this script runs behind a UAC prompt where
nothing it prints is seen, so Install-All.ps1 waits on the broker's own HTTP endpoint from the
unelevated side.

The seams exist so a test can drive the orchestration without the real Task Scheduler or a real
process kill.
#>
function Restart-ChannelBroker {
    param(
        [string]$TaskName = 'SapplefeldChannelsBroker',
        [int]$Port = 8787,
        [int]$GraceSeconds = 10,
        [scriptblock]$StopTask = { param($Name) Stop-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue },
        [scriptblock]$StartTask = { param($Name) Start-ScheduledTask -TaskName $Name },
        [scriptblock]$GetListener = {
            param($ListenPort)
            $connection = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if (-not $connection) { return $null }
            $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
            if (-not $process) { return $null }
            [pscustomobject]@{ ProcessId = $process.Id; Name = $process.Name }
        },
        [scriptblock]$StopListener = { param($ProcessId) Stop-Process -Id $ProcessId -Force }
    )

    & $StopTask $TaskName

    # The task's broker exits quickly on stop; a listener still there after that grace is one the
    # task does not own.
    $deadline = [DateTime]::UtcNow.AddSeconds($GraceSeconds)
    $listener = & $GetListener $Port
    while ($listener -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $listener = & $GetListener $Port
    }
    if ($listener) {
        if ($listener.Name -ne 'node') {
            throw "Restart-ChannelBroker: port $Port is held by '$($listener.Name)' (PID " +
                "$($listener.ProcessId)), which is not a broker. Refusing to kill it; free the " +
                "port and re-run."
        }
        & $StopListener $listener.ProcessId
    }

    & $StartTask $TaskName
}

<#
.SYNOPSIS
Throws unless this process is elevated. The seam exists so a test can drive both directions.
#>
function Assert-ChannelInstallElevated {
    param([bool]$IsElevated = (Test-IsElevated))
    if (-not $IsElevated) {
        throw "Install-Elevated.ps1: this must run from an elevated PowerShell session. " +
            "Install-All.ps1 launches it through a UAC prompt; run that instead of this directly."
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    # The parent's only signal across the elevation boundary is this process's exit code, and its
    # console closes the moment it exits. A non-terminating cmdlet error (a failed
    # Register-ScheduledTask, say) would otherwise print into that vanishing window and exit 0,
    # which the parent reads as success over a host with no broker task.
    $ErrorActionPreference = 'Stop'
    trap { Write-Error $_; exit 1 }

    if (-not $User -or -not $EnvFile) {
        throw "Install-Elevated.ps1: -User and -EnvFile are required. Install-All.ps1 passes both; " +
            "run that instead of this directly, or pass the account that ran Install-Host.ps1 and " +
            "its state root's broker.env path."
    }
    Assert-ChannelInstallElevated
    & (Join-Path $PSScriptRoot 'Register-BrokerTask.ps1') -User $User -EnvFile $EnvFile
    Install-ChannelManagedSettings
    Install-ChannelProfileBlock -RepoRoot $RepoRoot
    # $PSHOME above is this elevated child's own Windows PowerShell; a host that also runs
    # PowerShell 7 reads a different all-users profile, so cchat lands there too when present.
    $pwshProfileDir = Join-Path $env:ProgramFiles 'PowerShell\7'
    if (Test-Path -LiteralPath (Join-Path $pwshProfileDir 'pwsh.exe')) {
        Install-ChannelProfileBlock -RepoRoot $RepoRoot -ProfilePath (Join-Path $pwshProfileDir 'profile.ps1')
    }
    Restart-ChannelBroker
    Write-Host "Managed settings written, cchat launcher installed, broker restarted under the task."
}
