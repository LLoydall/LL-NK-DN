# known_mappings.py — trusted reference mappings: the deterministic "right
# answer" that an LLM-sketched pipeline is validated against (POST
# /pipeline/validate-against-known-mapping). Each takes the pipeline's
# original source DataFrame and returns the columns a correct pipeline must
# produce, resolved straight through the crosswalk tables in app.mapping.

import pandas as pd

from app import mapping as mp


def gl_to_loader(df: pd.DataFrame) -> pd.DataFrame:
    """Expected translation of the investor-level GL: legal entity, GL account
    and trans type resolved through the crosswalks. Mirrors what the operator
    catalog can express with `lookup` steps (no transaction-only fallback, so
    the oracle never demands more than a pipeline could have produced).
    Unmapped keys come out as null, same as a lookup with on_missing review."""
    out = pd.DataFrame(index=df.index)
    out["Corvus LE ID"] = df["Legal Entity"].map(mp.legal_entity_map.get)
    coa_keys = list(zip(df["GL Account"], df["Trans Type"]))
    out["New GL Account"] = [
        (mp.coa_map.get(key) or {}).get("new_gl_account") for key in coa_keys
    ]
    out["New Trans Type"] = [
        (mp.coa_map.get(key) or {}).get("new_transaction_type") for key in coa_keys
    ]
    return out


KNOWN_MAPPINGS = {
    "gl_to_loader": gl_to_loader,
}
