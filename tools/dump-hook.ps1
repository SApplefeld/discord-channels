# Appends each hook payload it receives, one JSON object per line, to hook-capture.jsonl
# beside this script. Used by the operator checks in docs/operator-checks.md.
#
# Exits zero and silently no matter what, so a capture failure can never disturb the session
# being observed.

try {
    $stdin = [Console]::In.ReadToEnd()
    if (-not [string]::IsNullOrWhiteSpace($stdin)) {
        Add-Content -Path (Join-Path $PSScriptRoot 'hook-capture.jsonl') -Value $stdin.Trim() -Encoding utf8
    }
} catch { }

exit 0
