#!/usr/bin/env python3
"""
YouTube Transcript Worker
Usage:
  python get_transcript.py "https://www.youtube.com/watch?v=VIDEO_ID"
  python get_transcript.py "https://youtu.be/VIDEO_ID"
"""

import re
import sys
from urllib.parse import parse_qs, urlparse

import requests
import yt_dlp
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)


def extract_video_id(url: str) -> str:
    url = url.strip()
    patterns = [
        r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/v/|youtube\.com/shorts/)([a-zA-Z0-9_-]{11})",
        r"^([a-zA-Z0-9_-]{11})$",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)

    parsed = urlparse(url)
    if parsed.hostname and "youtube" in parsed.hostname:
        query = parse_qs(parsed.query)
        if "v" in query:
            return query["v"][0]

    raise ValueError(f"Could not extract video ID from URL: {url}")


def _format_duration(seconds) -> str:
    if not seconds:
        return "unknown"
    mins, secs = divmod(int(seconds), 60)
    hours, mins = divmod(mins, 60)
    if hours:
        return f"{hours:02d}:{mins:02d}:{secs:02d}"
    return f"{mins:02d}:{secs:02d}"


def _metadata_from_oembed(video_id: str) -> dict:
    url = f"https://www.youtube.com/watch?v={video_id}"
    resp = requests.get(
        "https://www.youtube.com/oembed",
        params={"url": url, "format": "json"},
        timeout=20,
    )
    resp.raise_for_status()
    data = resp.json()
    return {
        "video_id": video_id,
        "title": data.get("title", ""),
        "channel": data.get("author_name", ""),
        "duration": "unknown",
        "duration_seconds": None,
        "upload_date": "",
        "view_count": None,
        "description": "",
        "url": url,
    }


def get_video_metadata(video_id: str) -> dict:
    url = f"https://www.youtube.com/watch?v={video_id}"

    # Android client avoids YouTube web "page needs to be reloaded" blocks
    attempts = [
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": {"youtube": {"player_client": ["android"]}},
        },
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extractor_args": {"youtube": {"player_client": ["ios"]}},
        },
        {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
        },
    ]

    last_error = None
    for ydl_opts in attempts:
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)

            return {
                "video_id": video_id,
                "title": info.get("title", ""),
                "channel": info.get("channel", info.get("uploader", "")),
                "duration": _format_duration(info.get("duration")),
                "duration_seconds": info.get("duration"),
                "upload_date": info.get("upload_date", ""),
                "view_count": info.get("view_count"),
                "description": info.get("description", ""),
                "url": info.get("webpage_url", url),
            }
        except Exception as e:
            last_error = e

    # Fallback: oEmbed (title + channel always available)
    try:
        print(f"Warning: full metadata failed ({last_error}). Using basic metadata.\n")
        return _metadata_from_oembed(video_id)
    except Exception as e:
        raise RuntimeError(f"Could not fetch metadata: {last_error}; oEmbed also failed: {e}") from e


def get_english_transcript(video_id: str) -> str:
    api = YouTubeTranscriptApi()

    # Prefer English (manual or auto-generated)
    try:
        transcript = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
        return " ".join(seg.text for seg in transcript)
    except NoTranscriptFound:
        pass
    except (TranscriptsDisabled, VideoUnavailable) as e:
        raise RuntimeError(f"Transcript not available: {e}") from e

    # Fallback: any available language, translate to English if possible
    try:
        transcript_list = api.list(video_id)

        for t in transcript_list:
            try:
                if t.language_code.startswith("en"):
                    fetched = t.fetch()
                    return " ".join(seg.text for seg in fetched)
            except Exception:
                continue

        for t in transcript_list:
            try:
                translated = t.translate("en").fetch()
                return " ".join(seg.text for seg in translated)
            except Exception:
                continue

        # Last resort: return first available transcript as-is
        for t in transcript_list:
            fetched = t.fetch()
            return " ".join(seg.text for seg in fetched)

    except (TranscriptsDisabled, VideoUnavailable) as e:
        raise RuntimeError(f"Transcript not available: {e}") from e

    raise RuntimeError("No transcript found for this video.")


def format_output(metadata: dict, transcript: str) -> str:
    upload = metadata["upload_date"]
    if upload and len(upload) == 8:
        upload = f"{upload[:4]}-{upload[4:6]}-{upload[6:]}"

    views = metadata.get("view_count")
    views_str = f"{views:,}" if views is not None else "unknown"

    return (
        f"Title       : {metadata['title']}\n"
        f"Channel     : {metadata['channel']}\n"
        f"Duration    : {metadata['duration']}\n"
        f"Upload Date : {upload or 'unknown'}\n"
        f"Views       : {views_str}\n"
        f"URL         : {metadata['url']}\n"
        f"Video ID    : {metadata['video_id']}\n"
        f"\n--- Description ---\n"
        f"{metadata['description']}\n"
        f"\n--- Transcript ---\n"
        f"{transcript}\n"
    )


def sanitize_filename(text: str, max_len: int = 80) -> str:
    """Make a string safe for use in a filename."""
    text = (text or "unknown").strip()
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", text)
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"_+", "_", text).strip("._")
    return text[:max_len] or "unknown"


def build_output_filename(metadata: dict) -> str:
    channel = sanitize_filename(metadata.get("channel", "unknown"))
    title = sanitize_filename(metadata.get("title", "unknown"))
    video_id = metadata.get("video_id", "unknown")
    return f"{channel}_{title}_{video_id}.txt"


def main():
    if len(sys.argv) < 2:
        print("Usage: python get_transcript.py <youtube_url>")
        print('Example: python get_transcript.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ"')
        sys.exit(1)

    url = sys.argv[1]

    try:
        video_id = extract_video_id(url)
        print(f"Fetching metadata + English transcript for: {video_id}\n")

        metadata = get_video_metadata(video_id)
        transcript = get_english_transcript(video_id)
        output = format_output(metadata, transcript)

        print(output)

        out_file = build_output_filename(metadata)
        with open(out_file, "w", encoding="utf-8") as f:
            f.write(output)
        print(f"--- Saved to {out_file} ---")

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
