# Shared functions for provisioning one host. Dot-source this file; it defines functions and runs
# nothing on its own, the same shape as wrapper/Enter-ClaudeSession.ps1.
#
#   . .\install\Install-Functions.ps1
#
# Install-Host.ps1 and Register-BrokerTask.ps1 are the scripts an operator actually runs. Splitting
# the logic out here is what makes it testable: a test dot-sources this file and calls a function
# directly against a temp directory, never touching the real ~/.claude/settings.json, the real
# Task Scheduler, or a real file's ACL.

<#
.SYNOPSIS
Recursively converts a ConvertFrom-Json result into ordered hashtables and arrays.

.DESCRIPTION
Windows PowerShell 5.1's ConvertFrom-Json has no -AsHashtable switch (that arrived in PowerShell 6),
so a value read back from settings.json or the fragment is a tree of PSCustomObject and Object[].
Property lookup and assignment on a PSCustomObject requires a different syntax than a hashtable's
key indexer, and the merge logic below needs both, so everything is converted once, up front, to a
hashtable tree it can index uniformly.
#>
function ConvertTo-OrderedHashtable {
    param($InputObject)

    if ($null -eq $InputObject) { return $null }

    if ($InputObject -is [System.Collections.IDictionary]) {
        $hash = [ordered]@{}
        foreach ($key in $InputObject.Keys) { $hash[$key] = ConvertTo-OrderedHashtable $InputObject[$key] }
        return $hash
    }

    if ($InputObject -is [System.Management.Automation.PSCustomObject]) {
        $hash = [ordered]@{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $hash[$property.Name] = ConvertTo-OrderedHashtable $property.Value
        }
        return $hash
    }

    if ($InputObject -is [System.Collections.IEnumerable] -and $InputObject -isnot [string]) {
        # The leading comma is load-bearing: `return @(...)` still enumerates onto the output
        # stream, and PowerShell collapses a single-element array back to a scalar the moment it
        # crosses a function's return boundary that way. The unary comma operator wraps the already-
        # built array in one more array, which enumerates down to exactly the array this function
        # built, one element or many.
        return , @($InputObject | ForEach-Object { ConvertTo-OrderedHashtable $_ })
    }

    return $InputObject
}

<#
.SYNOPSIS
Writes text as UTF-8 with no byte-order mark.

.DESCRIPTION
Set-Content -Encoding UTF8 writes a BOM on Windows PowerShell 5.1 (there is no BOM-less UTF8
encoding name until PowerShell 6's utf8NoBOM). A BOM is invisible to Get-Content, which strips it,
but not to a Node readFileSync(..., "utf8"), which returns it as a leading character. The bot token
is read exactly that way by broker/discord/config.ts's readToken and then only .trim()'d, and trim()
does not remove a BOM, so a BOM-prefixed token file would authenticate as a token Discord has never
seen and fail with no signal pointing back at this. Everything this installer writes for another
program to read raw uses this instead of Set-Content -Encoding UTF8.
#>
function Set-Utf8NoBomFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Content
    )
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

<#
.SYNOPSIS
True when a hooks-array entry is this project's own hook for the given event.

.DESCRIPTION
Identifies a SessionStart entry by matching the exact invocation shape Get-SubstitutedFragment
generates (powershell, the fixed flags, -File, a path ending in session-start.ps1), not merely by
the presence of that filename anywhere in the command: a substring match would also delete an
unrelated tool's own hook that happens to run a same-named script, silently, on the next install.
Every other event's entry is identified by carrying the X-Channel-Hook-Event header this project's
fragment always sets, which is specific enough on its own. That covers an event declaring more than
one entry, as Stop does with its liveness tick and its mirror post: both carry the header, so both
are recognized together and neither survives into a re-install as a stale twin of the other.
Neither identity depends on the broker port or the substituted script path, because both are exactly
what re-running the installer is expected to update: this is what lets Merge-ChannelHooksFragment
replace a stale entry instead of leaving it beside a fresh one.
#>
function Test-IsChannelHookEntry {
    param(
        [Parameter(Mandatory)][hashtable]$Entry,
        [Parameter(Mandatory)][string]$EventName
    )
    foreach ($hook in @($Entry['hooks'])) {
        if ($EventName -eq 'SessionStart') {
            if ($hook['command'] -and $hook['command'] -match
                '^\s*powershell\s+-NoProfile\s+-ExecutionPolicy\s+Bypass\s+-File\s+"[^"]*session-start\.ps1"\s*$') {
                return $true
            }
        } elseif ($hook['headers'] -and $hook['headers']['X-Channel-Hook-Event'] -eq $EventName) {
            return $true
        }
    }
    return $false
}

<#
.SYNOPSIS
Throws unless a fragment declares only the shape this installer is willing to merge verbatim.

