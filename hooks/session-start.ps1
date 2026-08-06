# SessionStart command hook. Reads the hook payload from stdin, adds the same three identity
# headers described in broker/intake.ts, and posts it to the broker.
#
# Exits zero and silently no matter what: a broker that is down, refuses the connection, times out,
# or answers a non-2xx status must never slow or block session startup. An `http` hook gets that for
# free (documented as non-blocking); this script is what gives the `command` hook the same property,
# because SessionStart cannot be an `http` hook (it does not deliver over that transport, per the
# broker's SessionStart/http probe). session-start.test.ts holds both halves of that property.
#
# CHANNEL_PROCESS_TOKEN and CHANNEL_SESSION come from this process's own environment, inherited from
# the launch wrapper (wrapper/Enter-ClaudeSession.ps1), not from the hook payload.
#
# hooks/settings-fragment.json belongs in the user-level settings file, so this hook runs for every
# Claude Code session on the machine, including ones started without the wrapper. Those have no
# process token, are not being watched, and exit below without opening a socket.

$ProgressPreference = 'SilentlyContinue'

# The port is a literal rather than an environment override on purpose. Every `http` hook in
# hooks/settings-fragment.json carries its port inside a URL that no environment variable can move,
# so an override honored here and nowhere else produces the worst reachable state: the session
# announces itself, then never sends another event, and the broker's sweep marks a working session
# stale. One literal, pinned against broker/config.ts's DEFAULT_PORT and every http hook URL in the
# fragment by settings-fragment.test.ts, means all three move together or the gate fails.
$brokerPort = 8787

try {
    if ([string]::IsNullOrWhiteSpace($env:CHANNEL_PROCESS_TOKEN)) { exit 0 }

    # Read stdin as bytes and post them unchanged. Windows PowerShell 5.1 decodes redirected stdin
    # with the console codepage (IBM437 on this fleet) and re-encodes a string body as Latin-1, so
    # round-tripping the payload through a [string] corrupts every non-ASCII byte in it. The payload
    # carries `cwd` and `transcript_path`, which can hold non-ASCII, so this is the difference
    # between forwarding the hook payload and forwarding a mangled copy of it.
    $buffer = New-Object System.IO.MemoryStream
    ([Console]::OpenStandardInput()).CopyTo($buffer)
    $body = $buffer.ToArray()
    if ($body.Length -eq 0) { exit 0 }

    $headers = @{
        'X-Channel-Hook-Event'    = 'SessionStart'
        'X-Channel-Process-Token' = $env:CHANNEL_PROCESS_TOKEN
    }
    # Only ASCII reaches a header value. Invoke-RestMethod rejects a non-ASCII one client-side,
    # before opening the socket, and that throw would land in the catch below and take the whole
    # announcement with it: the session would never reach the registry and nothing would say so.
    # The wrapper validates -Name to keep this unreachable; this is the second line, and it drops
    # only the name rather than the announcement.
    if ($env:CHANNEL_SESSION -match '^[\x20-\x7E]+$') {
        $headers['X-Channel-Session-Name'] = $env:CHANNEL_SESSION
    }

    Invoke-RestMethod `
        -Uri "http://127.0.0.1:$brokerPort/hook" `
        -Method Post `
        -Headers $headers `
        -ContentType 'application/json; charset=utf-8' `
        -Body $body `
        -TimeoutSec 2 | Out-Null
} catch {
    # Broker down, connection refused, DNS failure, non-2xx, timeout, or malformed stdin: all land
    # here and are swallowed. Silent and non-blocking is the entire point of this hook. Nothing is
    # written to stdout in any path, because a SessionStart hook's stdout is injected into the
    # session's context, so a diagnostic here would become model input on every launch.
}

exit 0
