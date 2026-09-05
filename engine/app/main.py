"""YLookup deterministic engine — skeleton.

This service owns the "check the actual numbers" step of the pipeline:

    RAG (find mapping rules)  →  ENGINE (deterministic checks)  →  LLM (explain)  →  Human (approve)

The Node server calls POST /check with a loader batch / GL rows and expects a
list of deterministic check results back. Nothing is implemented yet — the
contract is fixed so the server and UI can be built against it.

Future checks map to the steps on the `Tasks` sheet of the Tranche 1 loader
workbook (dataset 02, investor-level GL → loader):

  1. resolve_legal_entities   — GL legal entity → target-system identifier (LE Mapping)
  2. resolve_coa              — source GL account + trans type → target CoA (CoA Mapping);
                                known gaps live on the `Mapping Gaps` sheet
  3. resolve_deals_positions  — deal/position → target IDs, flag creations
  4. resolve_investors        — investor name → target investor record (Investor Mapping)
  5. assign_batch_type        — batch type with the multi-trans-type override
                                priority from the `Batch Preference` sheet
  6. reconcile_movements      — per entity per account movements rec before upload
                                (amounts must foot; see `Movements Rec` sheet)

Each check is pure: rows + reference tables in → pass/fail + mismatches out.
No LLM calls in this service.
"""

from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="ylookup-engine", version="0.1.0")


class CheckRequest(BaseModel):
    """Payload forwarded by the Node server. `action` distinguishes review
    decisions (approve/reject) from batch checks; `rows` are GL or loader rows
    as opaque JSON until the row schema is fixed with the engine work."""

    action: str | None = None
    rows: list[dict[str, Any]] | None = None
    payload: dict[str, Any] | None = None


class CheckResult(BaseModel):
    name: str
    status: str  # "pass" | "fail" | "review" | "not_implemented"
    detail: str | None = None


class CheckResponse(BaseModel):
    status: str
    checks: list[CheckResult]


@app.get("/healthz")
def healthz() -> dict[str, bool]:
    return {"ok": True}


@app.post("/check", response_model=CheckResponse)
def check(request: CheckRequest) -> CheckResponse:
    # Stub: real deterministic checks land here (see module docstring).
    return CheckResponse(status="not_implemented", checks=[])
