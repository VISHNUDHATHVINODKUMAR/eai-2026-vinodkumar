# AI usage

## Tools used

I used ChatGPT (OpenAI) as an AI assistant during the capstone. I also used Visual Studio Code and Notepad for editing, PowerShell for running commands, Node.js and npm for the project and tests, and Docker Compose for running the services.

ChatGPT was used as a support tool for understanding requirements, interpreting errors, planning documentation, and reviewing technical decisions. I reviewed the suggested changes and applied them manually. No AI agent is connected to the running application.

## What for

AI assistance was used across the capstone for:

- Breaking down the assignment requirements into implementation and documentation tasks.
- Understanding the RabbitMQ topology, saga orchestration, retries, dead-letter handling, and service responsibilities.
- Interpreting test failures and PowerShell or Node.js errors.
- Reviewing the architecture documentation and preparing explanations of the system.
- Drafting documentation, including architecture, agent readiness, and AI usage.
- Planning verification steps using Docker Compose, service health endpoints, and the automated test suite.

The application itself does not call an AI API and does not depend on an AI model at runtime.

## What I changed or rejected

I did not apply every AI suggestion without checking it.

- I avoided claiming that the orchestrator has runtime RabbitMQ reconnection, because that behaviour had not been verified as implemented.
- I kept the agent-readiness document explicit that the proposed agent tools are a future design, not an existing autonomous agent integration.
- I used actual project service names, endpoints, queues, and test results instead of presenting generic architecture or security claims as implemented features.
- When documentation content was accidentally entered into PowerShell instead of Notepad, I corrected the editing process by opening the relevant Markdown file and replacing its contents in Notepad.

I reviewed the generated documentation and used project commands and test output to check the work.

## What I verified, and how

I used the following checks during development:

- `docker compose config --quiet` to validate the Compose configuration.
- `docker compose build` to build the service images.
- `docker compose up -d --wait` to start the services and wait for their health checks.
- `docker compose ps` to inspect container status.
- HTTP health checks on the intake, observer, orchestrator, and notifier services.
- `node --check` to check JavaScript syntax in the orchestrator.
- `npm test --prefix tests` to run the automated test suite.

At the latest recorded full test run, 28 tests passed and 2 documentation tests failed. The remaining failures concerned Stage 6 documentation requirements, including ADR content, patterns, runbook sections, and BPMN diagram elements. These failures are being addressed; I do not claim that the full test suite passes yet.

The Docker Compose services were reported healthy during the latest recorded service check. These checks provide evidence of service startup and health, but do not prove every failure and recovery scenario works.

## Dependencies beyond the allow-list

No additional AI API, AI SDK, or model runtime dependency was intentionally added to the application.

The project uses its existing application dependencies and Docker services. AI assistance was provided externally during development and is not a runtime dependency of the capstone.