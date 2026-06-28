"""Domain / URL normalization for join keys.

P1 owns THE canonical normalization helper (TypeScript, in ``convex/``); every
lane is supposed to call that single helper so keys are byte-identical across the
record set (``docs/CONTRACT.md`` global rules: "P1 owns the single normalization
helper"). This module is a **P4-local replica** until that helper is shared as a
language-neutral contract — FLAG FOR SIGN-OFF. It matters because every join in
this lane (measurement→page→company) keys on the normalized domain/URL, and a
mismatch between this replica and P1's helper is a silent-failure join break (the
#1 failure mode the contract warns about).

SIGN-OFF DECISION (specific): :func:`normalize_url` lowercases the *whole* URL,
including the path, not just the host. That keeps both join sides self-consistent
within P4, but if P1's canonical helper preserves path case, a real ``/Home``
measurement would fail to join a ``/home`` page. Reconcile path-case handling with
P1 before this replica is retired.
"""

from __future__ import annotations


def _strip_scheme_and_fragment(value: str) -> str:
    v = value.strip().lower()
    if "://" in v:
        v = v.split("://", 1)[1]
    # drop fragment and query — neither participates in the join key
    v = v.split("#", 1)[0]
    v = v.split("?", 1)[0]
    return v


def _strip_www(host: str) -> str:
    return host[4:] if host.startswith("www.") else host


def normalize_domain(value: str) -> str:
    """Canonical domain key: lowercase, no scheme, no ``www.``, no path/query/port.

    e.g. ``"https://WWW.Example.com/pricing?x=1"`` -> ``"example.com"``.
    """
    body = _strip_scheme_and_fragment(value)
    host = body.split("/", 1)[0]  # discard any path
    host = host.split(":", 1)[0]  # discard port
    return _strip_www(host).strip(".")


def normalize_url(value: str) -> str:
    """Canonical URL key: lowercase host, no scheme/``www.``, keep path, no trailing slash.

    e.g. ``"https://WWW.Example.com/Blog/Post/"`` -> ``"example.com/blog/post"``.
    """
    body = _strip_scheme_and_fragment(value)
    host, slash, path = body.partition("/")
    host = _strip_www(host.split(":", 1)[0])
    result = f"{host}/{path}" if slash else host
    return result.rstrip("/")
