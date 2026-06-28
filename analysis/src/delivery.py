"""3-tier delivery — CMS publish (stubbed), off-page playbook, partner referral.

Tier-1: Generate content + CMS publish payload (stubbed in v1 — returns
        the payload shape + a publish event stub).
Tier-2: Playbook text for off-page gaps (G2/Reddit/Wikipedia) that the
        content generator CANNOT auto-fix.
Tier-3: Partner-referral hook (stub).

Red-team guard: off-page gaps are routed to Tier-2/3, never to Tier-1.
    A page edit CANNOT fix an earned-media gap.
"""

from typing import Optional

from src.models import CmsPublishPayload, PlaybookStep


# ── Off-page gap classifer ────────────────────────────────────────────

OFFPAGE_CHANNEL_MAP: dict[str, str] = {
    "offpage.thirdparty_mentions": "earned_press",
    "offpage.reddit_presence": "reddit",
    "offpage.g2_presence": "g2",
    "offpage.wikipedia_presence": "wikipedia",
    "offpage.review_site_presence": "review_site",
    "offpage.brand_search_volume": "brand_awareness",
    "offpage.backlink_density": "seo_authority",
    "offpage.entity_cooccurrence": "entity_seo",
}


def classify_offpage_gap(feature_name: str) -> Optional[str]:
    """Map an off-page feature to its channel, or None if on-page."""
    return OFFPAGE_CHANNEL_MAP.get(feature_name)


def is_off_page_gap(feature_name: str) -> bool:
    """True if the feature is an off-page gap that cannot be auto-fixed."""
    return classify_offpage_gap(feature_name) is not None


# ── Tier-1: on-page CMS publish ──────────────────────────────────────

def build_cms_payload(
    page_url: str,
    content_md: str,
) -> CmsPublishPayload:
    """Build a CMS publish payload from generated content.

    STUBBED for v1 — returns the payload shape. In production P3's CMS
    adapter (WordPress/Webflow/… from target vertical) would receive this
    and execute the publish.
    """
    title = content_md.split("\n")[0].strip("# \t") if content_md else "Untitled"
    body_html = _md_to_simple_html(content_md)
    meta = {"generator": "gtm-radar-p4", "version": "0.1.0"}

    return CmsPublishPayload(
        page_url=page_url,
        title=title,
        body_html=body_html,
        meta=meta,
    )


def _md_to_simple_html(md: str) -> str:
    lines = md.split("\n")
    html_parts: list[str] = []
    in_list = False
    for line in lines:
        if line.startswith("# "):
            html_parts.append(f"<h1>{line[2:]}</h1>")
        elif line.startswith("## "):
            html_parts.append(f"<h2>{line[3:]}</h2>")
        elif line.startswith("### "):
            html_parts.append(f"<h3>{line[4:]}</h3>")
        elif line.startswith("- ") or line.startswith("* "):
            if not in_list:
                html_parts.append("<ul>")
                in_list = True
            html_parts.append(f"<li>{line[2:]}</li>")
        else:
            if in_list:
                html_parts.append("</ul>")
                in_list = False
            stripped = line.strip()
            if stripped:
                html_parts.append(f"<p>{stripped}</p>")
    if in_list:
        html_parts.append("</ul>")
    return "\n".join(html_parts)


# ── Tier-2: off-page playbook ────────────────────────────────────────

OPPOSITE_SIGN_PLAYBOOK: dict[str, str] = {
    "earned_press": "Pitch product milestones to industry journalists. "
        "Target HARO/Connectively queries in the company's vertical weekly.",
    "reddit": "Engage relevant r/{subreddit} communities with authentic "
        "Q&A — not promotional posts. Monitor subreddits via P3's Reddit "
        "crawl and contribute expert answers.",
    "g2": "Claim the G2 profile, collect verified reviews from existing "
        "customers, and respond to every review (positive and negative) "
        "within 48 hours.",
    "wikipedia": "Wikipedia presence requires independent third-party "
        "coverage; no direct edit is possible. Invest in earned press "
        "(Tier-3) to eventually meet notability guidelines.",
    "review_site": "Claim profiles on Capterra, TrustRadius, and G2. "
        "Send post-purchase NPS surveys with review-site redirects for "
        "promoters.",
    "brand_awareness": "Invest in branded search via PR (Tier-3) and "
        "co-occurrence with industry keywords in Tier-1 content.",
    "seo_authority": "Build backlinks through guest posting on industry "
        "publications, broken-link building, and data-driven original "
        "research that other sites cite.",
    "entity_seo": "Ensure consistent structured data (Schema.org) across "
        "all owned properties. Co-cite the company brand with key entity "
        "terms in Tier-1 content.",
}


def generate_playbook(feature_name: str) -> PlaybookStep:
    """Generate a Tier-2 playbook step for an off-page gap."""
    channel = classify_offpage_gap(feature_name)
    if channel is None:
        return PlaybookStep(
            channel="on_page",
            action="This is an on-page gap; use Tier-1 content generation.",
            rationale="On-page gaps can be addressed by the content generator.",
        )

    action = OPPOSITE_SIGN_PLAYBOOK.get(channel, f"Build {channel} presence through earned channels.")
    return PlaybookStep(
        channel=channel,
        action=action,
        rationale=f"Off-page gap '{feature_name}' cannot be auto-fixed by content generation.",
    )


# ── Tier-3: partner-referral hook (stub) ─────────────────────────────

def partner_referral_hook(feature_name: str) -> dict:
    """Stub: return a partner-referral shape for earned-media gaps.

    In production this would query a partner marketplace (PR agencies,
    guest-post networks, review-acquisition services).
    """
    channel = classify_offpage_gap(feature_name)
    return {
        "channel": channel or "unknown",
        "feature": feature_name,
        "partner_providers": [],
        "note": "Partner marketplace not yet integrated (stub in v1). "
        "See docs/DELIVERY_PARTNERS.md when live.",
    }
