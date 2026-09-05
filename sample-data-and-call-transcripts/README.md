# Ylookup hackathon — anonymised datasets

Three sets of material, all derived from real client work and all anonymised. Everything here is safe to
hand to contestants. Nothing in this folder names a real client, manager, administrator, investor,
counterparty, individual, bank, account or system.

| Folder | What it is | Shape of the task |
|---|---|---|
| `01-bank-statements-to-journal-entries` | Seven bank statements plus a working file | Read a PDF statement, work out who each payment was to or from, classify it, and produce the journal entries |
| `02-investor-level-gl-to-loader` | A quarter of investor-level GL, a loader sample, and the finished loader | Map a general ledger from one fund accounting system into another system's upload format |
| `03-call-transcripts` | Four anonymised call transcripts | Context on the problems these workflows exist to solve |

Each folder has its own README with the detail.

## How the anonymisation works

Replacement is token-level and consistent. The same source word maps to the same replacement everywhere
it appears, across every file in a dataset, so all the lookups between files still resolve. Amounts,
dates, balances and quantities are untouched and still tie. Identifiers — account numbers, IBANs,
transaction references, system IDs — were regenerated in the same shape, with valid check digits where
the original had them.

Replacement names are invented. None reuse a word that existed in the source, so you cannot tell which
parts were changed and which survived, and you cannot work backwards.

## Two things to know before using this

**The imperfections are deliberate.** Both datasets carry unmatched rows, rows flagged for review, and
lookups that do not resolve. These were in the original files and were preserved exactly — same counts
before and after. They are the difficulty of the exercise, not defects to clean up.

**Do not distribute the reversal keys.** They live in a separate `INTERNAL - do not distribute` folder,
outside this one. Anyone holding a key can undo all of this. They should never travel with the datasets.
