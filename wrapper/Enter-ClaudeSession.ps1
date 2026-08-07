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
# would inherit a live token, and the broker would read that second session as a subprocess of the
# first and never register it, leaving it with no thread, no card, and no mirroring.
#
# -ClaudeArgs passes extra arguments straight through to `claude` after the channel flag and the
# relay's server name: a -p prompt, or anything else.
#
# -NoMirror sets CHANNEL_SESSION_MIRROR to an off value for this one launch, restored along with the
# other two on exit. It is the per-session escape from the host-wide CHANNEL_MIRROR default in
# broker.env: the launched session's console prompts and turn replies are not mirrored to its thread,
# while every other session on the host keeps mirroring. Named differently from the broker's own
# CHANNEL_MIRROR on purpose, so the two never alias: the broker inherits its process environment, and
# a broker started from inside a -NoMirror session must not come up with mirroring off for every
# session on the host. Absent, CHANNEL_SESSION_MIRROR is cleared for the launch regardless of what
# the calling shell already had, so the launched session never carries a value this wrapper did not
# set. -NoMirror also verifies the installed settings file's mirror hooks actually forward the
# switch header, and throws rather than launching a session that mirrors exactly as it would without
# the switch; see Assert-InstalledMirrorSwitch.

# Which flag opens channels on each host. Plain --channels loads a channel only when its plugin is
# on an allowlist; otherwise the launch is refused, and a refused channel is this project's worst
# shape of failure, because the session starts, the hooks announce it, and the thread and card look
# healthy while nothing can reach it.
#
# The relay is on no allowlist on any host today: it is registered per launch through --mcp-config,
# and packaging it as a plugin so it can be named in allowedChannelPlugins is the one step of the
# install deliberately left for later. So every host takes the development flag and its one
# confirmation keypress, which is a nuisance at a keyboard the operator is already sitting at.
#
# Operator check D settled that a local managed-settings file is honored on a personal account, so
# this is not a Team-and-Enterprise privilege: once the relay is a plugin, every host here can move
# to plain --channels, SCOTT included. Change an entry only alongside that packaging, and confirm
# the startup banner's channel line on the first launch after.
$script:ChannelFlagByHost = @{
    'NEO'   = '--dangerously-load-development-channels'
    'ASR'   = '--dangerously-load-development-channels'
    'SCOTT' = '--dangerously-load-development-channels'
}

# Both channel flags are variadic and take tagged entries, not a bare switch: `server:<name>` for a
# manually configured MCP server, `plugin:<name>@<marketplace>` for a plugin-provided channel. The
# relay is an MCP server, so the launch line passes it as server:<this name>. The untagged name is
# the key the relay is registered under in the generated --mcp-config, and it is also what Claude
# Code builds the reply tool's permission rule from. The entry is passed explicitly rather than left
# to the caller: a flag given no value silently swallows whatever argument follows it, and a session
# that loaded no channel starts and runs normally with no signal that it cannot be steered.
# hooks/settings-fragment.json's allow rule and relay/reply-permission.test.ts hold the copies
# together.
$script:ChannelServerName = 'channel-relay'

# The relay itself, resolved from this file's own location so it is correct wherever the repository
# is checked out.
$script:RelayScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'relay\index.ts'

