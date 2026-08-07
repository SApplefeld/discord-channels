<#
.SYNOPSIS
Provisions this host to run the broker: config, the merged hook settings, and hardened ACLs.

.DESCRIPTION
Writes the broker's runtime configuration to %LOCALAPPDATA%\sapplefeld-channels\broker.env, outside
the repository. Substitutes this checkout's absolute SessionStart script path into the hooks
fragment, validates its shape, and merges it into the user-level Claude Code settings file
(~/.claude/settings.json), backing that file up first. Hardens the ACL on the whole execution
surface a scheduled task and a Bypass-executed hook depend on: hooks/, wrapper/, install/, broker/,
the bot token file, and the state root that holds it, so only this process's own account,
Administrators, and SYSTEM can read or write any of them.

Does not register the scheduled task; run Register-BrokerTask.ps1 separately, from an elevated
session, once this has completed.

.PARAMETER HostName
The label this host's sessions carry on every surface. One of NEO, ASR, or SCOTT per the plan, but
not restricted to those: an unrecognized value is still a valid CHANNEL_HOST_NAME, it just needs an
entry in wrapper/Enter-ClaudeSession.ps1's channel-flag table to launch a session from.

.PARAMETER ChannelId
The Discord channel this host's threads are opened in. A snowflake (17-20 digits).

.PARAMETER AllowedUserId
The Discord user ID allowed to send this host's sessions messages and approve their permission
prompts. A snowflake. Stored in the same config file the broker reads, where its sender gate is the
only thing that admits an inbound message. A broker with a Discord connection refuses to start
without it.

.PARAMETER BotToken
The bot token, as a SecureString rather than plain text: a plain-text parameter lands in
PSReadLine's history file indefinitely, in the process command line for the life of the process, and
in any transcript. Prompted for with Read-Host -AsSecureString when neither this nor -BotTokenFile is
given. Written to a file inside the state root and hardened immediately, before this script does
anything else with it. Mutually exclusive with -BotTokenFile.

.PARAMETER BotTokenFile
Path to an existing file already holding the bot token. Must resolve inside the state root
(-StateRoot); a token file anywhere else is refused rather than hardened in place, because hardening
an operator-chosen directory outside the root this installer owns is how a `-BotTokenFile D:\token.txt`
strips a whole drive's ACL down to three entries. Mutually exclusive with -BotToken.

.PARAMETER Port
The broker's listening port. Must equal the port already baked into every http hook URL in
hooks/settings-fragment.json, because nothing here rewrites hooks/session-start.ps1's own copy of
that literal, and settings-fragment.test.ts pins broker/config.ts's DEFAULT_PORT against both. A
-Port that disagreed with the fragment would open the broker on one port while every hook posts into
another, failing silently. Defaults to the fragment's own literal.

.PARAMETER RepoRoot
This checkout's root, defaulting to the directory this script's parent lives in. Overridable so a
test can point this at a fixture tree instead of the real checkout.

.PARAMETER SettingsPath
The Claude Code user settings file to merge into. Defaults to ~/.claude/settings.json. Overridable
so a test never writes to the operator's real settings file.

.PARAMETER StateRoot
Where the config file, token file, and (once the broker runs) its state and log files live, and the
root -BotTokenFile must resolve inside. Defaults to Get-ChannelStateRoot
(%LOCALAPPDATA%\sapplefeld-channels). Overridable for the same reason as -SettingsPath.

.PARAMETER SkipAcl
Skips every ACL hardening step. Refuses to run at all when a token is being provisioned (from either
-BotToken or -BotTokenFile), because a credential file this installer chose not to protect is worse
than one it never touched. For a test run against a fixture tree with no token involved, where
hardening the fixture's own ACL is not the thing under test.

.PARAMETER SkipNpmCi
Skips `npm ci`. For a test run, where installing the real dependency tree is not the thing under
test and is slow to repeat.
#>
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$HostName,

    [Parameter(Mandatory)]
    [ValidatePattern('^\d{17,20}$')]
    [string]$ChannelId,

    [Parameter(Mandatory)]
    [ValidatePattern('^\d{17,20}$')]
    [string]$AllowedUserId,

    [System.Security.SecureString]$BotToken,

    [string]$BotTokenFile,

    [Nullable[int]]$Port,

    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),

    [string]$SettingsPath = (Join-Path $HOME '.claude\settings.json'),

    [string]$StateRoot,

    [switch]$SkipAcl,

    [switch]$SkipNpmCi
)

. (Join-Path $PSScriptRoot 'Install-Functions.ps1')

if ($BotToken -and $BotTokenFile) {
    throw "Install-Host: pass -BotToken or -BotTokenFile, not both."
}
if ($SkipAcl -and ($BotToken -or $BotTokenFile)) {
    throw "Install-Host: -SkipAcl cannot be combined with a token. A credential file this " +
        "installer left unprotected is worse than one it never wrote; run without -SkipAcl, or " +
        "without a token for a dry run against a fixture tree."
}

