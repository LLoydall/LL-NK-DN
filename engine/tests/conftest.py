# conftest.py — make the `app` package importable when pytest runs from engine/.

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