# Absolute path to the SessionStart hook script, resolved from this file's own location so it is
# correct wherever the repository is checked out.
$script:SessionStartHook = Join-Path (Split-Path -Parent $PSScriptRoot) 'hooks\session-start.ps1'

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

    .PARAMETER NoMirror
    Turns off the mirror for this one session only. Sets CHANNEL_SESSION_MIRROR to an off value in
    the launched process's environment; the mirror hooks (hooks/settings-fragment.json's
    UserPromptSubmit and second Stop entries) forward it as the X-Channel-Mirror header, and
    broker/intake.ts drops that session's mirror posts without touching CHANNEL_MIRROR's host-wide
    default, which other sessions keep mirroring under. Named apart from that host-wide variable so
    the two can never alias: the broker inherits its own process environment, and a broker started
    from inside a -NoMirror session must not thereby lose mirroring for every session on the host.
    Absent, the launched environment carries no CHANNEL_SESSION_MIRROR, whether or not the calling
    shell already had one set: a value left over from an earlier -NoMirror launch, or set by hand,
    is cleared rather than carried through to a session that never asked for it.

    Before setting anything, verifies the installed settings file's mirror hooks actually carry the
    X-Channel-Mirror header (see Assert-InstalledMirrorSwitch) and throws if they do not, because a
    settings file merged before this parameter existed has mirror hooks that forward nothing: the
    session would mirror exactly as it would without -NoMirror, silently, during the sensitive work
    the switch exists for.
    #>
    param(
        [Parameter(Mandatory)]
        [ValidatePattern('^[\x20-\x7E]+$')]
        [ValidateLength(1, 64)]
        [string]$Name,

        [string[]]$ClaudeArgs = @(),

        [switch]$NoMirror
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

    # The installed hooks name the script by absolute path, which is correct for exactly one
    # checkout. A repository cloned or moved somewhere else keeps launching happily while every
    # session silently fails to announce, so the disagreement is made loud here.
    Assert-InstalledHookPath

    # A privacy switch that fails open must fail loudly. Checked only when asked for: a launch with
    # no -NoMirror carries no expectation about the mirror hooks at all.
    if ($NoMirror) {
        Assert-InstalledMirrorSwitch
    }

    Assert-HookScriptProtected

    if (-not (Test-Path -LiteralPath $script:RelayScript)) {
        throw "Enter-ClaudeSession: the relay is missing at '$script:RelayScript'. Without it the " +
            "session starts with no channel: it can be watched but not answered, and nothing in " +
            "the session says so."
    }
    $mcpConfig = New-ChannelMcpConfig

    $previous = @{
        CHANNEL_SESSION        = $env:CHANNEL_SESSION
        CHANNEL_PROCESS_TOKEN  = $env:CHANNEL_PROCESS_TOKEN
        CHANNEL_SESSION_MIRROR = $env:CHANNEL_SESSION_MIRROR
    }
    try {
        $env:CHANNEL_SESSION = $Name
        $env:CHANNEL_PROCESS_TOKEN = [guid]::NewGuid().ToString()
        # CHANNEL_SESSION_MIRROR rides into an HTTP header via the fragment's allowedEnvVars with no
        # validation beyond what Claude Code's own interpolation performs, unlike CHANNEL_SESSION
        # (pattern-validated above) and CHANNEL_PROCESS_TOKEN (a GUID this wrapper mints itself). Set
        # to the literal 'off' when asked, and cleared otherwise rather than left at whatever the
        # calling shell already had: an ambient value (left behind by an earlier crashed -NoMirror
        # session, or set by hand) must not silently carry into a session that never asked for it.
        if ($NoMirror) {
            $env:CHANNEL_SESSION_MIRROR = 'off'
        } else {
            $env:CHANNEL_SESSION_MIRROR = $null
        }

        & claude --mcp-config $mcpConfig $channelFlag "server:$($script:ChannelServerName)" @ClaudeArgs
    } finally {
        # Restored whether claude exited, threw, or was interrupted. A token left behind in a
        # dot-sourced shell is inherited by the next `claude` started from it, and the broker reads
        # a second session announcing itself on a relayed session's token as a subprocess of it: the
        # newcomer never registers, so it gets no thread, no card, and no mirroring, and it goes on
        # posting hook events that nothing can route. CHANNEL_SESSION_MIRROR is restored for the
        # same reason: a bare `claude` run later from this shell must not silently inherit
        # -NoMirror's off value from a session that has since exited.
        $env:CHANNEL_SESSION = $previous.CHANNEL_SESSION
        $env:CHANNEL_PROCESS_TOKEN = $previous.CHANNEL_PROCESS_TOKEN
        $env:CHANNEL_SESSION_MIRROR = $previous.CHANNEL_SESSION_MIRROR
    }
}

<#
.SYNOPSIS
Writes the --mcp-config file that registers the relay for one launch, and returns its path.

.DESCRIPTION
The relay is registered per launch rather than installed into a settings file, for two reasons.

It has to work: an `mcpServers` key in a settings file is read by nothing. Measured against build
2.1.223, a session started with such a file applies the permission rules beside it and starts no
server at all, with the relay's absence reported nowhere.

And it is the right scope anyway. A user-scope registration would start the relay for every Claude
Code session on the machine, including the ones this project deliberately leaves alone; a session
launched without this wrapper carries no process token, is not being watched, and has no thread to
reach. Registering here means exactly the wrapped sessions get a relay.

Written to a file rather than passed as an inline JSON string because this is Windows PowerShell
5.1, whose native-argument quoting mangles embedded double quotes. Regenerated from $PSScriptRoot on
every launch, so unlike the installed hook path it cannot come to name a checkout that has moved.
#>
function New-ChannelMcpConfig {
    param(
        # Defaulted rather than read inline so a test can drive this against a temp directory.
        # Mirrors broker/config.ts's defaultStateFile and install/Install-Functions.ps1's
        # Get-ChannelStateRoot: one directory holds everything this project writes at runtime, and
        # the installer hardens it.
        [string]$Directory = (Join-Path $env:LOCALAPPDATA 'sapplefeld-channels')
    )

    if ([string]::IsNullOrWhiteSpace($Directory)) {
        throw "Enter-ClaudeSession: cannot resolve a directory for the relay's MCP config " +
            "(LOCALAPPDATA is not set)."
    }
    if (-not (Test-Path -LiteralPath $Directory)) {
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    }

    $config = [ordered]@{
        mcpServers = [ordered]@{
            $script:ChannelServerName = [ordered]@{
                command = 'node'
                args    = @($script:RelayScript)
            }
        }
    }
    $path = Join-Path $Directory 'relay-mcp.json'
    # UTF-8 with no byte-order mark: Claude Code parses this as JSON, and a BOM is a parse error.
    [System.IO.File]::WriteAllText(
        $path,
        ($config | ConvertTo-Json -Depth 10),
        [System.Text.UTF8Encoding]::new($false)
    )
    return $path
}

