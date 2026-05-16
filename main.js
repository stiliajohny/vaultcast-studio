const {
  App,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  requestUrl
} = require("obsidian");

const DEFAULT_SETTINGS = {
  deepseekApiKey: "",
  deepgramApiKey: "",
  prompt:
    "Create a plain text podcast script that will be sent directly to Deepgram text-to-speech. Begin the script with: Welcome to your weekly podcast. The podcast should be around 3 minutes long. Use a natural narration pace of about 150 words per minute, so write approximately 450 words. The script must contain only the words one narrator should speak aloud. Do not include stage directions, sound cues, music notes, speaker labels, timestamps, headings, markdown, brackets, bullet points, or instructions such as intro music, pause, fade in, or fade out. Keep the episode faithful to the source document, explain the main ideas clearly, use natural spoken transitions, and return plain text only.",
  deepseekModel: "deepseek-chat",
  deepgramModel: "aura-2-thalia-en",
  chunkSize: 1800,
  audioCarpetEnabled: false,
  audioCarpetPath: ".obsidian/plugins/vaultcast-studio/audio/carpet_sound.mp3",
  audioCarpetVolume: 20,
  outputFolder: "Podcasts"
};

module.exports = class VaultCastStudioPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new VaultCastStudioSettingTab(this.app, this));

    this.addCommand({
      id: "create-podcast-from-current-note",
      name: "Create podcast from current note",
      callback: () => this.createPodcastFromCurrentNote()
    });

    this.addCommand({
      id: "open-vaultcast-studio",
      name: "Open VaultCast Studio",
      callback: () => this.openPodcastLauncher()
    });

    this.addRibbonIcon("mic-vocal", "VaultCast Studio", () => {
      this.openPodcastLauncher();
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  openPodcastLauncher() {
    new PodcastLauncherModal(this.app, this).open();
  }

  async createPodcastFromCurrentNote() {
    const controller = new AbortController();
    const progress = new PodcastProgressModal(this.app, () => controller.abort());
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const file = view && view.file;
      if (!file) {
        new Notice("Open a note first.");
        return;
      }

      this.requireSettings();
      progress.open();
      progress.setStatus("Preparing source note", `Reading ${file.basename}.`);

      const sourceText = await this.app.vault.read(file);
      progress.setStatus("Creating podcast script", "Sending the note to DeepSeek.");
      const script = this.cleanPodcastScript(await this.createPodcastScript(sourceText, controller.signal));
      progress.addLog("Podcast script created.");
      this.throwIfCancelled(controller.signal);

      const outputDir = await this.createOutputDirectory(file.basename);
      const scriptPath = normalizePath(`${outputDir}/podcast-script.md`);
      progress.setStatus("Saving script", scriptPath);
      await this.app.vault.adapter.write(scriptPath, script + "\n");

      const chunks = this.chunkText(script, Number(this.settings.chunkSize));
      progress.setTotalChunks(chunks.length);
      progress.addLog(`Split script into ${chunks.length} audio chunk${chunks.length === 1 ? "" : "s"}.`);

      const metadata = [];
      const audioFiles = [];

      for (let index = 0; index < chunks.length; index += 1) {
        this.throwIfCancelled(controller.signal);
        const chunkNumber = String(index + 1).padStart(3, "0");
        progress.setChunkProgress(index, chunks.length, `Sending chunk ${index + 1} to Deepgram.`);
        const audioPath = normalizePath(`${outputDir}/audio-chunk-${chunkNumber}.mp3`);
        const bytes = await this.createAudioChunk(chunks[index], controller.signal);
        this.throwIfCancelled(controller.signal);
        await this.app.vault.adapter.writeBinary(audioPath, bytes);
        progress.setChunkProgress(index + 1, chunks.length, `Saved ${audioPath}.`);
        audioFiles.push(audioPath);
        metadata.push({
          index: index + 1,
          characters: chunks[index].length,
          path: audioPath
        });
      }

      const chunksPath = normalizePath(`${outputDir}/chunks.json`);
      const concatPath = normalizePath(`${outputDir}/concat.txt`);
      await this.app.vault.adapter.write(chunksPath, JSON.stringify(metadata, null, 2) + "\n");
      await this.app.vault.adapter.write(
        concatPath,
        audioFiles.map((path) => `file '${path.split("/").pop()}'`).join("\n") + "\n"
      );
      this.throwIfCancelled(controller.signal);

      progress.setStatus("Merging audio", "Combining Deepgram chunks into one MP3.");
      let finalAudioPath = await this.mergeAudioChunks(outputDir, audioFiles, concatPath, controller.signal);

      if (this.settings.audioCarpetEnabled) {
        progress.setStatus("Adding audio carpet", "Mixing the background audio into the podcast.");
        const mixedAudioPath = await this.mixWithAudioCarpet(outputDir, finalAudioPath, controller.signal);
        await this.deleteTemporaryAudioFiles([finalAudioPath], null, null);
        finalAudioPath = mixedAudioPath;
      }

      progress.setStatus("Cleaning up", "Deleting temporary audio chunks.");
      await this.deleteTemporaryAudioFiles(audioFiles, concatPath, chunksPath);

      progress.finish(finalAudioPath);
      new Notice(`Podcast created: ${finalAudioPath}`);
    } catch (error) {
      console.error(error);
      if (error.name === "AbortError" || error.message === "Podcast generation cancelled.") {
        progress.cancel();
        new Notice("Podcast generation cancelled.");
      } else {
        progress.fail(error.message);
        new Notice(`Podcast failed: ${error.message}`);
      }
    }
  }

  requireSettings() {
    if (!this.settings.deepseekApiKey.trim()) {
      throw new Error("Add your DeepSeek API key in VaultCast Studio settings.");
    }
    if (!this.settings.deepgramApiKey.trim()) {
      throw new Error("Add your Deepgram API key in VaultCast Studio settings.");
    }
    const chunkSize = Number(this.settings.chunkSize);
    if (!Number.isInteger(chunkSize) || chunkSize < 500 || chunkSize > 4500) {
      throw new Error("Chunk size must be between 500 and 4500 characters.");
    }
  }

  throwIfCancelled(signal) {
    if (signal && signal.aborted) {
      throw new Error("Podcast generation cancelled.");
    }
  }

  async createPodcastScript(sourceText, signal) {
    const response = await requestUrl({
      url: "https://api.deepseek.com/chat/completions",
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.settings.deepseekApiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.settings.deepseekModel.trim() || DEFAULT_SETTINGS.deepseekModel,
        messages: [
          {
            role: "system",
            content: "You are an expert podcast producer and scriptwriter."
          },
          {
            role: "user",
            content: `${this.settings.prompt.trim()}\n\nSOURCE DOCUMENT:\n${sourceText}`
          }
        ],
        temperature: 0.7
      })
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`DeepSeek returned HTTP ${response.status}: ${response.text}`);
    }

    const script = response.json && response.json.choices && response.json.choices[0]
      && response.json.choices[0].message && response.json.choices[0].message.content;
    if (!script || !script.trim()) {
      throw new Error("DeepSeek returned an empty script.");
    }
    return script.trim();
  }

  async createAudioChunk(text, signal) {
    const model = this.settings.deepgramModel.trim() || DEFAULT_SETTINGS.deepgramModel;
    const response = await requestUrl({
      url: `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}`,
      method: "POST",
      signal,
      headers: {
        Authorization: `Token ${this.settings.deepgramApiKey.trim()}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Deepgram returned HTTP ${response.status}: ${response.text}`);
    }

    return response.arrayBuffer;
  }

  async mergeAudioChunks(outputDir, audioFiles, concatPath, signal) {
    const finalAudioPath = normalizePath(`${outputDir}/podcast.mp3`);
    const audioBuffers = [];
    let totalLength = 0;

    for (const audioFile of audioFiles) {
      this.throwIfCancelled(signal);
      const buffer = await this.app.vault.adapter.readBinary(audioFile);
      const bytes = new Uint8Array(buffer);
      audioBuffers.push(bytes);
      totalLength += bytes.byteLength;
    }

    this.throwIfCancelled(signal);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const bytes of audioBuffers) {
      merged.set(bytes, offset);
      offset += bytes.byteLength;
    }

    await this.app.vault.adapter.writeBinary(finalAudioPath, merged.buffer);
    return finalAudioPath;
  }

  async deleteTemporaryAudioFiles(audioFiles, concatPath, chunksPath) {
    const paths = [...audioFiles, concatPath, chunksPath].filter(Boolean);
    for (const path of paths) {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
    }
  }

  async mixWithAudioCarpet(outputDir, voiceAudioPath, signal) {
    const carpetPath = normalizePath(this.settings.audioCarpetPath || DEFAULT_SETTINGS.audioCarpetPath);
    if (!(await this.app.vault.adapter.exists(carpetPath))) {
      throw new Error(`Audio carpet file not found: ${carpetPath}`);
    }

    this.throwIfCancelled(signal);
    const voiceBuffer = await this.app.vault.adapter.readBinary(voiceAudioPath);
    const carpetBuffer = await this.app.vault.adapter.readBinary(carpetPath);
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    try {
      const voiceAudio = await audioContext.decodeAudioData(voiceBuffer.slice(0));
      const carpetAudio = await audioContext.decodeAudioData(carpetBuffer.slice(0));
      this.throwIfCancelled(signal);

      const mixedBuffer = await this.renderMixedAudio(voiceAudio, carpetAudio, signal);
      const wavBytes = this.encodeWav(mixedBuffer);
      const mixedAudioPath = normalizePath(`${outputDir}/podcast.wav`);
      await this.app.vault.adapter.writeBinary(mixedAudioPath, wavBytes.buffer);
      return mixedAudioPath;
    } finally {
      await audioContext.close();
    }
  }

  async renderMixedAudio(voiceAudio, carpetAudio, signal) {
    const sampleRate = voiceAudio.sampleRate;
    const channels = Math.max(1, Math.min(2, voiceAudio.numberOfChannels));
    const frameCount = voiceAudio.length;
    const offlineContext = new OfflineAudioContext(channels, frameCount, sampleRate);
    const voiceSource = offlineContext.createBufferSource();
    const carpetSource = offlineContext.createBufferSource();
    const carpetGain = offlineContext.createGain();

    voiceSource.buffer = voiceAudio;
    carpetSource.buffer = this.createLoopedCarpetBuffer(offlineContext, carpetAudio, frameCount, channels);
    carpetGain.gain.value = this.getAudioCarpetGain();
    this.applyCarpetFade(carpetGain, offlineContext, frameCount, sampleRate);

    voiceSource.connect(offlineContext.destination);
    carpetSource.connect(carpetGain);
    carpetGain.connect(offlineContext.destination);

    voiceSource.start(0);
    carpetSource.start(0);

    if (signal && signal.aborted) throw new Error("Podcast generation cancelled.");
    const rendered = await offlineContext.startRendering();
    this.throwIfCancelled(signal);
    return rendered;
  }

  createLoopedCarpetBuffer(audioContext, carpetAudio, frameCount, channels) {
    const buffer = audioContext.createBuffer(channels, frameCount, audioContext.sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const target = buffer.getChannelData(channel);
      const sourceChannel = Math.min(channel, carpetAudio.numberOfChannels - 1);
      const source = carpetAudio.getChannelData(sourceChannel);
      const resampleRatio = carpetAudio.sampleRate / audioContext.sampleRate;
      for (let targetIndex = 0; targetIndex < frameCount; targetIndex += 1) {
        const sourcePosition = (targetIndex * resampleRatio) % source.length;
        const sourceIndex = Math.floor(sourcePosition);
        const nextIndex = (sourceIndex + 1) % source.length;
        const blend = sourcePosition - sourceIndex;
        target[targetIndex] = source[sourceIndex] * (1 - blend) + source[nextIndex] * blend;
      }
    }
    return buffer;
  }

  applyCarpetFade(carpetGain, audioContext, frameCount, sampleRate) {
    const volume = this.getAudioCarpetGain();
    const duration = frameCount / sampleRate;
    const fadeSeconds = Math.min(1, duration / 2);

    carpetGain.gain.cancelScheduledValues(0);
    carpetGain.gain.setValueAtTime(0, 0);
    carpetGain.gain.linearRampToValueAtTime(volume, fadeSeconds);
    carpetGain.gain.setValueAtTime(volume, Math.max(fadeSeconds, duration - fadeSeconds));
    carpetGain.gain.linearRampToValueAtTime(0, duration);
  }

  getAudioCarpetGain() {
    const volume = Number(this.settings.audioCarpetVolume);
    if (!Number.isFinite(volume)) return DEFAULT_SETTINGS.audioCarpetVolume / 100;
    return Math.max(0, Math.min(100, volume)) / 100;
  }

  encodeWav(audioBuffer) {
    const channels = Math.max(1, Math.min(2, audioBuffer.numberOfChannels));
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length * channels * 2;
    const buffer = new ArrayBuffer(44 + length);
    const view = new DataView(buffer);

    this.writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + length, true);
    this.writeAscii(view, 8, "WAVE");
    this.writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    this.writeAscii(view, 36, "data");
    view.setUint32(40, length, true);

    let offset = 44;
    const channelData = [];
    for (let channel = 0; channel < channels; channel += 1) {
      channelData.push(audioBuffer.getChannelData(channel));
    }

    for (let index = 0; index < audioBuffer.length; index += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = Math.max(-1, Math.min(1, channelData[channel][index]));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += 2;
      }
    }

    return new Uint8Array(buffer);
  }

  writeAscii(view, offset, text) {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }

  cleanPodcastScript(script) {
    return script
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```(?:text|markdown)?/gi, "").replace(/```/g, ""))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !/^\[[^\]]+\]$/.test(line))
      .filter((line) => !/^\([^)]+\)$/.test(line))
      .filter((line) => !/^(intro|outro|music|sound|sfx|fade|transition|host|narrator|speaker)\s*[:\-\]]/i.test(line))
      .map((line) => line.replace(/^(host|narrator|speaker)\s*\d*\s*:\s*/i, ""))
      .join("\n\n")
      .trim();
  }

  chunkText(text, maxLength) {
    const cleanText = text.replace(/\r\n/g, "\n").trim();
    if (cleanText.length <= maxLength) return [cleanText];

    const paragraphs = cleanText.split(/\n{2,}/);
    const chunks = [];
    let current = "";

    for (const paragraph of paragraphs) {
      if (paragraph.length > maxLength) {
        if (current.trim()) chunks.push(current.trim());
        current = "";
        chunks.push(...this.splitLongParagraph(paragraph, maxLength));
        continue;
      }

      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (candidate.length > maxLength) {
        chunks.push(current.trim());
        current = paragraph;
      } else {
        current = candidate;
      }
    }

    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  splitLongParagraph(paragraph, maxLength) {
    const sentences = paragraph.match(/[^.!?]+[.!?]+["')\]]*|.+$/g) || [paragraph];
    const chunks = [];
    let current = "";

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      const candidate = current ? `${current} ${trimmed}` : trimmed;
      if (candidate.length <= maxLength) {
        current = candidate;
        continue;
      }

      if (current) chunks.push(current);
      if (trimmed.length <= maxLength) {
        current = trimmed;
      } else {
        for (let i = 0; i < trimmed.length; i += maxLength) {
          chunks.push(trimmed.slice(i, i + maxLength));
        }
        current = "";
      }
    }

    if (current) chunks.push(current);
    return chunks;
  }

  async createOutputDirectory(noteName) {
    const safeNoteName = noteName.replace(/[\\/:*?"<>|]/g, "-");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputDir = normalizePath(`${this.settings.outputFolder}/${safeNoteName}-${timestamp}`);
    await this.ensureFolder(outputDir);
    return outputDir;
  }

  async ensureFolder(folderPath) {
    const parts = normalizePath(folderPath).split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.createFolder(current);
      }
    }
  }
};

class PodcastLauncherModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.modalEl.addClass("vaultcast-studio-launcher-modal");
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({ cls: "vaultcast-studio-shell" });
    const header = shell.createDiv({ cls: "vaultcast-studio-header" });
    header.createEl("h2", { text: "VaultCast Studio" });
    header.createDiv({ cls: "vaultcast-studio-state", text: "Ready" });

    const activeFile = this.app.workspace.getActiveFile();
    shell.createDiv({
      cls: "vaultcast-studio-message",
      text: activeFile ? `Current note: ${activeFile.path}` : "Open a note before creating a podcast."
    });

    const statusList = shell.createDiv({ cls: "vaultcast-studio-status-list" });
    this.createStatusRow(statusList, "DeepSeek API key", this.plugin.settings.deepseekApiKey.trim() ? "Configured" : "Missing");
    this.createStatusRow(statusList, "Deepgram API key", this.plugin.settings.deepgramApiKey.trim() ? "Configured" : "Missing");
    this.createStatusRow(statusList, "DeepSeek model", this.plugin.settings.deepseekModel || DEFAULT_SETTINGS.deepseekModel);
    this.createStatusRow(statusList, "Deepgram model", this.plugin.settings.deepgramModel || DEFAULT_SETTINGS.deepgramModel);
    this.createStatusRow(statusList, "Audio carpet", this.plugin.settings.audioCarpetEnabled ? `${this.plugin.settings.audioCarpetVolume}%` : "Off");
    this.createStatusRow(statusList, "Output folder", this.plugin.settings.outputFolder || DEFAULT_SETTINGS.outputFolder);

    const actions = shell.createDiv({ cls: "vaultcast-studio-actions" });
    const createButton = actions.createEl("button", {
      cls: "mod-cta",
      text: "Create podcast"
    });
    createButton.disabled = !activeFile;
    createButton.addEventListener("click", () => {
      this.close();
      this.plugin.createPodcastFromCurrentNote();
    });

    const settingsButton = actions.createEl("button", { text: "Open settings" });
    settingsButton.addEventListener("click", () => {
      this.close();
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
    });
  }

  createStatusRow(parent, label, value) {
    const row = parent.createDiv({ cls: "vaultcast-studio-status-row" });
    row.createDiv({ cls: "vaultcast-studio-status-label", text: label });
    row.createDiv({ cls: "vaultcast-studio-status-value", text: value });
  }
}

