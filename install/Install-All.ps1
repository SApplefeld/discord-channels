# One-command host install. Runs everything scriptable from a single unelevated invocation:
#
#   install\Install-All.ps1 -HostName NEO -ChannelId <channel id> -AllowedUserId <your user id>
#
# It runs Install-Host.ps1 in this process (config, token, hooks, ACLs, npm ci), registers the
# marketplace and installs the relay plugin through the claude CLI, then launches
# Install-Elevated.ps1 exactly once through a UAC prompt for the three steps that need
# Administrators: the scheduled task, the machine's managed-settings file, and the machine-profile
# block that makes `cchat <name>` work from any shell.
#
# Unelevated is a requirement here exactly as it is for Install-Host.ps1: a file created by an
# elevated shell is owned by Administrators, and the broker's credential guard reads that owner
# shift on its token file as a planted credential. The elevation boundary is one child process, not
# this script.
#
# What stays manual, because it lives in Discord's web console: creating the application and bot,
# enabling Message Content Intent, inviting the bot, and creating the private channel. Step 1 of
# docs/install.md covers those, and this script's parameters are their outputs.
# Not marked Mandatory, because a test dot-sources this file to reach the functions and a Mandatory
# script parameter would hang the probe on a prompt; the runner below validates them instead, and
# Install-Host.ps1's own Mandatory parameters re-validate the values that reach it.
param(
    [string]$HostName,

    [ValidatePattern('^(\d{17,20})?$')]
    [string]$ChannelId,

    [ValidatePattern('^(\d{17,20})?$')]
    [string]$AllowedUserId,

    [System.Security.SecureString]$BotToken,

    [string]$BotTokenFile,

    [Nullable[int]]$Port,

    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot)
)

. (Join-Path $PSScriptRoot 'Install-Functions.ps1')

<#
.SYNOPSIS
Registers this checkout as a marketplace and installs the relay plugin, tolerating a re-run.

.DESCRIPTION
Both claude CLI calls are idempotent in effect but not in exit code: adding a marketplace that is
already configured, or installing a plugin that is already installed, can exit non-zero with an
already-exists message. A re-run of this installer must not fail on that, so each call is verified
by asking the CLI for the resulting state rather than by trusting the exit code of the mutation.

-ClaudeCommand exists so a test can shadow the CLI.
#>
function Install-ChannelPlugin {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$ClaudeCommand = 'claude'
    )

    # Local to this function: under an operator profile that sets $ErrorActionPreference = 'Stop',
    # PS 5.1 turns redirected native stderr into a terminating NativeCommandError, and the
    # already-exists message a re-run produces would kill the install the comment above promises to
    # tolerate.
    $ErrorActionPreference = 'Continue'
    & $ClaudeCommand plugin marketplace add $RepoRoot 2>&1 | Out-Null
    & $ClaudeCommand plugin install 'relay@sapplefeld-channels' 2>&1 | Out-Null

    $installed = & $ClaudeCommand plugin list 2>&1 | Out-String
    if ($installed -notmatch 'relay@sapplefeld-channels') {
        throw "Install-All: the relay plugin did not install. Run " +
            "'claude plugin marketplace add $RepoRoot' and " +
            "'claude plugin install relay@sapplefeld-channels' by hand to see the error."
    }
}

<#
.SYNOPSIS
Runs Install-Elevated.ps1 once through a UAC prompt and fails loudly if it fails.

.DESCRIPTION
The child's exit code is the only signal that crosses the elevation boundary: -Verb RunAs cannot
redirect the child's output, so the child runs with its own console window and this waits on it.
-User and -EnvFile are pinned from this unelevated process, which is the account that owns the
ACLs Install-Host.ps1 just laid down; the elevated session's own identity may differ and must not
leak into the task principal.

-Launcher exists so a test can capture the launch instead of raising a real UAC prompt.
#>
function Invoke-ChannelElevatedInstall {
    param(
        [Parameter(Mandatory)][string]$User,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$RepoRoot,
        [scriptblock]$Launcher
    )

    $scriptPath = Join-Path $PSScriptRoot 'Install-Elevated.ps1'
    # A value ending in a backslash would escape its own closing quote on the child's native
    # command line and mangle every argument after it; doubling trailing backslashes is the
    # native-quoting rule that keeps them literal.
    $quote = { param($Value) '"' + ($Value -replace '(\\+)$', '$1$1') + '"' }
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', (& $quote $scriptPath),
        '-User', (& $quote $User),
        '-EnvFile', (& $quote $EnvFile),
        '-RepoRoot', (& $quote $RepoRoot)
    )
    if (-not $Launcher) {
        $Launcher = {
            param($ArgumentList)
            try {
                $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $ArgumentList `
                    -Verb RunAs -Wait -PassThru -ErrorAction Stop
            } catch {
                # Declining the UAC prompt lands here; the distinct message keeps it from reading
                # as a failure of the elevated script, which never ran.
                throw "Install-All: the elevation prompt was declined or the elevated launch " +
                    "failed ($($_.Exception.Message)). Approve the prompt on a re-run, or run " +
                    "install\Install-Elevated.ps1 from an elevated session yourself."
            }
            return $process.ExitCode
        }
    }
    $exitCode = & $Launcher $arguments
    if ($exitCode -ne 0) {
        throw "Install-All: the elevated install step exited $exitCode. Re-run it alone from an " +
            "elevated session: install\Install-Elevated.ps1 -User '$User' -EnvFile '$EnvFile'."
    }
}

<#
.SYNOPSIS
Waits until the restarted broker answers on its own HTTP endpoint, or throws.

.DESCRIPTION
The elevated child bounces the broker but runs behind a UAC prompt where nothing it prints is
seen, so the readiness check lives here on the unelevated side, against the real signal: the
/sessions endpoint answering. A broker that never comes up fails the install with the log path to
read, rather than letting the completion message vouch for a dead service.

-Probe exists so a test can drive both outcomes without a real broker.
#>
function Wait-ChannelBrokerReady {
    param(
        [int]$Port = 8787,
        [int]$TimeoutSeconds = 30,
        [scriptblock]$Probe
    )

    if (-not $Probe) {
        $Probe = {
            param($ProbePort)
            try {
                $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 `
                    -Uri "http://127.0.0.1:$ProbePort/sessions"
                return $response.StatusCode -eq 200
            } catch { return $false }
        }
    }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Probe $Port) { return }
        Start-Sleep -Seconds 1
    }
    throw "Install-All: the broker did not answer on http://127.0.0.1:$Port/sessions within " +
        "$TimeoutSeconds seconds of the restart. Read the log in the state root " +
        "(%LOCALAPPDATA%\sapplefeld-channels\broker.log) for why it will not start."
}

