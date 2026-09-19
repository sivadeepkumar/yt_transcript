function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = String(url || "").match(pattern);
    if (match) return match[1];
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube") && parsed.searchParams.get("v")) {
      return parsed.searchParams.get("v");
    }
  } catch (_) {
    // ignore
  }

  return null;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === "") return "unknown";
  const total = Number(seconds);
  if (Number.isNaN(total)) return "unknown";
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(remMins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(remMins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatUploadDate(raw) {
  if (!raw) return "unknown";
  if (String(raw).includes("T")) return String(raw).slice(0, 10);
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw;
}

function sanitizeFilename(text, maxLen = 80) {
  let value = (text || "unknown").trim();
  value = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "");
  value = value.replace(/\s+/g, "_");
  value = value.replace(/_+/g, "_").replace(/^[._]+|[._]+$/g, "");
  return value.slice(0, maxLen) || "unknown";
}

function buildFilename(metadata) {
  return `${sanitizeFilename(metadata.channel)}_${sanitizeFilename(metadata.title)}_${metadata.videoId}.txt`;
}

function formatOutput(metadata, transcript) {
  return [
    `Title       : ${metadata.title}`,
    `Channel     : ${metadata.channel}`,
    `Duration    : ${metadata.duration}`,
    `Upload Date : ${metadata.uploadDate}`,
    `Views       : ${metadata.views}`,
    `URL         : ${metadata.url}`,
    `Video ID    : ${metadata.videoId}`,
    "",
    "--- Description ---",
    metadata.description || "",
    "",
    "--- Transcript ---",
    transcript,
    "",
  ].join("\n");
}

async function downloadTextFile(filename, content) {
  const dataUrl =
    "data:text/plain;charset=utf-8," + encodeURIComponent(content);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false,
  });
}

/**
 * Runs inside the YouTube page. Uses ANDROID innertube player (same as
 * youtube-transcript-api) so caption URLs work without web poToken.
 * Falls back to scraping the on-page transcript panel.
 */