.DESCRIPTION
Get-SubstitutedFragment changes one field and trusts the rest of the file completely otherwise, and
Merge-ChannelHooksFragment then installs every event the fragment declares into the operator's real
user-level settings. hooks/settings-fragment.json inherits Authenticated Users: Modify on at least
one host (closed for this checkout by hardening hooks/ itself, but a defense that depends on every
host's hardening having already run and never having been undone is not a defense on its own), so an
attacker who can write that one file can otherwise turn a routine re-install into a machine-wide,
persistent hook of their own choosing. This is checked in addition to hardening the file, not
instead of it: allowed event names, allowed hook types, and no `command` string other than the one
SessionStart entry this installer itself substitutes.

A `command` hook is refused under every event but SessionStart. That is the only command hook this
project declares, every other event is http by design, and it is the only one whose path
Get-SubstitutedFragment rewrites for the host: a command hook under any other event carries the
directory the fragment names, unsubstituted, into the operator's settings and back out of every
later re-install. The path pattern still gates SessionStart's own invocation, but the pattern
constrains the script's filename rather than the directory it sits in, so restricting which event
may carry a command at all is what keeps that to one entry this installer writes itself.

An http hook is pinned just as tightly, and for a threat the command pin does not cover. Its url,
headers, and allowedEnvVars are otherwise merged verbatim, so a url pointing off-host would send
every console prompt and every assistant reply on the machine, plus the process token riding in a
header, to whatever address the fragment names, on the next routine re-install. The url must
therefore name loopback and one of this project's own routes; a header name must be one of the three
core headers every http hook carries, or, on a hook posting to /mirror or on the PreToolUse question
hook, the fourth, X-Channel-Mirror; and an allowedEnvVars entry must be one of the two variables the
core headers interpolate, or, again only on those same content-bearing hooks,
CHANNEL_SESSION_MIRROR, since that list is what authorizes an environment variable to be read into a
request at all. The switch header and its variable are tied to the entries whose payloads carry
conversation text (the mirror route's, and PreToolUse, whose AskUserQuestion payload carries the
open question's text to /hook) rather than admitted everywhere, which keeps a liveness hook from
carrying a header settings-fragment.test.ts's own split forbids it from carrying. A PreToolUse
entry's matcher is pinned to exactly AskUserQuestion for the same reason: PreToolUse posts a tool
call's whole input at emission, so a widened or missing matcher would send every matched call's
input on the machine to the broker, on the very entry the switch header is admitted for.
settings-fragment.test.ts pins the same shapes, but it runs in this repository, not on the host at
install time, which is where the fragment is read.

Loopback alone is not enough on the url, so every http hook in the fragment must also name the same
port. A local process is what an attacker who can write this file most cheaply has, and two of these
urls pointed at a port of their choosing would hand that process every console prompt, every turn's
reply, and the process token in a header, persistently, while the broker keeps running healthy and
every surface looks right. Install-Host.ps1 holds the other half, checking -Port against every url
rather than the first, so the port they agree on is also the port the broker is opened on.

The switch header's value is pinned as well as its name. A hook carrying a literal
'X-Channel-Mirror: on' passes a name-only check and sends that value from every session on the
machine, at which point -NoMirror sets a variable no request carries and the wrapper's own
Assert-InstalledMirrorSwitch sees a header that is present: a privacy switch that fails open and
silent, which is the one failure mode worse than not having it. Only the interpolation form is
merged, and Claude Code substitutes the session's own value into it at request time.
#>
# Exact names, never a pattern: the list is what stands between an attacker-writable fragment and a
# tool pre-approved for every session on the machine, and a pattern admits names nobody wrote down.
# One entry: Claude Code names the reply tool after the key the server arrived under, and every
# fleet host takes the plugin route, whose plugin-scoped key gives this rule. The development
# route's rule (mcp__channel-relay__reply) is deliberately off this list;
# hooks/settings-fragment.json's _permissions_comment says why and what a host on the development
# flag should expect.
$script:AllowedChannelPermissionRules = @(
    'mcp__plugin_relay_channel-relay__reply'
)

function Assert-ValidChannelFragment {
    param([Parameter(Mandatory)][hashtable]$Fragment)

    $allowedEvents = @('SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop')
    $allowedTypes = @('command', 'http')
    $allowedUrl = '^http://127\.0\.0\.1:(\d+)/(hook|mirror)\z'
    $coreHeaders = @('X-Channel-Hook-Event', 'X-Channel-Process-Token', 'X-Channel-Session-Name')
    $mirrorOnlyHeaders = @('X-Channel-Mirror')
    $coreEnvVars = @('CHANNEL_PROCESS_TOKEN', 'CHANNEL_SESSION')
    $mirrorOnlyEnvVars = @('CHANNEL_SESSION_MIRROR')
    # The one form of the switch header this installer merges. Single-quoted: in double quotes
    # PowerShell would read ${CHANNEL_SESSION_MIRROR} as one of its own variables and compare every
    # header against the empty string.
    $mirrorHeaderValue = '${CHANNEL_SESSION_MIRROR}'
    # The port the first http hook named, and the url it came from, so a later disagreement can name
    # both sides of it.
    $port = $null
    $portUrl = $null

    # The permission rules are held to an exact list for the same reason the command string is: this
    # fragment inherits Authenticated Users: Modify on at least one host, and a permission rule
    # merged verbatim into the operator's real user-level settings pre-approves a tool for every
    # session on the machine, with no prompt and no record anywhere the operator would look.
    $declaredRules = @()
    if ($Fragment.Contains('permissions') -and $null -ne $Fragment['permissions']) {
        $declaredRules = @($Fragment['permissions']['allow'])
    }
    foreach ($rule in $declaredRules) {
        if ($null -eq $rule) { continue }
        # Case-sensitive membership: -notcontains compares case-insensitively, and a case-variant
        # rule would merge verbatim while matching nothing this list meant to allow.
        if ($script:AllowedChannelPermissionRules -cnotcontains [string]$rule) {
            throw "Assert-ValidChannelFragment: the fragment declares a permission rule this " +
                "installer does not merge: '$rule'. Only $($script:AllowedChannelPermissionRules -join ', ') " +
                "is allowed, and it is the relay's own reply tool."
        }
    }

    if (-not $Fragment.Contains('hooks') -or $null -eq $Fragment['hooks']) {
        throw "Assert-ValidChannelFragment: the fragment declares no 'hooks' object."
    }

    foreach ($eventName in $Fragment['hooks'].Keys) {
        if ($allowedEvents -notcontains $eventName) {
            throw "Assert-ValidChannelFragment: the fragment declares an unrecognized hook event " +
                "'$eventName'. Only SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, and " +
                "Stop are merged."
        }
        foreach ($entry in @($Fragment['hooks'][$eventName])) {
            if ($eventName -eq 'PreToolUse' -and ([string]$entry['matcher']) -cne 'AskUserQuestion') {
                # PreToolUse fires before a tool runs and its payload carries the tool's whole
                # input, so a widened or missing matcher posts every matched tool call's input on
                # the machine to the broker at emission. This pin is also what the mirror switch
                # admission below leans on: X-Channel-Mirror is admitted on PreToolUse on the
                # strength of the entry being exactly the AskUserQuestion question alert.
                throw "Assert-ValidChannelFragment: the fragment's PreToolUse entry carries matcher " +
                    "'$($entry['matcher'])' rather than 'AskUserQuestion'. PreToolUse posts a tool " +
                    "call's whole input at emission, so only the question alert's exact matcher is " +
                    "merged; anything wider would send every matched tool call's input to the broker."
            }
            foreach ($hook in @($entry['hooks'])) {
                $type = [string]$hook['type']
                if ($allowedTypes -notcontains $type) {
                    throw "Assert-ValidChannelFragment: the fragment's $eventName hook declares an " +
                        "unrecognized type '$type'. Only 'command' and 'http' are merged."
                }
                if ($type -eq 'command') {
                    if ($eventName -ne 'SessionStart') {
                        throw "Assert-ValidChannelFragment: the fragment declares a 'command' hook " +
                            "under $eventName. SessionStart's is this project's only command hook, " +
                            "and it is the only one Get-SubstitutedFragment rewrites the path of, so " +
                            "a command hook under any other event names a directory nothing here " +
                            "controls and is refused rather than merged."
                    }
                    $command = [string]$hook['command']
                    if ($command -notmatch
                        '^\s*powershell\s+-NoProfile\s+-ExecutionPolicy\s+Bypass\s+-File\s+"[^"]*session-start\.ps1"\s*$') {
                        throw "Assert-ValidChannelFragment: the fragment's $eventName command is not " +
                            "the SessionStart invocation this installer substitutes: '$command'. A " +
                            "command hook naming anything else is refused rather than merged."
                    }
                }
                if ($type -eq 'http') {
                    $url = [string]$hook['url']
                    if ($url -notmatch $allowedUrl) {
                        throw "Assert-ValidChannelFragment: the fragment's $eventName hook posts to " +
                            "'$url', which is not one of this project's own loopback routes. A hook " +
                            "url naming any other address would send this machine's hook traffic, " +
                            "and the process token in its headers, wherever the fragment says."
                    }
                    # Read from the match above rather than parsed again here, so one reading of a
                    # url decides both that it is allowed and which port it named. -notmatch fills
                    # $Matches on the runs where the pattern matched, which is every run that
                    # reaches this line, and it is read before the /mirror test below overwrites it.
                    $hookPort = $Matches[1]
                    if ($null -eq $port) {
                        $port = $hookPort
                        $portUrl = $url
                    } elseif ($hookPort -ne $port) {
                        throw "Assert-ValidChannelFragment: the fragment's $eventName hook posts to " +
                            "'$url' while another posts to '$portUrl'. Every http hook here must name " +
                            "the one port this project's broker is opened on: a hook split off onto " +
                            "another local port hands whatever is listening there this machine's " +
                            "console prompts, assistant replies, and process token, and nothing about " +
                            "a healthy broker on the real port would show it."
                    }
                    # The switch header and its env var are legitimate only on the entries whose
                    # payloads carry conversation text: a hook posting to /mirror, and the
                    # PreToolUse question hook, whose AskUserQuestion payload carries the open
                    # question's text to /hook. The PreToolUse arm rides the matcher pin at the
                    # top of the entry loop: by the time headers are checked here, any PreToolUse
                    # entry is exactly the AskUserQuestion one. A liveness hook carries no content
                    # for a per-session mirror switch to govern, and settings-fragment.test.ts
                    # holds that split as a pinned property of the shipped fragment.
                    $carriesMirrorSwitch = ($url -match '/mirror$') -or ($eventName -eq 'PreToolUse')
                    $allowedHeadersHere = if ($carriesMirrorSwitch) { $coreHeaders + $mirrorOnlyHeaders } else { $coreHeaders }
                    $allowedEnvVarsHere = if ($carriesMirrorSwitch) { $coreEnvVars + $mirrorOnlyEnvVars } else { $coreEnvVars }

                    if ($null -ne $hook['headers']) {
                        foreach ($headerName in @($hook['headers'].Keys)) {
                            if ($allowedHeadersHere -notcontains [string]$headerName) {
                                throw "Assert-ValidChannelFragment: the fragment's $eventName hook " +
                                    "sets a header this installer does not merge on this route: " +
                                    "'$headerName'. Only $($allowedHeadersHere -join ', ') are allowed here."
                            }
                            if ([string]$headerName -eq 'X-Channel-Mirror' -and
                                ([string]$hook['headers'][$headerName]) -ne $mirrorHeaderValue) {
                                throw "Assert-ValidChannelFragment: the fragment's $eventName hook " +
                                    "sends X-Channel-Mirror as " +
                                    "'$([string]$hook['headers'][$headerName])' rather than " +
                                    "'$mirrorHeaderValue'. A fixed value is sent by every session on " +
                                    "the machine and reads as none of them: -NoMirror would set a " +
                                    "variable no request carries, and the launch check that exists to " +
                                    "catch that would see the header present and let the session run " +
                                    "mirrored."
                            }
                        }
                    }
                    foreach ($envVar in @($hook['allowedEnvVars'])) {
                        if ($null -eq $envVar) { continue }
                        if ($allowedEnvVarsHere -notcontains [string]$envVar) {
                            throw "Assert-ValidChannelFragment: the fragment's $eventName hook " +
                                "authorizes an environment variable this installer does not merge on " +
                                "this route: '$envVar'. Only $($allowedEnvVarsHere -join ', ') are " +
                                "read into a request here, and the list is what permits a variable " +
                                "to be read at all."
                        }
                    }
                }
            }
        }
    }
}

<#
.SYNOPSIS
Merges the channel hooks fragment into a settings ordered dictionary, in place, and returns it.

.DESCRIPTION
For each event the fragment declares, drops every existing entry that Test-IsChannelHookEntry
recognizes as this project's own, then appends all of that event's entries from the fragment. Every
other hook already present, for the same event or a different one, is left exactly as it was.
Calling this twice with the same fragment leaves the settings unchanged the second time: the first
call's entries are recognized and replaced by the second, not duplicated beside it. That holds for
an event carrying several entries, such as Stop's liveness tick and mirror post, because the whole
per-event array is rebuilt from the kept entries plus the fragment's, never appended to.

Both parameters are typed as OrderedDictionary rather than the more permissive [hashtable]: passing
an OrderedDictionary through a [hashtable]-typed parameter coerces it to a plain Hashtable at the
call boundary, silently discarding key order, and the settings file this writes is meant to come
back out in the order a human last saw it, not reshuffled on every install.
#>
function Merge-ChannelHooksFragment {
    param(
        [Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Settings,
        [Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Fragment
    )

    Assert-ValidChannelFragment -Fragment $Fragment

    if (-not $Settings.Contains('hooks') -or $null -eq $Settings['hooks']) {
        $Settings['hooks'] = [ordered]@{}
    }

    foreach ($eventName in $Fragment['hooks'].Keys) {
        $existing = @()
        if ($Settings['hooks'].Contains($eventName) -and $null -ne $Settings['hooks'][$eventName]) {
            $existing = @($Settings['hooks'][$eventName])
        }
        $kept = @($existing | Where-Object { -not (Test-IsChannelHookEntry -Entry $_ -EventName $eventName) })
        $Settings['hooks'][$eventName] = @($kept + @($Fragment['hooks'][$eventName]))
    }

    # The permission rules merge the same way the hooks do: this project's own rules are removed and
    # re-added, and every other rule the operator has is left exactly where it was. Without the
    # relay's reply rule installed, the first reply a session sends opens a permission prompt at the
    # terminal and parks the session, which is the failure the whole design is built to avoid.
    $rules = @()
    if ($Fragment.Contains('permissions') -and $null -ne $Fragment['permissions']) {
        $rules = @($Fragment['permissions']['allow']) | Where-Object { $null -ne $_ }
    }
    if ($rules.Count -gt 0) {
        if (-not $Settings.Contains('permissions') -or $null -eq $Settings['permissions']) {
            $Settings['permissions'] = [ordered]@{}
        }
        $existingRules = @()
        if ($Settings['permissions'].Contains('allow') -and $null -ne $Settings['permissions']['allow']) {
            $existingRules = @($Settings['permissions']['allow'])
        }
        $keptRules = @($existingRules | Where-Object { $rules -notcontains [string]$_ })
        $Settings['permissions']['allow'] = @($keptRules + $rules)
    }

    return $Settings
}

<#
.SYNOPSIS
Reads hooks/settings-fragment.json and substitutes this host's absolute SessionStart script path.

.DESCRIPTION
The fragment as checked in names the checkout it was written against. A hook runs with the
monitored session's own project as its working directory, so the SessionStart command must name its
script by a drive-rooted absolute path specific to the host it is installed on, per the fragment's
own file comment and hooks/settings-fragment.test.ts. This is that substitution: the file on disk is
never modified, only the in-memory copy this function returns.
#>
function Get-SubstitutedFragment {
    param(
        [Parameter(Mandatory)][string]$FragmentPath,
        [Parameter(Mandatory)][string]$SessionStartScriptPath
    )
    $raw = Get-Content -LiteralPath $FragmentPath -Raw | ConvertFrom-Json
    $fragment = ConvertTo-OrderedHashtable $raw
    $fragment['hooks']['SessionStart'][0]['hooks'][0]['command'] =
        "powershell -NoProfile -ExecutionPolicy Bypass -File `"$SessionStartScriptPath`""
    return $fragment
}

<#
.SYNOPSIS
How many timestamped backups of a settings file Merge-ChannelSettingsFile keeps beside it.
#>
$script:MaxSettingsBackups = 5

<#
.SYNOPSIS
Merges the channel hooks into a Claude Code settings file, backing it up first.

.DESCRIPTION
A missing settings file is treated as {}. An existing one is copied beside itself with a timestamp
suffix before it is touched, because this function overwrites the file, not just the "hooks" key of
an in-memory copy of it: a settings file that failed to parse or a merge that went wrong should never
cost the operator their existing settings with no way back. Only the most recent $script:
MaxSettingsBackups are kept; the operator's whole settings file, run through every prior install,
would otherwise accumulate in ~/.claude forever.

Written to a temp file beside the target and renamed over it, the same pattern
broker/persistence.ts uses for the registry state file, so a crash mid-write leaves the previous
settings file intact rather than a truncated one.
#>
function Merge-ChannelSettingsFile {
    param(
        [Parameter(Mandatory)][string]$SettingsPath,
        [Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Fragment
    )

    $existing = [ordered]@{}
    if (Test-Path -LiteralPath $SettingsPath) {
        $parsed = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
        $existing = ConvertTo-OrderedHashtable $parsed
        $backup = "$SettingsPath.bak-$(Get-Date -Format 'yyyyMMddHHmmssfff')"
        Copy-Item -LiteralPath $SettingsPath -Destination $backup -Force

        $directory = Split-Path -Parent $SettingsPath
        $prefix = "$(Split-Path -Leaf $SettingsPath).bak-"
        $stale = Get-ChildItem -LiteralPath $directory -Filter "$prefix*" -File |
            Sort-Object -Property Name -Descending |
            Select-Object -Skip $script:MaxSettingsBackups
        foreach ($old in $stale) { Remove-Item -LiteralPath $old.FullName -Force }
    }

    $merged = Merge-ChannelHooksFragment -Settings $existing -Fragment $Fragment

    $directory = Split-Path -Parent $SettingsPath
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $temp = "$SettingsPath.$([guid]::NewGuid().ToString()).tmp"
    try {
        Set-Utf8NoBomFile -Path $temp -Content ($merged | ConvertTo-Json -Depth 20)
        Move-Item -LiteralPath $temp -Destination $SettingsPath -Force
    } catch {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw
    }

    return $merged
}

<#
.SYNOPSIS
The directory the broker's runtime state lives in, outside the repository.

.DESCRIPTION
Mirrors broker/config.ts's defaultStateFile: %LOCALAPPDATA%\sapplefeld-channels. The installer's
generated env file, the bot token file, the broker's state file, and its log file all belong under
this one root, so provisioning and hardening one directory covers all of them.
#>
function Get-ChannelStateRoot {
    param([string]$LocalAppData = $env:LOCALAPPDATA)
    if ([string]::IsNullOrWhiteSpace($LocalAppData)) {
        throw "Get-ChannelStateRoot: LOCALAPPDATA is not set; cannot resolve the broker's state directory."
    }
    return Join-Path $LocalAppData 'sapplefeld-channels'
}

<#
.SYNOPSIS
Writes the broker's runtime configuration as KEY=VALUE lines.

.DESCRIPTION
install/Start-Broker.ps1 reads this file and sets each line as an environment variable before
starting the broker. A flat KEY=VALUE file, rather than JSON, so the launcher does not need a JSON
parser just to set six environment variables.
#>
function Set-ChannelEnvFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Collections.Specialized.OrderedDictionary]$Values
    )
    $lines = foreach ($key in $Values.Keys) { "$key=$($Values[$key])" }
    $directory = Split-Path -Parent $Path
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Set-Utf8NoBomFile -Path $Path -Content (($lines -join "`n") + "`n")
}

<#
.SYNOPSIS
Reads a KEY=VALUE env file written by Set-ChannelEnvFile back into a hashtable.
#>
function Get-ChannelEnvFile {
    param([Parameter(Mandatory)][string]$Path)
    $result = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ([string]::IsNullOrWhiteSpace($line) -or $line.TrimStart().StartsWith('#')) { continue }
        $parts = $line -split '=', 2
        if ($parts.Count -ne 2) { continue }
        $result[$parts[0].Trim()] = $parts[1]
    }
    return $result
}

<#
.SYNOPSIS
Every environment variable Start-Broker.ps1 is willing to set from broker.env.

.DESCRIPTION
Exactly the variables broker/config.ts, broker/discord/config.ts, and broker/security/senders.ts
read. Named explicitly rather than setting whatever key happens to be in the
file: write access to broker.env would otherwise be arbitrary environment injection into the process
that then reads the bot token file, and something like NODE_OPTIONS in that file is a code-execution
primitive with no hook or ACL bypass required at all. CHANNEL_NODE_EXE and CHANNEL_TASK_USER are
metadata Start-Broker.ps1 and an operator read directly from the file; neither is meant to become an
environment variable of the broker process itself.
#>
$script:ChannelBrokerEnvAllowlist = @(
    'CHANNEL_HOST_NAME',
    'CHANNEL_BROKER_PORT',
    'CHANNEL_BROKER_STATE',
    'CHANNEL_STALE_AFTER_MS',
    'CHANNEL_SWEEP_INTERVAL_MS',
    'CHANNEL_MAX_BODY_BYTES',
    'CHANNEL_RETAIN_TERMINAL_MS',
    'CHANNEL_MAX_SESSIONS',
    # broker/config.ts reads and bounds this one. Without it here, the only configuration path an
    # installed host has cannot reach a knob the code documents as configurable.
    'CHANNEL_RELAY_HEARTBEAT_MS',
    'CHANNEL_MIRROR',
    'CHANNEL_MIRROR_MAX_BYTES',
    'CHANNEL_INTERIM_MIRROR',
    'CHANNEL_INTERIM_POLL_MS',
    'CHANNEL_TASK_NOTIFICATION',
    'CHANNEL_BROKER_LOG_FILE',
    'CHANNEL_BROKER_LOG_MAX_BYTES',
    'CHANNEL_BROKER_LOG_MAX_FILES',
    'CHANNEL_DISCORD_TOKEN_FILE',
    'CHANNEL_DISCORD_CHANNEL',
    'CHANNEL_DISCORD_REFRESH_MS',
    'CHANNEL_DISCORD_DWELL_MS',
    'CHANNEL_DISCORD_IDLE_AFTER_MS',
    'CHANNEL_DISCORD_EXITED_AFTER_MS',
    'CHANNEL_DISCORD_ARCHIVE_ON_END',
    'CHANNEL_ALLOWED_USER_ID'
)

<#
.SYNOPSIS
Sets every allowlisted key from an env file into the current process's environment.

.DESCRIPTION
A key not on $script:ChannelBrokerEnvAllowlist is skipped with a warning rather than set, and never
silently, since write access to the file this reads from would otherwise be arbitrary environment
injection into the broker process.
#>
function Set-ChannelBrokerEnvironment {
    param([Parameter(Mandatory)][string]$Path)
    $values = Get-ChannelEnvFile -Path $Path
    foreach ($key in $values.Keys) {
        if ($script:ChannelBrokerEnvAllowlist -notcontains $key) {
            Write-Warning ("Set-ChannelBrokerEnvironment: '$key' in '$Path' is not a recognized " +
                "broker setting and was not applied.")
            continue
        }
        Set-Item -Path "env:$key" -Value $values[$key]
    }
}

<#
.SYNOPSIS
True when the current process is running elevated.
#>
function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
.SYNOPSIS
A canonical, order-independent string of every access rule a security descriptor carries.

.DESCRIPTION
Two descriptors describe the same access exactly when this returns the same string for both. Each
rule is reduced to its trustee's security identifier, its rights, its inheritance and propagation
flags, and whether it allows or denies, and the lines are sorted, because Windows canonicalizes a
DACL's order when it writes one and the order carries no meaning here.

Trustees are compared as security identifiers rather than account names: an account name depends on
the display language and on a domain controller being reachable to translate it, and a rule for an
orphaned or cross-machine identity has no name at all.

The whole SDDL string is deliberately not compared instead. Windows sets the auto-inherited flag
(`AI`) on any descriptor that participates in inheritance, so a descriptor read back from disk
differs textually from the identical one held in memory before it was written, in a bit that grants
nobody anything.
#>
function Get-ChannelAccessRuleFingerprint {
    param([Parameter(Mandatory)][System.Security.AccessControl.FileSystemSecurity]$Acl)

    $rules = $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
    $lines = foreach ($rule in $rules) {
        '{0}|{1}|{2}|{3}|{4}' -f $rule.IdentityReference.Value,
            [int]$rule.FileSystemRights,
            [int]$rule.InheritanceFlags,
            [int]$rule.PropagationFlags,
            [int]$rule.AccessControlType
    }
    return (($lines | Sort-Object) -join "`n")
}

<#
.SYNOPSIS
How many access rules a security descriptor reports through the managed access-rule API.
#>
function Get-ChannelAccessRuleCount {
    param([Parameter(Mandatory)][System.Security.AccessControl.FileSystemSecurity]$Acl)
    return @($Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])).Count
}

<#
.SYNOPSIS
How many entries a security descriptor's discretionary access control list actually holds.

.DESCRIPTION
Counted from the raw descriptor, which reports entries structurally, rather than through the managed
access-rule API, which translates them. Comparing the two counts is what keeps the comparison honest
about its own coverage: an entry the managed API declines to surface would otherwise be an entry
nothing in the skip can see, and a descriptor carrying one would compare equal to a target it does
not match. Windows PowerShell 5.1 surfaces callback (conditional) entries through both, so the two
counts agree on every descriptor this installer produces or has been measured against; the check is
what makes a runtime that does not surface one a refusal to skip rather than a silent acceptance.

A descriptor with no discretionary list at all counts as zero entries, which is the honest answer:
a null list grants everyone everything and matches no target this installer writes.
#>
function Get-ChannelRawAceCount {
    param([Parameter(Mandatory)][System.Security.AccessControl.FileSystemSecurity]$Acl)
    $sddl = $Acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($sddl)
    if ($null -eq $raw.DiscretionaryAcl) { return 0 }
    return $raw.DiscretionaryAcl.Count
}

<#
.SYNOPSIS
Hardens a file or directory's ACL to this process's own account, Administrators, and SYSTEM only.

.DESCRIPTION
Refuses a drive root outright and a reparse point (a symlink, junction, or mount point) on either
platform's shape of one, since a link can pass every check below against its current target and
then be re-pointed at an attacker-controlled one the moment after.

Verifies the object's current owner is this process's own account before doing anything else, and
takes ownership if it is not. Two reasons, and the second is why no other owner is tolerated even
though it looks defensible. A file planted by any account on a shared root is owned by that account,
and granting "the owner" access unconditionally would grant that planted file's own author exclusive
control of it, which is the same hole S6 closes on the broker's side of this same check. And the
list this writes names the installing account by its raw security identifier, which
broker/discord/credentials.ts treats as a foreign grant unless that account is the descriptor's
owner: hardening a path owned by anyone else, Administrators included, produces a path that check
then refuses, so a path this function accepted would be one the broker rejects.

Ownership, once taken, stays taken. There is no path through this function that gives it back, so a
later failure leaves the object owned by the installing account rather than by whoever owned it
before.

The discretionary access control list is then replaced wholesale with a freshly built one carrying
exactly three entries: this process's own account, the local Administrators group (S-1-5-32-544),
and SYSTEM (S-1-5-18). Built from scratch rather than edited in place, because enumerating or
translating an existing rule can throw on an orphaned or cross-machine SID, and the only thing this
function needs to know about an old rule is that it is being discarded either way. This is also what
makes the rewrite atomic: the original descriptor is captured first, the new one is prepared
entirely in memory, and the single call that applies it either lands whole or throws.

Both writes here, the ownership change and the descriptor itself, go through the .NET
SetAccessControl on the item rather than Set-Acl, because Set-Acl cannot RE-apply either of them
unelevated. Against a path that is not yet protected it works either way; the difference appears on
every install after the first. Set-Acl writes the descriptor's audit section as well, which needs
SeSecurityPrivilege
whenever the target's DACL is already protected, and step 2 of the install runs unelevated by design.
That requirement is gratuitous here: nothing in this function sets an audit rule. SetAccessControl
writes only the sections the descriptor actually carries, so an already-protected path that has since
been granted an extra trustee is repaired by an ordinary re-install instead of refused, and a planted
file that is both foreign-owned and already protected fails only on whether ownership can really be
taken. SetAccessControl raises a .NET exception, which is terminating in PowerShell whatever the
caller's error preference, so the rollback and the throws below are reached on any failure.

Nothing is written at all when the path is already owned by the installing account and already
carries exactly the target descriptor: rewriting an identical ACL changes nothing and is worth
neither the call nor the risk. "Already carries that descriptor" is decided by comparing the current
access rules against the very object this function would write, not against a separately stated idea
of what hardened means, so the skip cannot be more permissive than the write: an extra trustee, a
missing one, weaker rights, different inheritance, or a DACL still open to inheritance from its
parent all read as a difference and the write goes ahead. A conditional grant to another trustee is
one of those differences: it arrives as an ordinary rule for that trustee and moves the fingerprint.
The rule count is checked against the raw entry count as well, so that the comparison refuses to
skip rather than passing whenever the descriptor holds an entry the managed API did not surface.

A failed descriptor write is followed by a rollback to the original, carrying -ErrorAction Stop so
that its own catch is reachable, and the error this function raises says whether that rollback
succeeded. Set-Acl reports a failure as a non-terminating error by default, which no catch sees and
which would print a raw error over the descriptive one. The rollback is a backstop: each
SetAccessControl above writes one section in one call, so a failed write does not leave a partial
descriptor behind.

This is the same allowlist broker/discord/credentials.ts's assertTokenFileIsProtected checks a token
file and its directory against at startup, so a path this function has processed is a path that
check accepts.

Run this against hooks/, wrapper/, install/, broker/, the bot token file, and the token file's
parent directory. The D: root grants Authenticated Users: Modify by inheritance on at least one
host, and the hook script runs under -ExecutionPolicy Bypass at every session start, and the broker
itself is what a scheduled task executes at every logon, so write access under any of those trees is
code execution in the operator's context.
#>
function Protect-ChannelPath {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Protect-ChannelPath: '$Path' does not exist."
    }
    $resolved = (Resolve-Path -LiteralPath $Path).ProviderPath

    if ($resolved -match '^[A-Za-z]:\\?$') {
        throw "Protect-ChannelPath: refusing to harden the drive root '$resolved'. Point this at " +
            "a specific file or directory beneath it, never a whole drive."
    }

    $item = Get-Item -LiteralPath $resolved -Force
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Protect-ChannelPath: '$resolved' is a reparse point (a symlink, junction, or mount " +
            "point); refusing to harden a path whose target can change after this runs."
    }
    $isContainer = $item.PSIsContainer

    # Captured before any mutation, so a failure below can be rolled back to exactly the state this
    # function found, rather than leaving a path with a DACL granting nobody anything.
    $original = Get-Acl -LiteralPath $resolved

    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $adminGroupSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $permitted = @($currentUserSid, $adminGroupSid, $systemSid)

    # Built before the owner check rather than after it, because it is also what decides whether any
    # write is needed at all.
    $fresh = if ($isContainer) {
        [System.Security.AccessControl.DirectorySecurity]::new()
    } else {
        [System.Security.AccessControl.FileSecurity]::new()
    }
    # isProtected = true blocks future inheritance; preserveInheritance = false is what drops the
    # D:\ root's Authenticated Users: Modify grant outright rather than converting it to an explicit
    # rule of the same shape, which /inheritance:r vs /inheritance:e is the icacls equivalent of.
    $fresh.SetAccessRuleProtection($true, $false)

    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    # A directory's grant must apply to itself and to everything created under it afterward, or a
    # file dropped into a hardened directory tomorrow inherits nothing and is left open; a file's
    # grant is just the file.
    $inheritance = if ($isContainer) {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [System.Security.AccessControl.InheritanceFlags]::None
    }
    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow

    foreach ($sid in $permitted) {
        $fresh.AddAccessRule(
            [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inheritance, $propagation, $allow)
        )
    }

    $ownerIsSelf = $false
    try {
        $ownerSidValue = ([Security.Principal.NTAccount]$original.Owner).Translate([Security.Principal.SecurityIdentifier])
    } catch {
        try {
            $ownerSidValue = [Security.Principal.SecurityIdentifier]::new($original.Owner)
        } catch {
            $ownerSidValue = $null
        }
    }
    if ($null -ne $ownerSidValue -and $currentUserSid.Equals($ownerSidValue)) {
        $ownerIsSelf = $true
    }

    # The installing account as owner and exactly the target rules, with inheritance already
    # blocked, is the state this function exists to produce, so there is nothing for a write to do.
    # This is the ordinary case on every install after the first.
    if ($ownerIsSelf -and
        $original.AreAccessRulesProtected -eq $fresh.AreAccessRulesProtected -and
        (Get-ChannelAccessRuleFingerprint -Acl $original) -eq (Get-ChannelAccessRuleFingerprint -Acl $fresh) -and
        (Get-ChannelRawAceCount -Acl $original) -eq (Get-ChannelAccessRuleCount -Acl $original)) {
        return
    }

    if (-not $ownerIsSelf) {
        try {
            $takeOwnership = Get-Acl -LiteralPath $resolved
            $takeOwnership.SetOwner($currentUserSid)
            $item.SetAccessControl($takeOwnership)
        } catch {
            throw "Protect-ChannelPath: '$resolved' is owned by '$($original.Owner)' rather than " +
                "by this process's own account, and taking ownership of it failed: " +
                "$($_.Exception.Message). The list this writes names the installing account by " +
                "security identifier, which the broker reads as a foreign grant on a path owned by " +
                "anyone else, so this path cannot be brought to standard until it is owned by the " +
                "account installing. Take ownership of it as that account and re-run."
        }
    }

    try {
        $item.SetAccessControl($fresh)
    } catch {
        $failure = $_.Exception.Message
        $rolledBack = $true
        try {
            Set-Acl -LiteralPath $resolved -AclObject $original -ErrorAction Stop
        } catch {
            $rolledBack = $false
        }
        $rollback = if ($rolledBack) {
            "its original access control list is back in place"
        } else {
            "its original access control list could not be put back either, so the path is left as " +
                "the failed write found it"
        }
        throw "Protect-ChannelPath: failed to harden '$resolved' and $rollback`: $failure"
    }
}

<#
.SYNOPSIS
Throws unless every path given is protected to the same standard broker/discord/credentials.ts
enforces on the bot token file at every broker start.

.DESCRIPTION
Shells out to Node and calls assertTokenFileIsProtected directly, rather than restating its SDDL
rules a second time in PowerShell: the two are the same check, on the same kind of path, and a
second implementation is a second place for the allowlist to drift out of step with the first.
Named generically because nothing about the check is specific to a bot token; it is exactly as
applicable to the SessionStart hook script wrapper/Enter-ClaudeSession.ps1's launch-time check
would need to assert its own protection, which is why this lives here rather than inline in
Install-Host.ps1.

Takes the whole set of paths in one call because the caller checks every file under the trees it
hardened, and a Node process per file is most of the cost of doing that. The check reads a path and
the directory holding it, so a directory is covered by any file in it; a directory passed in its own
right is checked against its parent, which is why the caller passes trees from the inside rather
than passing a tree root whose parent it does not own. The first path that fails ends the run, and
the message names it: the failures this catches are configuration, not a list to triage.

$NodePath and $CredentialsScriptPath are overridable so a test can point this at a fixture without
depending on where this checkout's own broker/ lives.
#>
function Assert-ChannelPathProtected {
    param(
        # AllowEmptyCollection so the guard below is the thing that refuses an empty set, with a
        # message saying why it matters. Without it the binder rejects the call first, and a
        # verification pass that looked at nothing would be reported as a parameter error.
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Path,
        [string]$NodePath = 'node',
        [string]$CredentialsScriptPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'broker\discord\credentials.ts')
    )

    if (-not (Test-Path -LiteralPath $CredentialsScriptPath)) {
        throw "Assert-ChannelPathProtected: credentials module not found at '$CredentialsScriptPath'."
    }
    if ($Path.Count -eq 0) {
        throw "Assert-ChannelPathProtected: no paths to check. A verification pass with nothing in " +
            "it reports success without having looked at anything."
    }

    # A tiny inline module: import the real check and run it against each path in turn, so the exit
    # code alone tells the caller pass or refuse and the message names the path that failed.
    $script = 'import(process.argv[1]).then(m => { for (const p of process.argv.slice(2)) m.assertTokenFileIsProtected(p); }).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })'
    $moduleUrl = ([uri]([System.IO.Path]::GetFullPath($CredentialsScriptPath))).AbsoluteUri

    $output = & $NodePath '--input-type=module' '-e' $script $moduleUrl @Path 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Assert-ChannelPathProtected: $output"
    }
}
