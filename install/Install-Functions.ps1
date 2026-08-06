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
this project sets; and an allowedEnvVars entry must be one of the two variables those headers
interpolate, since that list is what authorizes an environment variable to be read into a request at
all. settings-fragment.test.ts pins the same shapes, but it runs in this repository, not on the host
at install time, which is where the fragment is read.
#>
$script:AllowedChannelPermissionRules = @('mcp__channel-relay__reply')

function Assert-ValidChannelFragment {
    param([Parameter(Mandatory)][hashtable]$Fragment)

    $allowedEvents = @('SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop')
    $allowedTypes = @('command', 'http')
    $allowedUrl = '^http://127\.0\.0\.1:\d+/(hook|mirror)\z'
    $allowedHeaders = @('X-Channel-Hook-Event', 'X-Channel-Process-Token', 'X-Channel-Session-Name')
    $allowedEnvVars = @('CHANNEL_PROCESS_TOKEN', 'CHANNEL_SESSION')

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
        if ($script:AllowedChannelPermissionRules -notcontains [string]$rule) {
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
                "'$eventName'. Only SessionStart, UserPromptSubmit, PostToolUse, and Stop are merged."
        }
        foreach ($entry in @($Fragment['hooks'][$eventName])) {
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
                    if ($null -ne $hook['headers']) {
                        foreach ($headerName in @($hook['headers'].Keys)) {
                            if ($allowedHeaders -notcontains [string]$headerName) {
                                throw "Assert-ValidChannelFragment: the fragment's $eventName hook " +
                                    "sets a header this installer does not merge: '$headerName'. " +
                                    "Only $($allowedHeaders -join ', ') are this project's own."
                            }
                        }
                    }
                    foreach ($envVar in @($hook['allowedEnvVars'])) {
                        if ($null -eq $envVar) { continue }
                        if ($allowedEnvVars -notcontains [string]$envVar) {
                            throw "Assert-ValidChannelFragment: the fragment's $eventName hook " +
                                "authorizes an environment variable this installer does not merge: " +
                                "'$envVar'. Only $($allowedEnvVars -join ', ') are read into a " +
                                "request, and the list is what permits a variable to be read at all."
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
Hardens a file or directory's ACL to this process's own account, Administrators, and SYSTEM only.

.DESCRIPTION
Refuses a drive root outright and a reparse point (a symlink, junction, or mount point) on either
platform's shape of one, since a link can pass every check below against its current target and
then be re-pointed at an attacker-controlled one the moment after.

Verifies the object's current owner is this process's own account or an administrative identity
before doing anything else, and takes ownership if it is not: a file planted by any account on a
shared root is owned by that account, and granting "the owner" access unconditionally would grant
that planted file's own author exclusive control of it, which is the same hole S6 closes on the
broker's side of this same check.

The discretionary access control list is then replaced wholesale with a freshly built one carrying
exactly three entries: this process's own account, the local Administrators group (S-1-5-32-544),
and SYSTEM (S-1-5-18). Built from scratch rather than edited in place, because enumerating or
translating an existing rule can throw on an orphaned or cross-machine SID, and the only thing this
function needs to know about an old rule is that it is being discarded either way. This is also what
makes the rewrite atomic: the original descriptor is captured first, the new one is prepared
entirely in memory, and the single Set-Acl call that applies it either lands whole or throws, with
the original restored in the catch.

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

    $ownerIsPermitted = $false
    try {
        $ownerSidValue = ([Security.Principal.NTAccount]$original.Owner).Translate([Security.Principal.SecurityIdentifier])
    } catch {
        try {
            $ownerSidValue = [Security.Principal.SecurityIdentifier]::new($original.Owner)
        } catch {
            $ownerSidValue = $null
        }
    }
    if ($null -ne $ownerSidValue -and ($permitted | Where-Object { $_.Equals($ownerSidValue) })) {
        $ownerIsPermitted = $true
    }

    if (-not $ownerIsPermitted) {
        try {
            $takeOwnership = Get-Acl -LiteralPath $resolved
            $takeOwnership.SetOwner($currentUserSid)
            Set-Acl -LiteralPath $resolved -AclObject $takeOwnership
        } catch {
            throw "Protect-ChannelPath: '$resolved' is owned by '$($original.Owner)', which is " +
                "neither this process's account nor an administrative identity, and taking " +
                "ownership of it failed: $($_.Exception.Message). Run this elevated, or take " +
                "ownership of the path manually before installing."
        }
    }

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

    try {
        Set-Acl -LiteralPath $resolved -AclObject $fresh
    } catch {
        try { Set-Acl -LiteralPath $resolved -AclObject $original } catch {
            # The restore itself failing is reported alongside the original failure below; there is
            # nothing further this function can do about a path it can no longer write an ACL to.
        }
        throw "Protect-ChannelPath: failed to harden '$resolved' and restored its original ACL: $($_.Exception.Message)"
    }
}

<#
.SYNOPSIS
Throws unless a path is protected to the same standard broker/discord/credentials.ts enforces on
the bot token file at every broker start.

.DESCRIPTION
Shells out to Node and calls assertTokenFileIsProtected directly, rather than restating its SDDL
rules a second time in PowerShell: the two are the same check, on the same kind of path, and a
second implementation is a second place for the allowlist to drift out of step with the first.
Named generically because nothing about the check is specific to a bot token; it is exactly as
applicable to the SessionStart hook script wrapper/Enter-ClaudeSession.ps1's launch-time check
would need to assert its own protection, which is why this lives here rather than inline in
Install-Host.ps1.

$NodePath and $CredentialsScriptPath are overridable so a test can point this at a fixture without
depending on where this checkout's own broker/ lives.
#>
function Assert-ChannelPathProtected {
    param(
        [Parameter(Mandatory)][string]$Path,
        [string]$NodePath = 'node',
        [string]$CredentialsScriptPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'broker\discord\credentials.ts')
    )

    if (-not (Test-Path -LiteralPath $CredentialsScriptPath)) {
        throw "Assert-ChannelPathProtected: credentials module not found at '$CredentialsScriptPath'."
    }

    # A tiny inline module: import the real check and run it against the one path this call cares
    # about, so the exit code alone tells the caller pass or refuse without parsing any output.
    $script = 'import(process.argv[1]).then(m => m.assertTokenFileIsProtected(process.argv[2])).catch(e => { console.error(String(e && e.message || e)); process.exit(1); })'
    $moduleUrl = ([uri]([System.IO.Path]::GetFullPath($CredentialsScriptPath))).AbsoluteUri

    $output = & $NodePath '--input-type=module' '-e' $script $moduleUrl $Path 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Assert-ChannelPathProtected: '$Path' is not protected: $output"
    }
}