async function extractInPage(videoId) {
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function parseXmlTranscript(xml) {
    const parts = [];
    const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const text = m[1]
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/<[^>]+>/g, "")
        .replace(/\n/g, " ")
        .trim();
      if (text) parts.push(text);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function parseJson3Transcript(data) {
    const parts = [];
    for (const event of data?.events || []) {
      if (!event.segs) continue;
      const text = event.segs
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/\n/g, " ")
        .trim();
      if (text) parts.push(text);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function cleanCaptionUrl(url) {
    // youtube-transcript-api strips fmt=srv3; avoid web-only exp tokens when possible
    return String(url || "")
      .replace(/&fmt=srv3/g, "")
      .replace(/\?fmt=srv3&/g, "?")
      .replace(/\?fmt=srv3$/g, "");
  }

  function pickEnglishTrack(tracks) {
    if (!tracks?.length) return null;
    const scored = tracks.map((track) => {
      const code = (track.languageCode || "").toLowerCase();
      let score = 0;
      if (code === "en" || code.startsWith("en-")) score += 10;
      if (!track.kind || track.kind !== "asr") score += 5;
      const name = (
        track.name?.simpleText ||
        track.name?.runs?.[0]?.text ||
        ""
      ).toLowerCase();
      if (name.includes("english")) score += 3;
      // Prefer URLs that don't require poToken
      if (track.baseUrl && !track.baseUrl.includes("exp=xpe")) score += 2;
      return { track, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.track);
  }

  function getApiKey() {
    try {
      if (window.ytcfg?.get) {
        const key = window.ytcfg.get("INNERTUBE_API_KEY");
        if (key) return key;
      }
    } catch (_) {
      // ignore
    }
    const html = document.documentElement.innerHTML;
    const m = html.match(/"INNERTUBE_API_KEY"\s*:\s*"([a-zA-Z0-9_-]+)"/);
    return m ? m[1] : null;
  }

  function metadataFromPlayer(player) {
    const details = player?.videoDetails || {};
    const micro = player?.microformat?.playerMicroformatRenderer || {};
    return {
      videoId,
      title:
        details.title ||
        micro.title?.simpleText ||
        document.title.replace(/ - YouTube$/, "").trim() ||
        "unknown",
      channel:
        details.author ||
        micro.ownerChannelName ||
        document
          .querySelector("ytd-channel-name a")
          ?.textContent?.trim() ||
        "unknown",
      duration: details.lengthSeconds || null,
      uploadDate: micro.uploadDate || micro.publishDate || "",
      viewCount: details.viewCount || null,
      description:
        details.shortDescription ||
        micro.description?.simpleText ||
        "",
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  async function fetchCaptionText(baseUrl) {
    const url = cleanCaptionUrl(baseUrl);
    if (!url) throw new Error("Empty caption URL");
    if (url.includes("exp=xpe")) {
      throw new Error("Caption URL requires poToken (skipped)");
    }

    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`Captions HTTP ${res.status}`);
    const raw = (await res.text() || "").trim();
    if (!raw) throw new Error("Empty caption body");

    if (raw.startsWith("{") || raw.startsWith("[")) {
      const data = JSON.parse(raw);
      const text = parseJson3Transcript(data);
      if (!text) throw new Error("json3 empty");
      return text;
    }

    if (raw.includes("<text")) {
      const text = parseXmlTranscript(raw);
      if (!text) throw new Error("XML empty");
      return text;
    }

    throw new Error("Unrecognized caption format");
  }

  async function fetchViaAndroidPlayer(apiKey) {
    const clients = [
      { clientName: "ANDROID", clientVersion: "20.10.38" },
      { clientName: "ANDROID", clientVersion: "19.09.37" },
      { clientName: "IOS", clientVersion: "19.45.4" },
      {
        clientName: "WEB",
        clientVersion: "2.20240101.00.00",
        clientScreen: "WATCH",
      },
    ];

    let lastError = "player API failed";
    let metadata = null;

    for (const client of clients) {
      try {
        const res = await fetch(
          `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              context: { client },
              videoId,
            }),
          }
        );

        if (!res.ok) {
          lastError = `player HTTP ${res.status}`;
          continue;
        }

        const data = await res.json();
        if (!metadata) metadata = metadataFromPlayer(data);

        const tracks =
          data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
          [];
        if (!tracks.length) {
          lastError = "No captionTracks from player";
          continue;
        }

        const ordered = pickEnglishTrack(tracks);
        for (const track of ordered) {
          try {
            const text = await fetchCaptionText(track.baseUrl);
            if (text) {
              return { metadata: metadata || metadataFromPlayer(data), transcript: text };
            }
          } catch (e) {
            lastError = e.message || String(e);
          }
        }
      } catch (e) {
        lastError = e.message || String(e);
      }
    }

    throw new Error(lastError);
  }

  async function scrapeTranscriptPanel() {
    // Try to open transcript UI
    const showBtn =
      document.querySelector('button[aria-label="Show transcript"]') ||
      document.querySelector('button[aria-label*="transcript" i]') ||
      [...document.querySelectorAll("button, yt-button-shape button")].find(
        (b) => /transcript/i.test(b.textContent || b.getAttribute("aria-label") || "")
      );

    if (showBtn) {
      showBtn.click();
      await sleep(1200);
    } else {
      // Expand description "...more" then look again
      const more = document.querySelector(
        "#description-inline-expander tp-yt-paper-button#expand, #expand"
      );
      if (more) {
        more.click();
        await sleep(500);
      }
      const again =
        document.querySelector('button[aria-label="Show transcript"]') ||
        [...document.querySelectorAll("button")].find((b) =>
          /show transcript/i.test(b.textContent || "")
        );
      if (again) {
        again.click();
        await sleep(1200);
      }
    }

    // Wait for segments to appear
    for (let i = 0; i < 15; i++) {
      const segments = document.querySelectorAll(
        "ytd-transcript-segment-renderer, .ytd-transcript-segment-renderer"
      );
      if (segments.length) {
        const parts = [];
        segments.forEach((seg) => {
          const textEl =
            seg.querySelector(".segment-text") ||
            seg.querySelector("yt-formatted-string");
          const text = (textEl?.textContent || "").trim();
          if (text) parts.push(text);
        });
        const joined = parts.join(" ").replace(/\s+/g, " ").trim();
        if (joined) return joined;
      }
      await sleep(300);
    }

    throw new Error("Could not open/scrape transcript panel");
  }

  // Prefer live page player for metadata
  let metadata = metadataFromPlayer(window.ytInitialPlayerResponse || {});

  const apiKey = getApiKey();
  let transcript = null;
  let lastError = null;

  if (apiKey) {
    try {
      const result = await fetchViaAndroidPlayer(apiKey);
      metadata = { ...metadata, ...result.metadata };
      transcript = result.transcript;
    } catch (e) {
      lastError = e.message || String(e);
    }
  } else {
    lastError = "Missing INNERTUBE_API_KEY";
  }

  // Try caption URLs from page player (non-poToken only)
  if (!transcript) {
    const tracks =
      window.ytInitialPlayerResponse?.captions
        ?.playerCaptionsTracklistRenderer?.captionTracks || [];
    for (const track of pickEnglishTrack(tracks) || []) {
      try {
        transcript = await fetchCaptionText(track.baseUrl);
        if (transcript) break;
      } catch (e) {
        lastError = e.message || String(e);
      }
    }
  }

  if (!transcript) {
    try {
      transcript = await scrapeTranscriptPanel();
    } catch (e) {
      lastError = e.message || String(e);
    }
  }

  if (!transcript) {
    return {
      ok: false,
      error: lastError || "No transcript found",
      metadata,
    };
  }

  return { ok: true, metadata, transcript };
}

async function runExtraction(tabId, videoId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [videoId],
    func: extractInPage,
  });

  if (!result) {
    throw new Error("No response from YouTube page script.");
  }
  if (!result.ok) {
    throw new Error(result.error || "Transcript extraction failed.");
  }

  const meta = result.metadata || {};
  const metadata = {
    videoId,
    title: meta.title || "unknown",
    channel: meta.channel || "unknown",
    duration: formatDuration(meta.duration),
    uploadDate: formatUploadDate(meta.uploadDate),
    views: meta.viewCount
      ? Number(meta.viewCount).toLocaleString("en-US")
      : "unknown",
    description: meta.description || "",
    url: meta.url || `https://www.youtube.com/watch?v=${videoId}`,
  };

  return { metadata, transcript: result.transcript };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FETCH_TRANSCRIPT") {
    (async () => {
      try {
        const videoId = extractVideoId(message.url || "");
        if (!videoId) {
          throw new Error("Open a YouTube video page first.");
        }
        if (!message.tabId) {
          throw new Error("Missing tab id.");
        }

        const { metadata, transcript } = await runExtraction(
          message.tabId,
          videoId
        );
        const content = formatOutput(metadata, transcript);
        const filename = buildFilename(metadata);
        sendResponse({ ok: true, content, filename });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "DOWNLOAD_TRANSCRIPT") {
    (async () => {
      try {
        if (!message.content) {
          throw new Error("Nothing to download. Load transcript first.");
        }
        const filename = message.filename || "transcript.txt";
        await downloadTextFile(filename, message.content);
        sendResponse({ ok: true, filename });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  }

  return false;
});
