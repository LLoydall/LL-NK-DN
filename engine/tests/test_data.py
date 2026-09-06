# test_data.py — uploaded workbook storage, read_sheet resolution, and
# runtime reload of the crosswalk tables (/data/* endpoints).

import io
import os

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app import mapping as mp
from app import operators
from app.main import app

client = TestClient(app)


@pytest.fixture
def uploads_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(mp, "UPLOADS_DIR", tmp_path)
    return tmp_path


@pytest.fixture
def restore_workbook():
    original = mp.FILE_PATH
    yield
    if original:
        mp.load_workbook(original)


def _xlsx_bytes(sheets: dict[str, pd.DataFrame], startrow_sheets=()) -> bytes:
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine="openpyxl") as writer:
        for name, df in sheets.items():
            df.to_excel(
                writer,
                sheet_name=name,
                index=False,
                startrow=1 if name in startrow_sheets else 0,
            )
    return buffer.getvalue()


TINY_GL = pd.DataFrame({
    "Legal Entity": ["Uploaded Entity Ltd", "Uploaded Entity Ltd"],
    "Debit": [10.0, 5.0],
    "Credit": [7.5, 7.5],
})


# =========================================================
# /data/upload + read_sheet RESOLUTION
# =========================================================

def test_upload_then_pipeline_reads_it(uploads_dir):
    response = client.post(
        "/data/upload",
        params={"name": "uploaded-gl.xlsx"},
        content=_xlsx_bytes({"GL": TINY_GL}),
        headers={"content-type": "application/octet-stream"},
    )
    assert response.status_code == 200, response.text
    assert (uploads_dir / "uploaded-gl.xlsx").is_file()

    result = client.post("/pipeline/run", json={
        "pipeline": {"steps": [
            {"id": "src", "op": "read_sheet",
             "params": {"source": "uploaded-gl.xlsx", "sheet": "GL"}},
            {"id": "chk", "op": "assert_debit_credit",
             "params": {"debit": "Debit", "credit": "Credit"}},
        ]},
    }).json()

    assert result["ok"] is True
    src, chk = result["steps"]
    assert src["rowCount"] == 2
    assert src["sample"][0]["Legal Entity"] == "Uploaded Entity Ltd"
    assert chk["checks"]["status"] == "PASS"


def test_uploaded_workbook_wins_over_dataset_file(monkeypatch, tmp_path):
    uploads = tmp_path / "uploads"
    dataset = tmp_path / "dataset"
    uploads.mkdir()
    dataset.mkdir()
    TINY_GL.to_excel(uploads / "same.xlsx", sheet_name="GL", index=False)
    pd.DataFrame({"Legal Entity": ["Dataset Entity"]}).to_excel(
        dataset / "same.xlsx", sheet_name="GL", index=False
    )
    monkeypatch.setattr(mp, "UPLOADS_DIR", uploads)
    monkeypatch.setattr(mp, "DATA_DIR", dataset)

    frame = operators.read_source("same.xlsx", "GL", 10)
    assert frame["Legal Entity"].tolist() == ["Uploaded Entity Ltd"] * 2


def test_read_source_row_cap_and_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(mp, "UPLOADS_DIR", tmp_path / "none")
    monkeypatch.setattr(mp, "DATA_DIR", tmp_path)
    operators._READ_CACHE.clear()

    path = tmp_path / "ten.xlsx"
    pd.DataFrame({"n": range(10)}).to_excel(path, sheet_name="GL", index=False)

    # Row cap is applied at parse time.
    frame = operators.read_source("ten.xlsx", "GL", 3)
    assert frame["n"].tolist() == [0, 1, 2]

    # Same (path, sheet, max_rows) with unchanged mtime -> cached copy.
    again = operators.read_source("ten.xlsx", "GL", 3)
    assert again["n"].tolist() == [0, 1, 2]

    # A changed file invalidates the cache (mtime bumped explicitly: some
    # filesystems have coarse mtime granularity).
    pd.DataFrame({"n": range(100, 110)}).to_excel(path, sheet_name="GL", index=False)
    future = path.stat().st_mtime + 10
    os.utime(path, (future, future))
    fresh = operators.read_source("ten.xlsx", "GL", 3)
    assert fresh["n"].tolist() == [100, 101, 102]


