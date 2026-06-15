"""
Web crawler for German job boards.
Sources:
  - StepStone (stepstone.de) — listing via embedded JSON, description via session fetch
  - Bundesagentur fuer Arbeit (arbeitsagentur.de) — public REST API for listing + detail

Flow per job:
  1. Collect candidates from listing (title, company, location, url, textSnippet)
  2. If textSnippet already satisfies ALL hard keywords → use it, skip detail fetch
  3. Otherwise fetch the detail page / API endpoint for the full description
  4. Apply hard-keyword AND check on full text
  5. Score soft keywords on full text
  Only jobs passing step 4 reach the database.
"""

import hashlib
import json
import logging
import re
import time
import random
from datetime import datetime
from typing import Generator

import requests
from bs4 import BeautifulSoup

from config import HARD_KEYWORD_SYNONYMS

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# HTTP session factory
# ---------------------------------------------------------------------------

def _make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    return s


def _get_with_session(session: requests.Session, url: str,
                      params: dict | None = None,
                      extra_headers: dict | None = None,
                      retries: int = 3) -> requests.Response | None:
    if extra_headers:
        session.headers.update(extra_headers)
    for attempt in range(retries):
        try:
            resp = session.get(url, params=params, timeout=20)
            if resp.status_code == 200:
                return resp
            if resp.status_code == 429:
                wait = 15 * (attempt + 1)
                logger.warning("Rate limited — waiting %ds", wait)
                time.sleep(wait)
            else:
                logger.warning("HTTP %d for %s", resp.status_code, url)
                return None
        except requests.RequestException as exc:
            logger.warning("Request error (%s): %s", url, exc)
            time.sleep(3)
    return None


def _make_id(source: str, key: str) -> str:
    return hashlib.md5(f"{source}:{key}".encode()).hexdigest()


def _parse_iso_date(raw: str | None) -> str:
    if not raw:
        return ""
    try:
        return str(datetime.fromisoformat(raw).date())
    except Exception:
        return raw[:10] if len(raw) >= 10 else ""


# ---------------------------------------------------------------------------
# Keyword helpers
# ---------------------------------------------------------------------------

def _synonyms_for(keyword: str) -> list[str]:
    return HARD_KEYWORD_SYNONYMS.get(keyword.lower(), [keyword.lower()])


def matches_hard_keywords(text: str, hard_keywords: list[str]) -> bool:
    """ALL hard keywords (or one synonym each) must appear — AND logic."""
    t = text.lower()
    for kw in hard_keywords:
        if not any(syn in t for syn in _synonyms_for(kw)):
            return False
    return True


def find_context_words(text: str, keyword: str) -> list[str]:
    """Return distinct words in text that contain keyword as a substring."""
    kw_lower = keyword.lower()
    words = re.findall(r'[A-Za-zÄäÖöÜüß][A-Za-zÄäÖöÜüß0-9\-]*', text)
    seen: set[str] = set()
    result: list[str] = []
    for w in words:
        wl = w.lower()
        if kw_lower in wl and wl not in seen:
            seen.add(wl)
            result.append(w)
    return result[:8]


def score_soft_keywords(text: str, soft_keywords: list[dict]) -> tuple[float, list[dict]]:
    """Score soft keywords against text, respecting banned contexts.

    Returns (total_score, matched) where each matched entry is
    {"keyword": str, "contexts": [words that contained the keyword]}.
    """
    t = text.lower()
    score = 0.0
    matched: list[dict] = []
    for sk in soft_keywords:
        kw = sk["keyword"].lower()
        if kw not in t:
            continue
        contexts = find_context_words(text, sk["keyword"])
        banned = {b.lower() for b in sk.get("banned_contexts", [])}
        valid = [c for c in contexts if c.lower() not in banned]
        if valid:
            score += sk["rating"]
            matched.append({"keyword": sk["keyword"], "contexts": valid})
    return score, matched


def is_within_days(published_date_str: str | None, max_days: int) -> bool:
    if not published_date_str:
        return True
    try:
        pub = datetime.fromisoformat(published_date_str).date()
        return (datetime.now().date() - pub).days <= max_days
    except Exception:
        return True


# ---------------------------------------------------------------------------
# Description extractors
# ---------------------------------------------------------------------------

def _strip_html(text: str) -> str:
    """Strip HTML tags and return plain text."""
    if not text or "<" not in text:
        return text
    return BeautifulSoup(text, "lxml").get_text(" ", strip=True)


def _extract_jsonld_description(soup: BeautifulSoup) -> str:
    """Try to get job description from schema.org JSON-LD in the page."""
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
            if isinstance(data, list):
                data = next((d for d in data if d.get("@type") == "JobPosting"), {})
            if data.get("@type") == "JobPosting":
                parts = []
                for field in ("description", "responsibilities", "qualifications",
                              "skills", "experienceRequirements"):
                    v = data.get(field, "")
                    if v:
                        # JSON-LD description fields often contain raw HTML — strip it
                        parts.append(_strip_html(str(v)))
                return " ".join(parts)
        except Exception:
            pass
    return ""