class PodcastProgressModal extends Modal {
  constructor(app, onCancel) {
    super(app);
    this.totalChunks = 0;
    this.onCancel = onCancel;
    this.isDone = false;
  }

  onOpen() {
    this.modalEl.addClass("vaultcast-studio-modal");
    this.contentEl.empty();

    const shell = this.contentEl.createDiv({ cls: "vaultcast-studio-shell" });
    const header = shell.createDiv({ cls: "vaultcast-studio-header" });
    header.createEl("h2", { text: "VaultCast Studio" });
    this.stateEl = header.createDiv({ cls: "vaultcast-studio-state", text: "Starting" });

    this.messageEl = shell.createDiv({ cls: "vaultcast-studio-message" });

    const progressWrap = shell.createDiv({ cls: "vaultcast-studio-progress" });
    this.progressBarEl = progressWrap.createDiv({ cls: "vaultcast-studio-progress-bar" });
    this.progressLabelEl = shell.createDiv({ cls: "vaultcast-studio-progress-label", text: "Waiting for work to begin." });

    this.logEl = shell.createDiv({ cls: "vaultcast-studio-log" });

    const actions = shell.createDiv({ cls: "vaultcast-studio-actions" });
    this.cancelButtonEl = actions.createEl("button", { text: "Cancel" });
    this.cancelButtonEl.addEventListener("click", () => {
      this.cancelButtonEl.disabled = true;
      this.cancelButtonEl.setText("Cancelling...");
      this.setStatus("Cancelling", "Stopping the current podcast generation.");
      if (this.onCancel) this.onCancel();
    });

    this.closeButtonEl = actions.createEl("button", { text: "Close" });
    this.closeButtonEl.disabled = true;
    this.closeButtonEl.addEventListener("click", () => this.close());
  }

