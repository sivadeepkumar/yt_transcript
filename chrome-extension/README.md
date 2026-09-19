# Chrome Extension — YouTube Transcript Saver

Separate from the Python worker. Python files are unchanged.

## Install in Chrome

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder:
   ```
   yt_script_audio_text/chrome-extension
   ```

## Use

1. Open any YouTube video
2. Click the extension icon
3. Click **Load Transcript** — content appears in the popup
4. Click **Download .txt** only when you want to save the file

Filename format:
```
<channel>_<Title>_<videoID>.txt
```

## What it saves

- Title, channel, duration, upload date, views, URL, video ID
- Description
- English transcript (manual captions preferred, auto-generated fallback)

## Note

Works only when the video has captions available.
