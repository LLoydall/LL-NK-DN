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
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request

# Deterministic checks — wired into POST /check as the engine work lands.
from app.deterministic_layer import balance_reconciliation, debit_credit_validation, validate_mapping, validate_coa_mapping
from pydantic import BaseModel
from app import mapping as mp
from app.pipeline import OPERATOR_CATALOG, run_pipeline, validate_pipeline
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

@app.get("/validate_mapping")
def validate_mapping_endpoint() -> dict[str, Any]:
    entity_result = validate_mapping(
            "legal_entity",
            "Chalbury Co-Invest L.P.",
            mp.legal_entity_map
        )
    print(entity_result)

    coa_result = validate_coa_mapping(
        "10010 - Cash",
        "Cash Received"
    )

    print(coa_result)
    return {"ok": True, "entity_result": entity_result, "coa_result": coa_result}


# =========================================================
# JSON PIPELINES (operator catalog -> validate -> execute)
# =========================================================

class PipelineValidateRequest(BaseModel):
    pipeline: dict[str, Any]


class PipelineRunRequest(BaseModel):
    pipeline: dict[str, Any]
    max_rows: int = 200


@app.get("/operators")
def operators() -> dict[str, Any]:
    # Served verbatim so an LLM prompt can sketch pipelines from the catalog.
    return {"operators": OPERATOR_CATALOG}


@app.post("/pipeline/validate")
def pipeline_validate(request: PipelineValidateRequest) -> dict[str, Any]:
    errors = validate_pipeline(request.pipeline)
    return {"ok": not errors, "errors": errors}


@app.post("/pipeline/run")
def pipeline_run(request: PipelineRunRequest) -> dict[str, Any]:
    return run_pipeline(request.pipeline, max_rows=request.max_rows)


# =========================================================
# UPLOADED WORKBOOKS (pushed by the Node server at ingest)
# =========================================================

# Mirrors the server's MAX_FILE_BYTES; uploads are whole-file POSTs.
MAX_UPLOAD_BYTES = 20_000_000


def _safe_upload_name(name: str) -> str:
    # The name comes over the wire — keep only a plain .xlsx basename.
    base = name.replace("\\", "/").split("/")[-1].strip()
    if not base or base in (".", "..") or not base.lower().endswith(".xlsx"):
        raise HTTPException(400, f"upload name must be an .xlsx filename: {name!r}")
    return base


@app.post("/data/upload")
async def data_upload(request: Request, name: str, as_mapping: bool = False) -> dict[str, Any]:
    """Store an uploaded workbook under UPLOADS_DIR so pipelines can read it
    via read_sheet. as_mapping additionally (re)loads the crosswalk tables
    from it (used when a mapping workbook is ingested)."""
    base = _safe_upload_name(name)
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"workbook too large ({len(body)} > {MAX_UPLOAD_BYTES} bytes)")

    dest_dir = Path(mp.UPLOADS_DIR)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / base
    dest.write_bytes(body)

    result: dict[str, Any] = {"ok": True, "name": base, "bytes": len(body)}
    if as_mapping:
        if not mp.load_workbook(str(dest)):
            raise HTTPException(
                422, f"could not load crosswalk tables from {base}: {mp.workbook_error}"
            )
        result["mappingTables"] = len(mp.legal_entity_map) + len(mp.coa_map)
    return result


@app.get("/data/uploads")
def data_list_uploads() -> dict[str, Any]:
    dest_dir = Path(mp.UPLOADS_DIR)
    files = sorted(p.name for p in dest_dir.glob("*.xlsx")) if dest_dir.is_dir() else []
    return {"uploads": files}


@app.delete("/data/uploads")
def data_clear_uploads() -> dict[str, Any]:
    dest_dir = Path(mp.UPLOADS_DIR)
    removed = 0
    if dest_dir.is_dir():
        for path in dest_dir.glob("*.xlsx"):
            path.unlink()
            removed += 1
    return {"ok": True, "removed": removed}