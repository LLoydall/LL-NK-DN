# Investor-level GL to loader

A fund administration migration. One quarter of investor-level general ledger out of the old system,
and the upload file built to load it into the new one. Anonymised.

## Contents

- `source/` — what the exercise starts from.
  - *Investor-Level GL - Q2 activity - all entities* — the quarter's GL, roughly 34,000 rows across 43
    columns, covering every entity in scope. Fund family, legal entity, vehicle, deal, position, issuer,
    security, batch and journal indices, comments, GL account, trans type, amounts in both transaction
    and entity currency, allocation rule, investor and identifier.
  - *Phase I loader - sample* — an earlier loader in the target system's upload format, roughly 94,000
    rows. This is the shape the output has to take.
- `output/` — the finished article.
  - *Tranche 1 - reference and verified loader v4c* — 14 sheets. The upload template plus every mapping
    table used to build it.

## The workflow

Take the source GL and produce a valid upload file for the target system. That means, per row:

1. Map the legal entity to its identifier in the target system.
2. Map the GL account and transaction type from the old chart of accounts to the new one.
3. Resolve the deal and position to target-system IDs, creating new ones where they do not exist.
4. Resolve the investor to a target-system investor record.
5. Assign a batch type, applying the override rule where a batch contains several transaction types.
6. Reconcile movements per entity per account before upload.

The `Tasks` sheet in the output workbook lists the eight steps as they were actually run, including the
batch type override rule.

## Sheet guide for the output workbook

`Upload Template (VERIFIED v4c)` the deliverable, ~19,000 rows · `LE Mapping`, `Investor Mapping`,
`Deal Mapping`, `CoA Mapping` the four crosswalks from source to target · `Entity Listing` what is in
scope and its migration status · `Deals List`, `Investors List`, `Suppliers List` what has to exist in
the target before upload · `Corvus CoA` the target system's full chart of accounts and transaction
types · `Batch Preference` the override priority · `Mapping Gaps` the accounts and transaction types
with no mapping · `Movements Rec` the pre-upload reconciliation · `Tasks` the method.

## Known unmatched rows

Preserved from the original, do not treat as errors:

- 4 legal entities in the upload template are not in the entity listing
- 16 deal names in the upload template are not in the deals list
- 198 investor names in the investor mapping are not in the investors list
- The mapping gaps sheet is populated on purpose — those are real gaps that went back to the
  administrator for a decision

Amounts, dates and quantities are untouched. Every amount column sums identically to the source, and
the cross-file joins between the GL and the loader still resolve.
