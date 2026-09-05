# operators.py
#
# Atomic, composable pipeline operators. Each operator is a pure function on a
# pandas DataFrame; terminal assertions take a frame and return a check dict.
# The pipeline runner (app/pipeline.py) is the only caller — an LLM may sketch
# pipelines, but it can only ever name operators from this fixed catalog. There
# is deliberately no expression/eval operator.

import numbers
from pathlib import Path

import pandas as pd

from app import mapping as mp
from app.deterministic_layer import balance_reconciliation, debit_credit_validation

# Registered crosswalk tables for the `lookup` operator, by their attribute
# name in app.mapping. Resolved dynamically (not captured at import) so a
# runtime workbook reload via /data/upload takes effect immediately.
_TABLE_ATTRS = {
    "legal_entity": "legal_entity_map",
    "investor": "investor_map",
    "deal": "deal_map",
    "position": "position_map",
    "vehicle": "vehicle_map",
    "coa": "coa_map",
    "transaction_only": "transaction_only_map",
    "batch_type": "batch_type_map",
}

ALLOWED_AGGS = {"sum", "count", "min", "max", "mean"}


# =========================================================
# SOURCE I/O
# =========================================================

def _resolve_inside(root, source):
    root = Path(root).resolve()
    path = (root / source).resolve()
    if path != root and root not in path.parents:
        raise ValueError(f"source {source!r} resolves outside its data root")
    return path


def read_source(source, sheet, max_rows):
    """Read `sheet` from a workbook living under UPLOADS_DIR or DATA_DIR.

    `source` is a filename or relative path; it must resolve inside one of the
    data roots or a ValueError is raised. Uploaded workbooks (UPLOADS_DIR) win
    over same-named dataset files.
    """

    for root in (mp.UPLOADS_DIR, mp.DATA_DIR):
        path = _resolve_inside(root, source)
        if path.is_file():
            return pd.read_excel(path, sheet_name=sheet).head(max_rows)

    raise ValueError(f"source {source!r} not found under the data roots")


def op_read_sheet(source, sheet, max_rows):
    return read_source(source, sheet, max_rows)


# =========================================================
# CROSSWALK LOOKUP
# =========================================================

def _table(name):
    attr = _TABLE_ATTRS.get(name)
    if attr is None:
        raise ValueError(
            f"unknown lookup table {name!r}; available: {sorted(_TABLE_ATTRS)}"
        )
    mapping = getattr(mp, attr, {})
    if not mapping:
        raise ValueError(
            f"lookup table {name!r} is empty — no reference workbook loaded "
            f"({mp.workbook_error or 'none loaded'}); upload one via "
            "/data/upload?as_mapping=true"
        )
    return mapping


def _make_keys(df, on):
    if not isinstance(on, list) or not 1 <= len(on) <= 2:
        raise ValueError("'on' must be a list of 1 or 2 column names")
    for col in on:
        if col not in df.columns:
            raise ValueError(f"column {col!r} not in frame")
    if len(on) == 1:
        return df[on[0]]
    return pd.Series(list(zip(df[on[0]], df[on[1]])), index=df.index)


def lookup_unmatched(df, table, on):
    """Row count whose key is absent from the table — runner reporting only."""
    mapping = _table(table)
    keys = _make_keys(df, on)
    return int((~keys.map(lambda k: k in mapping)).sum())


def op_lookup(df, table, on, select, on_missing="review"):
    mapping = _table(table)
    dict_valued = isinstance(next(iter(mapping.values()), None), dict)

    for value_key in select.values():
        if value_key == "target" and dict_valued:
            raise ValueError(
                f"table {table!r} is dict-valued; select a value key such as "
                "'new_gl_account' instead of 'target'"
            )
        if value_key != "target" and not dict_valued:
            raise ValueError(
                f"table {table!r} is a simple value map; use value key 'target'"
            )

    keys = _make_keys(df, on)
    unmatched = lookup_unmatched(df, table, on)

    if on_missing == "fail" and unmatched:
        missing = keys[~keys.map(lambda k: k in mapping)]
        examples = ", ".join(repr(k) for k in pd.unique(missing)[:5])
        raise ValueError(
            f"lookup on table {table!r}: {unmatched} unmatched row(s), e.g. {examples}"
        )

    out = df.copy()
    for out_col, value_key in select.items():
        out[out_col] = keys.map(lambda k: _select_value(mapping.get(k), value_key))
    return out


def _select_value(raw, value_key):
    if isinstance(raw, dict):
        return raw.get(value_key)
    if raw is None or pd.isna(raw):
        return None
    return raw  # simple map, value_key == "target" (validated in op_lookup)


# =========================================================
# ROW MATH (vectorized, non-numeric -> NaN)
# =========================================================

def _operand(df, col_or_scalar):
    if isinstance(col_or_scalar, str) and col_or_scalar in df.columns:
        return pd.to_numeric(df[col_or_scalar], errors="coerce")
    return pd.to_numeric(
        pd.Series([col_or_scalar] * len(df), index=df.index), errors="coerce"
    )


def op_add(df, inputs, output):
    out = df.copy()
    out[output] = _operand(df, inputs[0]) + _operand(df, inputs[1])
    return out


def op_subtract(df, inputs, output):
    out = df.copy()
    out[output] = _operand(df, inputs[0]) - _operand(df, inputs[1])
    return out


def op_multiply(df, inputs, output):
    out = df.copy()
    out[output] = _operand(df, inputs[0]) * _operand(df, inputs[1])
    return out


def op_divide(df, inputs, output):
    out = df.copy()
    out[output] = _operand(df, inputs[0]) / _operand(df, inputs[1])
    return out


