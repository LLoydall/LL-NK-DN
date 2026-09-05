import os
from pathlib import Path

import pandas as pd

# Reference workbook (dataset 02 output). Containers get it via a mounted
# volume + MAPPING_WORKBOOK; the local default resolves relative to this file
# (repo root = two levels up from engine/app/mapping.py).
DEFAULT_WORKBOOK = (
    Path(__file__).resolve().parents[2]
    / "sample-data-and-call-transcripts/02-investor-level-gl-to-loader/output"
    / "Tranche 1 - reference and verified loader v4c (anonymised).xlsx"
)

# Dataset 02 root directory (source GL, sample loader, output workbook).
# Containers mount it at /data and set DATA_DIR; the local default resolves
# relative to this file, same style as DEFAULT_WORKBOOK.
DEFAULT_DATA_DIR = (
    Path(__file__).resolve().parents[2]
    / "sample-data-and-call-transcripts/02-investor-level-gl-to-loader"
)
DATA_DIR = Path(os.environ.get("DATA_DIR", str(DEFAULT_DATA_DIR)))

# Workbooks uploaded at runtime (pushed by the Node server at ingest) live
# here; read_sheet resolves against this dir before DATA_DIR.
DEFAULT_UPLOADS_DIR = Path(__file__).resolve().parents[2] / "data" / "uploads"
UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR", str(DEFAULT_UPLOADS_DIR)))

# Crosswalk tables built from the reference workbook. load_workbook() swaps
# them atomically, so a failed (re)load never wipes working tables — the
# engine still boots in environments without the workbook (e.g. GKE), and a
# mapping workbook can be (re)loaded at runtime via /data/upload.
_MAP_NAMES = [
    "legal_entity_map",
    "investor_map",
    "deal_map",
    "position_map",
    "vehicle_map",
    "coa_map",
    "gl_account_map",
    "transaction_type_map",
    "transaction_only_map",
    "batch_type_map",
    "batch_priority_map",
]

FILE_PATH: str | None = None
# None when the last (re)load succeeded, otherwise the error string.
workbook_error: str | None = None

for _name in _MAP_NAMES:
    globals()[_name] = {}


