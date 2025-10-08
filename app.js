const dropZone = document.getElementById("drop-zone");
const dropZoneMessage = dropZone.querySelector("p");
const defaultDropText = dropZoneMessage.textContent;
const fileInput = document.getElementById("file-input");
const selectFilesBtn = document.getElementById("select-files");
const startBtn = document.getElementById("start-slideshow");
const pasteBtn = document.getElementById("paste-clipboard");
const resetBtn = document.getElementById("reset-gallery");
const saveBtn = document.getElementById("save-gallery");
const delayRange = document.getElementById("delay-range");
const delayInput = document.getElementById("delay-input");
const loader = document.getElementById("loader");
const stage = document.getElementById("stage");
const stageImage = document.getElementById("stage-image");

const pdfjsGlobal = typeof window !== "undefined" ? window.pdfjsLib : undefined;
const pdfSupported = Boolean(pdfjsGlobal);
if (pdfSupported) {
  pdfjsGlobal.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
} else {
  console.warn("PDF.js failed to load - PDF support is disabled.");
}

let imageEntries = [];
const imageSignatures = new Set();
let slideshowTimeout = null;
let slideshowRaf = null;
let currentIndex = 0;
let isRunning = false;
let statusTimeout = null;

const supportsIndexedDB = typeof indexedDB !== "undefined";
let dbPromise = null;

function openDatabase() {
  if (!supportsIndexedDB) {
    return Promise.resolve(null);
  }
  if (dbPromise) {
    return dbPromise;
  }
  dbPromise = new Promise(resolve => {
    const request = indexedDB.open("lightning-slideshow-storage", 1);
    request.onupgradeneeded = event => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("slides")) {
        const store = db.createObjectStore("slides", { keyPath: "signature" });
        store.createIndex("addedAt", "addedAt");
      }
    };
    request.onsuccess = event => {
      const db = event.target.result;
      db.onversionchange = () => {
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => {
      console.warn("IndexedDB unavailable, persistence disabled.", request.error);
      resolve(null);
    };
    request.onblocked = () => {
      console.warn("IndexedDB upgrade blocked. Persistence may not work as expected.");
    };
  });
  return dbPromise;
}

async function saveSlideRecord({ signature, label, blob, addedAt }) {
  const db = await openDatabase();
  if (!db) {
    return;
  }

  let bytes;
  try {
    bytes = await blob.arrayBuffer();
  } catch (error) {
    console.warn("Could not read slide data", error);
    return;
  }

  const record = {
    signature,
    label,
    addedAt,
    bytes,
    type: blob.type || "application/octet-stream"
  };

  return new Promise(resolve => {
    const tx = db.transaction("slides", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      console.warn("Failed to persist slide", tx.error);
      resolve();
    };
    const store = tx.objectStore("slides");
    try {
      store.put(record);
    } catch (error) {
      console.warn("Could not store slide", error);
      resolve();
    }
  });
}

async function getPersistedSlides() {
  const db = await openDatabase();
  if (!db) {
    return [];
  }
  return new Promise(resolve => {
    try {
      const tx = db.transaction("slides", "readonly");
      const store = tx.objectStore("slides");
      const request = store.getAll();
      request.onsuccess = () => {
        const records = (request.result || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
        resolve(records);
      };
      request.onerror = () => {
        console.warn("Failed to read persisted slides", request.error);
        resolve([]);
      };
    } catch (error) {
      console.warn("Could not access persisted slides", error);
      resolve([]);
    }
  });
}

async function clearPersistedSlides() {
  const db = await openDatabase();
  if (!db) {
    return;
  }
  return new Promise(resolve => {
    try {
      const tx = db.transaction("slides", "readwrite");
      const store = tx.objectStore("slides");
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.warn("Failed to clear persisted slides", request.error);
        resolve();
      };
    } catch (error) {
      console.warn("Could not clear persisted slides", error);
      resolve();
    }
  });
}

async function registerEntry({ blob, label, signature, persist = true, addedAt = Date.now() }) {
  if (imageSignatures.has(signature)) {
    return false;
  }

  const url = URL.createObjectURL(blob);
  imageEntries.push({ url, signature, label });
  imageSignatures.add(signature);

  if (persist) {
    await saveSlideRecord({ signature, label, blob, addedAt });
  }

  return true;
}

