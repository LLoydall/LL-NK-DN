import pandas as pd


FILE_PATH = r"C:\hackathon\fund-validator\datas\output\Tranche 1 - reference and verified loader v4c (anonymised).xlsx"

# =========================================================
# 1. LEGAL ENTITY MAPPING
# =========================================================

le_df = pd.read_excel(
    FILE_PATH,
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
    FILE_PATH,
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
    FILE_PATH,
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
    FILE_PATH,
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

print(list(coa_map.items())[:5])

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
    FILE_PATH,
    sheet_name="Batch Preference"
)

batch_priority_map = dict(
    zip(
        batch_df["Batch Type"],
        batch_df["Prioritization"]
    )
)


# =========================================================
# PRINT SMALL SAMPLE
# =========================================================

print("Legal entities:")
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