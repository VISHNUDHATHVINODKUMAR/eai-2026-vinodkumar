\# EAI 2026 — Assignment Repository



This repository contains my coursework for the EAI 2026 assignments.



\## Repository structure



\- `canonical/` — canonical order schema.

\- `pa6/` — checkout saga orchestrator and mock services.

\- `pa7/` — checkout saga implemented with Temporal.



\## PA6



PA6 implements the checkout process using an orchestrator, including payment, inventory, shipping, notification, and compensation.



See \[PA6 README](pa6/README.md).



\## PA7



PA7 ports the checkout saga to Temporal. The workflow runs payment, inventory, shipping, and notification sequentially and compensates completed steps after a failure.



See \[PA7 README](pa7/README.md).



\## Running PA7



Open PowerShell in the `pa7/` directory and run:



```powershell

docker compose up -d --build --wait

npm --prefix tests test

```



See `pa7/README.md` for setup, testing, and submission details.

