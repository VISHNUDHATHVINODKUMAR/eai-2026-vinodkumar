#!/usr/bin/env bash
#
# EAI 2026 - Session 0 environment doctor (bash).
#
# Seven checks. Every failure names what is wrong and what to do about it.
# The last line is always "DOCTOR: PASS" or "DOCTOR: FAIL (n checks)".
# Exit code is 0 on PASS, 1 on FAIL.
#
# Runs on Git Bash (Windows), WSL, macOS and Linux.
# Its output is kept identical to doctor.ps1 - if you change one, change both.

set -u
export LC_ALL=C

# Work from the directory this script lives in, so it can be called from anywhere.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1

MARKER="EAI-2026-S0-OK"
MIN_FREE_GB=5
TOTAL=7
SERVICES="echo postgres"

failed=0
skipped=0

# ---------------------------------------------------------------- output ----

head_() { printf '[%d/%d] %-32s' "$1" "$TOTAL" "$2"; }
pass_() { printf 'PASS\n'; }
fail_() { printf 'FAIL\n'; failed=$((failed + 1)); }
skip_() { printf 'SKIP\n'; skipped=$((skipped + 1)); }
why_()  { printf '      why:  %s\n' "$1"; }
fix_()  { printf '      fix:  %s\n' "$1"; }
and_()  { printf '            %s\n' "$1"; }

# ----------------------------------------------------------------- utils ----

container_id() { # -a, or a stopped container looks like one that was never created
    docker compose ps -a -q "$1" 2>/dev/null | head -n 1
}

tcp_open() { # tcp_open PORT -> 0 if something accepts a connection on it
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

printf 'EAI 2026 - Session 0 doctor\n'
printf '===========================\n\n'

# --------------------------------------------- 1. Docker daemon reachable ----

docker_ok=0
head_ 1 "Docker daemon reachable"
if ! command -v docker >/dev/null 2>&1; then
    fail_
    why_ 'the "docker" command was not found on your PATH'
    fix_ 'Install Docker Desktop (Windows, macOS) or Docker Engine (Linux),'
    and_ 'then close this terminal and open a new one so that PATH is picked'
    and_ 'up. See README.md for the download links.'
elif [ -z "$(docker info --format '{{.ServerVersion}}' 2>/dev/null)" ]; then
    fail_
    why_ 'the docker command works but the daemon is not answering'
    fix_ 'Start Docker Desktop and wait until the whale icon stops animating,'
    and_ 'then run the doctor again. On Linux: sudo systemctl start docker,'
    and_ 'and make sure you are in the docker group -'
    and_ 'sudo usermod -aG docker $USER, then log out and back in.'
else
    pass_
    docker_ok=1
fi

# -------------------------------------------------- 2. Compose v2 present ----

compose_ok=0
head_ 2 "Compose v2 present"
if [ "$docker_ok" -eq 0 ]; then
    skip_
    why_ 'not checked, because check 1 did not pass'
else
    cv="$(docker compose version --short 2>/dev/null)"
    cv="${cv#v}"
    major="${cv%%.*}"
    if [ -z "$cv" ]; then
        fail_
        why_ '"docker compose" is not available'
        fix_ 'You probably have only the legacy standalone docker-compose (v1),'
        and_ 'which this course does not use. Update Docker Desktop to a'
        and_ 'current version, or install the Compose plugin:'
        and_ 'https://docs.docker.com/compose/install/'
    elif ! printf '%s' "$major" | grep -Eq '^[0-9]+$' || [ "$major" -lt 2 ]; then
        fail_
        why_ "Compose reports version $cv, which is older than v2"
        fix_ 'Update Docker Desktop, or install the current Compose plugin:'
        and_ 'https://docs.docker.com/compose/install/'
    else
        pass_
        compose_ok=1
    fi
fi

# --------------------------------------------- 3. Both containers running ----

running_ok=0
head_ 3 "Both containers running"
if [ "$compose_ok" -eq 0 ]; then
    skip_
    why_ 'not checked, because check 2 did not pass'
else
    stopped=""
    present=0
    for svc in $SERVICES; do
        cid="$(container_id "$svc")"
        if [ -z "$cid" ]; then
            stopped="$stopped $svc (not created)"
        else
            present=$((present + 1))
            st="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null)"
            [ -n "$st" ] || st="unknown"
            if [ "$st" != "running" ]; then
                stopped="$stopped $svc ($st)"
            fi
        fi
    done
    if [ -z "$stopped" ]; then
        pass_
        running_ok=1
    else
        fail_
        why_ "not running:${stopped}"
        if [ "$present" -eq 0 ]; then
            fix_ 'run "make up" - this stack has never been started, or it was'
            and_ 'removed by "make nuke". Then run the doctor again.'
        else
            fix_ 'run "make up" to bring the stopped container back, then run'
            and_ 'the doctor again. If it will not stay up, run "make logs" and'
            and_ 'look for a port conflict - another Postgres or web server on'
            and_ 'your machine may already hold 5432 or 8080.'
        fi
    fi
fi

# --------------------------------------------- 4. Both containers healthy ----

head_ 4 "Both containers healthy"
if [ "$running_ok" -eq 0 ]; then
    skip_
    why_ 'not checked, because check 3 did not pass'
else
    unhealthy=""
    starting=0
    for svc in $SERVICES; do
        cid="$(container_id "$svc")"
        hs="$(docker inspect \
            --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
            "$cid" 2>/dev/null)"
        [ -n "$hs" ] || hs="unknown"
        if [ "$hs" != "healthy" ]; then
            unhealthy="$unhealthy $svc ($hs)"
            [ "$hs" = "starting" ] && starting=1
        fi
    done
    if [ -z "$unhealthy" ]; then
        pass_
    else
        fail_
        why_ "not healthy:${unhealthy}"
        if [ "$starting" -eq 1 ]; then
            fix_ 'the container is still starting up. Wait 20 seconds and run'
            and_ 'the doctor again. Postgres needs a moment on first start,'
            and_ 'because it has to create the database and run the seed.'
        else
            fix_ 'run "make logs" and read the last 20 lines for that service.'
            and_ 'A healthcheck reporting "unhealthy" means the process inside'
            and_ 'the container started and then broke. "make nuke" followed'
            and_ 'by "make up" resolves most first-run cases.'
        fi
    fi
