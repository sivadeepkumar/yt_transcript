# YouTube Transcript Worker

Simple Python script — pass a YouTube URL, get the English transcript. No server.

## Setup

```bash
pip install -r requirements.txt
```

## Usage

```bash
python get_transcript.py "https://www.youtube.com/watch?v=VIDEO_ID"
```

Also works with:
- `https://youtu.be/VIDEO_ID`
- `https://www.youtube.com/shorts/VIDEO_ID`

## What it does

1. Extracts the video ID from the URL
2. Fetches video metadata (title, channel, duration, upload date, views, description)
3. Fetches the English transcript (manual captions preferred, auto-generated as fallback)
4. If no English exists, translates another language to English when possible
5. Prints everything and saves it to `<channel>_<title>_<videoID>.txt`

## Chrome extension

A separate browser extension lives in `chrome-extension/` (Python code untouched).  
See [chrome-extension/README.md](chrome-extension/README.md) to install.