const DEFAULT_DELAY = 200;
const delayStorageKey = "lightning-slideshow-delay";

function storeDelay(value) {
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.setItem(delayStorageKey, String(value));
  } catch (error) {
    console.warn("Could not persist delay value", error);
  }
}

function getStoredDelay() {
  if (typeof localStorage === "undefined") {
    return null;
  }
  try {
    const raw = localStorage.getItem(delayStorageKey);
    if (raw === null) {
      return null;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 2000) {
      return parsed;
    }
  } catch (error) {
    console.warn("Could not read delay value", error);
  }
  return null;
}

function applyDelay(value, { persist = true } = {}) {
  const clamped = Math.min(2000, Math.max(0, Number(value) || 0));
  delayRange.value = String(clamped);
  delayInput.value = String(clamped);
  if (persist) {
    storeDelay(clamped);
  }
}

function restoreDelaySetting() {
  const stored = getStoredDelay();
  if (stored === null) {
    applyDelay(DEFAULT_DELAY, { persist: false });
    return;
  }
  applyDelay(stored, { persist: false });
}

const SAVE_PACKAGE_VERSION = 1;

function arrayBufferToBase64(buffer) {
  const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer instanceof Uint8Array ? buffer : new Uint8Array();
  if (view.length === 0) {
    return "";
  }
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < view.length; i += chunkSize) {
    const chunk = view.subarray(i, Math.min(view.length, i + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const length = binary.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function generateImportSignature() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `import-${crypto.randomUUID()}`;
  }
  return `import-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function buildExportPayload() {
  const persistedSlides = await getPersistedSlides();
  const slides = [];
  for (const slide of persistedSlides) {
    if (!slide || !slide.bytes) {
      continue;
    }
    try {
      slides.push({
        signature: slide.signature,
        label: slide.label,
        type: slide.type,
        addedAt: slide.addedAt,
        bytes: arrayBufferToBase64(slide.bytes)
      });
    } catch (error) {
      console.warn("Could not include slide in export", error);
    }
  }
  return {
    version: SAVE_PACKAGE_VERSION,
    delay: Number(delayRange.value),
    generatedAt: new Date().toISOString(),
    slides
  };
}

async function importSavedPackage(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Number(data.version) !== SAVE_PACKAGE_VERSION || !Array.isArray(data.slides)) {
      throw new Error("Unsupported package format");
    }

    if (typeof data.delay === "number") {
      applyDelay(data.delay);
    }

    let added = 0;
    const total = data.slides.length;

    for (const slide of data.slides) {
      if (!slide || typeof slide.bytes !== "string") {
        continue;
      }
      let buffer;
      try {
        buffer = base64ToArrayBuffer(slide.bytes);
      } catch (error) {
        console.warn("Could not decode slide from package", error);
        continue;
      }
      const blob = new Blob([buffer], { type: slide.type || "application/octet-stream" });
      const label = slide.label || "Image";
      let signature = slide.signature || generateImportSignature();
      const registered = await registerEntry({
        blob,
        label,
        signature,
        addedAt: slide.addedAt || Date.now()
      });
      if (registered) {
        added += 1;
      }
    }

    return { added, total };
  } catch (error) {
    console.warn("Could not load saved slideshow", error);
    return { added: 0, total: 0, error: true };
  }
}

async function handleSaveClick() {
  try {
    const payload = await buildExportPayload();
    const fileContents = JSON.stringify(payload, null, 2);
    const timestamp = new Date().toISOString().replace(/[:]/g, "-");
    const suggestedName = `lightning-slideshow-${timestamp}.json`;
    const messageCount = payload.slides.length;

    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [
            {
              description: "Lightning Slideshow package",
              accept: {
                "application/json": [".json"]
              }
            }
          ]
        });
        const writable = await handle.createWritable();
        await writable.write(fileContents);
        await writable.close();
        showStatus(`Saved ${messageCount} slide${messageCount === 1 ? "" : "s"}.`);
        return;
      } catch (pickerError) {
        if (pickerError && pickerError.name === "AbortError") {
          showStatus("Save cancelled.");
          return;
        }
        console.warn("Save picker failed, using download fallback", pickerError);
      }
    }

    const blob = new Blob([fileContents], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showStatus(`Saved ${messageCount} slide${messageCount === 1 ? "" : "s"}.`);
  } catch (error) {
    console.warn("Could not create slideshow export", error);
    showStatus("Could not create export file.");
  }
}

function revokeAll() {
  imageEntries.forEach(entry => URL.revokeObjectURL(entry.url));
}

function fileSignature(file) {
  return [file.name, file.type, file.size, file.lastModified].join("::");
}

function updateDropZoneMessage() {
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }

  if (!imageEntries.length) {
    dropZoneMessage.textContent = defaultDropText;
  } else {
    dropZoneMessage.textContent = `${imageEntries.length} image${imageEntries.length === 1 ? '' : 's'} ready.`;
  }
}

function showStatus(message, revert = true, duration = 2400) {
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }

  dropZoneMessage.textContent = message;

  if (revert) {
    statusTimeout = setTimeout(() => {
      statusTimeout = null;
      updateDropZoneMessage();
    }, duration);
  }
}

function collectFilesFromDataTransfer(data) {
  if (!data) {
    return [];
  }

  const files = [];

  if (data.files && data.files.length) {
    files.push(...Array.from(data.files));
  }

  if (data.items && data.items.length) {
    Array.from(data.items)
      .filter(item => item.kind === "file")
      .forEach(item => {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      });
  }

  return files;
}

async function addImageFile(file) {
  const signature = fileSignature(file);
  if (imageSignatures.has(signature)) {
    return 0;
  }

  const added = await registerEntry({
    blob: file,
    label: file.name || "Image",
    signature
  });

  return added ? 1 : 0;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not create image from PDF."));
      }
    }, "image/png");
  });
}

async function addPdfFile(file) {
  if (!pdfSupported) {
    return { added: 0, total: 0 };
  }

  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsGlobal.getDocument({ data: arrayBuffer });
  const pdfDoc = await loadingTask.promise;
  const total = pdfDoc.numPages;
  let added = 0;

  try {
    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
      const pageSignature = `${fileSignature(file)}::page${pageNumber}`;
      if (imageSignatures.has(pageSignature)) {
        continue;
      }

      let page;
      try {
        page = await pdfDoc.getPage(pageNumber);
      } catch (error) {
        console.warn(`Could not load page ${pageNumber} from ${file.name}`, error);
        continue;
      }

      const baseViewport = page.getViewport({ scale: 1 });
      const maxDimension = Math.max(baseViewport.width, baseViewport.height);
      const targetScale = Math.min(2.2, Math.max(1.2, 1400 / maxDimension));
      const viewport = page.getViewport({ scale: targetScale });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { alpha: false });

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      try {
        await page.render({ canvasContext: context, viewport }).promise;
      } catch (renderError) {
        console.warn(`Could not render page ${pageNumber} from ${file.name}`, renderError);
        continue;
      }

      let blob;
      try {
        blob = await canvasToBlob(canvas);
      } catch (blobError) {
        console.warn(`Could not store page ${pageNumber} as an image`, blobError);
        continue;
      }

      const registered = await registerEntry({
        blob,
        label: `${file.name || "PDF"} - page ${pageNumber}`,
        signature: pageSignature
      });

      if (registered) {
        added += 1;
      }
    }
  } finally {
    await pdfDoc.cleanup();
    await pdfDoc.destroy();
  }

  return { added, total };
}

async function addFiles(files) {
  if (!files || !files.length) {
    return { added: 0, supported: 0, unsupported: 0, pdfUnsupported: 0, packageSlidesAdded: 0, packagesProcessed: 0, packageErrors: 0, packageSlidesTotal: 0 };
  }

  const incoming = Array.from(files);
  let added = 0;
  let supported = 0;
  let unsupported = 0;
  let pdfUnsupported = 0;
  let packageSlidesAdded = 0;
  let packagesProcessed = 0;
  let packageErrors = 0;
  let packageSlidesTotal = 0;

  for (const file of incoming) {
    const name = (file.name || "").toLowerCase();
    const isPackageCandidate = file.type === "application/json" || name.endsWith(".json") || name.endsWith(".lss") || name.endsWith(".slideshow");

    if (isPackageCandidate) {
      const packageResult = await importSavedPackage(file);
      if (packageResult.error) {
        unsupported += 1;
        packageErrors += 1;
      } else {
        packagesProcessed += 1;
        const totalSlides = Number(packageResult.total) || 0;
        const addedSlides = Number(packageResult.added) || 0;
        supported += totalSlides;
        packageSlidesTotal += totalSlides;
        added += addedSlides;
        packageSlidesAdded += addedSlides;
      }
      continue;
    }

    if (file.type.startsWith("image/")) {
      supported += 1;
      added += await addImageFile(file);
      continue;
    }

    if (file.type === "application/pdf") {
      supported += 1;
      if (!pdfSupported) {
        pdfUnsupported += 1;
        continue;
      }

      showStatus(`Processing ${file.name || "PDF"} ...`, false, 6000);
      try {
        const { added: pagesAdded } = await addPdfFile(file);
        added += pagesAdded;
      } catch (error) {
        console.warn("Could not process PDF", error);
        showStatus(`Unable to read ${file.name || "PDF"}.`);
      }
      continue;
    }

    unsupported += 1;
  }

  if (added) {
    updateDropZoneMessage();
    if (!isRunning) {
      startBtn.disabled = imageEntries.length === 0;
    }
  } else if (!imageEntries.length) {
    updateDropZoneMessage();
    startBtn.disabled = true;
  }

  return { added, supported, unsupported, pdfUnsupported, packageSlidesAdded, packagesProcessed, packageErrors, packageSlidesTotal };
}

async function restorePersistedSlides() {
  const storedSlides = await getPersistedSlides();
  if (!storedSlides.length) {
    updateDropZoneMessage();
    startBtn.disabled = imageEntries.length === 0;
    return;
  }

  for (const slide of storedSlides) {
    if (!slide || !slide.signature) {
      continue;
    }

    let blob = null;

    if (slide.blob instanceof Blob) {
      blob = slide.blob;
    } else if (slide.bytes) {
      try {
        blob = new Blob([slide.bytes], { type: slide.type || "application/octet-stream" });
      } catch (error) {
        console.warn("Could not reconstruct slide", error);
        continue;
      }
    }

    if (!blob) {
      continue;
    }

    await registerEntry({
      blob,
      label: slide.label || "Image",
      signature: slide.signature,
      persist: false,
      addedAt: slide.addedAt || Date.now()
    });
  }

  updateDropZoneMessage();
  startBtn.disabled = imageEntries.length === 0;
}

function syncDelayFromRange() {
  applyDelay(Number(delayRange.value));
}

function syncDelayFromInput() {
  const value = Number(delayInput.value);
  if (Number.isNaN(value)) {
    applyDelay(Number(delayRange.value), { persist: false });
    return;
  }
  const clamped = Math.min(2000, Math.max(0, value));
  applyDelay(clamped);
}

function scheduleNextFrame() {
  const delay = Number(delayRange.value);
  if (delay <= 0) {
    slideshowRaf = requestAnimationFrame(showNextImage);
  } else {
    slideshowTimeout = setTimeout(showNextImage, delay);
  }
}

function showNextImage() {
  if (!isRunning) {
    return;
  }

  if (!imageEntries.length) {
    stopSlideshow();
    return;
  }

  const entry = imageEntries[currentIndex];
  stageImage.src = entry.url;
  stageImage.alt = entry.label || "Slideshow image";

  currentIndex = (currentIndex + 1) % imageEntries.length;
  scheduleNextFrame();
}

async function startSlideshow() {
  if (isRunning || !imageEntries.length) {
    return;
  }

  isRunning = true;
  currentIndex = 0;
  startBtn.disabled = true;
  loader.classList.add("hidden");
  stage.classList.remove("hidden");

  try {
    if (stage.requestFullscreen && !document.fullscreenElement) {
      await stage.requestFullscreen();
    }
  } catch (err) {
    console.warn("Fullscreen request failed", err);
  }

  showNextImage();
}

function clearTimers() {
  if (slideshowTimeout) {
    clearTimeout(slideshowTimeout);
    slideshowTimeout = null;
  }

  if (slideshowRaf) {
    cancelAnimationFrame(slideshowRaf);
    slideshowRaf = null;
  }
}

function stopSlideshow() {
  if (!isRunning) {
    return;
  }

  isRunning = false;
  startBtn.disabled = imageEntries.length === 0;
  loader.classList.remove("hidden");
  stage.classList.add("hidden");
  stageImage.removeAttribute("src");
  stageImage.removeAttribute("alt");

  clearTimers();

  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

async function resetGallery() {
  stopSlideshow();
  clearTimers();
  revokeAll();
  imageEntries = [];
  imageSignatures.clear();
  currentIndex = 0;
  updateDropZoneMessage();
  startBtn.disabled = true;
  await clearPersistedSlides();
  applyDelay(DEFAULT_DELAY);
}

function preventDefaults(event) {
  event.preventDefault();
  event.stopPropagation();
}

dropZone.addEventListener("dragenter", event => {
  preventDefaults(event);
  dropZone.classList.add("dragover");
});

dropZone.addEventListener("dragover", preventDefaults);

dropZone.addEventListener("dragleave", event => {
  preventDefaults(event);
  dropZone.classList.remove("dragover");
});

dropZone.addEventListener("drop", async event => {
  preventDefaults(event);
  dropZone.classList.remove("dragover");
  const files = collectFilesFromDataTransfer(event.dataTransfer);
  const result = await addFiles(files);
  const messages = [];
  if (result.added > 0) {
    let message = `Added ${result.added} slide${result.added === 1 ? "" : "s"}.`;
    if (result.packageSlidesAdded > 0) {
      message += ` (${result.packageSlidesAdded} from saved package${result.packageSlidesAdded === 1 ? "" : "s"}.)`;
    }
    messages.push(message);
  }
  if (result.supported > 0 && result.added === 0 && !result.pdfUnsupported) {
    messages.push("Everything was already added.");
  }
  if (result.packageErrors > 0) {
    messages.push("Some saved packages could not be read.");
  }
  if (result.packagesProcessed > 0 && result.packageSlidesAdded === 0) {
    if (result.packageSlidesTotal > 0) {
      messages.push("Saved package already loaded.");
    } else {
      messages.push("Saved package contained no slides.");
    }
  }
  if (result.pdfUnsupported > 0) {
    messages.push("PDF support is not available in this browser.");
  }
  if (result.unsupported > 0) {
    messages.push(`Skipped ${result.unsupported} unsupported file${result.unsupported === 1 ? '' : 's'}.`);
  }
  if (messages.length) {
    showStatus(messages.join(" "));
  } else {
    updateDropZoneMessage();
  }
});

selectFilesBtn.addEventListener("click", () => {
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", async event => {
  const files = event.target.files;
  const result = await addFiles(files);
  event.target.value = "";
  const messages = [];
  if (result.added > 0) {
    let message = `Added ${result.added} slide${result.added === 1 ? "" : "s"}.`;
    if (result.packageSlidesAdded > 0) {
      message += ` (${result.packageSlidesAdded} from saved package${result.packageSlidesAdded === 1 ? "" : "s"}.)`;
    }
    messages.push(message);
  }
  if (result.supported > 0 && result.added === 0 && !result.pdfUnsupported) {
    messages.push("No new slides to add.");
  }
  if (result.packageErrors > 0) {
    messages.push("Some saved packages could not be read.");
  }
  if (result.packagesProcessed > 0 && result.packageSlidesAdded === 0) {
    if (result.packageSlidesTotal > 0) {
      messages.push("Saved package already loaded.");
    } else {
      messages.push("Saved package contained no slides.");
    }
  }
  if (result.pdfUnsupported > 0) {
    messages.push("PDF support is not available in this browser.");
  }
  if (result.unsupported > 0) {
    messages.push(`Skipped ${result.unsupported} unsupported file${result.unsupported === 1 ? '' : 's'}.`);
  }
  if (messages.length) {
    showStatus(messages.join(" "));
  } else {
    updateDropZoneMessage();
  }
});

startBtn.addEventListener("click", startSlideshow);
resetBtn.addEventListener("click", () => { void resetGallery(); });
if (saveBtn) {
  saveBtn.addEventListener("click", () => { void handleSaveClick(); });
}

delayRange.addEventListener("input", syncDelayFromRange);
delayInput.addEventListener("input", syncDelayFromInput);

document.addEventListener("paste", async event => {
  const files = collectFilesFromDataTransfer(event.clipboardData);
  if (!files.length) {
    return;
  }
  event.preventDefault();
  const result = await addFiles(files);
  const messages = [];
  if (result.added > 0) {
    let message = `Added ${result.added} slide${result.added === 1 ? "" : "s"} from the clipboard.`;
    if (result.packageSlidesAdded > 0) {
      message += ` (${result.packageSlidesAdded} from saved package${result.packageSlidesAdded === 1 ? "" : "s"}.)`;
    }
    messages.push(message);
  }
  if (result.supported > 0 && result.added === 0 && !result.pdfUnsupported) {
    messages.push("Everything from the clipboard is already added.");
  }
  if (result.packageErrors > 0) {
    messages.push("Some saved packages could not be read.");
  }
  if (result.packagesProcessed > 0 && result.packageSlidesAdded === 0) {
    if (result.packageSlidesTotal > 0) {
      messages.push("Saved package already loaded.");
    } else {
      messages.push("Saved package contained no slides.");
    }
  }
  if (result.pdfUnsupported > 0) {
    messages.push("PDF support is not available in this browser.");
  }
  if (result.unsupported > 0) {
    messages.push(`The clipboard held ${result.unsupported} unsupported file${result.unsupported === 1 ? '' : 's'}.`);
  }
  showStatus(messages.join(" ") || "Found no supported files in the clipboard.");
});

if (pasteBtn) {
  const clipboardReadSupported = !!(navigator.clipboard && navigator.clipboard.read);
  if (!clipboardReadSupported) {
    pasteBtn.disabled = true;
    pasteBtn.title = "Clipboard read is not supported in this browser.";
  } else {
    pasteBtn.addEventListener("click", async () => {
      try {
        const items = await navigator.clipboard.read();
        const clipboardFiles = [];
        let index = 0;
        for (const item of items) {
          for (const type of item.types) {
            const isImage = type.startsWith("image/");
            const isPdf = type === "application/pdf";
            if (!isImage && !isPdf) {
              continue;
            }
            const blob = await item.getType(type);
            const extension = isPdf ? "pdf" : (type.split("/")[1] || "png");
            const file = new File([blob], `clipboard-${Date.now()}-${index}.${extension}`, {
              type: blob.type,
              lastModified: Date.now()
            });
            clipboardFiles.push(file);
            index += 1;
          }
        }

        if (!clipboardFiles.length) {
          showStatus("Found no supported files in the clipboard.");
          return;
        }

        const result = await addFiles(clipboardFiles);
        const messages = [];
        if (result.added > 0) {
          let message = `Added ${result.added} slide${result.added === 1 ? "" : "s"} from the clipboard.`;
          if (result.packageSlidesAdded > 0) {
            message += ` (${result.packageSlidesAdded} from saved package${result.packageSlidesAdded === 1 ? "" : "s"}.)`;
          }
          messages.push(message);
        }
        if (result.supported > 0 && result.added === 0 && !result.pdfUnsupported) {
          messages.push("Everything from the clipboard is already added.");
        }
        if (result.packageErrors > 0) {
          messages.push("Some saved packages could not be read.");
        }
        if (result.packagesProcessed > 0 && result.packageSlidesAdded === 0) {
          messages.push("Saved package already loaded.");
        }
        if (result.pdfUnsupported > 0) {
          messages.push("PDF support is not available in this browser.");
        }
        if (result.unsupported > 0) {
          messages.push(`The clipboard held ${result.unsupported} unsupported file${result.unsupported === 1 ? '' : 's'}.`);
        }
        showStatus(messages.join(" ") || "Found no supported files in the clipboard.");
      } catch (err) {
        console.warn("Could not read the clipboard", err);
        showStatus("Could not read the clipboard. Allow access and try again.");
      }
    });
  }
}

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    stopSlideshow();
  }
});

window.addEventListener("beforeunload", () => {
  revokeAll();
  imageEntries = [];
  imageSignatures.clear();
  if (statusTimeout) {
    clearTimeout(statusTimeout);
    statusTimeout = null;
  }
});
restoreDelaySetting();
restorePersistedSlides().catch(error => {
  console.warn("Could not restore saved slides", error);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(err => {
      console.warn("Service worker registration failed", err);
    });
  });
}