def test_upload_sanitizes_path_parts(uploads_dir):
    # Path parts are stripped to a plain basename (same rule as the server's
    # upload loader), so traversal attempts land harmlessly in UPLOADS_DIR.
    response = client.post(
        "/data/upload",
        params={"name": "../escape.xlsx"},
        content=_xlsx_bytes({"GL": TINY_GL}),
    )
    assert response.status_code == 200
    assert response.json()["name"] == "escape.xlsx"
    assert (uploads_dir / "escape.xlsx").is_file()


def test_upload_rejects_bad_names(uploads_dir):
    for bad in ["not-a-workbook.csv", "", ".."]:
        response = client.post(
            "/data/upload", params={"name": bad}, content=b"x"
        )
        assert response.status_code == 400, bad


def test_list_and_clear_uploads(uploads_dir):
    client.post("/data/upload", params={"name": "a.xlsx"},
                content=_xlsx_bytes({"GL": TINY_GL}))
    client.post("/data/upload", params={"name": "b.xlsx"},
                content=_xlsx_bytes({"GL": TINY_GL}))

    assert client.get("/data/uploads").json()["uploads"] == ["a.xlsx", "b.xlsx"]

    cleared = client.delete("/data/uploads").json()
    assert cleared == {"ok": True, "removed": 2}
    assert client.get("/data/uploads").json()["uploads"] == []


# =========================================================
# as_mapping: RUNTIME CROSSWALK RELOAD
# =========================================================

def _mapping_workbook_bytes() -> bytes:
    return _xlsx_bytes(
        {
            # LE Mapping is read with header=1 (title row first).
            "LE Mapping": pd.DataFrame({
                "Legal Entity": ["Uploaded Entity Ltd"],
                "Corvus LE ID": [9999],
            }),
            "Investor Mapping": pd.DataFrame({
                "Investor Lookup": ["Inv A"],
                "Corvus Specific Id": [101],
                "Vehicle": ["Veh A"],
                "Corvus Veh ID": [202],
            }),
            "Deal Mapping": pd.DataFrame({
                "Deal Name": ["Deal A"],
                "Corvus Deal ID": [303],
                "Position": ["Pos A"],
                "Corvus Position ID": [404],
            }),
            "CoA Mapping": pd.DataFrame({
                "Helio GL Account": ["10010 - Cash"],
                "Helio Trans Type": ["Cash Received"],
                "Verado II GL Account Code": [10000],
                "Verado II TransType (Default)": ["Cash"],
                "Batch Type": ["General"],
            }),
            "Batch Preference": pd.DataFrame({
                "Batch Type": ["General"],
                "Prioritization": [1],
            }),
        },
        startrow_sheets=("LE Mapping",),
    )


def test_as_mapping_upload_reloads_tables(uploads_dir, restore_workbook):
    response = client.post(
        "/data/upload",
        params={"name": "mapping.xlsx", "as_mapping": True},
        content=_mapping_workbook_bytes(),
    )
    assert response.status_code == 200, response.text
    assert mp.legal_entity_map == {"Uploaded Entity Ltd": 9999}

    # The reloaded table is what the lookup operator now uses.
    assert operators._table("legal_entity") == {"Uploaded Entity Ltd": 9999}


def test_failed_mapping_reload_keeps_previous_tables(uploads_dir, restore_workbook):
    before = mp.legal_entity_map.copy()
    garbage = _xlsx_bytes({"Random": pd.DataFrame({"a": [1]})})

    response = client.post(
        "/data/upload",
        params={"name": "garbage.xlsx", "as_mapping": True},
        content=garbage,
    )
    assert response.status_code == 422
    assert mp.legal_entity_map == before
    assert mp.workbook_error is not None
