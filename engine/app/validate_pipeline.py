# validate_pipeline.py — validate a sketched pipeline by re-executing it and
# diffing its final frame against a trusted reference mapping (the "known
# mapping" — see app/known_mappings.py for the named registry).

import pandas as pd

from app.operators import OPERATOR_IMPL
from app.pipeline import OPERATOR_CATALOG, validate_pipeline


def validate_pipeline_against_known_mapping(
    doc,
    max_rows,
    known_mapping_function,
):
    """
    Validate an AI/generated pipeline against a trusted deterministic
    mapping function.

    known_mapping_function:
        Takes the original source DataFrame and returns a DataFrame
        containing the expected mapped columns.
    """

    # =========================================================
    # 1. NORMAL PIPELINE VALIDATION
    # =========================================================

    errors = validate_pipeline(doc)

    if errors:
        return {
            "ok": False,
            "status": "FAIL",
            "errors": errors,
        }

    if not callable(known_mapping_function):
        return {
            "ok": False,
            "status": "FAIL",
            "errors": ["known_mapping_function must be callable"],
        }

    steps = doc["steps"]

    frames = {}

    original_source = None
    final_frame = None

    # =========================================================
    # 2. EXECUTE PIPELINE
    # =========================================================

    try:

        for i, step in enumerate(steps):

            op_name = step["op"]
            spec = OPERATOR_CATALOG[op_name]

            kind = spec["kind"]
            impl = OPERATOR_IMPL[op_name]

            params = dict(step["params"])

            # -------------------------
            # SOURCE
            # -------------------------

            if kind == "source":

                frame = impl(
                    max_rows=max_rows,
                    **params,
                )

                frames[step["id"]] = frame

                if original_source is None:
                    original_source = frame.copy()

                final_frame = frame

            # -------------------------
            # TRANSFORM
            # -------------------------

            elif kind == "transform":

                input_id = (
                    step["uses"][0]
                    if step.get("uses")
                    else steps[i - 1]["id"]
                )

                if input_id not in frames:
                    return {
                        "ok": False,
                        "status": "FAIL",
                        "errors": [
                            f"Input step {input_id!r} did not produce rows"
                        ],
                    }

                frame = impl(
                    frames[input_id],
                    **params,
                )

                frames[step["id"]] = frame
                final_frame = frame

            # -------------------------
            # TERMINAL
            # -------------------------

            elif kind == "terminal":

                # Terminal steps produce checks, not a new DataFrame.
                continue

    except Exception as exc:

        return {
            "ok": False,
            "status": "FAIL",
            "errors": [
                f"Pipeline execution failed: {exc}"
            ],
        }

    if original_source is None or final_frame is None:

        return {
            "ok": False,
            "status": "FAIL",
            "errors": ["Pipeline produced no data"],
        }

    # =========================================================
    # 3. RUN TRUSTED / KNOWN MAPPING
    # =========================================================

    try:

        expected_frame = known_mapping_function(
            original_source.copy()
        )

    except Exception as exc:

        return {
            "ok": False,
            "status": "FAIL",
            "errors": [
                f"Known mapping function failed: {exc}"
            ],
        }

    if not isinstance(expected_frame, pd.DataFrame):

        return {
            "ok": False,
            "status": "FAIL",
            "errors": [
                "known_mapping_function must return a pandas DataFrame"
            ],
        }

    # =========================================================
    # 4. ROW COUNT CHECK
    # =========================================================

    if len(final_frame) != len(expected_frame):

        return {
            "ok": False,
            "status": "FAIL",
            "reason": "Row count mismatch",
            "pipeline_rows": len(final_frame),
            "expected_rows": len(expected_frame),
        }

    # =========================================================
    # 5. CHECK EXPECTED COLUMNS EXIST
    # =========================================================

    missing_columns = [
        col
        for col in expected_frame.columns
        if col not in final_frame.columns
    ]

    if missing_columns:

        return {
            "ok": False,
            "status": "FAIL",
            "reason": "Pipeline is missing expected columns",
            "missing_columns": missing_columns,
        }

    # =========================================================
    # 6. COMPARE VALUES
    # =========================================================

    mismatches = []

    actual = final_frame.reset_index(drop=True)
    expected = expected_frame.reset_index(drop=True)

    for column in expected.columns:

        for index in range(len(expected)):

            actual_value = actual.loc[index, column]
            expected_value = expected.loc[index, column]

            # Treat NaN == NaN
            both_missing = (
                pd.isna(actual_value)
                and pd.isna(expected_value)
            )

            if both_missing:
                continue

            if actual_value != expected_value:

                mismatches.append({
                    "row": index,
                    "column": column,
                    "actual": (
                        None
                        if pd.isna(actual_value)
                        else actual_value
                    ),
                    "expected": (
                        None
                        if pd.isna(expected_value)
                        else expected_value
                    ),
                })

    # =========================================================
    # 7. FINAL RESULT
    # =========================================================

    if mismatches:

        return {
            "ok": False,
            "status": "FAIL",
            "rows_checked": len(expected),
            "mismatch_count": len(mismatches),

            # Don't send thousands of mismatches to the UI.
            "mismatches": mismatches[:20],
        }

    return {
        "ok": True,
        "status": "PASS",
        "rows_checked": len(expected),
        "columns_checked": list(expected.columns),
        "mismatch_count": 0,
    }