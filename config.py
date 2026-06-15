"""
Central configuration and synonym dictionaries for the job crawler.
Edit DEFAULT_CONFIG to change default search parameters.
"""

# ---------------------------------------------------------------------------
# Keyword synonym expansion
# ---------------------------------------------------------------------------

WERKSTUDENT_SYNONYMS = [
    "werkstudent",
    "werkstudentin",
    "working student",
    "student job",
    "studentenjob",
    "studentische hilfskraft",
    "studentische mitarbeit",
    "studentischer mitarbeiter",
    "hiwi",
    "studi job",
    "nebenjob student",
    "teilzeit student",
]

WIRTSCHAFTSINFORMATIK_SYNONYMS = [
    "wirtschaftsinformatik",
    "wirtschaftsinformatiker",
    "wirtschaftsinformatikerin",
    "wirtsch. informatik",
    "wi-student",
    "business informatics",
    "business information systems",
    "business information technology",
    "wirtschaftsinformation",
    "information systems",
    "bwl informatik",
    "digitales management",
    "digital business",
    "information management",
    "wirtschaft und informatik",
    "wi studium",
]

# Maps a hard keyword (lowercased) to its synonym list
HARD_KEYWORD_SYNONYMS: dict[str, list[str]] = {
    "werkstudent": WERKSTUDENT_SYNONYMS,
    "wirtschaftsinformatik": WIRTSCHAFTSINFORMATIK_SYNONYMS,
}


# ---------------------------------------------------------------------------
# Default search configuration (editable via the UI)
# ---------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "locations": [
        {"city": "Berlin", "distance_km": 30},
    ],
    "hard_keywords": ["Werkstudent", "Wirtschaftsinformatik"],
    "soft_keywords": [
        {"keyword": "Data Analyst", "rating": 9},
        {"keyword": "Python", "rating": 8},
        {"keyword": "SQL", "rating": 7},
        {"keyword": "Remote", "rating": 6},
        {"keyword": "Agile", "rating": 4},
    ],
    "max_days_online": 30,
    "max_pages_stepstone": 8,
    "sources": ["stepstone", "bundesagentur"],
    "auto_delete_days": 0,
}

# Distance mapping for Indeed radius parameter (approximate km → miles/indeed units)
# Indeed Germany uses km directly in the radius parameter
INDEED_RADIUS_MAP = {
    5: 5, 10: 10, 15: 15, 25: 25, 30: 30, 50: 50, 100: 100,
}

STEPSTONE_RADIUS_MAP = {
    5: 5, 10: 10, 20: 20, 30: 30, 40: 40, 50: 50, 75: 75, 100: 100,
}
