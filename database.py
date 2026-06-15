"""SQLite persistence layer for scraped jobs and user settings."""

import json
import sqlite3
from pathlib import Path
from datetime import datetime, timedelta

DB_PATH = Path(__file__).parent / "jobs.db"


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS jobs (
                id                  TEXT PRIMARY KEY,
                title               TEXT NOT NULL,
                company             TEXT,
                location            TEXT,
                url                 TEXT,
                published_date      TEXT,
                scraped_date        TEXT NOT NULL,
                source              TEXT,
                description         TEXT,
                score               REAL DEFAULT 0,
                matched_soft        TEXT DEFAULT '[]',
                status              TEXT DEFAULT 'new',
                notes               TEXT DEFAULT '',
                applied_date        TEXT DEFAULT '',
                rejected_date       TEXT DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS config (
                key     TEXT PRIMARY KEY,
                value   TEXT NOT NULL
            );
        """)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS cover_letters (
                id           TEXT PRIMARY KEY,
                job_id       TEXT NOT NULL,
                content      TEXT NOT NULL,
                chat_history TEXT DEFAULT '[]',
                model        TEXT DEFAULT '',
                created_at   TEXT NOT NULL,
                version_name TEXT DEFAULT ''
            );
        """)

        # Migrate existing DB: add columns if they don't exist yet
        for col_def in ("applied_date TEXT DEFAULT ''", "rejected_date TEXT DEFAULT ''",
                        "interview_date TEXT DEFAULT ''"):
            try:
                conn.execute(f"ALTER TABLE jobs ADD COLUMN {col_def}")
            except Exception:
                pass  # column already present

        # Normalize StepStone URL endings to exactly one dash before .html.
        # Previous migration used LENGTH-4 (off-by-one: always matched '.'),
        # so it added an extra '-' on every startup → accumulated dashes.
        # RTRIM strips any number of trailing dashes, then we add exactly one.
        conn.execute("""
            UPDATE jobs
            SET url = RTRIM(SUBSTR(url, 1, LENGTH(url)-5), '-') || '-.html'
            WHERE source = 'stepstone'
              AND url LIKE 'https://www.stepstone.de/%'
              AND url LIKE '%.html'
        """)


# ---------------------------------------------------------------------------
# Job CRUD
# ---------------------------------------------------------------------------

def upsert_job(job: dict) -> None:
    """Insert or update a job. Preserves status/notes for existing entries."""
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT status, notes FROM jobs WHERE id = ?", (job["id"],)
        ).fetchone()

        if existing:
            conn.execute("""
                UPDATE jobs SET
                    title=?, company=?, location=?, url=?, published_date=?,
                    scraped_date=?, source=?, description=?, score=?, matched_soft=?
                WHERE id=?
            """, (
                job["title"], job["company"], job["location"], job["url"],
                job["published_date"], job["scraped_date"], job["source"],
                job["description"], job["score"],
                json.dumps(job.get("matched_soft", [])),
                job["id"],
            ))
        else:
            conn.execute("""
                INSERT INTO jobs
                    (id, title, company, location, url, published_date, scraped_date,
                     source, description, score, matched_soft, status, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '')
            """, (
                job["id"], job["title"], job["company"], job["location"],
                job["url"], job["published_date"], job["scraped_date"],
                job["source"], job["description"], job["score"],
                json.dumps(job.get("matched_soft", [])),
            ))


def get_all_jobs() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY score DESC, published_date DESC"
        ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["matched_soft"] = json.loads(d["matched_soft"] or "[]")
        result.append(d)
    return result


def update_job_status(job_id: str, status: str) -> None:
    valid = {"new", "interested", "applied", "interview", "rejected", "no_fit"}
    if status not in valid:
        raise ValueError(f"Invalid status: {status}")
    with get_conn() as conn:
        conn.execute("UPDATE jobs SET status=? WHERE id=?", (status, job_id))


def update_job_notes(job_id: str, notes: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE jobs SET notes=? WHERE id=?", (notes, job_id))


def delete_job(job_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM jobs WHERE id=?", (job_id,))


def update_job_dates(job_id: str, applied_date: str | None = None,
                     rejected_date: str | None = None, interview_date: str | None = None) -> None:
    with get_conn() as conn:
        if applied_date is not None:
            conn.execute("UPDATE jobs SET applied_date=? WHERE id=?", (applied_date, job_id))
        if rejected_date is not None:
            conn.execute("UPDATE jobs SET rejected_date=? WHERE id=?", (rejected_date, job_id))
        if interview_date is not None:
            conn.execute("UPDATE jobs SET interview_date=? WHERE id=?", (interview_date, job_id))


def batch_update_scores(updates: list[tuple]) -> None:
    """Update score and matched_soft for multiple jobs. Each tuple: (score, matched_soft_json, id)."""
    with get_conn() as conn:
        conn.executemany(
            "UPDATE jobs SET score=?, matched_soft=? WHERE id=?",
            updates,
        )


# ---------------------------------------------------------------------------
# Cover letters
# ---------------------------------------------------------------------------

def save_cover_letter(job_id: str, content: str, chat_history: list,
                      model: str = "", version_name: str = "") -> str:
    import uuid
    cl_id = uuid.uuid4().hex[:16]
    created = datetime.now().isoformat(timespec="seconds")
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO cover_letters
               (id, job_id, content, chat_history, model, created_at, version_name)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (cl_id, job_id, content, json.dumps(chat_history), model, created, version_name),
        )
    return cl_id


def get_cover_letters(job_id: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM cover_letters WHERE job_id=? ORDER BY created_at DESC",
            (job_id,),
        ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d["chat_history"] = json.loads(d.get("chat_history") or "[]")
        result.append(d)
    return result


def delete_cover_letter(cl_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM cover_letters WHERE id=?", (cl_id,))


def delete_old_jobs(max_days: int) -> int:
    """Delete jobs with status='new' whose published_date is older than max_days.
    Jobs that have been moved to any Kanban column (status != 'new') are kept."""
    cutoff = str((datetime.now() - timedelta(days=max_days)).date())
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM jobs WHERE status = 'new' AND published_date != '' AND published_date < ?",
            (cutoff,),
        )
        return cur.rowcount


# ---------------------------------------------------------------------------
# Config persistence
# ---------------------------------------------------------------------------

def save_config(cfg: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO config (key, value) VALUES ('main', ?)",
            (json.dumps(cfg),),
        )


def load_config() -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT value FROM config WHERE key='main'"
        ).fetchone()
    if row:
        return json.loads(row["value"])
    return None