  setStatus(title, message) {
    if (!this.stateEl) return;
    this.stateEl.setText(title);
    this.messageEl.setText(message || "");
    this.addLog(title);
  }

  setTotalChunks(totalChunks) {
    this.totalChunks = totalChunks;
    this.setProgress(0, totalChunks);
  }

  setChunkProgress(doneChunks, totalChunks, message) {
    this.totalChunks = totalChunks;
    this.stateEl.setText("Generating audio");
    this.messageEl.setText(message);
    this.setProgress(doneChunks, totalChunks);
    this.addLog(message);
  }

  setProgress(doneChunks, totalChunks) {
    const percent = totalChunks > 0 ? Math.round((doneChunks / totalChunks) * 100) : 0;
    this.progressBarEl.style.width = `${percent}%`;
    this.progressLabelEl.setText(`${doneChunks} of ${totalChunks} audio chunks complete`);
  }

  addLog(message) {
    if (!this.logEl || !message) return;
    const entry = this.logEl.createDiv({ cls: "vaultcast-studio-log-entry", text: message });
    entry.scrollIntoView({ block: "nearest" });
  }

  finish(outputDir) {
    this.isDone = true;
    this.stateEl.setText("Podcast created");
    this.messageEl.setText(outputDir);
    this.progressBarEl.style.width = "100%";
    this.progressLabelEl.setText(`${this.totalChunks} of ${this.totalChunks} audio chunks complete`);
    this.addLog(`Finished: ${outputDir}`);
    this.cancelButtonEl.disabled = true;
    this.closeButtonEl.disabled = false;
  }