if (-not $StateRoot) { $StateRoot = Get-ChannelStateRoot }
if (-not (Test-Path -LiteralPath $StateRoot)) {
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
}

if (-not $BotToken -and -not $BotTokenFile) {
    $BotToken = Read-Host -AsSecureString -Prompt 'Discord bot token'
}

# The token file. Written and hardened back to back, with nothing else run in between: a comment
# claiming there is no window between the write and the guard is only true if nothing actually runs
# there, so nothing does. A pre-existing file named by -BotTokenFile is hardened where it is, once
# that location is confirmed to be inside the root this installer owns.
$tokenFile = if ($BotTokenFile) { $BotTokenFile } else { Join-Path $StateRoot 'discord-token.txt' }
if ($BotToken) {
    # Converted to plain text only for the instant it takes to write the file. SecureString does not
    # make the token unrecoverable in memory, but it does keep it off the command line, out of
    # PSReadLine's history, and out of a transcript, which a [string] parameter cannot.
    $plainToken = [System.Net.NetworkCredential]::new('', $BotToken).Password
    try {
        Set-Utf8NoBomFile -Path $tokenFile -Content $plainToken
    } finally {
        $plainToken = $null
    }
}
if (-not (Test-Path -LiteralPath $tokenFile)) {
    throw "Install-Host: token file '$tokenFile' does not exist."
}

