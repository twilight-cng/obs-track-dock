const STORAGE_KEY = "obs-track-dock-v1";
const TRACK_COUNT = 5;

const defaultConfig = () => ({
  host: "127.0.0.1",
  port: 4455,
  password: "",
  trackNames: ["配信", "録画", "トラック3", "トラック4", "トラック5"],
});

const els = {
  status: document.getElementById("status"),
  btnConnect: document.getElementById("btn-connect"),
  btnSettings: document.getElementById("btn-settings"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnSaveSettings: document.getElementById("btn-save-settings"),
  settingsPanel: document.getElementById("settings-panel"),
  trackNameFields: document.getElementById("track-name-fields"),
  cfgHost: document.getElementById("cfg-host"),
  cfgPort: document.getElementById("cfg-port"),
  cfgPassword: document.getElementById("cfg-password"),
  matrixHead: document.getElementById("matrix-head"),
  matrixBody: document.getElementById("matrix-body"),
  empty: document.getElementById("empty"),
  dialog: document.getElementById("new-source-dialog"),
  newSourceForm: document.getElementById("new-source-form"),
  newSourceName: document.getElementById("new-source-name"),
  newSourceToggles: document.getElementById("new-source-toggles"),
};

let config = loadConfig();
let ws = null;
let reqId = 1;
const pending = new Map();
/** @type {Map<string, { name: string, tracks: Record<string, boolean>, warning: string|null }>} */
let sources = new Map();
let pendingNewInput = null;

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    return defaultConfig();
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function setStatus(kind, text) {
  els.status.className = `status status-${kind}`;
  els.status.textContent = text;
}

function trackLabel(i) {
  return config.trackNames[i - 1] || `トラック${i}`;
}

function isBgmName(name) {
  return /bgm/i.test(name);
}

function findTrackIndexesByName(re) {
  const hits = [];
  for (let i = 1; i <= TRACK_COUNT; i++) {
    if (re.test(trackLabel(i))) hits.push(i);
  }
  return hits;
}

function evaluateBgmWarning(name, tracks) {
  if (!isBgmName(name)) return null;

  const streamTracks = findTrackIndexesByName(/配信|stream/i);
  const recordTracks = findTrackIndexesByName(/録画|record|vod/i);

  const onRecord = recordTracks.filter((i) => tracks[String(i)]);
  const streamOn =
    streamTracks.length === 0
      ? null
      : streamTracks.some((i) => tracks[String(i)]);

  if (onRecord.length > 0) {
    return `BGM が「${onRecord.map(trackLabel).join(", ")}」に乗っています`;
  }
  if (streamOn === false) {
    return `BGM の「${streamTracks.map(trackLabel).join(", ")}」が OFF です`;
  }
  return null;
}

function renderSettingsFields() {
  els.cfgHost.value = config.host;
  els.cfgPort.value = String(config.port);
  els.cfgPassword.value = config.password;
  els.trackNameFields.innerHTML = "";
  for (let i = 1; i <= TRACK_COUNT; i++) {
    const label = document.createElement("label");
    label.textContent = `Track ${i}`;
    const input = document.createElement("input");
    input.type = "text";
    input.value = config.trackNames[i - 1] || "";
    input.dataset.track = String(i);
    label.appendChild(input);
    els.trackNameFields.appendChild(label);
  }
}

function renderHead() {
  els.matrixHead.innerHTML = "";
  const nameTh = document.createElement("th");
  nameTh.textContent = "ソース";
  els.matrixHead.appendChild(nameTh);
  for (let i = 1; i <= TRACK_COUNT; i++) {
    const th = document.createElement("th");
    th.textContent = trackLabel(i);
    els.matrixHead.appendChild(th);
  }
}

function renderMatrix() {
  renderHead();
  els.matrixBody.innerHTML = "";
  const list = [...sources.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ja"),
  );
  els.empty.classList.toggle("hidden", list.length > 0);

  for (const src of list) {
    const tr = document.createElement("tr");
    if (src.warning) tr.classList.add("warn-row");

    const nameTd = document.createElement("td");
    nameTd.innerHTML = `<div class="source-name"><strong></strong>${
      src.warning ? `<span class="warn-text"></span>` : ""
    }</div>`;
    nameTd.querySelector("strong").textContent = src.name;
    if (src.warning) {
      nameTd.querySelector(".warn-text").textContent = src.warning;
    }
    tr.appendChild(nameTd);

    for (let i = 1; i <= TRACK_COUNT; i++) {
      const td = document.createElement("td");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "toggle";
      toggle.checked = !!src.tracks[String(i)];
      const isRecord = /録画|record|vod/i.test(trackLabel(i));
      if (isBgmName(src.name) && isRecord && toggle.checked) {
        toggle.classList.add("warn-on");
      }
      toggle.addEventListener("change", async () => {
        const next = { ...src.tracks, [String(i)]: toggle.checked };
        try {
          await setTracks(src.name, next);
          src.tracks = next;
          src.warning = evaluateBgmWarning(src.name, next);
          renderMatrix();
        } catch (err) {
          toggle.checked = !toggle.checked;
          setStatus("off", String(err.message || err));
        }
      });
      td.appendChild(toggle);
      tr.appendChild(td);
    }

    els.matrixBody.appendChild(tr);
  }
}

async function sha256Base64(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function request(requestType, requestData = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("OBS に接続していません"));
  }
  const requestId = String(reqId++);
  const payload = {
    op: 6,
    d: { requestType, requestId, requestData },
  };
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    ws.send(JSON.stringify(payload));
  });
}