<#
.SYNOPSIS
Throws when this process is elevated. The seam exists so a test can drive both directions.
#>
function Assert-ChannelInstallUnelevated {
    param([bool]$IsElevated = (Test-IsElevated))
    if ($IsElevated) {
        throw "Install-All: run this from a plain, non-elevated PowerShell session. Files created " +
            "elevated are owned by Administrators, which the broker's credential guard reads as a " +
            "planted token file. The steps that need elevation run in their own child through a " +
            "UAC prompt."
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    # Mirrors Install-Elevated.ps1's runner: a non-terminating cmdlet error anywhere in this
    # sequence must stop the install rather than scroll past and let the completion message print
    # over a half-provisioned host.
    $ErrorActionPreference = 'Stop'

    if (-not $HostName -or -not $ChannelId -or -not $AllowedUserId) {
        throw "Install-All: -HostName, -ChannelId, and -AllowedUserId are all required. The two " +
            "IDs come from Discord with Developer Mode on; docs/install.md step 1 walks through it."
    }
    Assert-ChannelInstallUnelevated

    $hostArgs = @{
        HostName      = $HostName
        ChannelId     = $ChannelId
        AllowedUserId = $AllowedUserId
        RepoRoot      = $RepoRoot
    }
    if ($BotToken) { $hostArgs.BotToken = $BotToken }
    if ($BotTokenFile) { $hostArgs.BotTokenFile = $BotTokenFile }
    # A verify-run on an already-installed host reuses the hardened token from the last install
    # rather than re-prompting: Install-Host.ps1's prompt is unconditional, and an operator pressing
    # Enter through it would overwrite a working token with an empty one. Rotating the token is
    # still just passing -BotToken or -BotTokenFile explicitly.
    if (-not $BotToken -and -not $BotTokenFile) {
        $existingToken = Join-Path (Get-ChannelStateRoot) 'discord-token.txt'
        if (Test-Path -LiteralPath $existingToken) { $hostArgs.BotTokenFile = $existingToken }
    }
    if ($null -ne $Port) { $hostArgs.Port = $Port }
    & (Join-Path $PSScriptRoot 'Install-Host.ps1') @hostArgs

    Install-ChannelPlugin -RepoRoot $RepoRoot

    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $envFile = Join-Path (Get-ChannelStateRoot) 'broker.env'
    Invoke-ChannelElevatedInstall -User $user -EnvFile $envFile -RepoRoot $RepoRoot

    $brokerPort = if ($null -ne $Port) { $Port } else { 8787 }
    Wait-ChannelBrokerReady -Port $brokerPort
    Write-Host "Broker restarted and answering on http://127.0.0.1:$brokerPort/sessions."

    Write-Host ""
    Write-Host "Install complete. Open a NEW PowerShell window (the profile block loads at shell"
    Write-Host "start) and launch a session from any directory with:"
    Write-Host ""
    Write-Host "    cchat <session-name>"
    Write-Host ""
    Write-Host "Then verify the channel end to end:"
    Write-Host "  1. No full-screen channel warning at launch."
    Write-Host "  2. A message typed in the session's Discord thread reaches the session, and a"
    Write-Host "     reply from the session lands back in the thread."
    Write-Host "  3. curl.exe -s http://127.0.0.1:8787/sessions shows the session, and after the"
    Write-Host "     reply, its lastTool."
    Write-Host ""
    Write-Host "If the thread never appears, the Discord side is the usual cause; re-check step 1"
    Write-Host "of docs/install.md: Message Content Intent enabled on the bot, the bot invited with"
    Write-Host "thread permissions, and the channel private to you and the bot. If this host's"
    Write-Host "entry in wrapper\Enter-ClaudeSession.ps1's channel-flag table still carries the"
    Write-Host "development flag, run docs/install.md's per-host checklist before moving it to"
    Write-Host "--channels."
}
