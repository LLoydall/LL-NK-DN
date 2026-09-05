# deterministic_layer.py

import pandas as pd

from app import mapping as mp


# =========================================================
# BALANCE RECONCILIATION
# =========================================================

def balance_reconciliation(opening_b, debit, credit, closing_b):

    expected = opening_b + credit - debit
    difference = closing_b - expected

    return {
        "expected_closing": expected,
        "reported_closing": closing_b,
        "difference": difference,
        "status": "PASS" if abs(difference) < 0.01 else "FAIL"
    }


# =========================================================
# DEBIT / CREDIT VALIDATION
# =========================================================

def debit_credit_validation(debits, credits):

    total_debit = sum(debits)
    total_credit = sum(credits)
    difference = total_debit - total_credit

    return {
        "total_debit": total_debit,
        "total_credit": total_credit,
        "difference": difference,
        "status": "PASS" if abs(difference) < 0.01 else "FAIL"
    }


# =========================================================
# GENERIC ENTITY MAPPING
# =========================================================

def validate_mapping(entity_type, source_value, mapping):

    if pd.isna(source_value):
        return {
            "entity_type": entity_type,
            "source": source_value,
            "target": None,
            "status": "NEEDS_REVIEW",
            "reason": "Source value is empty"
        }

    target = mapping.get(source_value)

    if target is not None and not pd.isna(target):
        return {
            "entity_type": entity_type,
            "source": source_value,
            "target": target,
            "status": "PASS"
        }

    return {
        "entity_type": entity_type,
        "source": source_value,
        "target": None,
        "status": "NEEDS_REVIEW",
        "reason": "No approved mapping found"
    }


# =========================================================
# CoA VALIDATION
# =========================================================

def validate_coa_mapping(gl_account, transaction_type):

    key = (gl_account, transaction_type)

    # Strongest rule:
    # GL account + transaction type
    if key in mp.coa_map:

        return {
            "status": "PASS",
            "mapping_type": "GL_AND_TRANSACTION",
            "old_gl_account": gl_account,
            "old_transaction_type": transaction_type,
            **mp.coa_map[key]
        }

    # Fallback:
    # transaction type only
    if transaction_type in mp.transaction_only_map:

        return {
            "status": "PASS",
            "mapping_type": "TRANSACTION_ONLY",
            "old_gl_account": gl_account,
            "old_transaction_type": transaction_type,
            **mp.transaction_only_map[transaction_type]
        }

    return {
        "status": "NEEDS_REVIEW",
        "old_gl_account": gl_account,
        "old_transaction_type": transaction_type,
        "reason": "No approved CoA mapping found"
    }


# =========================================================
# TESTS (manual smoke check)
# =========================================================

if __name__ == "__main__":
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