<#
.SYNOPSIS
Throws when the hook script is writable by anyone but its owner, Administrators, and SYSTEM.

.DESCRIPTION
The installer hardens this path, but nothing keeps it hardened: a delete-and-recreate on a branch
switch or a re-clone restores the inherited permissions with no signal, and the script then runs
under -ExecutionPolicy Bypass at every session start, which makes write access to it code execution
in the operator's context.

The rule is the broker's own, called rather than restated so the two cannot drift apart. A failure
to *run* the check warns instead of throwing: the launcher's job is starting sessions, and a Node
hiccup at the desk should not stop work when the check has not actually found anything wrong.
#>
function Assert-HookScriptProtected {
    $functions = Join-Path (Split-Path -Parent $PSScriptRoot) 'install\Install-Functions.ps1'
    if (-not (Test-Path -LiteralPath $functions)) { return }

    try {
        . $functions
    } catch {
        Write-Warning "Enter-ClaudeSession: could not load the permission check ($($_.Exception.Message))."
        return
    }

    try {
        Assert-ChannelPathProtected -Path $script:SessionStartHook
    } catch [System.Management.Automation.RuntimeException] {
        # The check ran and refused. That is a real finding, and it is fatal.
        throw "Enter-ClaudeSession: $($_.Exception.Message) This script runs under " +
            "-ExecutionPolicy Bypass at every session start, so write access to it is code " +
            "execution as you. Re-run install/Install-Host.ps1 to restore its permissions."
    } catch {
        Write-Warning "Enter-ClaudeSession: the hook script permission check could not run ($($_.Exception.Message))."
    }
}

<#
.SYNOPSIS
Throws when the installed SessionStart hook does not run this checkout's script.

.DESCRIPTION
Reads the user-level settings file, which is the copy that actually runs. The fragment in the
checkout is a template the installer substitutes and merges; checking it instead would pass on
exactly the case worth catching, a checkout moved or re-cloned while the installed settings still
name the old path.

Silence means no opinion: an absent settings file, no SessionStart hook in it, or no hook belonging
to this project all mean nothing has been installed to disagree with, and a launch is not the place
to insist on an install. Only a hook that names a session-start.ps1 other than this checkout's is a
contradiction, and that one is fatal, because the alternative is a session that runs unwatched with
no signal that anything is wrong.
#>
function Assert-InstalledHookPath {
    param(
        # Defaulted rather than read inline so the check is exercisable against a fixture. $HOME is
        # read-only in PowerShell, so a test cannot redirect it and a function that reads it
        # directly can only ever be run against the operator's real settings.
        [string]$SettingsPath = (Join-Path $HOME '.claude\settings.json')
    )

    if (-not (Test-Path -LiteralPath $SettingsPath)) { return }

    try {
        $settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
    } catch {
        # A settings file this cannot parse is Claude Code's problem to report, not the launcher's.
        return
    }

    $actualFull = [System.IO.Path]::GetFullPath($script:SessionStartHook)
    foreach ($entry in @($settings.hooks.SessionStart)) {
        foreach ($hook in @($entry.hooks)) {
            $command = [string]$hook.command
            # Deliberately not anchored to the end of the command: a hook that passes arguments
            # after the script path is still this project's hook, and an anchored match would skip
            # it silently, which is a false pass in the one check standing between a moved checkout
            # and a fleet of sessions that never announce themselves.
            if ($command -notmatch '-File\s+(?:"([^"]+)"|([^\s"]+))') { continue }

            $declared = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }

            # A path this cannot even parse is not one to form an opinion about, and a launcher that
            # throws on a malformed third-party entry blocks work for no safety gain. Both calls are
            # guarded: each throws on invalid path characters, and the file-name check runs first.
            try {
                if ([System.IO.Path]::GetFileName($declared) -ine 'session-start.ps1') { continue }
                $declaredFull = [System.IO.Path]::GetFullPath($declared)
            } catch {
                continue
            }
            if ($declaredFull -ieq $actualFull) { return }

            throw "Enter-ClaudeSession: the installed SessionStart hook in '$SettingsPath' runs " +
                "'$declaredFull', but this checkout's hook script is '$actualFull'. Sessions would " +
                "start and never announce themselves. Re-run install/Install-Host.ps1 from this " +
                "checkout to point the installed hook at it."
        }
    }
}

