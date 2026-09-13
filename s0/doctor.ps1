# EAI 2026 - Session 0 environment doctor (PowerShell).
#
# Seven checks. Every failure names what is wrong and what to do about it.
# The last line is always "DOCTOR: PASS" or "DOCTOR: FAIL (n checks)".
# Exit code is 0 on PASS, 1 on FAIL.
#
# Targets Windows PowerShell 5.1, which is what ships with Windows - so no
# ternary operator, no ?? and no -AsHashtable in here. Deliberately ASCII
# only: PS 5.1 reads .ps1 files as ANSI unless they carry a BOM, and a stray
# accented character turns into mojibake on somebody's machine.
#
# Its output is kept identical to doctor.sh - if you change one, change both.
#
#   Run it with:  .\doctor.ps1
#   If Windows refuses to run the script, see README.md (execution policy).

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Continue'

# Work from the directory this script lives in, so it can be called from anywhere.
Set-Location -LiteralPath $PSScriptRoot

$MARKER      = 'EAI-2026-S0-OK'
$MIN_FREE_GB = 5
$TOTAL       = 7
$SERVICES    = @('echo', 'postgres')

$script:failed  = 0
$script:skipped = 0

# ---------------------------------------------------------------- output ----

function Write-Head($n, $name) { Write-Host ("[{0}/{1}] {2,-32}" -f $n, $TOTAL, $name) -NoNewline }
function Write-Pass()          { Write-Host 'PASS' }
function Write-Fail()          { Write-Host 'FAIL'; $script:failed  = $script:failed  + 1 }
function Write-Skip()          { Write-Host 'SKIP'; $script:skipped = $script:skipped + 1 }
function Write-Why($t)         { Write-Host ('      why:  ' + $t) }
function Write-Fix($t)         { Write-Host ('      fix:  ' + $t) }
function Write-And($t)         { Write-Host ('            ' + $t) }

# ----------------------------------------------------------------- utils ----

# Runs a native command and returns @{ Out = <trimmed stdout+stderr>; Code = <exit code> }.
#
# The argument list is passed as ONE array on purpose. With
# ValueFromRemainingArguments, PowerShell would bind "-d" to the common
# -Debug parameter by prefix match and quietly drop it from the command line.
#
# 2>&1 on a native exe wraps stderr lines in ErrorRecords under PS 5.1, so
# every item is cast back to a string before use.
function Invoke-Native([string[]] $Argv) {
    $exe  = $Argv[0]
    $rest = @()
    if ($Argv.Count -gt 1) { $rest = $Argv[1..($Argv.Count - 1)] }
    $raw  = & $exe @rest 2>&1
    $code = $LASTEXITCODE
    $text = ''
    if ($null -ne $raw) { $text = ((@($raw) | ForEach-Object { $_.ToString() }) -join "`n") }
    return @{ Out = $text.Trim(); Code = $code }
}

function Get-ContainerId([string] $svc) {
    # -a, or a stopped container looks like one that was never created.
    $r = Invoke-Native @('docker', 'compose', 'ps', '-a', '-q', $svc)
    if ($r.Code -ne 0) { return '' }
    $lines = @($r.Out -split "`n" | Where-Object { $_.Trim() -ne '' })
    if ($lines.Count -eq 0) { return '' }
    return ([string] $lines[0]).Trim()
}

