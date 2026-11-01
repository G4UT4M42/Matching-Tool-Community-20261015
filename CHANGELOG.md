# Changelog

This file tracks Community source-preparation changes. No public stable release has been issued.

## Unreleased — 2026-11-01

- Updated body-parser to 1.20.9, multer to 2.5.0 and the qs override to 6.16.1 to address GHSA-27r3-jxmh-p828, GHSA-q7qp-rjg7-q26m and GHSA-6pq8-jhm2-2vcw.
- Refreshed the exact-lock dependency inventory. Application behavior, stored financial contracts and provider connections are unchanged.
- Updated the affected development dependency chains, including tsx/esbuild and Vite 6, and added full root/frontend advisory checks to CI. No application framework major-version migration was made.

## Unreleased — 2026-10-13

- Established a separate sanitized Community developer-preview source tree with a fresh Git history.
- Added local token-protected loopback web/API preview with unreviewed financial and external-action endpoints blocked.
- Introduced synthetic transactions, invoice evidence, matching and accepted-evidence reporting checks.
- Added English-first locale registry with selectable German fallback for the translated UI scaffold; full app localization is pending.
- Added versioned Community SQLite and JSON state bootstrap with unsafe old/new-version refusal.
- Hardened the offline synthetic legacy V2 stage against unmapped tables, credential-bearing columns/settings/metadata, duplicated relationships and unsupported JSON keys.
- Added offline stage artifact-hash, integrity, financial-summary and status verification; import activation remains disabled.
- Corrected Windows PowerShell 5.1 demo-launch compatibility, supported Node.js 22 on PATH, and added protected isolated synthetic profiles.
- Added real synthetic local HTTP start/restart/access-control tests, Windows negative launcher tests and current installation/release documentation.

## Publication

Current version is a developer-preview candidate, NOT_READY. No production-finance compatibility, complete backup/restore or real V2 upgrade is certified. Redistribution rights, release artifacts, hosted CI and independent privacy/security/licensing reviews remain pending.

Do not interpret this changelog as a stable release announcement. Public GitHub publication requires explicit final owner approval.
