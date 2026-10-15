# Work package index

Every package records its actual implementation, remaining criteria, dependencies, source, tests, evidence and recovery. Focused/intermediate passes remain distinct from final exact-candidate acceptance. Raw fixtures/evidence stay external.

|ID|Title|Dependencies|Status|
|---|---|---|---|
|[P00-W01](packages/P00-W01.md)|Baseline and safe consolidation|none|IN_PROGRESS|
|[P01-W01](packages/P01-W01.md)|Source-to-user-action parity mapping|P00-W01|IN_PROGRESS|
|[P02-W01](packages/P02-W01.md)|First owner and authenticated sessions|P00-W01|IN_PROGRESS|
|[P02-W02](packages/P02-W02.md)|Method-specific route registry and request security|P01-W01|IN_PROGRESS|
|[P03-W01](packages/P03-W01.md)|Owner-scoped encrypted credential vault|P02-W01|IN_PROGRESS|
|[P03-W02](packages/P03-W02.md)|Integration management interface|P03-W01, P02-W02|IN_PROGRESS|
|[P04-W01](packages/P04-W01.md)|PayPal authenticated read-only API client|P03-W01|IN_PROGRESS|
|[P04-W02](packages/P04-W02.md)|PayPal transaction synchronization and reconciliation|P04-W01, P06-W02|IN_PROGRESS|
|[P05-W01](packages/P05-W01.md)|Stripe restricted-key API client|P03-W01|IN_PROGRESS|
|[P05-W02](packages/P05-W02.md)|Stripe balance and payout reconciliation|P05-W01, P06-W02|IN_PROGRESS|
|[P06-W01](packages/P06-W01.md)|Exact offline statement parsing and event identities|P01-W01|IN_PROGRESS|
|[P06-W02](packages/P06-W02.md)|Browser import preview, commit and durable persistence|P06-W01, P02-W02|IN_PROGRESS|
|[P06-W03](packages/P06-W03.md)|User-owned bank account and provider configuration|P03-W02, P06-W02|IN_PROGRESS|
|[P07-W01](packages/P07-W01.md)|Safe document upload, hash and retrieval|P02-W02|IN_PROGRESS|
|[P07-W02](packages/P07-W02.md)|Controlled OCR and invoice-field extraction|P07-W01|IN_PROGRESS|
|[P07-W03](packages/P07-W03.md)|Invoice corrections, relationships and recovery|P07-W02, P08-W01|IN_PROGRESS|
|[P08-W01](packages/P08-W01.md)|Validated matching decision lifecycle|P02-W02|IN_PROGRESS|
|[P08-W02](packages/P08-W02.md)|Full matching cardinality, refunds and FX matrix|P08-W01, P06-W02, P07-W01|IN_PROGRESS|
|[P09-W01](packages/P09-W01.md)|Evidence-qualified financial and VAT reports|P08-W01|IN_PROGRESS|
|[P09-W02](packages/P09-W02.md)|Report exports, filters and auditability|P09-W01, P02-W02|IN_PROGRESS|
|[P10-W01](packages/P10-W01.md)|Invoice Bot adapter inventory and contracts|P01-W01, P03-W01|IN_PROGRESS|
|[P10-W02](packages/P10-W02.md)|Invoice Bot controlled browser execution and scheduling|P10-W01, P07-W01|IN_PROGRESS|
|[P11-W01](packages/P11-W01.md)|Payment candidates, drafts, validation and SEPA|P07-W03, P08-W01|IN_PROGRESS|
|[P11-W02](packages/P11-W02.md)|Transaction-bound payment submission and unknown outcomes|P11-W01, P06-W03, P02-W01|IN_PROGRESS|
|[P12-W01](packages/P12-W01.md)|Explicit schema versions and forward upgrade registry|P00-W01|IN_PROGRESS|
|[P12-W02](packages/P12-W02.md)|Coordinated backup, staged restore and fault recovery|P12-W01|IN_PROGRESS|
|[P13-W01](packages/P13-W01.md)|Complete synthetic legacy entity migration|P12-W01, P12-W02|IN_PROGRESS|
|[P13-W02](packages/P13-W02.md)|Migration wizard, comparison, activation and rollback|P13-W01, P02-W02|IN_PROGRESS|
|[P14-W01](packages/P14-W01.md)|Complete navigable English/German interface|P03-W02, P06-W02, P07-W03, P09-W02, P13-W02|IN_PROGRESS|
|[P14-W02](packages/P14-W02.md)|Usability, accessibility and error states|P14-W01|IN_PROGRESS|
|[P15-W01](packages/P15-W01.md)|Independent complete synthetic fixture generator|P01-W01|IN_PROGRESS|
|[P15-W02](packages/P15-W02.md)|Demo environment isolation and safe reset|P15-W01, P02-W02|IN_PROGRESS|
|[P16-W01](packages/P16-W01.md)|Full browser/API acceptance and restart qualification|P06-W02, P07-W03, P08-W02, P09-W02, P13-W02, P14-W02, P15-W02|IN_PROGRESS|
|[P16-W02](packages/P16-W02.md)|Security, corruption, performance and installation regression|P16-W01, P12-W02|IN_PROGRESS|
|[P16-W03](packages/P16-W03.md)|Provider sandbox acceptance|P04-W02, P05-W02, P06-W03, P10-W02, P11-W02|BLOCKED_EXTERNAL|
|[P17-W01](packages/P17-W01.md)|Current-tree, artifact and history privacy qualification|P01-W01|IN_PROGRESS|
|[P17-W02](packages/P17-W02.md)|License, SBOM and asset provenance qualification|P17-W01|IN_PROGRESS|
|[P18-W01](packages/P18-W01.md)|Clean Windows installation and upgrade experience|P12-W02, P13-W02, P14-W01|IN_PROGRESS|
|[P18-W02](packages/P18-W02.md)|CI, migration policy and contributor readiness|P16-W02, P17-W02|IN_PROGRESS|
|[P19-W01](packages/P19-W01.md)|Final branch consolidation and integrated qualification|P16-W03, P18-W01, P18-W02|IN_PROGRESS|
|[P19-W02](packages/P19-W02.md)|Sanitized private release and owner report|P19-W01, P17-W01, P17-W02|IN_PROGRESS|

Current consolidated evidence: [FINAL-P03](packages/FINAL-P03-integrated-acceptance.md). Source map: [canonical implementation and route index](community-source-map.json). All three product/repository/release milestones remain false.
