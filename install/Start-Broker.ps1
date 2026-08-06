# Runs the broker as source, with the runtime configuration Install-Host.ps1 wrote. This is the
# script the scheduled task actually launches; Register-BrokerTask.ps1 points a task at it.
#
# There is no build step (see the plan's Standing Brief Amendments): the broker is invoked exactly
# as `node broker/index.ts`, the same way a developer runs it by hand, so a scheduled run and a
# manual one are the same command.

param(
    # Defaults to the repository this script lives in, two levels up from install/. Overridable so
    # a test can point this at a fixture tree instead of the real checkout.
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),

    # Defaults to the standard state root so a bare invocation matches what Install-Host.ps1
    # provisions. Overridable for the same reason as $RepoRoot.
    [string]$EnvFile = $null
)

. (Join-Path $PSScriptRoot 'Install-Functions.ps1')

if (-not $EnvFile) {
    $EnvFile = Join-Path (Get-ChannelStateRoot) 'broker.env'
}

$nodePath = 'node'
if (Test-Path -LiteralPath $EnvFile) {
    # Only the allowlisted keys become environment variables; see Set-ChannelBrokerEnvironment for
    # why write access to this file must not be arbitrary environment injection into the process
    # that reads the bot token.
    Set-ChannelBrokerEnvironment -Path $EnvFile
    $raw = Get-ChannelEnvFile -Path $EnvFile
    # Pinned by Install-Host.ps1 at install time rather than resolved from PATH here, under
    # -ExecutionPolicy Bypass, where PATH is whatever the triggering logon happened to carry.
    if ($raw.Contains('CHANNEL_NODE_EXE') -and -not [string]::IsNullOrWhiteSpace($raw['CHANNEL_NODE_EXE'])) {
        $nodePath = $raw['CHANNEL_NODE_EXE']
    }
} else {
    # No config yet is not fatal: the broker starts with every knob at its default (see
    # broker/config.ts), which is a registry-only broker with no Discord surfaces, exactly like a
    # local debugging run. Install-Host.ps1 is what makes this file exist.
    Write-Warning "Start-Broker: no config at '$EnvFile'; starting with defaults (no Discord surfaces)."
}

$brokerEntry = Join-Path $RepoRoot 'broker\index.ts'
if (-not (Test-Path -LiteralPath $brokerEntry)) {
    throw "Start-Broker: broker entry point not found at '$brokerEntry'. Is `$RepoRoot correct?"
}

& $nodePath $brokerEntry
exit $LASTEXITCODE
