# test_pipeline.py — catalog consistency, pipeline validation, execution.

import pandas as pd
import pytest

from app import mapping as mp
from app import operators
from app.operators import OPERATOR_IMPL
from app.pipeline import OPERATOR_CATALOG, run_pipeline, validate_pipeline


# =========================================================
# CATALOG SELF-CONSISTENCY
# =========================================================

def test_catalog_matches_impl_registry():
    assert set(OPERATOR_CATALOG) == set(OPERATOR_IMPL)
    for name, impl in OPERATOR_IMPL.items():
        assert callable(impl), name


def test_catalog_examples_only_use_declared_params():
    for name, spec in OPERATOR_CATALOG.items():
        example = spec.get("example", {})
        unknown = set(example) - set(spec["params"])
        assert not unknown, f"{name}: example uses undeclared params {unknown}"


def test_catalog_kinds_are_valid():
    for name, spec in OPERATOR_CATALOG.items():
        assert spec["kind"] in {"source", "transform", "terminal"}, name


# =========================================================
# VALIDATION
# =========================================================

def _valid_pipeline():
    return {
        "steps": [
            {"id": "src", "op": "read_sheet",
             "params": {"source": "gl.xlsx", "sheet": "GL"}},
            {"id": "chk", "op": "assert_no_nulls",
             "params": {"columns": ["Legal Entity"]}},
        ]
    }


def test_valid_pipeline_has_no_errors():
    assert validate_pipeline(_valid_pipeline()) == []


def test_unknown_op():
    doc = _valid_pipeline()
    doc["steps"][1]["op"] = "eval_python"
    errors = validate_pipeline(doc)
    assert any("unknown op" in e for e in errors)


def test_duplicate_step_id():
    doc = _valid_pipeline()
    doc["steps"][1]["id"] = "src"
    errors = validate_pipeline(doc)
    assert any("duplicate step id" in e for e in errors)


def test_forward_uses_reference():
    doc = _valid_pipeline()
    doc["steps"][0]["op"] = "assert_no_nulls"
    doc["steps"][0]["params"] = {"columns": ["x"]}
    doc["steps"][0]["uses"] = ["chk"]  # 'chk' comes later
    errors = validate_pipeline(doc)
    assert any("earlier step" in e for e in errors)


def test_missing_required_param():
    doc = _valid_pipeline()
    del doc["steps"][0]["params"]["source"]
    errors = validate_pipeline(doc)
    assert any("missing required param 'source'" in e for e in errors)


def test_unknown_param():
    doc = _valid_pipeline()
    doc["steps"][0]["params"]["bogus"] = 1
    errors = validate_pipeline(doc)
    assert any("unknown param 'bogus'" in e for e in errors)


def test_transform_with_two_inputs():
    doc = _valid_pipeline()
    doc["steps"][1]["uses"] = ["src", "other"]
    errors = validate_pipeline(doc)
    assert any("exactly one input supported" in e for e in errors)


def test_source_must_not_have_uses():
    doc = {
        "steps": [
            {"id": "a", "op": "read_sheet",
             "params": {"source": "gl.xlsx", "sheet": "GL"}},
            {"id": "b", "op": "read_sheet",
             "params": {"source": "gl.xlsx", "sheet": "GL"}, "uses": ["a"]},
        ]
    }
    errors = validate_pipeline(doc)
    assert any("must have no input" in e for e in errors)


def test_lookup_select_rejects_unknown_value_key():
    # 'coa' values only carry new_gl_account / new_transaction_type — batch
    # type lives in the separate 'batch_type' table. (Uses the real loaded
    # crosswalk tables.)
    doc = {
        "steps": [
            {"id": "src", "op": "read_sheet",
             "params": {"source": "gl.xlsx", "sheet": "GL"}},
            {"id": "map", "op": "lookup",
             "params": {"table": "coa", "on": ["GL Account", "Trans Type"],
                        "select": {"Mapped Batch Type": "batch_type"}}},
        ]
    }
    errors = validate_pipeline(doc)
    assert any("no value key 'batch_type'" in e for e in errors)
    assert any("new_gl_account" in e for e in errors)


def test_rename_to_duplicate_names_rejected_at_validate():
    doc = _valid_pipeline()
    doc["steps"][1] = {
        "id": "ren", "op": "rename",
        "params": {"columns": {"Debit": "amount", "Credit": "amount"}},
    }
    errors = validate_pipeline(doc)
    assert any("duplicate column(s): amount" in e for e in errors)


# =========================================================
# EXECUTION (sheet loading monkeypatched to in-memory data)
# =========================================================

FAKE_GL = pd.DataFrame({
    "Legal Entity": ["Chalbury Co-Invest L.P.", "Chalbury Co-Invest L.P."],
    "Debit": [100.0, 50.0],
    "Credit": [75.0, 75.0],
})