  fail(message) {
    this.isDone = true;
    if (!this.stateEl) return;
    this.modalEl.addClass("vaultcast-studio-modal-error");
    this.stateEl.setText("Podcast failed");
    this.messageEl.setText(message);
    this.addLog(message);
    this.cancelButtonEl.disabled = true;
    this.closeButtonEl.disabled = false;
  }

  cancel() {
    this.isDone = true;
    if (!this.stateEl) return;
    this.stateEl.setText("Cancelled");
    this.messageEl.setText("Podcast generation was cancelled.");
    this.addLog("Cancelled by user.");
    this.cancelButtonEl.disabled = true;
    this.closeButtonEl.disabled = false;
  }
}

class VaultCastStudioSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "VaultCast Studio" });

    new Setting(containerEl)
      .setName("DeepSeek API key")
      .setDesc("Used to create the podcast script from the current note.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.deepseekApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepseekApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Deepgram API key")
      .setDesc("Used to generate text-to-speech audio chunks.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("dg-...")
          .setValue(this.plugin.settings.deepgramApiKey)
          .onChange(async (value) => {
            this.plugin.settings.deepgramApiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Podcast script prompt")
      .setDesc("Sent to DeepSeek before the note content.")
      .addTextArea((text) => {
        text.inputEl.addClass("vaultcast-studio-prompt");
        text
          .setValue(this.plugin.settings.prompt)
          .onChange(async (value) => {
            this.plugin.settings.prompt = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("DeepSeek model")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.deepseekModel)
          .setValue(this.plugin.settings.deepseekModel)
          .onChange(async (value) => {
            this.plugin.settings.deepseekModel = value.trim() || DEFAULT_SETTINGS.deepseekModel;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Deepgram model")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.deepgramModel)
          .setValue(this.plugin.settings.deepgramModel)
          .onChange(async (value) => {
            this.plugin.settings.deepgramModel = value.trim() || DEFAULT_SETTINGS.deepgramModel;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Chunk size")
      .setDesc("Maximum script characters per Deepgram request. Keep this below API limits.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.chunkSize))
          .setValue(String(this.plugin.settings.chunkSize))
          .onChange(async (value) => {
            this.plugin.settings.chunkSize = Number(value) || DEFAULT_SETTINGS.chunkSize;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Audio carpet")
      .setDesc("Mix a background audio bed into the final podcast.")
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.audioCarpetEnabled))
          .onChange(async (value) => {
            this.plugin.settings.audioCarpetEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Audio carpet file")
      .setDesc("Put carpet_sound.mp3 in the plugin audio folder, or set another vault path.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.audioCarpetPath)
          .setValue(this.plugin.settings.audioCarpetPath || DEFAULT_SETTINGS.audioCarpetPath)
          .onChange(async (value) => {
            this.plugin.settings.audioCarpetPath = value.trim() || DEFAULT_SETTINGS.audioCarpetPath;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Audio carpet volume")
      .setDesc("Background volume as a percentage. 20 is usually subtle.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 1)
          .setDynamicTooltip()
          .setValue(Number(this.plugin.settings.audioCarpetVolume) || DEFAULT_SETTINGS.audioCarpetVolume)
          .onChange(async (value) => {
            this.plugin.settings.audioCarpetVolume = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Output folder")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.outputFolder)
          .setValue(this.plugin.settings.outputFolder)
          .onChange(async (value) => {
            this.plugin.settings.outputFolder = value.trim() || DEFAULT_SETTINGS.outputFolder;
            await this.plugin.saveSettings();
          })
      );
  }
}
