"""Normalization vector tests: every output must match the canonical TypeScript
helper (convex/lib/domain.ts) byte-for-byte.

These vectors are the cross-lane join contract. If any of these assertions fail,
the P4 analysis lane is producing different keys than P1/P2/P3 — joins will break
silently.
"""

from __future__ import annotations

from src.domains import normalize_domain, normalize_url


class TestNormalizeDomain:
    def test_bare_domain(self):
        assert normalize_domain("acme.com") == "acme.com"

    def test_www_uppercase(self):
        assert normalize_domain("WWW.Acme.com") == "acme.com"

    def test_www_lowercase(self):
        assert normalize_domain("www.acme.com") == "acme.com"

    def test_subdomain_stripped(self):
        assert normalize_domain("docs.acme.com") == "acme.com"

    def test_blog_subdomain_stripped(self):
        assert normalize_domain("blog.acme.com") == "acme.com"

    def test_multi_label_suffix(self):
        assert normalize_domain("blog.acme.co.uk") == "acme.co.uk"

    def test_docs_multi_label_suffix(self):
        assert normalize_domain("docs.example.co.uk") == "example.co.uk"

    def test_full_url_with_path(self):
        assert normalize_domain("https://www.Acme.com/pricing?x=1") == "acme.com"

    def test_userinfo_stripped(self):
        assert normalize_domain("user:pass@example.com") == "example.com"

    def test_subdomain_with_port(self):
        assert normalize_domain("sub.host.example.com:8080") == "example.com"

    def test_double_trailing_dot(self):
        assert normalize_domain("example.com..") == "example.com"

    def test_http_scheme_uppercase(self):
        assert normalize_domain("HTTP://Foo.COM/") == "foo.com"

    def test_localhost(self):
        assert normalize_domain("localhost") == "localhost"

    def test_empty_string(self):
        assert normalize_domain("") == ""


class TestNormalizeUrl:
    def test_www_path_case_preserved(self):
        assert normalize_url("https://www.Example.com/Home") == "https://example.com/Home"

    def test_trailing_slash_stripped(self):
        assert normalize_url("https://www.Acme.com/About-Us/") == "https://acme.com/About-Us"

    def test_subdomain_preserved(self):
        assert normalize_url("https://docs.acme.com/x") == "https://docs.acme.com/x"

    def test_http_upgraded_to_https(self):
        assert normalize_url("http://example.com") == "https://example.com"

    def test_tracking_params_dropped_others_sorted(self):
        assert normalize_url("https://example.com/page?utm_source=x&q=1&a=2") == "https://example.com/page?a=2&q=1"

    def test_root_slash_stripped(self):
        assert normalize_url("https://example.com/") == "https://example.com"

    def test_bare_domain_with_path(self):
        assert normalize_url("example.com/Path/") == "https://example.com/Path"

    def test_fragment_dropped_params_sorted(self):
        assert normalize_url("https://www.Example.com/a?b=2&a=1#frag") == "https://example.com/a?a=1&b=2"

    def test_empty_string(self):
        assert normalize_url("") == ""