def _fetch_stepstone_description(session: requests.Session, url: str) -> str:
    """Fetch a StepStone detail page and return its full description text."""
    session.headers["Referer"] = "https://www.stepstone.de/jobs/suche"
    resp = _get_with_session(session, url, retries=2)
    if not resp:
        return ""
    soup = BeautifulSoup(resp.text, "lxml")

    # 1. JSON-LD — most reliable
    desc = _extract_jsonld_description(soup)
    if desc and len(desc) > 50:
        return desc

    # 2. article[data-at='rebranded-version'] — confirmed selector
    el = soup.select_one("article[data-at='rebranded-version']")
    if el:
        return el.get_text(" ", strip=True)

    # 3. Widest fallback
    main = soup.select_one("main") or soup.select_one("article") or soup.body
    return main.get_text(" ", strip=True)[:8000] if main else ""


# ---------------------------------------------------------------------------
# StepStone scraper
# ---------------------------------------------------------------------------

STEPSTONE_BASE = "https://www.stepstone.de"
PRELOADED_RE = re.compile(
    r'window\.__PRELOADED_STATE__\["app-unifiedResultlist"\]\s*=\s*(\{.*?\});?\s*\n',
    re.DOTALL,
)


def _extract_stepstone_listing(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    for script in soup.find_all("script"):
        t = script.string or ""
        if "searchResults" not in t or "__PRELOADED_STATE__" not in t:
            continue
        m = PRELOADED_RE.search(t)
        if not m:
            continue
        try:
            data = json.loads(m.group(1))
            items = data["searchResults"]["items"]
            return items if isinstance(items, list) else []
        except Exception as exc:
            logger.warning("StepStone JSON parse error: %s", exc)
    return []


def crawl_stepstone(
    hard_keywords: list[str],
    soft_keywords: list[dict],
    locations: list[dict],
    max_days: int,
    max_pages: int = 8,
    on_progress=None,
) -> Generator[dict, None, None]:

    session = _make_session()

    for loc in locations:
        city   = loc["city"]
        radius = loc.get("distance_km", 30)
        query  = " ".join(hard_keywords)
        logger.info("StepStone: '%s' in %s (%dkm)", query, city, radius)

        for page in range(max_pages):
            if on_progress:
                on_progress("StepStone", city, page + 1, max_pages)
            offset = page * 25
            params: dict = {"q": query, "where": city, "radius": radius, "culture": "de-DE"}
            if offset:
                params["of"] = offset

            # Listing fetch also initialises session cookies
            resp = _get_with_session(session, f"{STEPSTONE_BASE}/jobs/suche", params=params)
            if not resp:
                break

            items = _extract_stepstone_listing(resp.text)
            if not items:
                logger.info("StepStone: no items on page %d, stopping", page + 1)
                break

            logger.info("StepStone page %d: %d candidates", page + 1, len(items))

            for item in items:
                title      = item.get("title", "")
                company    = item.get("companyName", "")
                location   = item.get("location", "")
                snippet    = item.get("textSnippet", "")  # short description in listing JSON
                rel_url    = item.get("url", "").split("?")[0]
                full_url   = STEPSTONE_BASE + rel_url if rel_url.startswith("/") else rel_url
                full_url   = full_url.replace("-inline.html", "-.html")
                pub_date   = _parse_iso_date(item.get("datePosted"))

                if not is_within_days(pub_date, max_days):
                    continue

                base_text = f"{title} {company} {location} {snippet}"

                # Always fetch detail page so soft-keyword scoring runs on the
                # full description — not just the short listing snippet.
                # Hard-keyword check on snippet is used only as a quick pre-filter
                # to skip obvious non-matches without making a network request.
                if not matches_hard_keywords(base_text, hard_keywords):
                    # Quick pre-check failed — still try detail in case snippet missed it
                    time.sleep(random.uniform(0.8, 1.5))
                    detail_desc = _fetch_stepstone_description(session, full_url)
                    full_text   = f"{base_text} {detail_desc}"
                    if not matches_hard_keywords(full_text, hard_keywords):
                        logger.debug("StepStone SKIP (hard kw miss): %s", title[:60])
                        time.sleep(random.uniform(0.3, 0.8))
                        continue
                else:
                    # Pre-check passed — still fetch detail for accurate soft scoring
                    time.sleep(random.uniform(0.8, 1.5))
                    detail_desc = _fetch_stepstone_description(session, full_url)
                    full_text   = f"{base_text} {detail_desc}"

                description = full_text

                score, matched = score_soft_keywords(description, soft_keywords)
                logger.info("StepStone MATCH [score=%g, soft=%s]: %s",
                            score, matched, title[:60])

                yield {
                    "id":             _make_id("stepstone", str(item.get("id", full_url))),
                    "title":          title,
                    "company":        company,
                    "location":       location,
                    "url":            full_url,
                    "published_date": pub_date,
                    "scraped_date":   str(datetime.now().date()),
                    "source":         "stepstone",
                    "description":    full_text,
                    "score":          score,
                    "matched_soft":   matched,
                }

                time.sleep(random.uniform(0.8, 1.5))

            time.sleep(random.uniform(2.0, 3.5))

        time.sleep(random.uniform(2.0, 4.0))


# ---------------------------------------------------------------------------
# Bundesagentur fuer Arbeit scraper
# ---------------------------------------------------------------------------

BA_LIST_API   = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs"
BA_DETAIL_API = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs/{refnr}"
BA_JOB_URL    = "https://www.arbeitsagentur.de/jobsuche/suche?id={refnr}"
BA_HEADERS    = {
    "User-Agent": "JobCrawler/1.0 (educational project)",
    "X-API-Key":  "jobboerse-jobsuche",
}


def _fetch_ba_description(refnr: str) -> str:
    """Fetch full job description from Bundesagentur detail API."""
    if not refnr:
        return ""
    try:
        resp = requests.get(
            BA_DETAIL_API.format(refnr=refnr),
            headers=BA_HEADERS, timeout=15,
        )
        if resp.status_code != 200:
            return ""
        data = resp.json()
    except Exception:
        return ""

    parts = []
    for field in ("stellenbeschreibung", "beschreibung", "tatigkeitsbeschreibung",
                  "qualifikation", "anforderungen"):
        v = data.get(field, "")
        if v:
            parts.append(_strip_html(str(v)))
    for field in ("angebotsdetails",):
        obj = data.get(field)
        if isinstance(obj, dict):
            parts.extend(_strip_html(str(v)) for v in obj.values() if v)
    return " ".join(parts)


def crawl_bundesagentur(
    hard_keywords: list[str],
    soft_keywords: list[dict],
    locations: list[dict],
    max_days: int,
    max_pages: int = 10,
    on_progress=None,
) -> Generator[dict, None, None]:

    for loc in locations:
        city   = loc["city"]
        radius = loc.get("distance_km", 30)
        query  = " ".join(hard_keywords)
        logger.info("Bundesagentur: '%s' in %s (%dkm)", query, city, radius)

        for page in range(1, max_pages + 1):
            if on_progress:
                on_progress("Bundesagentur", city, page, max_pages)
            params = {
                "was":         query,
                "wo":          city,
                "umkreis":     radius,
                "angebotsart": 1,
                "page":        page,
                "size":        25,
                "zeitraum":    max_days,
            }
            try:
                resp = requests.get(BA_LIST_API, params=params,
                                    headers=BA_HEADERS, timeout=20)
                if resp.status_code != 200:
                    break
                data = resp.json()
            except Exception:
                break

            jobs  = data.get("stellenangebote") or []
            total = data.get("maxErgebnisse", 0)
            logger.info("BA page %d: %d/%d candidates", page, len(jobs), total)

            if not jobs:
                break

            for job in jobs:
                title    = job.get("titel", "")
                company  = job.get("arbeitgeber", "")
                ort_obj  = job.get("arbeitsort", {})
                location = ort_obj.get("ort", "") if isinstance(ort_obj, dict) else ""
                refnr    = job.get("refnr", "")
                pub_date = _parse_iso_date(
                    job.get("modifikationsTimestamp") or
                    job.get("aktuelleVeroeffentlichungsdatum", "")
                )

                base_text = f"{title} {company} {location}"

                # Always fetch full description for accurate soft-keyword scoring
                detail    = _fetch_ba_description(refnr)
                full_text = f"{base_text} {detail}"

                if not matches_hard_keywords(full_text, hard_keywords):
                    logger.debug("BA SKIP (hard kw miss): %s", title[:60])
                    time.sleep(0.3)
                    continue

                description = full_text

                score, matched = score_soft_keywords(description, soft_keywords)
                logger.info("BA MATCH [score=%g, soft=%s]: %s", score, matched, title[:60])

                yield {
                    "id":             _make_id("ba", refnr or title),
                    "title":          title,
                    "company":        company,
                    "location":       location,
                    "url":            BA_JOB_URL.format(refnr=refnr) if refnr else "",
                    "published_date": pub_date,
                    "scraped_date":   str(datetime.now().date()),
                    "source":         "bundesagentur",
                    "description":    full_text,
                    "score":          score,
                    "matched_soft":   matched,
                }

                time.sleep(random.uniform(0.4, 0.8))

            if page * 25 >= total:
                break
            time.sleep(random.uniform(1.0, 2.0))

        time.sleep(random.uniform(1.5, 3.0))


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run_crawl(config: dict, on_progress=None) -> list[dict]:
    hard          = config["hard_keywords"]
    soft          = config["soft_keywords"]
    locations     = config["locations"]
    max_days      = config["max_days_online"]
    sources       = config.get("sources", ["stepstone", "bundesagentur"])
    max_pages_ss  = config.get("max_pages_stepstone", 8)

    collected: dict[str, dict] = {}

    if "stepstone" in sources:
        for job in crawl_stepstone(hard, soft, locations, max_days,
                                   max_pages=max_pages_ss, on_progress=on_progress):
            collected[job["id"]] = job

    if "bundesagentur" in sources or "indeed" in sources:
        for job in crawl_bundesagentur(hard, soft, locations, max_days,
                                       on_progress=on_progress):
            if job["id"] not in collected:
                collected[job["id"]] = job

    return sorted(collected.values(), key=lambda j: j["score"], reverse=True)
