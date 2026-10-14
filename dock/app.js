const STORAGE_KEY = "obs-track-dock-v1";
const TRACK_COUNT = 6;
const CONNECT_TIMEOUT_MS = 8000;
const REQUEST_TIMEOUT_MS = 8000;

const defaultConfig = () => ({
  host: "127.0.0.1",
  port: 4455,
  password: "",
  trackNames: ["配信", "録画", "トラック3", "トラック4", "トラック5", "トラック6"],
});

const els = {
  status: document.getElementById("status"),
  btnConnect: document.getElementById("btn-connect"),
  btnSettings: document.getElementById("btn-settings"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnHelp: document.getElementById("btn-help"),
  helpDialog: document.getElementById("help-dialog"),
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
let socketGen = 0;
let connecting = false;
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

function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Pure JS SHA-256 for OBS Browser Dock (file:// has no crypto.subtle). */
function sha256Bytes(message) {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const rotr = (n, x) => (x >>> n) | (x << (32 - n));
  const bytes = message instanceof Uint8Array ? message : new TextEncoder().encode(message);
  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array(((bytes.length + 9 + 63) & ~63));
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, bitLen >>> 0, false);
  // high 32 bits of length; fine for dock-sized strings
  view.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let i = 0; i < withPad.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = view.getUint32(i + j * 4, false);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(7, w[j - 15]) ^ rotr(18, w[j - 15]) ^ (w[j - 15] >>> 3);
      const s1 = rotr(17, w[j - 2]) ^ rotr(19, w[j - 2]) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let j = 0; j < 64; j++) {
      const S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

async function sha256Base64(input) {
  const data = new TextEncoder().encode(input);
  // file:// / OBS Browser Dock では crypto.subtle が使えないことが多い
  if (globalThis.crypto?.subtle) {
    try {
      const hash = await crypto.subtle.digest("SHA-256", data);
      return bytesToBase64(new Uint8Array(hash));
    } catch {
      /* fall through */
    }
  }
  return bytesToBase64(sha256Bytes(data));
}

function rejectPending(err) {
  for (const [, waiter] of pending) waiter.reject(err);
  pending.clear();
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
    const timer = setTimeout(() => {
      if (!pending.has(requestId)) return;
      pending.delete(requestId);
      reject(new Error(`OBS リクエストがタイムアウトしました (${requestType})`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    ws.send(JSON.stringify(payload));
  });
}

async function connect() {
  if (connecting) {
    throw new Error("接続処理中です");
  }
  connecting = true;
  els.btnConnect.disabled = true;

  const prev = ws;
  const gen = ++socketGen;
  ws = null;
  if (prev) {
    try {
      prev.onopen = null;
      prev.onerror = null;
      prev.onclose = null;
      prev.onmessage = null;
      prev.close();
    } catch {
      /* ignore */
    }
  }
  rejectPending(new Error("再接続のため中断しました"));

  setStatus("busy", "接続中…");
  const url = `ws://${config.host}:${config.port}`;

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let identified = false;
      const socket = new WebSocket(url);
      ws = socket;

      const finish = (fn, value) => {
        if (settled || gen !== socketGen) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
        finish(reject, new Error("接続がタイムアウトしました"));
        if (gen === socketGen) setStatus("off", "接続タイムアウト");
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (gen !== socketGen) return;
        setStatus("busy", "認証中…");
      };

      socket.onerror = () => {
        if (gen !== socketGen) return;
        if (!identified) {
          setStatus("off", "接続失敗");
          finish(reject, new Error("WebSocket 接続に失敗しました"));
        }
      };

      socket.onclose = () => {
        if (gen !== socketGen) return;
        rejectPending(new Error("接続が閉じられました"));
        if (!identified) {
          setStatus("off", "切断");
          finish(reject, new Error("接続が閉じられました"));
        } else {
          setStatus("off", "切断");
        }
      };

      socket.onmessage = async (ev) => {
        if (gen !== socketGen) return;
        try {
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
            if (gen !== socketGen || socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify(identify));
            return;
          }

          if (msg.op === 2) {
            identified = true;
            setStatus("on", "接続中");
            finish(resolve);
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
        } catch (err) {
          setStatus("off", String(err.message || err));
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          finish(reject, err instanceof Error ? err : new Error(String(err)));
        }
      };
    });
  } finally {
    connecting = false;
    els.btnConnect.disabled = false;
  }
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
  // SetInputAudioTracks updates only the keys we send. Tracks 1–6 are
  // explicit; any other key OBS returns is left unchanged.
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

els.btnHelp.addEventListener("click", () => {
  if (!els.helpDialog.open) els.helpDialog.showModal();
});

els.btnSettings.addEventListener("click", () => {
  const opening = els.settingsPanel.classList.contains("hidden");
  if (opening) renderSettingsFields();
  els.settingsPanel.classList.toggle("hidden", !opening);
  document.body.classList.toggle("settings-open", opening);
  els.btnSettings.setAttribute("aria-expanded", String(opening));
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
  document.body.classList.remove("settings-open");
  els.btnSettings.setAttribute("aria-expanded", "false");
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
