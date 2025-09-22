import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

// --- Persistent settings keys ---
const LS = {
  BAUD: "pam.baud",
  NL: "pam.nl",
  TAB: "pam.tab",
};

/* =========================================================================
   PAM WebSerial Dashboard — JS-only, robust parsing
   - Works with/without a printed header
   - Uses refs to avoid stale closures in the serial read loop
   - Handles CRLF/LF/CR newlines
   - “Assume Default Header” + custom header input
   ======================================================================= */

// -----------------------------
// Sensor map + defaults
// -----------------------------
const SENSOR_MAP = [
  {
    key: "PM1",
    matches: (h) => /\bPM1\b/i.test(h),
    label: "PM1",
    unit: "µg/m³",
  },
  {
    key: "PM2_5",
    matches: (h) => /PM2\.5/i.test(h),
    label: "PM2.5",
    unit: "µg/m³",
  },
  {
    key: "PM10",
    matches: (h) => /\bPM10\b/i.test(h),
    label: "PM10",
    unit: "µg/m³",
  },
  { key: "NO2", matches: (h) => /\bNO2\b/i.test(h), label: "NO₂", unit: "ppb" },
  { key: "CO", matches: (h) => /\bCO\b/i.test(h), label: "CO", unit: "ppb" },
  { key: "CO2", matches: (h) => /\bCO2\b/i.test(h), label: "CO₂", unit: "ppm" },
  { key: "TVOC", matches: (h) => /TVOC/i.test(h), label: "TVOCs", unit: "ppb" },
  {
    key: "RH",
    matches: (h) => /RELH|RH\b/i.test(h),
    label: "Relative Humidity",
    unit: "%",
  },
  {
    key: "TEMP",
    matches: (h) => /TEMP\b/i.test(h),
    label: "Temperature",
    unit: "°C",
  },
  {
    key: "PRESS",
    matches: (h) => /PRESS\b/i.test(h),
    label: "Pressure",
    unit: "hPa",
  },
  {
    key: "CH4",
    matches: (h) => /METHANE|CH4/i.test(h),
    label: "Methane",
    unit: "ppm",
  },
  {
    key: "CELL",
    matches: (h) => /Cell-Strength/i.test(h),
    label: "Cell Strength",
    unit: "dBm",
  },
  {
    key: "BAT",
    matches: (h) => /Battery/i.test(h),
    label: "Battery",
    unit: "%",
  },
];
//DeviceId,CO(PPM),PM1(UGM3),PM2.5(UGM3),PM10(UGM3),CO2(PPM),RELHUM(%),TEMP(C),PRESS(HPA),LAT(LAT),LON(LON),Battery(%),Date,Time
const DEFAULT_HEADER = [
  "DeviceId",
  "CO(PPM)",
  "PM1(UGM3)",
  "PM2.5(UGM3)",
  "PM10(UGM3)",
  "CO2(PPM)",
  "RELHUM(%)",
  "TEMP(C)",
  "PRESS(HPA)",
  "LAT(LAT)",
  "LON(LON)",
  "Battery(%)",
  "Date",
  "Time",
];

const looksLikeNumericCsv = (line) => /^[0-9 .,:\-]+$/.test(String(line));

// -----------------------------
// Line splitter (bytes -> text lines)
// -----------------------------
class LineBreakTransformer {
  constructor() {
    this.container = "";
  }
  transform(chunk, controller) {
    this.container += chunk;
    // IMPORTANT: one-line regex (CRLF, LF, or CR)
    const lines = this.container.split(/\r\n|[\r\n]/);
    this.container = lines.pop() || "";
    for (const line of lines) controller.enqueue(line);
  }
  flush(controller) {
    if (this.container) controller.enqueue(this.container);
  }
}

// -----------------------------
// Helpers
// -----------------------------
function parseMaybeNumber(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v || v.toUpperCase() === "N/A") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function buildTimestamp(row, fallbackMs) {
  const dateStr = row["Date"] || row["DATE"];
  const timeStr = row["Time"] || row["TIME"];
  if (dateStr && timeStr) {
    const ms = new Date(`${dateStr}T${timeStr}`).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return fallbackMs;
}
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString();
}

function mapHeaderUnit(u) {
  const U = String(u || "").toUpperCase();
  if (U === "UGM3") return "µg/m³";
  if (U === "HPA") return "hPa";
  if (U === "PPM") return "ppm";
  if (U === "PPB") return "ppb";
  if (U === "%") return "%";
  if (U === "C") return "°C";
  return u || "";
}

