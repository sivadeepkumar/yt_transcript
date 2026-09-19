const loadBtn = document.getElementById("loadBtn");
const downloadBtn = document.getElementById("downloadBtn");
const statusEl = document.getElementById("status");
const contentEl = document.getElementById("content");

let currentContent = "";
let currentFilename = "";

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`.trim();
}

function showContent(text) {
  contentEl.hidden = false;
  contentEl.textContent = text;
}

loadBtn.addEventListener("click", async () => {
  loadBtn.disabled = true;
  downloadBtn.disabled = true;
  currentContent = "";
  currentFilename = "";
  contentEl.hidden = true;
  contentEl.textContent = "";
  setStatus("Loading metadata + transcript...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      throw new Error("No active tab found.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "FETCH_TRANSCRIPT",
      tabId: tab.id,
      url: tab.url,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to load transcript.");
    }

    currentContent = response.content || "";
    currentFilename = response.filename || "transcript.txt";
    showContent(currentContent);
    downloadBtn.disabled = !currentContent;
    setStatus(`Loaded. Filename if downloaded:\n${currentFilename}`, "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    loadBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!currentContent) {
    setStatus("Load a transcript first.", "error");
    return;
  }

  downloadBtn.disabled = true;
  setStatus("Downloading...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_TRANSCRIPT",
      content: currentContent,
      filename: currentFilename,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Download failed.");
    }

    setStatus(`Downloaded:\n${currentFilename}`, "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    downloadBtn.disabled = !currentContent;
  }
});
