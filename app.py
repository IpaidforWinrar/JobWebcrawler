"""Flask application — serves the UI and exposes the REST API."""

import hashlib
import json
import logging
import threading
from datetime import datetime

from flask import Flask, jsonify, render_template, request, Response, stream_with_context

import database as db
from config import DEFAULT_CONFIG
from crawler import run_crawl

try:
    import anthropic as _ant
    _ANTHROPIC_AVAILABLE = True
except ImportError:
    _ant = None
    _ANTHROPIC_AVAILABLE = False

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Global crawl state
_crawl_state = {
    "running": False, "last_run": None, "last_count": 0, "error": None,
    "progress": 0, "progress_label": "", "progress_current": 0, "progress_total": 0,
}
_crawl_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Config API
# ---------------------------------------------------------------------------

@app.route("/api/config", methods=["GET"])
def get_config():
    cfg = db.load_config() or DEFAULT_CONFIG
    return jsonify(cfg)


@app.route("/api/config", methods=["POST"])
def set_config():
    cfg = request.get_json(force=True)
    db.save_config(cfg)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Jobs API
# ---------------------------------------------------------------------------

@app.route("/api/jobs", methods=["GET"])
def list_jobs():
    jobs = db.get_all_jobs()
    return jsonify(jobs)


@app.route("/api/jobs", methods=["POST"])
def create_job():
    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title required"}), 400
    job_id = hashlib.md5(f"custom:{title}{datetime.now().isoformat()}".encode()).hexdigest()
    job = {
        "id":             job_id,
        "title":          title,
        "company":        data.get("company", ""),
        "location":       data.get("location", ""),
        "url":            data.get("url", ""),
        "published_date": str(datetime.now().date()),
        "scraped_date":   str(datetime.now().date()),
        "source":         "custom",
        "description":    "",
        "score":          0,
        "matched_soft":   [],
    }
    db.upsert_job(job)
    if data.get("notes"):
        db.update_job_notes(job_id, data["notes"])
    return jsonify({"ok": True, "id": job_id})


@app.route("/api/jobs/<job_id>/dates", methods=["PATCH"])
def patch_dates(job_id: str):
    data = request.get_json(force=True)
    db.update_job_dates(
        job_id,
        applied_date=data.get("applied_date"),
        rejected_date=data.get("rejected_date"),
        interview_date=data.get("interview_date"),
    )
    return jsonify({"ok": True})


@app.route("/api/jobs/<job_id>/status", methods=["PATCH"])
def patch_status(job_id: str):
    data = request.get_json(force=True)
    status = data.get("status")
    try:
        db.update_job_status(job_id, status)
        return jsonify({"ok": True})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400


@app.route("/api/jobs/<job_id>/notes", methods=["PATCH"])
def patch_notes(job_id: str):
    data = request.get_json(force=True)
    db.update_job_notes(job_id, data.get("notes", ""))
    return jsonify({"ok": True})


@app.route("/api/jobs/<job_id>", methods=["DELETE"])
def delete_job(job_id: str):
    db.delete_job(job_id)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Crawl API
# ---------------------------------------------------------------------------