async function connect() {
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  setStatus("busy", "接続中…");
  const url = `ws://${config.host}:${config.port}`;

  await new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    let identified = false;

    ws.onopen = () => setStatus("busy", "認証中…");

    ws.onerror = () => {
      if (!identified) {
        setStatus("off", "接続失敗");
        reject(new Error("WebSocket 接続に失敗しました"));
      }
    };

    ws.onclose = () => {
      setStatus("off", "切断");
      if (!identified) reject(new Error("接続が閉じられました"));
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.op === 0) {
        const auth = msg.d.authentication;
        // General | Inputs
        const identify = {
          op: 1,
          d: {
            rpcVersion: 1,
            eventSubscriptions: (1 << 0) | (1 << 3),
          },
        };

        if (auth) {
          const secret = await sha256Base64(config.password + auth.salt);
          identify.d.authentication = await sha256Base64(
            secret + auth.challenge,
          );
        }
        ws.send(JSON.stringify(identify));
        return;
      }

      if (msg.op === 2) {
        identified = true;
        setStatus("on", "接続中");
        resolve();
        refreshAll().catch((e) => setStatus("off", String(e.message || e)));
        return;
      }

      if (msg.op === 5) {
        handleEvent(msg.d).catch(() => undefined);
        return;
      }

      if (msg.op === 7) {
        const { requestId, requestStatus, responseData } = msg.d;
        const waiter = pending.get(requestId);
        if (!waiter) return;
        pending.delete(requestId);
        if (requestStatus.result) waiter.resolve(responseData ?? {});
        else
          waiter.reject(
            new Error(requestStatus.comment || "OBS リクエスト失敗"),
          );
      }
    };
  });
}

async function handleEvent(d) {
  const type = d.eventType;
  const data = d.eventData || {};

  if (type === "InputCreated") {
    const name = data.inputName;
    // Give OBS a moment, then fetch tracks
    setTimeout(async () => {
      try {
        const tracks = await getTracks(name);
        sources.set(name, {
          name,
          tracks,
          warning: evaluateBgmWarning(name, tracks),
        });
        renderMatrix();
        openNewSourceDialog(name, tracks);
      } catch {
        /* non-audio input */
      }
    }, 200);
    return;
  }

  if (type === "InputRemoved") {
    sources.delete(data.inputName);
    renderMatrix();
    return;
  }

  if (type === "InputNameChanged") {
    const oldName = data.oldInputName;
    const newName = data.inputName;
    const prev = sources.get(oldName);
    if (prev) {
      sources.delete(oldName);
      prev.name = newName;
      prev.warning = evaluateBgmWarning(newName, prev.tracks);
      sources.set(newName, prev);
      renderMatrix();
    }
    return;
  }

  if (type === "InputAudioTracksChanged") {
    const name = data.inputName;
    const tracks = normalizeTracks(data.inputAudioTracks);
    const prev = sources.get(name) || { name, tracks: {}, warning: null };
    prev.tracks = tracks;
    prev.warning = evaluateBgmWarning(name, tracks);
    sources.set(name, prev);
    renderMatrix();
  }
}

function normalizeTracks(raw) {
  const out = {};
  for (let i = 1; i <= TRACK_COUNT; i++) {
    out[String(i)] = !!(raw && raw[String(i)]);
  }
  return out;
}

async function getTracks(inputName) {
  const res = await request("GetInputAudioTracks", { inputName });
  return normalizeTracks(res.inputAudioTracks);
}

