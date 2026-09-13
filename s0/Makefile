# EAI 2026 · Session 0 pre-flight.
#
# Windows users: you almost certainly do not have `make`. Every target below
# has a plain-command equivalent in README.md - use that column instead.

.PHONY: help pull up doctor logs down nuke

DC := docker compose

help:
	@echo "EAI 2026 - Session 0 pre-flight"
	@echo ""
	@echo "  make pull    download the images  (DO THIS BEFORE SESSION 1)"
	@echo "  make up      start the stack and wait until both are healthy"
	@echo "  make doctor  run the 7 environment checks"
	@echo "  make logs    show the last 50 log lines per service"
	@echo "  make down    stop the stack, keep the database volume"
	@echo "  make nuke    stop and delete containers and the database volume"
	@echo "               (images are kept, so nothing is re-downloaded)"

# Run this at home, on a connection you trust. Roughly 350 MB.
pull:
	$(DC) pull

# --wait blocks until every healthcheck passes, so `make up && make doctor`
# does not race the database.
up:
	$(DC) up -d --wait --wait-timeout 180

doctor:
	@bash ./doctor.sh

logs:
	$(DC) logs --tail 50

down:
	$(DC) down --remove-orphans

nuke:
	$(DC) down -v --remove-orphans
