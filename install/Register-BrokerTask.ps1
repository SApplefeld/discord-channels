# Registers the broker as a Windows scheduled task that starts at logon and restarts on failure.
#
#   .\install\Register-BrokerTask.ps1
#
# Requires an elevated PowerShell session. Registering a scheduled task under the Task Scheduler
# root without elevation fails with an access-denied error that does not say why; this checks first
# and fails with a message that does.
#
# Idempotent: running it again updates the existing task's action, trigger, settings, and principal
# in place rather than failing on a duplicate name or leaving two tasks behind.
#
# -User pins which account the task runs as and which account's logon triggers it. Defaulted to
# whoever runs this script, but named explicitly rather than left to Task Scheduler's own default,
# for two reasons. First, the ACL model Install-Host.ps1 lays down grants the file owner, this
# process's own account, and the operator is documented to run the installer unelevated while this
# script needs elevation; if the two ever ran as different accounts the broker would start as a
# principal that cannot read its own token file. Second, -AtLogOn with no -User fires on any
# account's logon at all, so a second interactive logon on a shared machine would start a second
# broker that cannot bind the same port. Recorded into broker.env by Install-Host.ps1 so a mismatch
# between the account that installed and the account the task runs as is something later code, or
# an operator reading the file, can actually detect.

# -EnvFile pins the absolute path to broker.env into the task's own action, for the same reason
# Install-Host.ps1 pins CHANNEL_NODE_EXE rather than resolving `node` from PATH: the task runs
# outside any interactive logon, where %LOCALAPPDATA% does not resolve to the profile that
# Install-Host.ps1 wrote the file into. Pinning it is what removes the broker's last dependency on
# a loaded user profile, and everything it reads afterward (the node binary, the state file, the
# log, the bot token) is already an absolute path inside broker.env. Install-Host.ps1 prints this
# script's full invocation with the path already filled in, because it runs unelevated as the
# account that owns the profile and this script does not.
#
# Defaulted to this session's own state root so a hand-run without the parameter still works. That
# default is wrong when the elevated session belongs to a different account than the one that ran
# Install-Host.ps1, which is exactly the case the printed command exists to avoid.
param(
    [string]$TaskName = 'SapplefeldChannelsBroker',
    [string]$ScriptPath = (Join-Path $PSScriptRoot 'Start-Broker.ps1'),
    [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    [string]$EnvFile
)

. (Join-Path $PSScriptRoot 'Install-Functions.ps1')

<#
.SYNOPSIS
Builds the scheduled task definition and registers or updates it under the given user.

.DESCRIPTION
$IsElevated and $WhatIf exist so a test can exercise the elevation guard and inspect the built
definition without ever calling a ScheduledTasks cmdlet for real, all of which touch the real Task
Scheduler and none of which a test may do.

Uses Set-ScheduledTask to update an existing task of the same name in place rather than unregistering
and re-registering: unregister-then-register leaves the host with no task at all if the process is
interrupted between the two calls, which is a worse failure than the duplicate-task problem removing
first was meant to solve.
#>
function Register-BrokerScheduledTask {
    param(
        [Parameter(Mandatory)][string]$TaskName,
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][string]$User,
        [string]$EnvFile,
        [bool]$IsElevated = (Test-IsElevated),
        [switch]$WhatIf
    )

    if (-not $IsElevated) {
        throw "Register-BrokerScheduledTask: this must run from an elevated PowerShell session " +
            "(right-click PowerShell, 'Run as Administrator'). Registering a scheduled task under " +
            "the Task Scheduler root fails without it, with an access-denied error that does not " +
            "say why."
    }

    # The broker runs in session 0, where there is no desktop, so no console window reaches it.
    # -WindowStyle Hidden stays anyway: it is what keeps a hand-run of this same command off the
    # desktop, and it costs nothing under the task.
    $arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""
    if ($EnvFile) { $arguments += " -EnvFile `"$EnvFile`"" }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    # Scoped to $User rather than every logon: an unscoped AtLogOn trigger fires for any account
    # that logs onto the machine, and a second broker started under a second account's logon cannot
    # bind the port the first one already holds.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    # S4U runs the broker as $User without a stored password and without an interactive desktop, so
    # it starts in session 0 and no console window is ever drawn on the operator's screen. It runs
    # as the same account either way, which is what the ACL model requires: Install-Host.ps1 grants
    # the file owner and this process's own account, so a task running as anyone else would start a
    # broker that cannot read its own token file. RunLevel stays Limited for the same reason the
    # operator is told to run Install-Host.ps1 unelevated: a broker running elevated writes files
    # owned by Administrators, and the credential guard reads that owner shift as a planted file.
    #
    # S4U carries no user profile, which is why -EnvFile is pinned into the action above. Without
    # that path the broker would look for broker.env under an unloaded profile, fail to find it, and
    # start with every knob at its default, which is a broker with no Discord surfaces at all and no
    # error to say so.
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited
    # A twelve-hour session's broker restarting is the whole point of this section; a task that
    # gives up after a handful of failures defeats it. RestartCount's ceiling is 999, the highest
    # the ScheduledTasks module accepts.
    $settings = New-ScheduledTaskSettingsSet `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries

    if ($WhatIf) {
        return [pscustomobject]@{
            TaskName  = $TaskName
            Action    = $action
            Trigger   = $trigger
            Principal = $principal
            Settings  = $settings
        }
    }

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings | Out-Null
    } else {
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
            -Principal $principal -Settings $settings | Out-Null
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $EnvFile) { $EnvFile = Join-Path (Get-ChannelStateRoot) 'broker.env' }
    Register-BrokerScheduledTask -TaskName $TaskName -ScriptPath $ScriptPath -User $User -EnvFile $EnvFile
    Write-Host "Registered scheduled task '$TaskName' running '$ScriptPath' at logon for '$User', reading '$EnvFile'."
}
