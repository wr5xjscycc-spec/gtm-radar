"""Asset generation — GPT-4o AEO-optimised treatment-page content.

In production, calls OpenAI's GPT-4o via the API key in OPENAI_API_KEY.
In tests, callers inject a call_llm stub to avoid real API calls.
"""

import json
import os
from typing import Callable, Optional

from src.models import DeliverableAsset


def _default_llm(prompt: str) -> str:
    """Real GPT-4o call (used in production). Requires OPENAI_API_KEY."""
    try:
        from openai import OpenAI
    except ImportError:
        return f"# Asset placeholder\n\nOpenAI SDK not installed. Install with: pip install openai\n\nPrompt: {prompt[:200]}..."

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return "# Asset placeholder\n\nOPENAI_API_KEY not set."

    client = OpenAI(api_key=api_key)
    resp = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are an AEO (Answer Engine Optimization) content strategist. "
                    "Write treatment-page content that will get cited by AI answer engines. "
                    "Use clear authority signals: data, citations, statistics, expert quotes. "
                    "Output in markdown with a title (H1), structured sections (H2/H3), "
                    "a metadata block (target_query, keywords), and a meta description."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        temperature=0.7,
        max_tokens=2000,
    )
    return str(resp.choices[0].message.content)


def generate_asset(
    hypothesis: str,
    page_url: str,
    queries: Optional[list[str]] = None,
    call_llm: Optional[Callable[[str], str]] = None,
) -> DeliverableAsset:
    """Generate AEO-optimised treatment-page content.

    Parameters
    ----------
    hypothesis : str
        The top hypothesis from model_fit to target.
    page_url : str
        The treatment page URL.
    queries : list of str, optional
        P3's queries to optimise for.
    call_llm : Callable[[str], str], optional
        LLM callable for the asset generation. Defaults to GPT-4o.
    """
    caller = call_llm or _default_llm

    prompt_lines = [
        f"Target hypothesis: {hypothesis}",
        f"Page URL: {page_url}",
    ]
    if queries:
        prompt_lines.append(f"Target queries: {json.dumps(queries)}")

    prompt_lines.append(
        "\nGenerate AEO-optimised page content. Include:\n"
        "1. A title (H1) that answers the target query directly.\n"
        "2. Structured sections (H2/H3) with data-backed claims.\n"
        "3. A metadata block with target_query and keywords.\n"
        "4. A meta description for SEO.\n"
        "5. Factual citations where possible.\n"
        "Format: markdown."
    )

    prompt = "\n".join(prompt_lines)
    content_md = caller(prompt)

    return DeliverableAsset(
        page_url=page_url,
        content_md=content_md,
        tier=1,
    )
