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

param(
    [string]$TaskName = 'SapplefeldChannelsBroker',
    [string]$ScriptPath = (Join-Path $PSScriptRoot 'Start-Broker.ps1'),
    [string]$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name
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
        [bool]$IsElevated = (Test-IsElevated),
        [switch]$WhatIf
    )

    if (-not $IsElevated) {
        throw "Register-BrokerScheduledTask: this must run from an elevated PowerShell session " +
            "(right-click PowerShell, 'Run as Administrator'). Registering a scheduled task under " +
            "the Task Scheduler root fails without it, with an access-denied error that does not " +
            "say why."
    }

    # -WindowStyle Hidden keeps the broker's console off the desktop. The window still exists (a
    # brief flash at logon is normal); an Interactive-logon task cannot be fully windowless, and
    # the logon type below explains why Interactive is required.
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ScriptPath`""
    # Scoped to $User rather than every logon: an unscoped AtLogOn trigger fires for any account
    # that logs onto the machine, and a second broker started under a second account's logon cannot
    # bind the port the first one already holds.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
    # Interactive (not S4U or a stored password), because the broker needs the invoking user's own
    # profile to resolve %LOCALAPPDATA% the same way Install-Host.ps1 did when it wrote broker.env
    # there.
    $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
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
    Register-BrokerScheduledTask -TaskName $TaskName -ScriptPath $ScriptPath -User $User
    Write-Host "Registered scheduled task '$TaskName' running '$ScriptPath' at logon for '$User'."
}
