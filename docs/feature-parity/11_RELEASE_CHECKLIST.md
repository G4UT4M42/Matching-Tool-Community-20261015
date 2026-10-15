> Current checkpoint (2026-10-15): app baseline `fa6c49a`441/441. Node diagnostic70/71 had one maintenance deadline failure; two subsequent real maintenance runs each pass3/3. Reviewed canvas02 and full-source WASM01 are integrated at `b979ebe`; focused replacement/supplement/runtime-overlay regression8/8. Combined8331-file/226-runtime-package artifact verifies and copied WASM passes all nine codec/load checks. Source/history independently reviewed through `f96dac5` (21commits/527files); later commits require extension. Native Windows libvips full-source build and actual ABI/codecs now pass; source bundling/independent review remain active. Complete final clean-commit regression and installed acceptance remain pending. PRIVATE_REPOSITORY_READY=false; SOFTWARE_ACCEPTED=false; RELEASE_ACCEPTED=false.

# Final release checklist

- [ ] Transactions and dashboard (F01)
- [ ] Bank CSV/XLSX imports (F02)
- [ ] PayPal/Stripe imports (F03)
- [ ] Documents and invoices (F04)
- [ ] Automatic matching (F05)
- [ ] Manual matching and review (F06)
- [ ] Refunds/splits/FX (F07)
- [ ] VAT/income reports and exports (F08)
- [ ] Exclusions/private transactions (F09)
- [ ] OCR and recognition (F10)
- [ ] Invoice Bot (F11)
- [ ] Payment preparation/SEPA (F12)
- [ ] Authorized bank payment execution (F13)
- [ ] Settings and user integrations (F14)
- [ ] Audit history (F15)
- [ ] Backup/restore (F16)
- [ ] Legacy V2 migration (F17)
- [ ] Versioned persistence/upgrades (F18)
- [ ] English/German UI (F19)
- [ ] Independent installation (F20)
- [ ] Complete synthetic demo/regression (F21)

- [ ] Complete P00-P19 work-package evidence and source-level mapping.
- [ ] Auth, credential isolation, financial safety and payment boundaries qualified.
- [ ] Clean Windows install and full 40-step browser acceptance.
- [ ] Exact integrated-commit unit/API/security/financial/migration/restore/restart tests.
- [ ] Privacy scan and independent review of source/build/assets/sanitized new history.
- [ ] SBOM, attribution, asset provenance and rights review.
- [ ] Actual private GitHub CI and branch protection verification.
- [ ] Artifact hashes, release notes and German owner report.
- [ ] External-provider test limitations are explicit and not claimed as passes.
- [ ] Separate owner approval before any public visibility change.
