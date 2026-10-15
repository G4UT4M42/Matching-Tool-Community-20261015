# Configuration and safe defaults

This document describes only the current developer preview. No configuration option turns it into a production accounting application.

## Recommended startup

Use the Windows launcher documented in INSTALLATION.md. It creates a cryptographically random local access token and an application-owned synthetic runtime root. Do not save the token in a repository .env file or a screenshot.

## Runtime settings

- MATCHING_RUNTIME_MODE: must be external-runtime-root.
- MATCHING_RUNTIME_ROOT: absolute path outside the source checkout. Never point it at the old Matching Tool V2 installation.
- MATCHING_LOCAL_ACCESS_TOKEN: random secret of 32 or more characters; provided by the launcher, not a permanent user password.
- MATCHING_HTTP_HOST: 127.0.0.1 (default), localhost, or ::1 only. External/LAN binding is refused.
- PORT: local HTTP port. The launcher validates 1024–65535 and checks for conflicts.
- MATCHING_ENABLE_BANK_AUTOMATION: must be false. Setting true throws during current preview startup.
- NODE_ENV: production for the local release-like demo. This is not authorization for actual money movement.

The static HOST environment variable is not the HTTP binding decision path; MATCHING_HTTP_HOST controls server binding. The .env.example is documentation only and must not contain real credentials.

## API authentication

The browser unlock flow transmits the ephemeral access token through the x-community-access-token HTTP header. Requests without it are refused. This model deliberately does not support remote/multiple users, identity recovery or password reset. An access token is not a banking authorization.

## Runtime path policy

The demo launcher uses %LOCALAPPDATA%\MatchingToolCommunity\DemoRuntime by default and named synthetic profiles under the same app folder. Arbitrary configured filesystem links and unknown pre-existing databases are rejected. Do not change paths by editing the original accounting code or copying actual invoice folders.

## Optional integrations

Real bank connectors, payment execution, external invoice harvesting, nonlocal browser automation and live restore are deliberately blocked. There is currently no supported production credential configuration; do not attempt to enable integrations by directly editing route guards or environment variables.

## Safe logging

Treat error messages, URLs, report output, temp files and test evidence as potentially sensitive. Never log access tokens, account numbers or real invoice data. Debug logs are not approved to enter public release artifacts. Before filing an issue, reproduce it using the generated synthetic fixtures.