@app.route("/api/crawl", methods=["POST"])
def start_crawl():
    with _crawl_lock:
        if _crawl_state["running"]:
            return jsonify({"error": "Crawl already running"}), 409

    cfg = db.load_config() or DEFAULT_CONFIG

    def _worker():
        locs          = cfg.get("locations", [])
        max_pages_ss  = cfg.get("max_pages_stepstone", 8)
        sources       = cfg.get("sources", ["stepstone", "bundesagentur"])
        total_ss = max_pages_ss * len(locs) if "stepstone" in sources else 0
        total_ba = 10 * len(locs) if ("bundesagentur" in sources or "indeed" in sources) else 0
        total    = max(1, total_ss + total_ba)

        with _crawl_lock:
            _crawl_state["running"]          = True
            _crawl_state["error"]            = None
            _crawl_state["progress"]         = 0
            _crawl_state["progress_label"]   = ""
            _crawl_state["progress_current"] = 0
            _crawl_state["progress_total"]   = total

        def on_progress(source, city, page, max_p):
            with _crawl_lock:
                _crawl_state["progress_current"] += 1
                pct = min(99, int(_crawl_state["progress_current"] / total * 100))
                _crawl_state["progress"]       = pct
                _crawl_state["progress_label"] = f"{source} · {city} · Seite {page}/{max_p}"

        try:
            jobs = run_crawl(cfg, on_progress=on_progress)
            for job in jobs:
                db.upsert_job(job)
            auto_delete_days = cfg.get("auto_delete_days", 0)
            if auto_delete_days > 0:
                deleted = db.delete_old_jobs(auto_delete_days)
                if deleted:
                    logger.info("Auto-deleted %d old jobs (status=new, older than %d days)",
                                deleted, auto_delete_days)
            with _crawl_lock:
                _crawl_state["last_count"]     = len(jobs)
                _crawl_state["last_run"]       = datetime.now().isoformat(timespec="seconds")
                _crawl_state["progress"]       = 100
                _crawl_state["progress_label"] = "Fertig"
        except Exception as exc:
            logger.exception("Crawl failed")
            with _crawl_lock:
                _crawl_state["error"] = str(exc)
        finally:
            with _crawl_lock:
                _crawl_state["running"] = False

    threading.Thread(target=_worker, daemon=True).start()
    return jsonify({"ok": True, "message": "Crawl started"})


@app.route("/api/rescore", methods=["POST"])
def rescore_all():
    """Re-score all non-custom jobs using current config's soft keywords."""
    from crawler import score_soft_keywords
    cfg = db.load_config() or DEFAULT_CONFIG
    soft_keywords = cfg.get("soft_keywords", [])
    jobs = db.get_all_jobs()
    updates = []
    for j in jobs:
        if j.get("source") == "custom":
            continue
        score, matched = score_soft_keywords(j.get("description") or "", soft_keywords)
        updates.append((score, json.dumps(matched), j["id"]))
    if updates:
        db.batch_update_scores(updates)
    return jsonify({"ok": True, "count": len(updates)})


@app.route("/api/jobs/<job_id>/cover-letters", methods=["GET"])
def list_cover_letters(job_id: str):
    return jsonify(db.get_cover_letters(job_id))


@app.route("/api/jobs/<job_id>/cover-letters", methods=["POST"])
def create_cover_letter(job_id: str):
    data = request.get_json(force=True)
    cl_id = db.save_cover_letter(
        job_id=job_id,
        content=data.get("content", ""),
        chat_history=data.get("chat_history", []),
        model=data.get("model", ""),
        version_name=data.get("version_name", ""),
    )
    return jsonify({"ok": True, "id": cl_id})


@app.route("/api/cover-letters/<cl_id>", methods=["DELETE"])
def delete_cover_letter(cl_id: str):
    db.delete_cover_letter(cl_id)
    return jsonify({"ok": True})


@app.route("/api/cover-letter/upload", methods=["POST"])
def cover_letter_upload():
    """Extract text from an uploaded PDF, DOCX or TXT file."""
    if "file" not in request.files:
        return jsonify({"error": "Keine Datei"}), 400
    f    = request.files["file"]
    name = f.filename or ""
    ext  = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    try:
        if ext == "pdf":
            import io
            import pdfplumber
            raw = f.read()
            with pdfplumber.open(io.BytesIO(raw)) as pdf:
                text = "\n\n".join(p.extract_text() or "" for p in pdf.pages).strip()
        elif ext == "docx":
            import io
            from docx import Document
            doc = Document(io.BytesIO(f.read()))
            text = "\n".join(p.text for p in doc.paragraphs if p.text).strip()
        elif ext in ("txt", "md"):
            text = f.read().decode("utf-8", errors="replace").strip()
        else:
            return jsonify({"error": f"Format '.{ext}' wird nicht unterstützt (PDF, DOCX, TXT)"}), 400
    except ImportError:
        missing = "pdfplumber" if ext == "pdf" else "python-docx"
        return jsonify({"error": f"Bibliothek fehlt: pip install {missing}"}), 500
    except Exception as exc:
        return jsonify({"error": f"Lesefehler: {exc}"}), 500
    return jsonify({"text": text, "filename": name, "chars": len(text)})