fi

# ------------------------------------------ 5. Ports 8080 and 5432 on host ----

head_ 5 "Ports 8080 and 5432 bound"
if [ "$running_ok" -eq 0 ]; then
    skip_
    why_ 'not checked, because check 3 did not pass'
else
    bad_ports=""
    pub_echo="$(docker compose port echo 80 2>/dev/null)"
    pub_pg="$(docker compose port postgres 5432 2>/dev/null)"
    case "$pub_echo" in
        *:8080) : ;;
        *) bad_ports="$bad_ports 8080 (not published)" ;;
    esac
    case "$pub_pg" in
        *:5432) : ;;
        *) bad_ports="$bad_ports 5432 (not published)" ;;
    esac
    if [ -z "$bad_ports" ]; then
        tcp_open 8080 || bad_ports="$bad_ports 8080 (published, refuses connections)"
        tcp_open 5432 || bad_ports="$bad_ports 5432 (published, refuses connections)"
    fi
    if [ -z "$bad_ports" ]; then
        pass_
    else
        fail_
        why_ "unreachable on 127.0.0.1:${bad_ports}"
        fix_ 'Another program is probably already holding that port. Find it -'
        and_ 'Windows:      netstat -ano | findstr :5432'
        and_ 'macOS, Linux: lsof -i :5432'
        and_ 'Stop that program - a locally installed Postgres is the usual'
        and_ 'culprit - then run "make down" and "make up" again.'
    fi
fi

# -------------------------------------- 6. Seed row readable from Postgres ----

head_ 6 "Seed row readable from Postgres"
if [ "$running_ok" -eq 0 ]; then
    skip_
    why_ 'not checked, because check 3 did not pass'
else
    raw="$(docker compose exec -T postgres \
        psql -U eai -d eai -tAc 'select marker from preflight limit 1' 2>&1)"
    got="$(printf '%s' "$raw" | tr -d '[:space:]')"
    if [ "$got" = "$MARKER" ]; then
        pass_
    else
        fail_
        why_ "the marker row did not come back (expected ${MARKER})"
        fix_ 'The seed in init/01-seed.sql runs only on a brand-new, empty'
        and_ 'data volume. If you started this stack before the seed existed,'
        and_ 'reset it: "make nuke", then "make up", then the doctor again.'
        and_ 'That deletes the pre-flight database only - nothing else.'
    fi
fi

# ----------------------------------------------------- 7. Free disk space ----

head_ 7 "Free disk space above 5 GB"
avail_kb="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')"
if ! printf '%s' "$avail_kb" | grep -Eq '^[0-9]+$'; then
    fail_
    why_ 'free disk space could not be determined'
    fix_ 'Check it by hand. Docker needs several GB for images; the course'
    and_ 'stacks total roughly 3 GB by the end of the semester.'
else
    avail_gb="$(awk -v k="$avail_kb" 'BEGIN { printf "%.1f", k / 1048576 }')"
    enough="$(awk -v k="$avail_kb" -v m="$MIN_FREE_GB" \
        'BEGIN { print (k / 1048576 > m) ? 1 : 0 }')"
    if [ "$enough" -eq 1 ]; then
        pass_
    else
        fail_
        why_ "${avail_gb} GB free where this project lives, need more than ${MIN_FREE_GB} GB"
        fix_ 'Free up space, then run the doctor again. "docker system prune"'
        and_ 'reclaims stopped containers and dangling layers. Adding -a also'
        and_ 'deletes every unused image, which means re-downloading them.'
        and_ 'On Windows and macOS, Docker keeps its images on the system'
        and_ 'drive even when this project lives elsewhere.'
    fi
fi

# --------------------------------------------------------------- verdict ----

printf '\n'
if [ "$failed" -eq 0 ]; then
    printf 'DOCTOR: PASS\n'
    exit 0
fi

if [ "$skipped" -eq 1 ]; then
    printf '1 check was skipped because a check it depends on failed.\n'
elif [ "$skipped" -gt 1 ]; then
    printf '%d checks were skipped because a check they depend on failed.\n' "$skipped"
fi
printf 'Fix the items marked FAIL above, then run the doctor again.\n\n'
if [ "$failed" -eq 1 ]; then
    printf 'DOCTOR: FAIL (1 check)\n'
else
    printf 'DOCTOR: FAIL (%d checks)\n' "$failed"
fi
exit 1
