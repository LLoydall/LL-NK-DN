# Bank statements to journal entries

A fund platform's bank statements for one week, and the working file used to turn them into journal
entries. Anonymised.

## Contents

- `statements/` — seven PDF bank statements, one per account. The filename carries the entity, the
  bank, the currency and the account short code. Six business days of activity, four currencies.
- `workbook/` — the working file, 15 sheets.

## The workflow

Every transaction on a statement has to become two journal lines. Getting there means, per row:

1. **Import** the statement rows.
2. **Counterparty** — pull the sender or beneficiary out of the narrative text and match it to a master
   list. The bank writes names truncated, in capitals, and wrapped across lines mid-word. The master
   lists hold the clean full name. Bridging those two is most of the work.
3. **Project code** — pull the project word out of the narrative and match it to a valid code.
4. **Classification** — decide whether the row is an investment, a vendor payment, a related party
   transfer, an investor movement, internal, or needs review.
5. **Position** — for investments, resolve the position under the deal.
6. **Journal** — two lines per batch, built from the values above.

The `Process` sheet in the workbook sets out the same six stages with the review points for each.

## Sheet guide

`Process` the stage-by-stage review guide · `Staging Sheet` the working rows, one per statement line ·
`DIU` the finished journal entries, two lines per batch · `Allocation Rule` how each entity allocates ·
`CoA` the chart of accounts · `Account Map` account number to bank account · `Bank Account Report`,
`Legal Entity Master List`, `Investor Master List`, `Vendor Master List`, `Vendor Codes`,
`Project Code Report`, `Deal & Position Master List`, `Related Party Master` the reference lists ·
`Korean and Taiwanese` the projects that take a specific allocation rule.

## Known unmatched rows

Preserved from the original, do not treat as errors:

- 30 project codes in the staging sheet do not resolve to the project code report
- 4 resolved positions do not resolve to the deal and position master
- 3 rows are flagged `Review`
- 52 of 100 rows have no counterparty match at all

Every counterparty string the staging sheet says was pulled out of a narrative is still literally
present in the corresponding PDF, in the bank's truncated uppercase form. That was verified after
anonymisation.
