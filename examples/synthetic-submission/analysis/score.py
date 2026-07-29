"""Calculate the score for the synthetic AIDaR fixture."""

import csv
from pathlib import Path


def readiness_score(path: Path) -> float:
    with path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    ready = sum(bool(row["value"] and row["provenance"]) for row in rows)
    return ready / len(rows)


if __name__ == "__main__":
    # The development path is intentionally identifying test data. The AIDaR
    # staging copy must redact its user component.
    source = Path("/Users/ada-example/research/records.csv")
    print(readiness_score(source))