def _build_maps(file_path):
    """Read every crosswalk out of the reference workbook. Pure: returns a
    dict of table name -> map without touching module state."""

    # =========================================================
    # 1. LEGAL ENTITY MAPPING
    # =========================================================

    le_df = pd.read_excel(
        file_path,
        sheet_name="LE Mapping",
        header=1
    )

    legal_entity_map = dict(
        zip(
            le_df["Legal Entity"],
            le_df["Corvus LE ID"]
        )
    )


    # =========================================================
    # 2. INVESTOR MAPPING
    # =========================================================

    investor_df = pd.read_excel(
        file_path,
        sheet_name="Investor Mapping"
    )

    investor_map = dict(
        zip(
            investor_df["Investor Lookup"],
            investor_df["Corvus Specific Id"]
        )
    )


    # =========================================================
    # 3. DEAL MAPPING
    # =========================================================

    deal_df = pd.read_excel(
        file_path,
        sheet_name="Deal Mapping"
    )

    deal_map = dict(
        zip(
            deal_df["Deal Name"],
            deal_df["Corvus Deal ID"]
        )
    )


    # =========================================================
    # 4. POSITION MAPPING
    # =========================================================

    position_df = deal_df.dropna(
        subset=["Position", "Corvus Position ID"]
    )

    position_map = dict(
        zip(
            position_df["Position"],
            position_df["Corvus Position ID"]
        )
    )


    # =========================================================
    # 5. VEHICLE MAPPING
    # =========================================================

    vehicle_df = investor_df.dropna(
        subset=["Vehicle", "Corvus Veh ID"]
    )

    vehicle_map = dict(
        zip(
            vehicle_df["Vehicle"],
            vehicle_df["Corvus Veh ID"]
        )
    )


    #Chart Account Mapping...................................
    coa_df = pd.read_excel(
        file_path,
        sheet_name="CoA Mapping"
    )

    coa_map = {}

    for _, row in coa_df.iterrows():
        old_gl = row["Helio GL Account"]
        old_trans = row["Helio Trans Type"]

        new_gl = row["Verado II GL Account Code"]
        new_trans = row["Verado II TransType (Default)"]

        key = (old_gl, old_trans)

        coa_map[key] = {
            "new_gl_account": new_gl,
            "new_transaction_type": new_trans
        }

    gl_account_map = dict(
        zip(
            coa_df["Helio GL Account"],
            coa_df["Verado II GL Account Code"]
        )
    )


    # =========================================================
    # 7. TRANSACTION TYPE MAPPING
    # =========================================================

    transaction_type_map = dict(
        zip(
            coa_df["Helio Trans Type"],
            coa_df["Verado II TransType (Default)"]
        )
    )


    # Transaction-type-only fallback for validate_coa_mapping: first row seen
    # for each trans type wins.
    transaction_only_map = {}

    for _, row in coa_df.iterrows():
        trans = row["Helio Trans Type"]

        if trans not in transaction_only_map:
            transaction_only_map[trans] = {
                "new_gl_account": row["Verado II GL Account Code"],
                "new_transaction_type": row["Verado II TransType (Default)"]
            }


    # =========================================================
    # 8. BATCH TYPE MAPPING
    # =========================================================

    batch_type_map = dict(
        zip(
            coa_df["Helio Trans Type"],
            coa_df["Batch Type"]
        )
    )


    # =========================================================
    # 9. BATCH PRIORITY / OVERRIDE RULE
    # =========================================================

    batch_df = pd.read_excel(
        file_path,
        sheet_name="Batch Preference"
    )

    batch_priority_map = dict(
        zip(
            batch_df["Batch Type"],
            batch_df["Prioritization"]
        )
    )

    return {
        "legal_entity_map": legal_entity_map,
        "investor_map": investor_map,
        "deal_map": deal_map,
        "position_map": position_map,
        "vehicle_map": vehicle_map,
        "coa_map": coa_map,
        "gl_account_map": gl_account_map,
        "transaction_type_map": transaction_type_map,
        "transaction_only_map": transaction_only_map,
        "batch_type_map": batch_type_map,
        "batch_priority_map": batch_priority_map,
    }


def load_workbook(file_path) -> bool:
    """(Re)build the crosswalk tables from `file_path`. Atomic: on failure the
    previous tables stay in place and `workbook_error` records why."""
    global FILE_PATH, workbook_error
    try:
        maps = _build_maps(file_path)
    except Exception as exc:
        workbook_error = f"{type(exc).__name__}: {exc}"
        if FILE_PATH is None:
            # First-ever load (import time): engine must still boot, e.g. in
            # GKE where the sample dataset is not mounted.
            print(f"WARNING: reference workbook not loaded: {workbook_error}")
        return False
    for name, value in maps.items():
        globals()[name] = value
    FILE_PATH = file_path
    workbook_error = None
    return True


load_workbook(os.environ.get("MAPPING_WORKBOOK", str(DEFAULT_WORKBOOK)))


# =========================================================
# PRINT SMALL SAMPLE (manual inspection only)
# =========================================================

if __name__ == "__main__":
    print(list(coa_map.items())[:5])

    print("\nLegal entities:")
    print(list(legal_entity_map.items())[:5])

    print("\nInvestors:")
    print(list(investor_map.items())[:5])

    print("\nDeals:")
    print(list(deal_map.items())[:5])

    print("\nPositions:")
    print(list(position_map.items())[:5])

    print("\nVehicles:")
    print(list(vehicle_map.items())[:5])

    print("\nGL accounts:")
    print(list(gl_account_map.items())[:5])

    print("\nTransaction types:")
    print(list(transaction_type_map.items())[:5])

    print("\nBatch types:")
    print(list(batch_type_map.items())[:5])

    print("\nBatch priority:")
    print(list(batch_priority_map.items())[:5])