function unitForMeta(meta, header) {
  if (!header) return meta.unit;
  const h = header.find((x) => meta.matches(x));
  if (!h) return meta.unit;
  const m = /\(([^)]*)\)/.exec(h);
  return mapHeaderUnit(m ? m[1] : meta.unit);
}

function unitForHeader(pattern, header, fallback) {
  if (!header) return fallback;
  const h = header.find((x) => pattern.test(x));
  if (!h) return fallback;
  const m = /\(([^)]*)\)/.exec(h);
  return mapHeaderUnit(m ? m[1] : fallback);
}

// -----------------------------
// Component
// -----------------------------
export default function PamWebSerialDashboard() {
  const readerRef = useRef(null);
  const writerRef = useRef(null);
  const portRef = useRef(null);

  // State
  const [isSupported] = useState(
    () => typeof navigator !== "undefined" && navigator.serial
  );
  const [isConnected, setIsConnected] = useState(false);
  const [baudRate, setBaudRate] = useState(115200);
  const [autoNewline, setAutoNewline] = useState("\r"); // "none" | "\r" | "\n" | "\r\n"
  const [csvHeader, setCsvHeader] = useState(null);
  const [latest, setLatest] = useState({});
  const [series, setSeries] = useState({});
  const [rawLog, setRawLog] = useState([]);
  const [activeTab, setActiveTab] = useState("latest");
  const [sending, setSending] = useState(false);
  const [customCmd, setCustomCmd] = useState("");
  const [customHeaderText, setCustomHeaderText] = useState("");
  const [maxPoints] = useState(600);

  // Terminal typing echo
  const [echoInput, setEchoInput] = useState(true);
  const logRef = useRef(null);

  // Refs to avoid stale closures in the stream loop
  const csvHeaderRef = useRef(null);
  const latestRef = useRef({});
  const seriesRef = useRef({});

  useEffect(() => {
    csvHeaderRef.current = csvHeader;
  }, [csvHeader]);
  useEffect(() => {
    latestRef.current = latest;
  }, [latest]);
  useEffect(() => {
    seriesRef.current = series;
  }, [series]);

  // Derive DeviceId from header/latest for display in the title
  const deviceId = useMemo(() => {
    try {
      if (csvHeader && Array.isArray(csvHeader)) {
        const key = csvHeader.find((h) => /DeviceId/i.test(h));
        const v = key ? latest?.[key] : null;
        if (v != null && String(v).trim() !== "") return String(v).trim();
      }
      if (
        latest &&
        latest.DeviceId != null &&
        String(latest.DeviceId).trim() !== ""
      ) {
        return String(latest.DeviceId).trim();
      }
      return "";
    } catch {
      return "";
    }
  }, [csvHeader, latest]);

  const presentSensors = useMemo(() => {
    if (!csvHeader) return [];
    return SENSOR_MAP.filter((meta) => csvHeader.some((h) => meta.matches(h)));
  }, [csvHeader]);

  // Helpers for conditional Latest rendering
  const hasHdr = (re) =>
    Array.isArray(csvHeader) && csvHeader.some((h) => re.test(h));
  const latestByRegex = (re) => {
    if (!csvHeader) return null;
    const h = csvHeader.find((x) => re.test(x));
    return h ? latest[h] : null;
  };

  useEffect(() => {
    if (!isSupported) return;
    return () => void disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported]);

  // Load saved settings once
  useEffect(() => {
    const savedBaud = Number(localStorage.getItem(LS.BAUD));
    if (Number.isFinite(savedBaud) && savedBaud > 0) setBaudRate(savedBaud);

    const savedNl = localStorage.getItem(LS.NL);
    if (
      savedNl === "none" ||
      savedNl === "\r" ||
      savedNl === "\n" ||
      savedNl === "\r\n"
    ) {
      setAutoNewline(savedNl);
    }

    const savedTab = localStorage.getItem(LS.TAB);
    if (
      savedTab === "latest" ||
      savedTab === "graphs" ||
      savedTab === "settings" ||
      savedTab === "log"
    ) {
      setActiveTab(savedTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist on change
  useEffect(() => {
    localStorage.setItem(LS.BAUD, String(baudRate));
  }, [baudRate]);
  useEffect(() => {
    localStorage.setItem(LS.NL, autoNewline);
  }, [autoNewline]);
  useEffect(() => {
    localStorage.setItem(LS.TAB, activeTab);
  }, [activeTab]);

  // Prefix helper: pulls DeviceId from the current header/latest and sanitizes it
  function getDeviceIdPrefix() {
    try {
      let id = null;
      // Prefer value from whatever header key matches "DeviceId"
      if (csvHeader && Array.isArray(csvHeader)) {
        const key = csvHeader.find((h) => /DeviceId/i.test(h));
        if (key) id = latest?.[key];
      }
      // Fallback to direct field
      if (id == null && latest && latest.DeviceId != null) id = latest.DeviceId;

      const s = String(id ?? "").trim();
      if (!s) return "";
      // Safe for filenames
      const safe = s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
      return safe ? `${safe}_` : "";
    } catch {
      return "";
    }
  }

  // -----------------------------
  // Serial connect / disconnect
  // -----------------------------

  // Export the Raw Serial Log (one column: raw)
  function exportRawLogCsv() {
    const prefix = getDeviceIdPrefix();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const header = "raw";
    const rows = rawLog.map((line) => csvCell(line));
    const csv = [header, ...rows].join("\r\n");
    downloadCsv(`${prefix}_pam_log_${stamp}.csv`, csv);
  }

  // Export the current time-series (wide table: Time + one col per sensor)
  function exportSeriesCsv() {
    // Which sensors are present?
    const sensors = presentSensors.map((m) => m); // copy
    if (!sensors.length) {
      alert("No time-series data to export yet.");
      return;
    }

    // Build a map of t -> value for each sensor
    const mapsByKey = {};
    const allTimes = new Set();
    for (const m of sensors) {
      const arr = series[m.key] || [];
      mapsByKey[m.key] = new Map(arr.map((p) => [p.t, p.v]));
      for (const p of arr) allTimes.add(p.t);
    }
    const times = Array.from(allTimes).sort((a, b) => a - b);

    // Header row: Time, "Label (unit)"...
    const headerCells = [
      "Time",
      ...sensors.map((m) => {
        const withUnit = m.unit ? `${m.label} (${m.unit})` : m.label;
        return csvCell(withUnit);
      }),
    ];
    const rows = [headerCells.join(",")];

    // Body rows
    for (const t of times) {
      const timeIso = new Date(t).toISOString();
      const row = [csvCell(toLocalISO(t))];
      for (const m of sensors) {
        const v = mapsByKey[m.key].get(t);
        row.push(csvCell(v == null ? "" : v));
      }
      rows.push(row.join(","));
    }

    const stamp = localStamp();
    const prefix = getDeviceIdPrefix();
    downloadCsv(`${prefix}pam_${stamp}.csv`, rows.join("\r\n"));
  }

  // Export time-series if present; otherwise export the raw log
  function exportSmartCsv() {
    const hasSeries = presentSensors.some(
      (m) => (series[m.key] || []).length > 0
    );
    if (hasSeries) {
      exportSeriesCsv();
    } else {
      exportRawLogCsv();
    }
  }

  async function connect() {
    try {
      if (!navigator.serial) throw new Error("Web Serial API not available");
      const filters = [{ usbVendorId: 0x10c4 }]; // optional: CP210x filter
      const port = await navigator.serial
        .requestPort({ filters })
        .catch(() => null);
      if (!port) return;

      await port.open({ baudRate, bufferSize: 65536 });
      portRef.current = port;

      // Reader: bytes -> text -> lines
      const textDecoder = new TextDecoderStream();
      port.readable.pipeTo(textDecoder.writable).catch(() => {});
      const lb = new LineBreakTransformer(); // reuse one instance
      const lineStream = textDecoder.readable.pipeThrough(
        new TransformStream({
          start() {},
          transform(chunk, controller) {
            lb.transform(chunk, controller);
          },
          flush(controller) {
            lb.flush(controller);
          },
        })
      );
      readerRef.current = lineStream.getReader();

      // Writer: text -> bytes
      const textEncoder = new TextEncoderStream();
      textEncoder.readable.pipeTo(port.writable).catch(() => {});
      writerRef.current = textEncoder.writable.getWriter();

      setIsConnected(true);
      readLoop();
    } catch (err) {
      console.error(err);
      pushLog(`⚠️ Connect error: ${err.message}`);
      await disconnect();
    }
  }

  async function disconnect() {
    try {
      if (readerRef.current) {
        try {
          await readerRef.current.cancel();
        } catch {}
        readerRef.current = null;
      }
      if (writerRef.current) {
        try {
          await writerRef.current.close();
        } catch {}
        writerRef.current = null;
      }
      if (portRef.current) {
        try {
          await portRef.current.close();
        } catch {}
        portRef.current = null;
      }
    } finally {
      setIsConnected(false);
    }
  }

  function pushLog(line) {
    setRawLog((prev) => {
      const next = [...prev, line];
      if (next.length > 2000) next.splice(0, next.length - 2000);
      return next;
    });
  }

  // -----------------------------
  // Stream read & parse
  // -----------------------------
  async function readLoop() {
    const reader = readerRef.current;
    if (!reader) return;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (typeof value === "string") handleLine(value);
      }
    } catch (err) {
      pushLog(`⚠️ Read error: ${err.message}`);
    }
  }

  function handleLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return;

    // Always log raw for debugging
    pushLog(trimmed);

    // If we don't have a header yet, try to detect one or assume default
    if (!csvHeaderRef.current) {
      // Textual header (with letters/units)
      if (/,/.test(trimmed) && /[A-Za-z]/.test(trimmed)) {
        const tokens = trimmed.split(/\s*,\s*/);
        csvHeaderRef.current = tokens;
        setCsvHeader(tokens);
        return;
      }
      // Numeric row first — assume default if length matches
      if (/,/.test(trimmed) && looksLikeNumericCsv(trimmed)) {
        const cells = trimmed.split(/\s*,\s*/);
        if (cells.length === DEFAULT_HEADER.length) {
          csvHeaderRef.current = DEFAULT_HEADER;
          setCsvHeader(DEFAULT_HEADER);
          // fall through to parse this very row as data
        } else {
          return; // wait for a header or matching-length row
        }
      } else {
        return;
      }
    }

    // Parse data with a known header
    if (trimmed.includes(",")) {
      const hdr = csvHeaderRef.current;
      const cells = trimmed.split(/\s*,\s*/);
      if (cells.length !== hdr.length) {
        // Helpful debug
        console.warn("CSV length mismatch", {
          expected: hdr.length,
          got: cells.length,
          hdr,
          line: trimmed,
        });
        return;
      }

      const row = {};
      for (let i = 0; i < hdr.length; i++) row[hdr[i]] = cells[i] ?? "";

      const nowMs = Date.now();
      const t = buildTimestamp(row, nowMs);

      setLatest((prev) => {
        const next = { ...prev };
        for (const h of hdr) {
          const num = parseMaybeNumber(row[h]);
          next[h] = num ?? row[h] ?? null;
        }
        return next;
      });

      setSeries((prev) => {
        const next = { ...prev };
        for (const meta of SENSOR_MAP) {
          const matchingHeader = hdr.find((h) => meta.matches(h));
          if (!matchingHeader) continue;
          const v = parseMaybeNumber(row[matchingHeader]);
          if (!next[meta.key]) next[meta.key] = [];
          next[meta.key] = [...next[meta.key], { t, v }];
          if (next[meta.key].length > maxPoints) {
            next[meta.key].splice(0, next[meta.key].length - maxPoints);
          }
        }
        return next;
      });
    }
  }

  // -----------------------------
  // Sending commands
  // -----------------------------
  async function send(text) {
    if (!writerRef.current) return;
    setSending(true);
    try {
      const payload = text + (autoNewline === "none" ? "" : autoNewline);
      await writerRef.current.write(payload);
      pushLog(`→ ${JSON.stringify(payload)}`);
    } catch (err) {
      pushLog(`⚠️ Write error: ${err.message}`);
    } finally {
      setSending(false);
    }
  }

  // --- Terminal typing handlers ---
  function handleTerminalKey(e) {
    if (!writerRef.current || !isConnected) return;
    const k = e.key;

    // Printable characters
    if (k.length === 1) {
      e.preventDefault();
      writerRef.current.write(k);
      if (echoInput) pushLog(`→ ${JSON.stringify(k)}`);
      return;
    }
    // Controls
    if (k === "Enter") {
      e.preventDefault();
      const nl = autoNewline === "none" ? "\n" : autoNewline;
      writerRef.current.write(nl);
      if (echoInput) pushLog(`→ ${JSON.stringify(nl)}`);
      return;
    }
    if (k === "Backspace") {
      e.preventDefault();
      writerRef.current.write("\b");
      if (echoInput) pushLog('→ "\\b"');
      return;
    }
    if (k === "Tab") {
      e.preventDefault();
      writerRef.current.write("\t");
      if (echoInput) pushLog('→ "\\t"');
      return;
    }
  }

  function handleTerminalPaste(e) {
    if (!writerRef.current || !isConnected) return;
    const text = e.clipboardData?.getData?.("text");
    if (!text) return;
    e.preventDefault();
    writerRef.current.write(text);
    if (echoInput) pushLog(`→ ${JSON.stringify(text)}`);
  }

  function StatCard({ title, value, unit }) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-sm text-slate-500">{title}</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">
          {value ?? "—"}
          {unit ? (
            <span className="ml-1 align-middle text-base font-normal text-slate-500">
              {unit}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  function ChartCard({ meta, data }) {
    const chartData = useMemo(
      () => (data || []).map((d) => ({ x: d.t, y: d.v })),
      [data]
    );
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-sm font-medium text-slate-700">
          {meta.label}
          {meta.unit ? `  (${meta.unit})` : ""}
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartData}
              margin={{ top: 5, right: 12, bottom: 5, left: 0 }}
            >
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="x" tickFormatter={fmtTime} minTickGap={40} />
              <YAxis allowDecimals tickFormatter={(v) => `${v}`} width={50} />
              <Tooltip
                labelFormatter={(x) => fmtTime(Number(x))}
                formatter={(v) => [v, meta.label]}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="y"
                dot={false}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  }

  // -----------------------------
  // UI
  // -----------------------------
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top Bar */}
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className={`h-3 w-3 rounded-full ${
                  isConnected ? "bg-green-500" : "bg-slate-300"
                }`}
              />
              <h1 className="text-xl font-semibold text-slate-900">
                PAM WebSerial Dashboard
                {deviceId ? (
                  <span className="ml-2 text-base font-normal text-slate-500">
                    · Device {deviceId}
                  </span>
                ) : null}
              </h1>
              {!isSupported && (
                <span className="ml-2 text-sm text-red-600">
                  Web Serial not supported in this browser.
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-slate-600">Baud</label>
              <input
                type="number"
                value={baudRate}
                onChange={(e) => setBaudRate(Number(e.target.value) || 0)}
                className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
              {isConnected ? (
                <button
                  onClick={() => void disconnect()}
                  className="rounded-xl bg-red-600 px-3 py-1.5 text-white shadow hover:bg-red-500"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={() => void connect()}
                  className="rounded-xl bg-blue-600 px-3 py-1.5 text-white shadow hover:bg-blue-500"
                >
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Tabs */}
      <main className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {[
            ["latest", "Latest"],
            ["graphs", "Graphs"],
            ["settings", "Settings"],
            ["log", "Log"],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`rounded-full px-4 py-1.5 text-sm ${
                activeTab === key
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 border border-slate-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === "latest" && (
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="md:col-span-2 lg:col-span-3 mb-2 flex justify-end">
              <button
                onClick={exportSeriesCsv}
                className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
              >
                Save to CSV
              </button>
            </div>
            {/* Device ID + Timestamp only if present */}
            {hasHdr(/DeviceId/i) && (
              <StatCard
                title="Device ID"
                value={latestByRegex(/DeviceId/i) ?? "—"}
              />
            )}
            {(hasHdr(/Date/i) || hasHdr(/Time/i)) && (
              <StatCard
                title="Last Timestamp"
                value={
                  (latestByRegex(/Date/i) || "") +
                    (latestByRegex(/Time/i)
                      ? ` ${latestByRegex(/Time/i)}`
                      : "") || "—"
                }
              />
            )}

            {/* All sensor cards come from the header-driven sensor list */}
            {presentSensors.map((meta) => {
              const h = csvHeader.find((x) => meta.matches(x));
              const v = h ? latest[h] : null;
              return (
                <StatCard
                  key={meta.key}
                  title={meta.label}
                  value={v ?? "—"}
                  unit={meta.unit}
                />
              );
            })}

            {/* Location only if present */}
            {hasHdr(/^LAT/i) && (
              <StatCard
                title="Latitude"
                value={latestByRegex(/^LAT/i) ?? "—"}
              />
            )}
            {hasHdr(/^LON/i) && (
              <StatCard
                title="Longitude"
                value={latestByRegex(/^LON/i) ?? "—"}
              />
            )}
          </section>
        )}

        {/* Graphs */}
        {activeTab === "graphs" && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="lg:col-span-2 mb-2 flex justify-end">
              <button
                onClick={exportSeriesCsv}
                className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
              >
                Save to CSV
              </button>
            </div>
            {presentSensors
              .filter((m) => m.key !== "BAT")
              .map((meta) => {
                const u = unitForMeta(meta, csvHeader);
                return (
                  <ChartCard
                    key={meta.key}
                    meta={{ ...meta, unit: u }}
                    data={series[meta.key] || []}
                  />
                );
              })}
          </section>
        )}

        {/* Settings */}
        {activeTab === "settings" && (
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Serial options */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium text-slate-700">
                Serial Options
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm">Auto newline:</label>
                <select
                  value={autoNewline}
                  onChange={(e) => setAutoNewline(e.target.value)}
                  className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
                >
                  <option value="none">(none)</option>
                  <option value="\r">CR (\r)</option>
                  <option value="\n">LF (\n)</option>
                  <option value="\r\n">CRLF (\r\n)</option>
                </select>
                <button
                  onClick={() => {
                    setBaudRate(115200);
                    setAutoNewline("\r");
                    setActiveTab("latest");
                    localStorage.removeItem(LS.BAUD);
                    localStorage.removeItem(LS.NL);
                    localStorage.removeItem(LS.TAB);
                  }}
                  className="mt-3 rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  Reset Saved Settings
                </button>
              </div>

              <button
                onClick={() => {
                  csvHeaderRef.current = DEFAULT_HEADER;
                  setCsvHeader(DEFAULT_HEADER);
                  pushLog("Assumed default header");
                }}
                className="mt-3 rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
              >
                Assume Default Header
              </button>

              <div className="mt-3 flex gap-2">
                <input
                  type="text"
                  placeholder="Paste custom header CSV"
                  value={customHeaderText}
                  onChange={(e) => setCustomHeaderText(e.target.value)}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
                <button
                  onClick={() => {
                    const tokens = (customHeaderText || "")
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    if (tokens.length) {
                      csvHeaderRef.current = tokens;
                      setCsvHeader(tokens);
                      pushLog("Custom header set");
                    }
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  Set Header
                </button>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Tip: PAM menu commands are single letters (e.g., <code>m</code>{" "}
                to open menu, <code>k</code> for header, <code>x</code> to
                exit).
              </p>
            </div>
          </section>
        )}

        {/* Log */}
        {activeTab === "log" && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-700">
                Raw Serial Log
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={echoInput}
                    onChange={(e) => setEchoInput(e.target.checked)}
                  />
                  Echo typed input in log
                </label>
                <button
                  onClick={() => setRawLog([])}
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  Clear
                </button>
                <button
                  onClick={() =>
                    navigator.clipboard.writeText(rawLog.join("\n"))
                  }
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  Copy
                </button>

                <button
                  onClick={exportSmartCsv}
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  SaveToCSV
                </button>
              </div>
            </div>

            <pre
              ref={logRef}
              tabIndex={0}
              onKeyDown={handleTerminalKey}
              onPaste={handleTerminalPaste}
              className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-xs text-slate-700 outline-none focus:ring-2 focus:ring-blue-200 rounded-lg p-2"
              title="Click here and type to send characters to the device"
            >
              {rawLog.join("\n")}
            </pre>
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 pt-4 text-center text-xs text-slate-500">
        <p>
          Tip: A new data line typically appears every 3–4 s (or ~12–15 s if NO₂
          is present). Use the "Header" quick command to capture column labels
          if they don’t appear automatically.
        </p>
      </footer>
    </div>
  );
}

// -----------------------------
// Utilities
// -----------------------------
function latestFind(header, latest, pattern) {
  if (!header) return null;
  const h = header.find((x) => pattern.test(x));
  if (!h) return null;
  const val = latest[h];
  if (val == null) return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  return val;
}

// --- CSV helpers ---
// ---- Local time helpers ----
function pad2(n) {
  return String(n).padStart(2, "0");
}
function pad3(n) {
  return String(n).padStart(3, "0");
}

function tzOffsetString(d) {
  // minutes *east* of UTC (positive = ahead)
  const off = -d.getTimezoneOffset(); // JS gives minutes *west*, invert
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const hh = pad2(Math.floor(abs / 60));
  const mm = pad2(abs % 60);
  return `${sign}${hh}:${mm}`;
}

// For filenames (no colons), e.g. 2025-09-22T14-07-03-123
function localStamp() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(
      d.getSeconds()
    )}-${pad3(d.getMilliseconds())}`
  );
}

// For CSV cells (ISO-like local with offset), e.g. 2025-09-22T14:07:03.123-06:00
function toLocalISO(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(
      d.getSeconds()
    )}.${pad3(d.getMilliseconds())}` +
    tzOffsetString(d)
  );
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, csvString) {
  // Prepend UTF-8 BOM so Excel opens the file with the right encoding
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
  const blob = new Blob([BOM, csvString], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
