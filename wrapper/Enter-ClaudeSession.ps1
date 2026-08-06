# Launch wrapper. Dot-source this file to load Enter-ClaudeSession into the current shell, then
# call it to start a session wired into this project's hooks:
#
#   . .\wrapper\Enter-ClaudeSession.ps1
#   Enter-ClaudeSession -Name 'neo-warden'
#
# It sets CHANNEL_SESSION (the human name the hooks and broker surfaces use) and a fresh
# CHANNEL_PROCESS_TOKEN (the GUID that joins hook posts to one launch, minted new every call so two
# sessions never share an identity), then starts `claude` with the channel flag this host needs.
# Both are restored to their previous values when `claude` exits, because this file is dot-sourced
# and would otherwise write them into the operator's own shell: a later bare `claude` in that shell
# would inherit a live token, and the broker would read the second session as a supersession of the
# first, mark the still-running session ended, and credit its tool calls to the wrong record.
#
# -ClaudeArgs passes extra arguments straight through to `claude` after the channel flag: a channel
# plugin spec once one exists (relay is Section 5, its NEO/ASR plugin packaging is Section 7), a
# -p prompt, or anything else. This script does not know or need to know what channel is loaded.

# Which flag opens channels on each host, per the spec's Approach: NEO and ASR are organization-
# owned and allowlist the relay plugin through managed settings, so plain --channels opens it with
# no development-flag warning dialog. SCOTT is a personal Max account with no organization to
# allowlist through, so it keeps --dangerously-load-development-channels and the one confirmation
# keypress that flag opens at launch. Add a host here rather than branching in Enter-ClaudeSession.
$script:ChannelFlagByHost = @{
    'NEO'   = '--channels'
    'ASR'   = '--channels'
    'SCOTT' = '--dangerously-load-development-channels'
}

# Absolute path to the SessionStart hook script, resolved from this file's own location so it is
# correct wherever the repository is checked out.
$script:SessionStartHook = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\session-start.ps1'
$script:SettingsFragment = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\settings-fragment.json'

<#
.SYNOPSIS
Resolves which of the configured hosts this machine is.

.DESCRIPTION
CHANNEL_HOST_NAME, when set, takes priority. It goes through the same matching as COMPUTERNAME
rather than being used as a literal table key: broker/config.ts reads the same variable as a
free-form display label, so an operator who sets it to 'SCOTT-CLAUDE' or 'NEO-2' for a better
registry label must not thereby break the launcher.

Matching requires either an exact name or the prefix followed by a delimiter. A bare StartsWith
would classify SCOTTSDALE-KIOSK as SCOTT and hand it the development-channel flag, and the
unknown-host throw below exists precisely to stop a machine from being launched under another
host's channel policy.
#>
function Resolve-ChannelHost {
    param([string]$ComputerName = $env:COMPUTERNAME)

    $source = 'COMPUTERNAME'
    $candidateName = $ComputerName
    if (-not [string]::IsNullOrWhiteSpace($env:CHANNEL_HOST_NAME)) {
        $source = 'CHANNEL_HOST_NAME'
        $candidateName = $env:CHANNEL_HOST_NAME
    }

    if ([string]::IsNullOrWhiteSpace($candidateName)) { $candidateName = '' }
    $upper = $candidateName.Trim().ToUpperInvariant()

    $known = $script:ChannelFlagByHost.Keys | Sort-Object -Property Length -Descending
    foreach ($candidate in $known) {
        if ($upper -eq $candidate -or $upper -like "${candidate}-*") {
            return [pscustomobject]@{ Host = $candidate; Source = $source; Raw = $upper }
        }
    }
    return [pscustomobject]@{ Host = $upper; Source = $source; Raw = $upper }
}