@app.route("/api/cover-letter/stream", methods=["POST"])
def cover_letter_stream():
    """Stream a cover-letter generation or chat continuation via SSE."""
    if not _ANTHROPIC_AVAILABLE:
        return jsonify({"error": "anthropic-Paket fehlt. Führe aus: pip install anthropic"}), 500

    data     = request.get_json(force=True)
    cfg      = db.load_config() or DEFAULT_CONFIG
    api_key  = cfg.get("anthropic_api_key", "").strip()
    if not api_key:
        return jsonify({"error": "Kein Anthropic API-Key. Bitte in den Einstellungen eintragen."}), 400

    model    = data.get("model", "claude-sonnet-4-6")
    thinking = data.get("thinking", False)
    messages = data.get("messages", [])
    system   = data.get("system", "")

    PRICING = {
        "claude-opus-4-8":   (5.0, 25.0),
        "claude-sonnet-4-6": (3.0, 15.0),
        "claude-haiku-4-5":  (1.0,  5.0),
    }

    def generate():
        try:
            client = _ant.Anthropic(api_key=api_key)
            kwargs = {"model": model, "max_tokens": 8192, "messages": messages}
            if system:
                kwargs["system"] = system
            if thinking:
                kwargs["thinking"] = {"type": "adaptive"}

            with client.messages.stream(**kwargs) as stream:
                for text_chunk in stream.text_stream:
                    yield f"data: {json.dumps({'type': 'text', 'text': text_chunk})}\n\n"
                final = stream.get_final_message()

            usage = final.usage
            in_p, out_p = PRICING.get(model, (3.0, 15.0))
            cost_usd = (usage.input_tokens / 1_000_000) * in_p + (usage.output_tokens / 1_000_000) * out_p
            cost_eur = cost_usd * 0.92
            yield f"data: {json.dumps({'type': 'done', 'usage': {'input_tokens': usage.input_tokens, 'output_tokens': usage.output_tokens, 'cost_usd': round(cost_usd, 6), 'cost_eur': round(cost_eur, 6)}})}\n\n"

        except Exception as exc:
            name = type(exc).__name__
            if "Authentication" in name:
                msg = "Ungültiger API-Key. Bitte prüfen."
            elif "RateLimit" in name:
                msg = "Rate limit erreicht. Bitte kurz warten."
            else:
                msg = str(exc)
            yield f"data: {json.dumps({'type': 'error', 'error': msg})}\n\n"

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.route("/api/config/ban", methods=["POST"])
def add_ban():
    data = request.get_json(force=True)
    keyword = data.get("keyword", "")
    context = data.get("context", "")
    if not keyword or not context:
        return jsonify({"error": "keyword and context required"}), 400
    cfg = db.load_config() or DEFAULT_CONFIG
    for sk in cfg.get("soft_keywords", []):
        if sk["keyword"].lower() == keyword.lower():
            bans = sk.setdefault("banned_contexts", [])
            if context not in bans:
                bans.append(context)
            break
    db.save_config(cfg)
    return jsonify({"ok": True})


@app.route("/api/crawl/status", methods=["GET"])
def crawl_status():
    with _crawl_lock:
        return jsonify(dict(_crawl_state))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    db.init_db()
    print("Job Crawler running at http://localhost:5000")
    app.run(debug=False, host="0.0.0.0", port=5000)