async function setTracks(inputName, tracks) {
  const payload = {};
  for (let i = 1; i <= TRACK_COUNT; i++) {
    payload[String(i)] = !!tracks[String(i)];
  }
  // Keep track 6 unchanged if present - send false or omit?
  // API replaces provided keys; send only 1-5 and leave 6 as-is by first getting full
  try {
    const current = await request("GetInputAudioTracks", { inputName });
    const merged = { ...(current.inputAudioTracks || {}), ...payload };
    await request("SetInputAudioTracks", {
      inputName,
      inputAudioTracks: merged,
    });
  } catch (e) {
    await request("SetInputAudioTracks", {
      inputName,
      inputAudioTracks: payload,
    });
  }
}

async function refreshAll() {
  const list = await request("GetInputList");
  const next = new Map();
  for (const input of list.inputs || []) {
    const name = input.inputName;
    try {
      const tracks = await getTracks(name);
      next.set(name, {
        name,
        tracks,
        warning: evaluateBgmWarning(name, tracks),
      });
    } catch {
      // video-only etc.
    }
  }
  sources = next;
  renderMatrix();
}

function openNewSourceDialog(name, tracks) {
  pendingNewInput = { name, tracks: { ...tracks } };
  els.newSourceName.textContent = name;
  els.newSourceToggles.innerHTML = "";

  for (let i = 1; i <= TRACK_COUNT; i++) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "toggle";
    cb.checked = !!tracks[String(i)];
    cb.dataset.track = String(i);
    label.appendChild(cb);
    label.appendChild(document.createTextNode(trackLabel(i)));
    els.newSourceToggles.appendChild(label);
  }

  // BGM default: stream only
  if (isBgmName(name)) {
    applyPreset("stream");
  }

  els.dialog.showModal();
}

function applyPreset(kind) {
  const streamTracks = findTrackIndexesByName(/配信|stream/i);
  const recordTracks = findTrackIndexesByName(/録画|record|vod/i);
  const boxes = [...els.newSourceToggles.querySelectorAll("input")];

  for (const box of boxes) {
    const i = Number(box.dataset.track);
    if (kind === "all-off") box.checked = false;
    else if (kind === "stream") {
      box.checked =
        streamTracks.length > 0 ? streamTracks.includes(i) : i === 1;
    } else if (kind === "record") {
      box.checked =
        recordTracks.length > 0 ? recordTracks.includes(i) : i === 2;
    } else if (kind === "both") {
      const allow = new Set([
        ...(streamTracks.length ? streamTracks : [1]),
        ...(recordTracks.length ? recordTracks : [2]),
      ]);
      box.checked = allow.has(i);
    }
  }
}

els.btnSettings.addEventListener("click", () => {
  renderSettingsFields();
  els.settingsPanel.classList.toggle("hidden");
});

els.btnSaveSettings.addEventListener("click", () => {
  config.host = els.cfgHost.value.trim() || "127.0.0.1";
  config.port = Number(els.cfgPort.value) || 4455;
  config.password = els.cfgPassword.value;
  const names = [...els.trackNameFields.querySelectorAll("input")].map(
    (el) => el.value.trim() || el.dataset.track,
  );
  config.trackNames = names;
  saveConfig();
  els.settingsPanel.classList.add("hidden");
  for (const src of sources.values()) {
    src.warning = evaluateBgmWarning(src.name, src.tracks);
  }
  renderMatrix();
});

els.btnConnect.addEventListener("click", () => {
  connect().catch((e) => setStatus("off", String(e.message || e)));
});

els.btnRefresh.addEventListener("click", () => {
  refreshAll().catch((e) => setStatus("off", String(e.message || e)));
});

els.newSourceForm.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-preset]");
  if (!btn) return;
  applyPreset(btn.dataset.preset);
});

els.newSourceForm.addEventListener("submit", async (e) => {
  const submitter = e.submitter;
  if (!pendingNewInput) return;
  if (submitter && submitter.value === "cancel") {
    pendingNewInput = null;
    return;
  }

  e.preventDefault();
  const tracks = {};
  for (const box of els.newSourceToggles.querySelectorAll("input")) {
    tracks[box.dataset.track] = box.checked;
  }
  try {
    await setTracks(pendingNewInput.name, tracks);
    const src = sources.get(pendingNewInput.name);
    if (src) {
      src.tracks = normalizeTracks(tracks);
      src.warning = evaluateBgmWarning(src.name, src.tracks);
    }
    renderMatrix();
    els.dialog.close();
    pendingNewInput = null;
  } catch (err) {
    setStatus("off", String(err.message || err));
  }
});

renderSettingsFields();
renderMatrix();
saveConfig();

// Auto-connect on load for dock convenience
connect().catch(() => {
  setStatus("off", "未接続（設定を確認）");
});