@pytest.fixture
def fake_read_source(monkeypatch):
    monkeypatch.setattr(
        operators, "read_source",
        lambda source, sheet, max_rows: FAKE_GL.copy().head(max_rows),
    )


def _e2e_pipeline(on_missing="review"):
    return {
        "steps": [
            {"id": "read", "op": "read_sheet",
             "params": {"source": "fake.xlsx", "sheet": "GL"}},
            {"id": "map_le", "op": "lookup",
             "params": {"table": "legal_entity", "on": ["Legal Entity"],
                        "select": {"LE ID": "target"}, "on_missing": on_missing}},
            {"id": "label", "op": "concat",
             "params": {"inputs": ["Legal Entity", "LE ID"],
                        "separator": " -> ", "output": "label"}},
            {"id": "check", "op": "assert_debit_credit",
             "params": {"debit": "Debit", "credit": "Credit"}},
        ]
    }


def test_end_to_end_run(fake_read_source):
    result = run_pipeline(_e2e_pipeline())

    assert result["ok"] is True
    steps = {s["id"]: s for s in result["steps"]}
    assert [s["status"] for s in result["steps"]] == ["ok"] * 4

    assert steps["read"]["rowCount"] == 2
    assert steps["read"]["sample"][0]["Legal Entity"] == "Chalbury Co-Invest L.P."

    assert steps["map_le"]["rowCount"] == 2
    assert steps["map_le"]["unmatched"] == 0
    assert steps["map_le"]["sample"][0]["LE ID"] is not None

    assert " -> " in steps["label"]["sample"][0]["label"]

    checks = steps["check"]["checks"]
    assert checks["status"] == "PASS"
    assert checks["total_debit"] == 150.0
    assert checks["total_credit"] == 150.0


def test_validation_failure_does_not_execute(fake_read_source):
    result = run_pipeline({"steps": [{"id": "x", "op": "nope", "params": {}}]})
    assert result["ok"] is False
    assert result["errors"]


def test_failing_lookup_skips_dependents(monkeypatch):
    gl = pd.DataFrame({
        "Legal Entity": ["Chalbury Co-Invest L.P.", "No Such Entity"],
        "Debit": [1.0, 2.0],
        "Credit": [1.0, 2.0],
    })
    monkeypatch.setattr(
        operators, "read_source",
        lambda source, sheet, max_rows: gl.copy().head(max_rows),
    )

    result = run_pipeline(_e2e_pipeline(on_missing="fail"))

    steps = {s["id"]: s for s in result["steps"]}
    assert steps["read"]["status"] == "ok"
    assert steps["map_le"]["status"] == "error"
    assert "No Such Entity" in steps["map_le"]["error"]
    assert steps["map_le"]["unmatched"] == 1
    assert steps["label"]["status"] == "skipped"
    assert steps["check"]["status"] == "skipped"


# =========================================================
# assert_balance MATH
# =========================================================

def _balance_df(closing):
    return pd.DataFrame({
        "opening": [100.0, 200.0],
        "debit": [30.0, 10.0],
        "credit": [50.0, 60.0],
        "closing": [closing, closing],
    })


def test_assert_balance_pass():
    # expected = (100 + 200) + (50 + 60) - (30 + 10) = 370
    checks = OPERATOR_IMPL["assert_balance"](
        _balance_df(185.0), "opening", "debit", "credit", "closing"
    )
    assert checks["status"] == "PASS"
    assert checks["expected_closing"] == 370.0
    assert checks["reported_closing"] == 370.0
    assert abs(checks["difference"]) < 0.01


def test_assert_balance_fail():
    checks = OPERATOR_IMPL["assert_balance"](
        _balance_df(1.0), "opening", "debit", "credit", "closing"
    )
    assert checks["status"] == "FAIL"
    assert checks["expected_closing"] == 370.0
    assert abs(checks["difference"]) >= 0.01


# =========================================================
# assert_debit_credit GROUP_BY
# =========================================================

def _grouped_df():
    # batch B1 foots (100 = 60 + 40), batch B2 does not (50 vs 0).
    return pd.DataFrame({
        "Legal Entity": ["E1", "E1", "E1"],
        "Batch ID": ["B1", "B1", "B2"],
        "debit": [100.0, 0.0, 50.0],
        "credit": [60.0, 40.0, 0.0],
    })


def test_assert_debit_credit_group_by_finds_unbalanced_group():
    checks = OPERATOR_IMPL["assert_debit_credit"](
        _grouped_df(), "debit", "credit", group_by=["Legal Entity", "Batch ID"]
    )
    assert checks["status"] == "FAIL"
    assert checks["groups"] == 2
    assert checks["unbalanced"] == 1
    example = checks["examples"][0]
    assert example["group"] == {"Legal Entity": "E1", "Batch ID": "B2"}
    assert example["difference"] == 50.0


