# Session 0 — Docker pre-flight

**Due: Monday 2026-09-14, 20:00 Europe/Riga · hard cut-off 2026-09-21, 20:00**

This is the first graded item of the course, and the cheapest mark you will
earn all semester. It contains no integration content. All it does is prove
that your machine can run a two-container stack — because every assignment
from PA2 onward assumes it can, and a Docker problem discovered in week eight
is a failed course rather than an inconvenience.

> **Do this before Session 1 on 2026-09-02.** Specifically, run `make pull` at
> home, on a connection you trust. It downloads about 350 MB. Fourteen people
> pulling images simultaneously on campus wifi at 09:00 does not work, and
> "the wifi was slow" is not an extension ground.

---

## What you need installed

| | |
|---|---|
| **Windows** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) with the WSL 2 backend, and [Git for Windows](https://git-scm.com/download/win) (which gives you Git Bash) |
| **macOS** | [Docker Desktop](https://www.docker.com/products/docker-desktop/) — pick the Apple silicon or Intel build to match your machine |
| **Linux** | [Docker Engine](https://docs.docker.com/engine/install/) plus the [Compose plugin](https://docs.docker.com/compose/install/linux/), and add yourself to the `docker` group |

Nothing else. No Node, no Python, no database client — Session 0 deliberately
depends on Docker and nothing else, so that a failure has exactly one cause.

---

## Run it

```bash
cd s0
make pull      # once, at home, BEFORE Session 1  (~350 MB)
make up        # starts both containers, waits until both are healthy
make doctor    # the 7 checks
```

### Windows: you do not have `make`

Git for Windows and Docker Desktop do not ship `make`, and you do not need it.
Every target has a plain equivalent — run these from PowerShell in the `s0`
folder:

| `make …` | PowerShell equivalent |
|---|---|
| `make pull` | `docker compose pull` |
| `make up` | `docker compose up -d --wait --wait-timeout 180` |
| `make doctor` | `.\doctor.ps1` |
| `make logs` | `docker compose logs --tail 50` |
| `make down` | `docker compose down --remove-orphans` |
| `make nuke` | `docker compose down -v --remove-orphans` |

`doctor.sh` (Git Bash, WSL, macOS, Linux) and `doctor.ps1` (PowerShell) print
**exactly the same output**. Use whichever matches your shell.

**If PowerShell refuses to run `doctor.ps1`** with a message about the
execution policy, run it once as:

```powershell
powershell -ExecutionPolicy Bypass -File .\doctor.ps1
```

That bypasses the policy for that single run only and changes nothing on your
system.

---

## What the doctor checks

Seven things, in order. Later checks are skipped when an earlier one they
depend on fails — fix from the top down.

| # | Check | Why it is here |
|---|---|---|
| 1 | Docker daemon reachable | Docker installed *and* actually running |
| 2 | Compose v2 present | The legacy standalone `docker-compose` (v1) is not used in this course |
| 3 | Both containers running | The stack came up and stayed up |
| 4 | Both containers healthy | Not just started — the process inside answers |
| 5 | Ports 8080 and 5432 bound | Nothing on your machine is already squatting on the ports every lab uses |
| 6 | Seed row readable from Postgres | The database is genuinely usable, not merely alive |
| 7 | Free disk space above 5 GB | The semester's images total roughly 3 GB |

A passing run looks like this, and ends with exit code 0:

```
EAI 2026 - Session 0 doctor
===========================

[1/7] Docker daemon reachable         PASS
[2/7] Compose v2 present              PASS
[3/7] Both containers running         PASS
[4/7] Both containers healthy         PASS
[5/7] Ports 8080 and 5432 bound       PASS
[6/7] Seed row readable from Postgres PASS
[7/7] Free disk space above 5 GB      PASS

DOCTOR: PASS
```

A failure names the thing that is wrong and what to do about it:

```
[3/7] Both containers running         FAIL
      why:  not running: postgres (exited)
      fix:  run "make up" to bring the stopped container back, then run
            the doctor again. If it will not stay up, run "make logs" and
            look for a port conflict - another Postgres or web server on
            your machine may already hold 5432 or 8080.
```

**Read the `fix:` line.** It is there so that you do not have to ask.

---

## What to submit

1. Get `DOCTOR: PASS`.
2. Save the full output to a file and commit it to your semester repo
   (`eai-2026-<surname>`) at `s0/doctor-output.txt`:

   ```bash
   bash ./doctor.sh > doctor-output.txt      # Git Bash, WSL, macOS, Linux
   ```
   ```powershell
   .\doctor.ps1 > doctor-output.txt          # PowerShell
   ```

3. Add a screenshot of the passing run at `s0/doctor-screenshot.png`. The
   screenshot must show your terminal, not a cropped text box — it is what
   distinguishes a run on your machine from a file somebody sent you.
4. Push, then submit the repository URL through the course portal at
   **<https://evaluentis.leitass.eu>**. **Not by email.** The timestamp that
   counts is the one the portal records in Europe/Riga time, and the graded
   commit is whatever is at `HEAD` when you submit.

Marked **pass/fail**, and it carries **no weight in your grade** — the seven
weighted assignments are PA1 to PA7. There is no partial credit and no ADR for
this one.

That does not make it optional. Session 0 is still **gated**: not submitted by
the hard cut-off of **2026-09-21, 20:00** and your capstone is not graded,
which fails the course. It is the one item that costs you nothing and can end
your semester — twenty minutes now removes that entirely. See
[SYLLABUS.md](../SYLLABUS.md) §1.

---

## When it does not work

| Symptom | Cause and cure |
|---|---|
| `docker: command not found` after installing | You did not restart the terminal. Close it, open a new one. |
| Check 1 fails, Docker Desktop is "starting" forever | On Windows: open PowerShell as administrator and run `wsl --update`, then restart Docker Desktop. |
| Check 3 keeps failing, `make logs` shows Postgres exiting | Something else already owns 5432 — very often a Postgres you installed directly years ago. Stop that service, then `make down && make up`. |
| Check 4 says `starting` | You were too quick. Wait 20 seconds, run the doctor again. Postgres creates the database and runs the seed on first start. |
| Check 5 fails on 8080 | A local web server, or another course's stack. Find it: `netstat -ano \| findstr :8080` on Windows, `lsof -i :8080` on macOS or Linux. |
| Check 6 fails but everything else passes | Your data volume predates the seed. `make nuke`, then `make up`. This deletes the pre-flight database and nothing else. |
| `doctor.sh: /usr/bin/env: bash^M: No such file` | Your Git client rewrote the line endings. `git config --global core.autocrlf input`, delete the file, `git checkout -- s0/doctor.sh`. The `.gitattributes` in this folder is supposed to prevent this. |
| Stuck for more than 30 minutes | Ask. Email me the doctor's full output, pasted as text. Do not spend an evening on it — that is not what this assignment is for. |

`make nuke` deletes the containers and the pre-flight database volume. It does
**not** delete the downloaded images, so you never have to re-download.

---

## What is actually in here

```
docker-compose.yml    two services: nginx on 8080, Postgres 18 on 5432
init/01-seed.sql      one table, one row, one marker string
echo/index.html       what nginx serves; open http://localhost:8080 to see it
doctor.sh             the 7 checks, for bash
doctor.ps1            the 7 checks, for PowerShell — identical output
Makefile              pull, up, doctor, logs, down, nuke
.gitattributes        keeps doctor.sh on LF endings after a Windows clone
```

Images are pinned (`nginx:1.27-alpine`, `postgres:18-alpine`) so that everyone
in the cohort runs the same bytes. You are welcome to read all of it — it is
about 40 lines of configuration and one SQL insert. Understanding this compose
file is a head start on every lab that follows.
