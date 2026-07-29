"""Small, inert pilot example. The AIDaR service does not execute this file."""

VALUES = [2, 4, 6]


def mean(values: list[int]) -> float:
    return sum(values) / len(values)


if __name__ == "__main__":
    print(mean(VALUES))