def test_assert_debit_credit_group_by_passes_when_all_groups_foot():
    df = _grouped_df()
    df.loc[2, "credit"] = 50.0
    checks = OPERATOR_IMPL["assert_debit_credit"](
        df, "debit", "credit", group_by=["Batch ID"]
    )
    assert checks["status"] == "PASS"
    assert checks["unbalanced"] == 0
    assert checks["examples"] == []


# =========================================================
# LOOKUP VALUE-KEY + DUPLICATE-COLUMN GUARDS
# =========================================================

def test_op_lookup_rejects_unknown_value_key_loudly():
    try:
        OPERATOR_IMPL["lookup"](
            FAKE_GL.copy(), "coa", ["Legal Entity", "Legal Entity"],
            {"Mapped Batch Type": "batch_type"},
        )
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "no value key 'batch_type'" in str(exc)
        assert "new_gl_account" in str(exc)


def test_duplicate_columns_error_and_skip_dependents(fake_read_source):
    # Renaming onto an EXISTING column is data-dependent, so it passes
    # validation and must fail at run time with dependents skipped.
    doc = {
        "steps": [
            {"id": "read", "op": "read_sheet",
             "params": {"source": "fake.xlsx", "sheet": "GL"}},
            {"id": "ren", "op": "rename",
             "params": {"columns": {"Debit": "Credit"}}},
            {"id": "chk", "op": "assert_no_nulls",
             "params": {"columns": ["Credit"]}},
        ]
    }
    result = run_pipeline(doc)
    steps = {s["id"]: s for s in result["steps"]}
    assert steps["ren"]["status"] == "error"
    assert "duplicate column(s): Credit" in steps["ren"]["error"]
    # Dependents of the failed step are skipped, not fed the broken frame.
    assert steps["chk"]["status"] == "skipped"


def test_rename_on_collision_replace_overwrites():
    df = pd.DataFrame({
        "Trans Type": ["source-a", "source-b"],
        "New Trans Type": ["mapped-a", "mapped-b"],
        "Other": [1, 2],
    })
    out = OPERATOR_IMPL["rename"](
        df, {"New Trans Type": "Trans Type"}, on_collision="replace"
    )
    assert list(out.columns) == ["Trans Type", "Other"]
    assert out["Trans Type"].tolist() == ["mapped-a", "mapped-b"]


def test_rename_default_keeps_duplicates_for_the_runner_guard():
    df = pd.DataFrame({"a": [1], "b": [2]})
    out = OPERATOR_IMPL["rename"](df, {"b": "a"})
    assert not out.columns.is_unique  # runner turns this into a step error


def test_rename_replace_still_rejected_when_mapping_values_collide():
    doc = _valid_pipeline()
    doc["steps"][1] = {
        "id": "ren", "op": "rename",
        "params": {"columns": {"Debit": "amount", "Credit": "amount"},
                   "on_collision": "replace"},
    }
    errors = validate_pipeline(doc)
    assert any("duplicate column(s): amount" in e for e in errors)


# =========================================================
# BEST-ATTEMPT OUTPUT
# =========================================================

def test_output_is_the_last_transform_frame(fake_read_source):
    result = run_pipeline(_e2e_pipeline())
    output = result["output"]
    # The e2e pipeline ends with a terminal; the final frame comes from the
    # last transform ("label").
    assert output["step"] == "label"
    assert output["complete"] is True
    assert output["rowCount"] == 2
    assert "label" in output["columns"]
    assert " -> " in output["rows"][0]["label"]


def test_output_falls_back_to_last_good_frame(fake_read_source):
    doc = {
        "steps": [
            {"id": "read", "op": "read_sheet",
             "params": {"source": "fake.xlsx", "sheet": "GL"}},
            {"id": "ren", "op": "rename",
             "params": {"columns": {"Debit": "Credit"}}},
        ]
    }
    result = run_pipeline(doc)
    output = result["output"]
    assert output["step"] == "read"
    assert output["complete"] is False
    assert output["rowCount"] == 2
    assert output["rows"][0]["Legal Entity"] == "Chalbury Co-Invest L.P."


def test_output_is_null_when_nothing_produced():
    doc = {
        "steps": [
            {"id": "read", "op": "read_sheet",
             "params": {"source": "no/such/file.xlsx", "sheet": "GL"}},
        ]
    }
    result = run_pipeline(doc)
    assert result["steps"][0]["status"] == "error"
    assert result["output"] is None


# =========================================================
# read_source PATH GUARD
# =========================================================

def test_read_source_rejects_escape(monkeypatch, tmp_path):
    monkeypatch.setattr(mp, "DATA_DIR", tmp_path)
    monkeypatch.setattr(mp, "UPLOADS_DIR", tmp_path / "uploads")
    with pytest.raises(ValueError, match="outside its data root"):
        operators.read_source("../../etc/passwd", "x", 10)
