"""Client build identity. Read from the installed client's `.build.info` (never assumed), validated, and carried into every output."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_PRODUCT = "wow_classic_beta"  # the Forever product id used by the Companion (AutoAtlasBuildVerifier)
VERSION_RE = re.compile(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{3,7}$")
BUILD_KEY_RE = re.compile(r"^[0-9a-fA-F]{32}$")
PRODUCT_RE = re.compile(r"^[a-z0-9_]{3,40}$")


class IdentityError(ValueError):
    pass


@dataclass(frozen=True)
class BuildIdentity:
    product: str
    version: str
    build_key: str
    branch: str = ""
    source: str = "build.info"

    @property
    def build_number(self) -> int:
        return int(self.version.rsplit(".", 1)[1])

    def to_json(self) -> dict:
        d = asdict(self)
        return {"product": d["product"], "version": d["version"], "buildKey": d["build_key"].lower(),
                "buildNumber": self.build_number, "branch": d["branch"], "source": d["source"]}


def validate_identity(product: str, version: str, build_key: str) -> None:
    if not PRODUCT_RE.match(product or ""):
        raise IdentityError(f"invalid product id {product!r}")
    if not VERSION_RE.match(version or ""):
        raise IdentityError(f"invalid client version {version!r} (expected major.minor.patch.build)")
    if not BUILD_KEY_RE.match(build_key or ""):
        raise IdentityError("invalid build key (expected 32 hex characters)")


def parse_build_info(text: str) -> list[dict[str, str]]:
    """`.build.info` is pipe-separated; the header cells look like `Build Key!HEX:16`."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        raise IdentityError(".build.info has no data rows")
    names = [h.split("!", 1)[0].strip() for h in lines[0].split("|")]
    rows = []
    for ln in lines[1:]:
        cells = ln.split("|")
        if len(cells) != len(names):
            raise IdentityError(".build.info row does not match its header")
        rows.append(dict(zip(names, (c.strip() for c in cells))))
    return rows


def find_build_info(wow_root: Path) -> Path:
    """The Companion accepts either the install root or a flavour folder (e.g. `_classic_beta_`); look in both places."""
    for base in (wow_root, wow_root.parent):
        p = base / ".build.info"
        if p.is_file():
            return p
    raise IdentityError(f".build.info not found under {wow_root} or its parent")


def select_identity(rows: list[dict[str, str]], product: str = DEFAULT_PRODUCT, source: str = "build.info") -> BuildIdentity:
    cands = [r for r in rows if r.get("Product", "").lower() == product.lower()]
    if not cands:
        found = sorted({r.get("Product", "?") for r in rows})
        raise IdentityError(f"product {product!r} not present in .build.info (found: {', '.join(found) or 'none'})")
    active = [r for r in cands if r.get("Active", "1") == "1"]
    if len(active) != 1:
        raise IdentityError(f"{len(active)} active rows for {product!r}; refusing to guess which build is installed")
    r = active[0]
    version, key = r.get("Version", ""), r.get("Build Key", "")
    validate_identity(product.lower(), version, key)
    return BuildIdentity(product.lower(), version, key.lower(), r.get("Branch", ""), source)


def read_identity(wow_root: Path, product: str = DEFAULT_PRODUCT, expect_version: str | None = None) -> BuildIdentity:
    ident = select_identity(parse_build_info(find_build_info(wow_root).read_text(encoding="utf-8")), product)
    if expect_version and ident.version != expect_version:
        raise IdentityError(f"installed client is {ident.version}, expected {expect_version}")
    return ident


def identity_from_json(d: dict) -> BuildIdentity:
    ident = BuildIdentity(d["product"], d["version"], d["buildKey"], d.get("branch", ""), d.get("source", "bundle"))
    validate_identity(ident.product, ident.version, ident.build_key)
    return ident
