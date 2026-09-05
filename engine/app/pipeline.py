# pipeline.py
#
# JSON pipeline validation + execution. OPERATOR_CATALOG is the single source
# of truth: validate_pipeline checks against it and GET /operators serves it
# verbatim so an LLM can sketch pipelines using only these operators.
#
# Pipeline document:
#   {"steps": [{"id": "...", "op": "...", "params": {...}, "uses": ["..."]?}, ...]}
#
# Rules: step ids are unique; `uses` may only reference earlier steps (so
# cycles are impossible by construction); source ops take no input; transform
# and terminal ops take exactly one input, defaulting to the previous step.

import json

from app.operators import OPERATOR_IMPL, lookup_unmatched

_GL_EXAMPLE = "source/Investor-Level GL - Q2 activity - all entities (anonymised).xlsx"


def _p(type_, required, description, default=None, enum=None):
    spec = {"type": type_, "required": required, "description": description}
    if default is not None:
        spec["default"] = default
    if enum is not None:
        spec["enum"] = enum
    return spec


# =========================================================
# OPERATOR CATALOG (served to LLM prompts via GET /operators)
# =========================================================

OPERATOR_CATALOG = {
    # ---------- source ----------
    "read_sheet": {
        "kind": "source",
        "description": (
            "Read a sheet from an Excel workbook in the dataset directory into "
            "a table. This is how every pipeline starts. The runner caps the "
            "number of rows read."
        ),
        "params": {
            "source": _p(
                "string", True,
                "Workbook path relative to the dataset directory, e.g. "
                f"'{_GL_EXAMPLE}'. Paths outside the dataset directory are rejected.",
            ),
            "sheet": _p("string", True, "Sheet name within the workbook, e.g. 'Investor-Level GL'."),
        },
        "example": {"source": _GL_EXAMPLE, "sheet": "Investor-Level GL"},
    },
    # ---------- crosswalk ----------
    "lookup": {
        "kind": "transform",
        "description": (
            "Crosswalk: map source values to target-system values through a "
            "registered reference table, adding one or more output columns. "
            "Available tables: 'legal_entity', 'investor', 'deal', 'position', "
            "'vehicle', 'batch_type' (simple value maps; select with value key "
            "'target') and 'coa', 'transaction_only' (dict-valued maps; select "
            "value keys 'new_gl_account' and/or 'new_transaction_type'). 'coa' "
            "is keyed by (GL account, trans type) so pass both columns in 'on'; "
            "'transaction_only' is keyed by trans type alone."
        ),
        "params": {
            "table": _p(
                "string", True,
                "Name of the registered reference table.",
                enum=["legal_entity", "investor", "deal", "position", "vehicle",
                      "coa", "transaction_only", "batch_type"],
            ),
            "on": _p(
                "array", True,
                "List of 1 or 2 column names forming the lookup key. Two columns "
                "are combined into a tuple key (required for the 'coa' table).",
            ),
            "select": _p(
                "object", True,
                "{output_column: value_key}. value_key is 'target' for simple "
                "maps, or a key of the value dict for dict-valued maps, e.g. "
                "'new_gl_account' for 'coa'.",
            ),
            "on_missing": _p(
                "string", False,
                "What to do with keys absent from the table: 'review'/'null' "
                "leave the output column empty (null); 'fail' aborts the step "
                "with an error listing example unmatched keys.",
                default="review", enum=["review", "null", "fail"],
            ),
        },
        "example": {
            "table": "coa",
            "on": ["GL Account", "Trans Type"],
            "select": {"New GL Account": "new_gl_account", "New Trans Type": "new_transaction_type"},
            "on_missing": "review",
        },
    },
    # ---------- row math ----------
    "add": {
        "kind": "transform",
        "description": "Add two numeric operands row-wise and write the result to 'output'. Non-numeric values become null.",
        "params": {
            "inputs": _p("array", True, "Two operands; each is a column name or a numeric scalar."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"inputs": ["Debits (Entity Currency)", "Credits (Entity Currency)"], "output": "total"},
    },
    "subtract": {
        "kind": "transform",
        "description": "Row-wise inputs[0] minus inputs[1], written to 'output'. Non-numeric values become null.",
        "params": {
            "inputs": _p("array", True, "Two operands; each is a column name or a numeric scalar."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"inputs": ["Credits (Entity Currency)", "Debits (Entity Currency)"], "output": "net"},
    },
    "multiply": {
        "kind": "transform",
        "description": "Row-wise multiplication of two operands, written to 'output'. Non-numeric values become null.",
        "params": {
            "inputs": _p("array", True, "Two operands; each is a column name or a numeric scalar."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"inputs": ["Amount (Entity Currency)", -1], "output": "negated"},
    },
    "divide": {
        "kind": "transform",
        "description": "Row-wise inputs[0] divided by inputs[1], written to 'output'. Non-numeric values become null.",
        "params": {
            "inputs": _p("array", True, "Two operands; each is a column name or a numeric scalar."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"inputs": ["Amount (Entity Currency)", 1000], "output": "amount_k"},
    },
    "abs": {
        "kind": "transform",
        "description": "Absolute value of a numeric column, written to 'output'.",
        "params": {
            "column": _p("string", True, "Numeric column."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"column": "Amount (Entity Currency)", "output": "abs_amount"},
    },
    "round": {
        "kind": "transform",
        "description": "Round a numeric column to 'digits' decimal places, written to 'output'.",
        "params": {
            "column": _p("string", True, "Numeric column."),
            "digits": _p("integer", False, "Decimal places.", default=2),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"column": "Amount (Entity Currency)", "digits": 2, "output": "rounded"},
    },
    # ---------- row lexical ----------
    "concat": {
        "kind": "transform",
        "description": "Concatenate several columns row-wise into a single string column ('output'). Nulls become empty strings.",
        "params": {
            "inputs": _p("array", True, "Columns to concatenate, in order."),
            "separator": _p("string", False, "Separator inserted between values.", default=""),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"inputs": ["GL Account", "Trans Type"], "separator": " | ", "output": "key"},
    },
    "upper": {
        "kind": "transform",
        "description": "Upper-case a string column, written to 'output'.",
        "params": {
            "column": _p("string", True, "String column."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"column": "Legal Entity", "output": "le_upper"},
    },
    "lower": {
        "kind": "transform",
        "description": "Lower-case a string column, written to 'output'.",
        "params": {
            "column": _p("string", True, "String column."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"column": "Legal Entity", "output": "le_lower"},
    },
    "trim": {
        "kind": "transform",
        "description": "Strip leading/trailing whitespace from a string column, written to 'output'.",
        "params": {
            "column": _p("string", True, "String column."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"column": "Legal Entity", "output": "le_trimmed"},
    },
    "pad_left": {
        "kind": "transform",
        "description": "Left-pad a string column with 'fill' up to 'width' characters, written to 'output' (e.g. zero-padded account codes).",
        "params": {
            "column": _p("string", True, "String column."),
            "width": _p("integer", True, "Target width in characters."),
            "fill": _p("string", False, "Single fill character.", default="0"),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"column": "Deal ID", "width": 6, "fill": "0", "output": "deal_code"},
    },
    "coalesce": {
        "kind": "transform",
        "description": "First non-null value across the given columns, row-wise, written to 'output'.",
        "params": {
            "inputs": _p("array", True, "Columns to try, in priority order."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"inputs": ["Debits (Entity Currency)", "Debits (Local Currency)"], "output": "debit"},
    },
    "constant": {
        "kind": "transform",
        "description": "Write the same constant value into 'output' on every row.",
        "params": {
            "value": _p("any", True, "Constant value (string or number)."),
            "output": _p("string", True, "Name of the column to write."),
        },
        "example": {"value": "Q2", "output": "period"},
    },
    # ---------- table ops ----------
    "filter": {
        "kind": "transform",
        "description": "Keep only rows matching a condition on one column.",
        "params": {
            "column": _p("string", True, "Column to test."),
            "op": _p(
                "string", True,
                "Comparison operator. 'isin' checks membership in the 'value' "
                "array; 'notnull'/'null' test for present/missing values and "
                "need no 'value'.",
                enum=["==", "!=", ">", ">=", "<", "<=", "isin", "notnull", "null"],
            ),
            "value": _p("any", False, "Comparison value (scalar, or array for 'isin'). Not used by 'notnull'/'null'."),
        },
        "example": {"column": "Legal Entity", "op": "==", "value": "Chalbury Co-Invest L.P."},
    },
    "rename": {
        "kind": "transform",
        "description": "Rename columns.",
        "params": {
            "columns": _p("object", True, "{old_name: new_name}."),
        },
        "example": {"columns": {"Debits (Entity Currency)": "debit", "Credits (Entity Currency)": "credit"}},
    },
    "select": {
        "kind": "transform",
        "description": "Keep only the listed columns, in the given order.",
        "params": {
            "columns": _p("array", True, "Column names to keep."),
        },
        "example": {"columns": ["Legal Entity", "GL Account", "debit", "credit"]},
    },
    "aggregate": {
        "kind": "transform",
        "description": "Group rows and compute aggregates — one output row per group.",
        "params": {
            "group_by": _p("array", True, "Columns to group by."),
            "measures": _p(
                "object", True,
                "{output_column: {column, agg}} where agg is 'sum', 'count', "
                "'min', 'max' or 'mean'.",
            ),
        },
        "example": {
            "group_by": ["Legal Entity"],
            "measures": {"total_debit": {"column": "debit", "agg": "sum"}},
        },
    },
    # ---------- terminal assertions ----------
    "assert_debit_credit": {
        "kind": "terminal",
        "description": (
            "Sum the debit and credit columns; PASS when the totals differ by "
            "less than 0.01. Produces a check result, not a table — use as the "
            "last step of a pipeline."
        ),
        "params": {
            "debit": _p("string", True, "Debit amount column."),
            "credit": _p("string", True, "Credit amount column."),
        },
        "example": {"debit": "Debits (Entity Currency)", "credit": "Credits (Entity Currency)"},
    },
    "assert_balance": {
        "kind": "terminal",
        "description": (
            "Movement reconciliation on column totals: expected closing = "
            "opening + credit - debit; PASS when the reported closing total is "
            "within 0.01 of expected."
        ),
        "params": {
            "opening": _p("string", True, "Opening balance column."),
            "debit": _p("string", True, "Debit movement column."),
            "credit": _p("string", True, "Credit movement column."),
            "closing": _p("string", True, "Closing balance column."),
        },
        "example": {"opening": "opening", "debit": "debit", "credit": "credit", "closing": "closing"},
    },
    "assert_no_nulls": {
        "kind": "terminal",
        "description": "PASS when none of the listed columns contains null or empty-string values; the detail lists offending columns with counts.",
        "params": {
            "columns": _p("array", True, "Columns that must be fully populated."),
        },
        "example": {"columns": ["Legal Entity", "GL Account"]},
    },
    "assert_all_mapped": {
        "kind": "terminal",
        "description": (
            "PASS when a column produced by a 'lookup' step (on_missing "
            "'review'/'null') has no nulls, i.e. every row mapped; the detail "
            "reports how many rows are unmapped."
        ),
        "params": {
            "column": _p("string", True, "Lookup output column to check."),
        },
        "example": {"column": "New GL Account"},
    },
}


# =========================================================
# VALIDATION
# =========================================================

_TYPE_CHECKS = {
    "any": lambda v: True,
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "array": lambda v: isinstance(v, list),
    "object": lambda v: isinstance(v, dict),
}


def _check_params(op_name, spec, params, label, errors):
    declared = spec["params"]
    for name, value in params.items():
        if name not in declared:
            errors.append(f"{label}: unknown param {name!r} for op {op_name!r}")
    for name, pspec in declared.items():
        if name not in params:
            if pspec.get("required"):
                errors.append(f"{label}: missing required param {name!r} for op {op_name!r}")
            continue
        value = params[name]
        if not _TYPE_CHECKS[pspec["type"]](value):
            errors.append(
                f"{label}: param {name!r} for op {op_name!r} must be of type {pspec['type']}"
            )
        elif "enum" in pspec and value not in pspec["enum"]:
            errors.append(
                f"{label}: param {name!r} for op {op_name!r} must be one of {pspec['enum']}"
            )


def validate_pipeline(doc):
    """Return a list of human-readable error strings ([] means valid)."""

    if not isinstance(doc, dict):
        return ["pipeline must be a JSON object with a 'steps' array"]
    steps = doc.get("steps")
    if not isinstance(steps, list) or not steps:
        return ["pipeline.steps must be a non-empty array"]

    errors = []
    seen = {}  # step id -> op kind, earlier steps only

    for i, step in enumerate(steps):
        label = f"steps[{i}]"
        if not isinstance(step, dict):
            errors.append(f"{label}: step must be an object")
            continue

        step_id = step.get("id")
        if not isinstance(step_id, str) or not step_id:
            errors.append(f"{label}: 'id' must be a non-empty string")
            step_id = None
        elif step_id in seen:
            errors.append(f"{label}: duplicate step id {step_id!r}")
        where = f"{label} ({step_id!r})" if step_id else label

        op_name = step.get("op")
        spec = OPERATOR_CATALOG.get(op_name) if isinstance(op_name, str) else None
        if spec is None:
            errors.append(f"{where}: unknown op {op_name!r}")

        params = step.get("params")
        if not isinstance(params, dict):
            errors.append(f"{where}: 'params' must be an object")
            params = None
        if spec is not None and params is not None:
            _check_params(op_name, spec, params, where, errors)

        uses = step.get("uses")
        if uses is not None and not (
            isinstance(uses, list) and all(isinstance(u, str) for u in uses)
        ):
            errors.append(f"{where}: 'uses' must be an array of step ids")
            uses = None

        if spec is not None:
            kind = spec["kind"]
            if kind == "source":
                if uses:
                    errors.append(f"{where}: source op {op_name!r} must have no input ('uses')")
            else:
                if uses is None:
                    if i == 0:
                        errors.append(
                            f"{where}: op {op_name!r} needs an input but there is no earlier step"
                        )
                    input_ids = [steps[i - 1].get("id")] if i > 0 else []
                else:
                    if len(uses) != 1:
                        errors.append(
                            f"{where}: exactly one input supported, got {len(uses)}"
                        )
                    input_ids = uses
                for ref in input_ids:
                    if ref is None:
                        continue  # earlier step already errored on its own id
                    if ref not in seen:
                        errors.append(
                            f"{where}: input {ref!r} is not an earlier step "
                            "('uses' may only reference earlier steps)"
                        )
                    elif seen[ref] == "terminal":
                        errors.append(
                            f"{where}: input {ref!r} is a terminal step and produces no rows"
                        )

        if step_id is not None:
            seen[step_id] = spec["kind"] if spec is not None else None

    return errors


# =========================================================
# EXECUTION
# =========================================================

def _sample(frame):
    # to_json -> json.loads keeps samples JSON-safe: NaN -> null, numpy
    # scalars -> plain numbers, dates -> ISO strings.
    return json.loads(frame.head(5).to_json(orient="records", date_format="iso"))


def run_pipeline(doc, max_rows=200):
    errors = validate_pipeline(doc)
    if errors:
        return {"ok": False, "errors": errors}

    steps = doc["steps"]
    frames = {}   # step id -> DataFrame, for steps that produced rows
    results = []

    for i, step in enumerate(steps):
        op_name = step["op"]
        kind = OPERATOR_CATALOG[op_name]["kind"]
        impl = OPERATOR_IMPL[op_name]
        params = dict(step["params"])
        result = {"id": step["id"], "op": op_name, "kind": kind}

        input_id = None
        if kind != "source":
            input_id = step["uses"][0] if step.get("uses") else steps[i - 1]["id"]
            if input_id not in frames:
                result["status"] = "skipped"
                result["error"] = f"input step {input_id!r} did not produce rows"
                results.append(result)
                continue

        try:
            if kind == "source":
                frame = impl(max_rows=max_rows, **params)
            elif kind == "transform":
                if op_name == "lookup":
                    result["unmatched"] = lookup_unmatched(
                        frames[input_id], params["table"], params["on"]
                    )
                frame = impl(frames[input_id], **params)
            else:  # terminal
                result["status"] = "ok"
                result["checks"] = impl(frames[input_id], **params)
                results.append(result)
                continue

            frames[step["id"]] = frame
            result["status"] = "ok"
            result["rowCount"] = int(len(frame))
            result["sample"] = _sample(frame)
        except Exception as exc:  # deterministic capture — never raise
            result["status"] = "error"
            result["error"] = str(exc)

        results.append(result)

    return {"ok": True, "steps": results}