def op_abs(df, column, output):
    out = df.copy()
    out[output] = pd.to_numeric(df[column], errors="coerce").abs()
    return out


def op_round(df, column, output, digits=2):
    out = df.copy()
    out[output] = pd.to_numeric(df[column], errors="coerce").round(digits)
    return out


# =========================================================
# ROW LEXICAL
# =========================================================

def op_concat(df, inputs, output, separator=""):
    out = df.copy()
    out[output] = (
        df[inputs].fillna("").astype(str).agg(separator.join, axis=1)
    )
    return out


def op_upper(df, column, output):
    out = df.copy()
    out[output] = df[column].astype("string").str.upper()
    return out


def op_lower(df, column, output):
    out = df.copy()
    out[output] = df[column].astype("string").str.lower()
    return out


def op_trim(df, column, output):
    out = df.copy()
    out[output] = df[column].astype("string").str.strip()
    return out


def op_pad_left(df, column, width, output, fill="0"):
    out = df.copy()
    out[output] = df[column].astype("string").str.pad(width, side="left", fillchar=fill)
    return out


def op_coalesce(df, inputs, output):
    out = df.copy()
    combined = df[inputs[0]]
    for col in inputs[1:]:
        combined = combined.combine_first(df[col])
    out[output] = combined
    return out


def op_constant(df, value, output):
    out = df.copy()
    out[output] = value
    return out


# =========================================================
# TABLE OPS
# =========================================================

def op_filter(df, column, op, value=None):
    if column not in df.columns:
        raise ValueError(f"column {column!r} not in frame")
    s = df[column]
    if op == "==":
        mask = s == value
    elif op == "!=":
        mask = s != value
    elif op == ">":
        mask = s > value
    elif op == ">=":
        mask = s >= value
    elif op == "<":
        mask = s < value
    elif op == "<=":
        mask = s <= value
    elif op == "isin":
        mask = s.isin(value)
    elif op == "notnull":
        mask = s.notna()
    elif op == "null":
        mask = s.isna()
    else:
        raise ValueError(f"unknown filter op {op!r}")
    return df[mask].reset_index(drop=True)


def op_rename(df, columns):
    return df.rename(columns=columns)


def op_select(df, columns):
    return df[columns].copy()


def op_aggregate(df, group_by, measures):
    for spec in measures.values():
        if spec.get("agg") not in ALLOWED_AGGS:
            raise ValueError(
                f"agg must be one of {sorted(ALLOWED_AGGS)}, got {spec.get('agg')!r}"
            )
    grouped = df.groupby(group_by, dropna=False)
    pieces = {
        out_col: grouped[spec["column"]].agg(spec["agg"])
        for out_col, spec in measures.items()
    }
    return pd.DataFrame(pieces).reset_index()


# =========================================================
# TERMINAL ASSERTIONS (frame in -> check dict out)
# =========================================================

def _totals(df, columns):
    return {
        name: float(pd.to_numeric(df[col], errors="coerce").fillna(0).sum())
        for name, col in columns.items()
    }


def _plain(value):
    # JSON-safe plain Python scalars (deterministic_layer returns numpy sums).
    if isinstance(value, bool):
        return value
    if isinstance(value, numbers.Integral):
        return int(value)
    if isinstance(value, numbers.Number):
        return float(value)
    return value


def op_assert_debit_credit(df, debit, credit):
    totals = _totals(df, {"debit": debit, "credit": credit})
    result = debit_credit_validation([totals["debit"]], [totals["credit"]])
    result["rows"] = int(len(df))
    return {k: _plain(v) for k, v in result.items()}


def op_assert_balance(df, opening, debit, credit, closing):
    totals = _totals(
        df,
        {"opening": opening, "debit": debit, "credit": credit, "closing": closing},
    )
    result = balance_reconciliation(
        totals["opening"], totals["debit"], totals["credit"], totals["closing"]
    )
    result.update({f"total_{k}": v for k, v in totals.items()})
    result["rows"] = int(len(df))
    return {k: _plain(v) for k, v in result.items()}


def op_assert_no_nulls(df, columns):
    offenders = {}
    for col in columns:
        if col not in df.columns:
            raise ValueError(f"column {col!r} not in frame")
        s = df[col]
        empty = (s.astype("string").str.strip() == "").fillna(False)
        n = int((s.isna() | empty).sum())
        if n:
            offenders[col] = n
    return {
        "columns": list(columns),
        "null_or_empty": offenders,
        "status": "PASS" if not offenders else "FAIL",
    }


def op_assert_all_mapped(df, column):
    if column not in df.columns:
        raise ValueError(f"column {column!r} not in frame")
    unmapped = int(df[column].isna().sum())
    return {
        "column": column,
        "rows": int(len(df)),
        "unmapped": unmapped,
        "status": "PASS" if unmapped == 0 else "FAIL",
    }


# =========================================================
# REGISTRY (names must match app.pipeline.OPERATOR_CATALOG)
# =========================================================

OPERATOR_IMPL = {
    "read_sheet": op_read_sheet,
    "lookup": op_lookup,
    "add": op_add,
    "subtract": op_subtract,
    "multiply": op_multiply,
    "divide": op_divide,
    "abs": op_abs,
    "round": op_round,
    "concat": op_concat,
    "upper": op_upper,
    "lower": op_lower,
    "trim": op_trim,
    "pad_left": op_pad_left,
    "coalesce": op_coalesce,
    "constant": op_constant,
    "filter": op_filter,
    "rename": op_rename,
    "select": op_select,
    "aggregate": op_aggregate,
    "assert_debit_credit": op_assert_debit_credit,
    "assert_balance": op_assert_balance,
    "assert_no_nulls": op_assert_no_nulls,
    "assert_all_mapped": op_assert_all_mapped,
}