<#
.SYNOPSIS
Throws when -NoMirror cannot be honored because the installed settings file's mirror hooks do not
carry the per-session switch header.

.DESCRIPTION
-NoMirror only works by setting CHANNEL_SESSION_MIRROR in the launched process's environment; the
mirror hooks have to forward it as X-Channel-Mirror for the broker to ever act on it. A settings file
merged before this parameter existed has UserPromptSubmit and Stop mirror hooks that interpolate
nothing, so the switch does nothing: the session mirrors exactly as it would without -NoMirror,
silently, during precisely the sensitive work the switch exists for. A privacy control fails closed
and loud, never open and quiet.

Silence still means no opinion where nothing of this project is installed at all, the same rule
Assert-InstalledHookPath holds: an absent settings file, or one with no SessionStart hook naming this
checkout's script, means there is no mirror traffic to suppress either way, and -NoMirror has nothing
to disagree with. Once this checkout's SessionStart hook is installed, both mirror hooks (
UserPromptSubmit's, and the Stop entry posting to /mirror) must send the switch header as the
interpolation of CHANNEL_SESSION_MIRROR and list that variable in allowedEnvVars, or this throws
naming the fix. The value is checked and not only the header's presence, because a hook sending a
fixed value sends it identically from every session on the machine: -NoMirror would set a variable
nothing reads, and a presence-only check would pass the one settings file it exists to refuse.
#>
function Assert-InstalledMirrorSwitch {
    param(
        # Defaulted the same way Assert-InstalledHookPath is, and for the same reason: $HOME is
        # read-only in PowerShell, so a test drives this against an explicit fixture path instead.
        [string]$SettingsPath = (Join-Path $HOME '.claude\settings.json')
    )

    if (-not (Test-Path -LiteralPath $SettingsPath)) { return }

    try {
        $settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
    } catch {
        # A settings file this cannot parse is Claude Code's problem to report, not the launcher's.
        return
    }

    $actualFull = [System.IO.Path]::GetFullPath($script:SessionStartHook)
    $installed = $false
    foreach ($entry in @($settings.hooks.SessionStart)) {
        foreach ($hook in @($entry.hooks)) {
            $command = [string]$hook.command
            if ($command -notmatch '-File\s+(?:"([^"]+)"|([^\s"]+))') { continue }
            $declared = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
            try {
                if ([System.IO.Path]::GetFileName($declared) -ieq 'session-start.ps1' -and
                    [System.IO.Path]::GetFullPath($declared) -ieq $actualFull) {
                    $installed = $true
                }
            } catch {
                continue
            }
        }
    }
    if (-not $installed) { return }

    # What the header has to carry, not merely that it carries something. A hook sending a fixed
    # value sends it from every session on the machine, so CHANNEL_SESSION_MIRROR reaches the broker
    # from none of them and -NoMirror mirrors in full while this check sees a header and passes.
    # Single-quoted: in double quotes PowerShell would expand ${CHANNEL_SESSION_MIRROR} as one of its
    # own variables and compare every installed header against the empty string.
    # install/Install-Functions.ps1's Assert-ValidChannelFragment refuses any other value at merge
    # time; this is the same rule read from the settings file that actually runs.
    $switchHeaderValue = '${CHANNEL_SESSION_MIRROR}'

    $stale = [System.Collections.Generic.List[string]]::new()
    foreach ($eventName in @('UserPromptSubmit', 'Stop')) {
        $found = $false
        $carriesSwitch = $false
        foreach ($entry in @($settings.hooks.$eventName)) {
            foreach ($hook in @($entry.hooks)) {
                if ([string]$hook.type -ne 'http') { continue }
                if (([string]$hook.url) -notlike '*/mirror') { continue }
                $found = $true
                $header = if ($hook.headers) { [string]$hook.headers.'X-Channel-Mirror' } else { '' }
                $allowed = @($hook.allowedEnvVars)
                if ($header -eq $switchHeaderValue -and $allowed -contains 'CHANNEL_SESSION_MIRROR') {
                    $carriesSwitch = $true
                }
            }
        }
        if (-not $found -or -not $carriesSwitch) { $stale.Add($eventName) }
    }

    if ($stale.Count -gt 0) {
        throw "Enter-ClaudeSession: -NoMirror cannot be honored. The installed settings file " +
            "'$SettingsPath' has a $($stale -join ', ') mirror hook that does not send the " +
            "X-Channel-Mirror switch header as '$switchHeaderValue', so this session's console " +
            "prompts and turn replies would mirror exactly as if -NoMirror had not been given. Re-run " +
            "install/Install-Host.ps1 from this checkout to install the current fragment, then " +
            "launch again."
    }
}