function Enter-ClaudeSession {
    <#
    .SYNOPSIS
    Launches a Claude Code session with a fresh process token and this host's channel flag.

    .PARAMETER Name
    Human session name. Set as CHANNEL_SESSION for the SessionStart hook to report and the Discord
    surfaces to render; may repeat across sessions without collision, since thread identity is the
    session ID, not this name.

    Restricted to printable ASCII. The name travels as an HTTP header, and Invoke-RestMethod
    rejects a non-ASCII header value client-side before opening the socket, which would take the
    whole announcement down inside the hook's catch and leave the session permanently invisible
    with no signal anywhere. Failing loudly here, at the keyboard, is the alternative.

    .PARAMETER ClaudeArgs
    Extra arguments passed through to `claude` after the channel flag.
    #>
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^[\x20-\x7E]+$')]
        [ValidateLength(1, 64)]
        [string]$Name,

        [string[]]$ClaudeArgs = @()
    )

    $resolved = Resolve-ChannelHost
    $channelFlag = $script:ChannelFlagByHost[$resolved.Host]
    if (-not $channelFlag) {
        throw "Enter-ClaudeSession: no channel flag configured for host '$($resolved.Host)' " +
            "(resolved from $($resolved.Source) '$($resolved.Raw)'). Add it to " +
            "`$script:ChannelFlagByHost in wrapper/Enter-ClaudeSession.ps1, or set " +
            "CHANNEL_HOST_NAME to one of: $($script:ChannelFlagByHost.Keys -join ', ')."
    }

    if (-not (Test-Path -LiteralPath $script:SessionStartHook)) {
        throw "Enter-ClaudeSession: the SessionStart hook script is missing at " +
            "'$script:SessionStartHook'. Without it the session starts but never announces itself, " +
            "so it would run unwatched with no signal that anything is wrong."
    }

    # The installed settings fragment names the hook script by absolute path, which is correct for
    # exactly one checkout. A repository cloned or moved somewhere else keeps launching happily
    # while every session silently fails to announce, so the disagreement is made loud here.
    Assert-HookPathMatchesFragment

    $previous = @{
        CHANNEL_SESSION       = $env:CHANNEL_SESSION
        CHANNEL_PROCESS_TOKEN = $env:CHANNEL_PROCESS_TOKEN
    }
    try {
        $env:CHANNEL_SESSION = $Name
        $env:CHANNEL_PROCESS_TOKEN = [guid]::NewGuid().ToString()

        & claude $channelFlag @ClaudeArgs
    } finally {
        # Restored whether claude exited, threw, or was interrupted. A token left behind in a
        # dot-sourced shell is inherited by the next `claude` started from it, and the broker reads
        # a second session on a live token as a supersession: the running session is marked ended
        # and its events are credited to the newcomer.
        $env:CHANNEL_SESSION = $previous.CHANNEL_SESSION
        $env:CHANNEL_PROCESS_TOKEN = $previous.CHANNEL_PROCESS_TOKEN
    }
}

<#
.SYNOPSIS
Throws when the settings fragment's SessionStart script path is not this checkout's script.
#>
function Assert-HookPathMatchesFragment {
    if (-not (Test-Path -LiteralPath $script:SettingsFragment)) { return }

    $fragment = Get-Content -LiteralPath $script:SettingsFragment -Raw | ConvertFrom-Json
    $command = $fragment.hooks.SessionStart[0].hooks[0].command
    if ($command -notmatch '-File\s+"([^"]+)"') { return }

    $declared = $Matches[1]
    $declaredFull = [System.IO.Path]::GetFullPath($declared)
    $actualFull = [System.IO.Path]::GetFullPath($script:SessionStartHook)
    if ($declaredFull -ieq $actualFull) { return }

    throw "Enter-ClaudeSession: hooks/settings-fragment.json points SessionStart at " +
        "'$declaredFull', but this checkout's hook script is '$actualFull'. Sessions would start " +
        "and never announce themselves. Update the fragment's path (Section 7's installer does " +
        "this) and re-merge it into the user-level settings file."
}