$resolvedStateRoot = (Resolve-Path -LiteralPath $StateRoot).ProviderPath
$tokenDirectory = Split-Path -Parent (Resolve-Path -LiteralPath $tokenFile).ProviderPath
$insideStateRoot = $tokenDirectory -eq $resolvedStateRoot -or
    $tokenDirectory.StartsWith("$resolvedStateRoot\", [StringComparison]::OrdinalIgnoreCase)
if (-not $SkipAcl -and -not $insideStateRoot) {
    throw "Install-Host: the token file '$tokenFile' is outside the state root " +
        "'$resolvedStateRoot'. Hardening an operator-chosen directory outside the root this " +
        "installer owns is how a token file at a drive root strips the whole drive's ACL down to " +
        "three entries. Move the token file into the state root (or pass -StateRoot to match " +
        "wherever it already lives) and re-run."
}

$sessionStartScript = Join-Path $RepoRoot 'hooks\session-start.ps1'
# Claude Code runs this at the start of every session on the machine, from the user-level settings
# file, so it is hardened alongside the hook script rather than trusted.
$relayScript = Join-Path $RepoRoot 'relay\index.ts'
$wrapperScript = Join-Path $RepoRoot 'wrapper\Enter-ClaudeSession.ps1'
$hooksDir = Join-Path $RepoRoot 'hooks'
$relayDir = Join-Path $RepoRoot 'relay'
$wrapperDir = Join-Path $RepoRoot 'wrapper'
$installDir = Join-Path $RepoRoot 'install'
$brokerDir = Join-Path $RepoRoot 'broker'
foreach ($required in @($sessionStartScript, $relayScript, $wrapperScript, $hooksDir, $relayDir, $wrapperDir, $installDir, $brokerDir)) {
    if (-not (Test-Path -LiteralPath $required)) {
        throw "Install-Host: expected path not found at '$required'. Is -RepoRoot correct?"
    }
}

$fragmentPath = Join-Path $RepoRoot 'hooks\settings-fragment.json'
if (-not (Test-Path -LiteralPath $fragmentPath)) {
    throw "Install-Host: expected file not found at '$fragmentPath'. Is -RepoRoot correct?"
}

# The port every http hook in the fragment already posts to. hooks/session-start.ps1 carries the
# same literal, hardcoded and unmoved by this installer, so -Port is validated against the fragment
# rather than substituted into it: rewriting the fragment's copies and not the script's would
# silently reintroduce exactly the drift settings-fragment.test.ts's port pin exists to catch.
#
# Every http url is read, not one of them. The broker is opened on the port this resolves to, so a
# single url checked here would leave the other hooks free to name a different local port: whatever
# is listening there would receive this machine's console prompts, assistant replies, and process
# token, from a fragment that installs cleanly and a broker that runs healthy on the real port.
$fragmentPreview = ConvertTo-OrderedHashtable (Get-Content -LiteralPath $fragmentPath -Raw | ConvertFrom-Json)
$fragmentPort = $null
foreach ($eventName in $fragmentPreview['hooks'].Keys) {
    foreach ($entry in @($fragmentPreview['hooks'][$eventName])) {
        foreach ($hook in @($entry['hooks'])) {
            # SessionStart's is a command hook and has no url to read.
            if ([string]$hook['type'] -ne 'http') { continue }
            $hookPort = [int]([uri][string]$hook['url']).Port
            if ($null -eq $fragmentPort) { $fragmentPort = $hookPort }
            if ($hookPort -ne $fragmentPort) {
                throw "Install-Host: the http hooks in '$fragmentPath' do not agree on a port " +
                    "($fragmentPort and $hookPort). The broker is opened on one port, so the hooks " +
                    "naming another would post this machine's hook traffic, and the mirror's " +
                    "content, to whatever is listening there. Fix the fragment before installing."
            }
        }
    }
}
if ($null -eq $fragmentPort) {
    throw "Install-Host: '$fragmentPath' declares no http hook, so there is no port to install " +
        "against. A fragment without them installs a session announcement and nothing that reports " +
        "a session is alive."
}
if (-not $Port) { $Port = $fragmentPort }
if ($Port -ne $fragmentPort) {
    throw "Install-Host: -Port $Port disagrees with the port already baked into " +
        "'$fragmentPath' ($fragmentPort). Nothing here rewrites hooks/session-start.ps1's own " +
        "copy of that literal, so a different port here would open the broker on one port while " +
        "every hook posts into another. Change the fragment (and session-start.ps1, and " +
        "broker/config.ts's DEFAULT_PORT) if the port must move; do not pass a different one here."
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
    throw "Install-Host: no 'node' found on PATH. install/Start-Broker.ps1 needs an absolute path " +
        "pinned at install time, rather than resolving 'node' from PATH itself under " +
        "-ExecutionPolicy Bypass at every logon."
}
$nodePath = $nodeCommand.Source

if (-not $SkipAcl) {
    # The whole execution surface a scheduled task and a Bypass-executed hook depend on: the hook
    # script and the wrapper (Chapter 3/4), and now install/ and broker/ too, since Register-
    # BrokerTask.ps1 points a scheduled task at install/Start-Broker.ps1, which runs broker/index.ts,
    # and neither was hardened before. Directories are hardened as containers so a file added to
    # either tree later inherits the same three-trustee grant rather than arriving open.
    Protect-ChannelPath -Path $hooksDir
    # relay/ joins them: the merged settings file names relay\index.ts as an MCP server command, so
    # Claude Code executes it at the start of every session on the machine.
    Protect-ChannelPath -Path $relayDir
    Protect-ChannelPath -Path $wrapperDir
    Protect-ChannelPath -Path $installDir
    Protect-ChannelPath -Path $brokerDir
    Protect-ChannelPath -Path $tokenFile
    # The state root unconditionally, not only "the token's parent directory": with -BotTokenFile
    # pointed elsewhere inside the root, or with no token at all, broker.env, the broker's state
    # file, and its log file still live here and are still worth the same three-trustee grant.
    Protect-ChannelPath -Path $resolvedStateRoot
}

$envFile = Join-Path $StateRoot 'broker.env'
Set-ChannelEnvFile -Path $envFile -Values ([ordered]@{
    CHANNEL_HOST_NAME          = $HostName
    CHANNEL_BROKER_PORT        = $Port
    CHANNEL_DISCORD_CHANNEL    = $ChannelId
    CHANNEL_DISCORD_TOKEN_FILE = $tokenFile
    # The broker's sender gate checks every inbound message's author against this, and refuses to
    # start without it whenever Discord is configured.
    CHANNEL_ALLOWED_USER_ID    = $AllowedUserId
    CHANNEL_BROKER_LOG_FILE    = (Join-Path $StateRoot 'broker.log')
    CHANNEL_BROKER_STATE       = (Join-Path $StateRoot 'broker-state.json')
    # Pinned rather than left to Start-Broker.ps1 to resolve from PATH under -ExecutionPolicy
    # Bypass at every logon, where PATH is whatever the triggering logon happened to carry.
    CHANNEL_NODE_EXE           = $nodePath
    # The account Register-BrokerTask.ps1 is told to run the scheduled task as. Recorded here, not
    # only passed at registration time, so a mismatch between the account that installed (and so
    # owns every hardened path) and the account the task actually runs as is something an operator
    # reading this file, or later code, can detect instead of the broker simply failing to read its
    # own token file with no signal pointing back at this.
    CHANNEL_TASK_USER          = [Security.Principal.WindowsIdentity]::GetCurrent().Name
})

$fragment = Get-SubstitutedFragment -FragmentPath $fragmentPath -SessionStartScriptPath $sessionStartScript
Merge-ChannelSettingsFile -SettingsPath $SettingsPath -Fragment $fragment | Out-Null

if (-not $SkipNpmCi) {
    # Not `npm install`: an install host resolves exactly the reviewed lockfile rather than
    # whatever a dependency's newer compatible version happens to be on install day.
    Push-Location $RepoRoot
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { throw "Install-Host: 'npm ci' failed with exit code $LASTEXITCODE." }
    } finally {
        Pop-Location
    }
}

Write-Host "Provisioned '$HostName': config at '$envFile', hooks merged into '$SettingsPath'."
# The env file path is printed into the command rather than left to the elevated session to resolve:
# that session may belong to a different account, whose %LOCALAPPDATA% is a different profile, and
# the task's broker has no user profile of its own to fall back on.
Write-Host ("Run install\Register-BrokerTask.ps1 -User '$([Security.Principal.WindowsIdentity]::GetCurrent().Name)' " +
    "-EnvFile '$envFile' from an elevated session to install the scheduled task.")