function Test-TcpOpen([int] $port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(3000, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

Write-Host 'EAI 2026 - Session 0 doctor'
Write-Host '==========================='
Write-Host ''

# --------------------------------------------- 1. Docker daemon reachable ----

$dockerOk = $false
Write-Head 1 'Docker daemon reachable'
if ($null -eq (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail
    Write-Why 'the "docker" command was not found on your PATH'
    Write-Fix 'Install Docker Desktop (Windows, macOS) or Docker Engine (Linux),'
    Write-And 'then close this terminal and open a new one so that PATH is picked'
    Write-And 'up. See README.md for the download links.'
} else {
    $r = Invoke-Native @('docker', 'info', '--format', '{{.ServerVersion}}')
    if ($r.Code -ne 0 -or $r.Out -eq '') {
        Write-Fail
        Write-Why 'the docker command works but the daemon is not answering'
        Write-Fix 'Start Docker Desktop and wait until the whale icon stops animating,'
        Write-And 'then run the doctor again. On Linux: sudo systemctl start docker,'
        Write-And 'and make sure you are in the docker group -'
        Write-And 'sudo usermod -aG docker $USER, then log out and back in.'
    } else {
        Write-Pass
        $dockerOk = $true
    }
}

# -------------------------------------------------- 2. Compose v2 present ----

$composeOk = $false
Write-Head 2 'Compose v2 present'
if (-not $dockerOk) {
    Write-Skip
    Write-Why 'not checked, because check 1 did not pass'
} else {
    $r  = Invoke-Native @('docker', 'compose', 'version', '--short')
    $cv = $r.Out
    if ($cv.StartsWith('v')) { $cv = $cv.Substring(1) }
    $major = @($cv -split '\.')[0]
    if ($r.Code -ne 0 -or $cv -eq '') {
        Write-Fail
        Write-Why '"docker compose" is not available'
        Write-Fix 'You probably have only the legacy standalone docker-compose (v1),'
        Write-And 'which this course does not use. Update Docker Desktop to a'
        Write-And 'current version, or install the Compose plugin:'
        Write-And 'https://docs.docker.com/compose/install/'
    } elseif (($major -notmatch '^\d+$') -or ([int] $major -lt 2)) {
        Write-Fail
        Write-Why ("Compose reports version {0}, which is older than v2" -f $cv)
        Write-Fix 'Update Docker Desktop, or install the current Compose plugin:'
        Write-And 'https://docs.docker.com/compose/install/'
    } else {
        Write-Pass
        $composeOk = $true
    }
}

# --------------------------------------------- 3. Both containers running ----

$runningOk = $false
Write-Head 3 'Both containers running'
if (-not $composeOk) {
    Write-Skip
    Write-Why 'not checked, because check 2 did not pass'
} else {
    $stopped = ''
    $present = 0
    foreach ($svc in $SERVICES) {
        $cid = Get-ContainerId $svc
        if ($cid -eq '') {
            $stopped = $stopped + ' ' + $svc + ' (not created)'
        } else {
            $present = $present + 1
            $r  = Invoke-Native @('docker', 'inspect', '--format', '{{.State.Status}}', $cid)
            $st = $r.Out
            if ($r.Code -ne 0 -or $st -eq '') { $st = 'unknown' }
            if ($st -ne 'running') {
                $stopped = $stopped + ' ' + $svc + ' (' + $st + ')'
            }
        }
    }
    if ($stopped -eq '') {
        Write-Pass
        $runningOk = $true
    } else {
        Write-Fail
        Write-Why ('not running:' + $stopped)
        if ($present -eq 0) {
            Write-Fix 'run "make up" - this stack has never been started, or it was'
            Write-And 'removed by "make nuke". Then run the doctor again.'
        } else {
            Write-Fix 'run "make up" to bring the stopped container back, then run'
            Write-And 'the doctor again. If it will not stay up, run "make logs" and'
            Write-And 'look for a port conflict - another Postgres or web server on'
            Write-And 'your machine may already hold 5432 or 8080.'
        }
    }
}

# --------------------------------------------- 4. Both containers healthy ----

Write-Head 4 'Both containers healthy'
if (-not $runningOk) {
    Write-Skip
    Write-Why 'not checked, because check 3 did not pass'
} else {
    $unhealthy = ''
    $starting  = $false
    foreach ($svc in $SERVICES) {
        $cid = Get-ContainerId $svc
        $fmt = '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
        $r   = Invoke-Native @('docker', 'inspect', '--format', $fmt, $cid)
        $hs  = $r.Out
        if ($r.Code -ne 0 -or $hs -eq '') { $hs = 'unknown' }
        if ($hs -ne 'healthy') {
            $unhealthy = $unhealthy + ' ' + $svc + ' (' + $hs + ')'
            if ($hs -eq 'starting') { $starting = $true }
        }
    }
    if ($unhealthy -eq '') {
        Write-Pass
    } else {
        Write-Fail
        Write-Why ('not healthy:' + $unhealthy)
        if ($starting) {
            Write-Fix 'the container is still starting up. Wait 20 seconds and run'
            Write-And 'the doctor again. Postgres needs a moment on first start,'
            Write-And 'because it has to create the database and run the seed.'
        } else {
            Write-Fix 'run "make logs" and read the last 20 lines for that service.'
            Write-And 'A healthcheck reporting "unhealthy" means the process inside'
            Write-And 'the container started and then broke. "make nuke" followed'
            Write-And 'by "make up" resolves most first-run cases.'
        }
    }
}

# ------------------------------------------ 5. Ports 8080 and 5432 on host ----

Write-Head 5 'Ports 8080 and 5432 bound'
if (-not $runningOk) {
    Write-Skip
    Write-Why 'not checked, because check 3 did not pass'
} else {
    $badPorts = ''
    $pubEcho  = (Invoke-Native @('docker', 'compose', 'port', 'echo', '80')).Out
    $pubPg    = (Invoke-Native @('docker', 'compose', 'port', 'postgres', '5432')).Out
    if (-not $pubEcho.EndsWith(':8080')) { $badPorts = $badPorts + ' 8080 (not published)' }
    if (-not $pubPg.EndsWith(':5432'))   { $badPorts = $badPorts + ' 5432 (not published)' }
    if ($badPorts -eq '') {
        if (-not (Test-TcpOpen 8080)) { $badPorts = $badPorts + ' 8080 (published, refuses connections)' }
        if (-not (Test-TcpOpen 5432)) { $badPorts = $badPorts + ' 5432 (published, refuses connections)' }
    }
    if ($badPorts -eq '') {
        Write-Pass
    } else {
        Write-Fail
        Write-Why ('unreachable on 127.0.0.1:' + $badPorts)
        Write-Fix 'Another program is probably already holding that port. Find it -'
        Write-And 'Windows:      netstat -ano | findstr :5432'
        Write-And 'macOS, Linux: lsof -i :5432'
        Write-And 'Stop that program - a locally installed Postgres is the usual'
        Write-And 'culprit - then run "make down" and "make up" again.'
    }
}

# -------------------------------------- 6. Seed row readable from Postgres ----

Write-Head 6 'Seed row readable from Postgres'
if (-not $runningOk) {
    Write-Skip
    Write-Why 'not checked, because check 3 did not pass'
} else {
    $sql = 'select marker from preflight limit 1'
    $r   = Invoke-Native @('docker', 'compose', 'exec', '-T', 'postgres',
                           'psql', '-U', 'eai', '-d', 'eai', '-tAc', $sql)
    $got = ($r.Out -replace '\s', '')
    if ($got -eq $MARKER) {
        Write-Pass
    } else {
        Write-Fail
        Write-Why ("the marker row did not come back (expected {0})" -f $MARKER)
        Write-Fix 'The seed in init/01-seed.sql runs only on a brand-new, empty'
        Write-And 'data volume. If you started this stack before the seed existed,'
        Write-And 'reset it: "make nuke", then "make up", then the doctor again.'
        Write-And 'That deletes the pre-flight database only - nothing else.'
    }
}

# ----------------------------------------------------- 7. Free disk space ----

Write-Head 7 'Free disk space above 5 GB'
$availGb = $null
try {
    $root    = [System.IO.Path]::GetPathRoot((Get-Location).ProviderPath)
    $drive   = New-Object System.IO.DriveInfo($root)
    $availGb = $drive.AvailableFreeSpace / 1GB
} catch {
    $availGb = $null
}
if ($null -eq $availGb) {
    Write-Fail
    Write-Why 'free disk space could not be determined'
    Write-Fix 'Check it by hand. Docker needs several GB for images; the course'
    Write-And 'stacks total roughly 3 GB by the end of the semester.'
} elseif ($availGb -gt $MIN_FREE_GB) {
    Write-Pass
} else {
    # Invariant culture, so a Latvian locale does not print "2,1 GB".
    $shown = [string]::Format([System.Globalization.CultureInfo]::InvariantCulture,
                              '{0:0.0}', $availGb)
    Write-Fail
    Write-Why ("{0} GB free where this project lives, need more than {1} GB" -f $shown, $MIN_FREE_GB)
    Write-Fix 'Free up space, then run the doctor again. "docker system prune"'
    Write-And 'reclaims stopped containers and dangling layers. Adding -a also'
    Write-And 'deletes every unused image, which means re-downloading them.'
    Write-And 'On Windows and macOS, Docker keeps its images on the system'
    Write-And 'drive even when this project lives elsewhere.'
}

# --------------------------------------------------------------- verdict ----

Write-Host ''
if ($script:failed -eq 0) {
    Write-Host 'DOCTOR: PASS'
    exit 0
}

if ($script:skipped -eq 1) {
    Write-Host '1 check was skipped because a check it depends on failed.'
} elseif ($script:skipped -gt 1) {
    Write-Host ("{0} checks were skipped because a check they depend on failed." -f $script:skipped)
}
Write-Host 'Fix the items marked FAIL above, then run the doctor again.'
Write-Host ''
if ($script:failed -eq 1) {
    Write-Host 'DOCTOR: FAIL (1 check)'
} else {
    Write-Host ("DOCTOR: FAIL ({0} checks)" -f $script:failed)
}
exit 1
