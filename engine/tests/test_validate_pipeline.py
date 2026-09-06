# test_validate_pipeline.py — validating a sketched pipeline's output against
# a trusted reference mapping (POST /pipeline/validate-against-known-mapping).

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import operators
from app.known_mappings import KNOWN_MAPPINGS
from app.main import app
from app.validate_pipeline import validate_pipeline_against_known_mapping

client = TestClient(app)

# Rows 0-1 map cleanly through the real crosswalk tables; row 2 is unmapped in
# both the pipeline (lookup on_missing review -> null) and the oracle, so the
# comparison must treat null == null rather than flagging it.
FAKE_GL = pd.DataFrame({
    "Legal Entity": ["Chalbury Co-Invest L.P."] * 3,
    "GL Account": ["10010 - Cash", "10010 - Cash", "99999 - Void"],
    "Trans Type": ["Cash Received", "Cash Received", "Void"],
})


@pytest.fixture
def fake_read_source(monkeypatch):
    monkeypatch.setattr(
        operators, "read_source",
        lambda source, sheet, max_rows: FAKE_GL.copy().head(max_rows),
    )


def _mapping_pipeline():
    return {
        "steps": [
            {"id": "read", "op": "read_sheet",
             "params": {"source": "fake.xlsx", "sheet": "GL"}},
            {"id": "le", "op": "lookup",
             "params": {"table": "legal_entity", "on": ["Legal Entity"],
                        "select": {"Corvus LE ID": "target"}}},
            {"id": "coa", "op": "lookup",
             "params": {"table": "coa", "on": ["GL Account", "Trans Type"],
                        "select": {"New GL Account": "new_gl_account",
                                   "New Trans Type": "new_transaction_type"}}},
        ]
    }


def test_pass_when_pipeline_matches_known_mapping(fake_read_source):
    result = validate_pipeline_against_known_mapping(
        _mapping_pipeline(), 200, KNOWN_MAPPINGS["gl_to_loader"]
    )
    assert result["ok"] is True
    assert result["status"] == "PASS"
    assert result["rows_checked"] == 3
    assert result["mismatch_count"] == 0


def test_fail_when_pipeline_maps_wrong_values(fake_read_source):
    doc = _mapping_pipeline()
    # Structurally valid, but the wrong value key feeds New GL Account.
    doc["steps"][2]["params"]["select"]["New GL Account"] = "new_transaction_type"
    result = validate_pipeline_against_known_mapping(
        doc, 200, KNOWN_MAPPINGS["gl_to_loader"]
    )
    assert result["ok"] is False
    assert result["status"] == "FAIL"
    assert result["mismatch_count"] == 2  # row 2 is null on both sides
    assert all(m["column"] == "New GL Account" for m in result["mismatches"])


def test_fail_when_expected_columns_missing(fake_read_source):
    doc = _mapping_pipeline()
    del doc["steps"][2]  # no CoA lookup -> New GL Account / New Trans Type absent
    result = validate_pipeline_against_known_mapping(
        doc, 200, KNOWN_MAPPINGS["gl_to_loader"]
    )
    assert result["ok"] is False
    assert result["reason"] == "Pipeline is missing expected columns"
    assert sorted(result["missing_columns"]) == ["New GL Account", "New Trans Type"]


def test_fail_on_row_count_mismatch(fake_read_source):
    doc = _mapping_pipeline()
    doc["steps"].append(
        {"id": "drop", "op": "filter",
         "params": {"column": "GL Account", "op": "!=", "value": "99999 - Void"}}
    )
    result = validate_pipeline_against_known_mapping(
        doc, 200, KNOWN_MAPPINGS["gl_to_loader"]
    )
    assert result["ok"] is False
    assert result["reason"] == "Row count mismatch"
    assert result["pipeline_rows"] == 2
    assert result["expected_rows"] == 3


def test_invalid_pipeline_doc_is_not_executed(fake_read_source):
    result = validate_pipeline_against_known_mapping(
        {"steps": [{"id": "x", "op": "nope", "params": {}}]},
        200, KNOWN_MAPPINGS["gl_to_loader"],
    )
    assert result["ok"] is False
    assert any("unknown op" in e for e in result["errors"])


def test_known_mapping_must_be_callable(fake_read_source):
    result = validate_pipeline_against_known_mapping(
        _mapping_pipeline(), 200, "gl_to_loader"
    )
    assert result["ok"] is False
    assert result["errors"] == ["known_mapping_function must be callable"]


# =========================================================
# HTTP ENDPOINT
# =========================================================

def test_endpoint_passes_a_matching_pipeline(fake_read_source):
    response = client.post(
        "/pipeline/validate-against-known-mapping",
        json={"pipeline": _mapping_pipeline(), "known_mapping_function": "gl_to_loader"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True


def test_endpoint_rejects_unknown_known_mapping(fake_read_source):
    response = client.post(
        "/pipeline/validate-against-known-mapping",
        json={"pipeline": _mapping_pipeline(), "known_mapping_function": "nope"},
    )
    assert response.status_code == 404
    assert "gl_to_loader" in response.json()["detail"]
