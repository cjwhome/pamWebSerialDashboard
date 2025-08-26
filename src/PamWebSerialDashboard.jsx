import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

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
  { key: "PM1",   matches: (h) => /\bPM1\b/i.test(h),   label: "PM1", unit: "µg/m³" },
  { key: "PM2_5", matches: (h) => /PM2\.5/i.test(h),    label: "PM2.5", unit: "µg/m³" },
  { key: "PM10",  matches: (h) => /\bPM10\b/i.test(h),  label: "PM10", unit: "µg/m³" },
  { key: "NO2",   matches: (h) => /\bNO2\b/i.test(h),   label: "NO₂", unit: "ppb" },
  { key: "CO",    matches: (h) => /\bCO\b/i.test(h),    label: "CO", unit: "ppb" },
  { key: "CO2",   matches: (h) => /\bCO2\b/i.test(h),   label: "CO₂", unit: "ppm" },
  { key: "TVOC",  matches: (h) => /TVOC/i.test(h),      label: "TVOCs", unit: "ppb" },
  { key: "RH",    matches: (h) => /RELH|RH\b/i.test(h), label: "Relative Humidity", unit: "%" },
  { key: "TEMP",  matches: (h) => /TEMP\b/i.test(h),    label: "Temperature", unit: "°C" },
  { key: "PRESS", matches: (h) => /PRESS\b/i.test(h),   label: "Pressure", unit: "hPa" },
  { key: "CH4",   matches: (h) => /METHANE|CH4/i.test(h), label: "Methane", unit: "ppm" },
  { key: "BAT",   matches: (h) => /Battery/i.test(h),   label: "Battery", unit: "%" },
];

// Fallback when the device streams numeric rows without a header
const DEFAULT_HEADER = [
  "DeviceId","PM1(UGM3)","PM2.5(UGM3)","PM10(UGM3)","TVOC(PPB)","CO2(PPM)","RELHUM(%)","TEMP(C)",
  "PRESS(MBAR)","LAT(LAT)","LON(LON)","Battery(%)","Date","Time"
];
const looksLikeNumericCsv = (line) => /^[0-9 .,:\-]+$/.test(String(line));

// -----------------------------
// Line splitter (bytes -> text lines)
// -----------------------------
class LineBreakTransformer {
  constructor() { this.container = ""; }
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
function fmtTime(ms) { return new Date(ms).toLocaleTimeString(); }

// -----------------------------
// Component
// -----------------------------
export default function PamWebSerialDashboard() {
  const readerRef = useRef(null);
  const writerRef = useRef(null);
  const portRef   = useRef(null);

  // State
  const [isSupported] = useState(() => typeof navigator !== "undefined" && navigator.serial);
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

  // Refs to avoid stale closures in the stream loop
  const csvHeaderRef = useRef(null);
  const latestRef = useRef({});
  const seriesRef = useRef({});

  useEffect(() => { csvHeaderRef.current = csvHeader; }, [csvHeader]);
  useEffect(() => { latestRef.current = latest; }, [latest]);
  useEffect(() => { seriesRef.current = series; }, [series]);

  const presentSensors = useMemo(() => {
    if (!csvHeader) return [];
    return SENSOR_MAP.filter((meta) => csvHeader.some((h) => meta.matches(h)));
  }, [csvHeader]);

  useEffect(() => {
    if (!isSupported) return;
    return () => void disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported]);

  // -----------------------------
  // Serial connect / disconnect
  // -----------------------------
  async function connect() {
    try {
      if (!navigator.serial) throw new Error("Web Serial API not available");
      const filters = [{ usbVendorId: 0x10c4 }]; // optional: CP210x filter
      const port = await navigator.serial.requestPort({ filters }).catch(() => null);
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
          transform(chunk, controller) { lb.transform(chunk, controller); },
          flush(controller) { lb.flush(controller); },
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
      if (readerRef.current) { try { await readerRef.current.cancel(); } catch {} readerRef.current = null; }
      if (writerRef.current) { try { await writerRef.current.close(); } catch {} writerRef.current = null; }
      if (portRef.current)   { try { await portRef.current.close(); } catch {} portRef.current = null; }
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
        console.warn("CSV length mismatch", { expected: hdr.length, got: cells.length, hdr, line: trimmed });
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

  function QuickCmd({ label, cmd, confirm }) {
    return (
      <button
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          void send(cmd);
        }}
        className="px-3 py-1.5 rounded-xl bg-slate-800 text-white hover:bg-slate-700 text-sm"
      >
        {label}
      </button>
    );
  }

  function StatCard({ title, value, unit }) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="text-sm text-slate-500">{title}</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">
          {value ?? "—"}
          {unit ? <span className="ml-1 align-middle text-base font-normal text-slate-500">{unit}</span> : null}
        </div>
      </div>
    );
  }

  function ChartCard({ meta, data }) {
    const chartData = useMemo(() => (data || []).map((d) => ({ x: d.t, y: d.v })), [data]);
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="mb-2 text-sm font-medium text-slate-700">
          {meta.label}{meta.unit ? `  (${meta.unit})` : ""}
        </div>
        <div className="h-48">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 12, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="x" tickFormatter={fmtTime} minTickGap={40} />
              <YAxis allowDecimals tickFormatter={(v) => `${v}`} width={50} />
              <Tooltip labelFormatter={(x) => fmtTime(Number(x))} formatter={(v) => [v, meta.label]} />
              <Legend />
              <Line type="monotone" dataKey="y" dot={false} strokeWidth={2} isAnimationActive={false} />
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
              <div className={`h-3 w-3 rounded-full ${isConnected ? "bg-green-500" : "bg-slate-300"}`} />
              <h1 className="text-xl font-semibold text-slate-900">PAM WebSerial Dashboard</h1>
              {!isSupported && <span className="ml-2 text-sm text-red-600">Web Serial not supported in this browser.</span>}
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
                <button onClick={() => void disconnect()} className="rounded-xl bg-red-600 px-3 py-1.5 text-white shadow hover:bg-red-500">
                  Disconnect
                </button>
              ) : (
                <button onClick={() => void connect()} className="rounded-xl bg-blue-600 px-3 py-1.5 text-white shadow hover:bg-blue-500">
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
          {([["latest","Latest"],["graphs","Graphs"],["settings","Settings"],["log","Log"]]).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`rounded-full px-4 py-1.5 text-sm ${activeTab === key ? "bg-slate-900 text-white" : "bg-white text-slate-700 border border-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Latest */}
        {activeTab === "latest" && (
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            <StatCard title="Device ID" value={latestFind(csvHeader, latest, /DeviceId/i)} />
            <StatCard
              title="Last Timestamp"
              value={
                ((latestFind(csvHeader, latest, /Date/i) || "") +
                (latestFind(csvHeader, latest, /Time/i) ? " " + latestFind(csvHeader, latest, /Time/i) : "")) || "—"
              }
            />
            <StatCard title="Battery" value={latestFind(csvHeader, latest, /Battery/i)} unit="%" />

            <StatCard title="Temperature" value={latestFind(csvHeader, latest, /TEMP\b/i)} unit="°C" />
            <StatCard title="Humidity" value={latestFind(csvHeader, latest, /RELH|RH\b/i)} unit="%" />
            <StatCard title="Pressure" value={latestFind(csvHeader, latest, /PRESS\b/i)} unit="hPa" />

            <StatCard title="PM1" value={latestFind(csvHeader, latest, /\bPM1\b/i)} unit="µg/m³" />
            <StatCard title="PM2.5" value={latestFind(csvHeader, latest, /PM2\.5/i)} unit="µg/m³" />
            <StatCard title="PM10" value={latestFind(csvHeader, latest, /\bPM10\b/i)} unit="µg/m³" />

            <StatCard title="NO₂" value={latestFind(csvHeader, latest, /\bNO2\b/i)} unit="ppb" />
            <StatCard title="CO" value={latestFind(csvHeader, latest, /\bCO\b/i)} unit="ppb" />
            <StatCard title="CO₂" value={latestFind(csvHeader, latest, /\bCO2\b/i)} unit="ppm" />
            <StatCard title="TVOCs" value={latestFind(csvHeader, latest, /TVOC/i)} unit="ppb" />

            <StatCard title="Latitude"  value={latestFind(csvHeader, latest, /^LAT/i) ?? latest["LAT(LAT)"] ?? latest["LAT"]} />
            <StatCard title="Longitude" value={latestFind(csvHeader, latest, /^LON/i) ?? latest["LON(LON)"] ?? latest["LON"]} />
          </section>
        )}

        {/* Graphs */}
        {activeTab === "graphs" && (
          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {presentSensors.filter((m) => m.key !== "BAT").map((meta) => (
              <ChartCard key={meta.key} meta={meta} data={series[meta.key] || []} />
            ))}
          </section>
        )}

        {/* Settings */}
        {activeTab === "settings" && (
          <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Serial options */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium text-slate-700">Serial Options</div>
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
              </div>

              <button
                onClick={() => { csvHeaderRef.current = DEFAULT_HEADER; setCsvHeader(DEFAULT_HEADER); pushLog("Assumed default header"); }}
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
                    const tokens = (customHeaderText || "").split(",").map(s => s.trim()).filter(Boolean);
                    if (tokens.length) { csvHeaderRef.current = tokens; setCsvHeader(tokens); pushLog("Custom header set"); }
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  Set Header
                </button>
              </div>

              <p className="mt-2 text-xs text-slate-500">
                Tip: PAM menu commands are single letters (e.g., <code>m</code> to open menu, <code>k</code> for header, <code>x</code> to exit).
              </p>
            </div>

            {/* Quick commands */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium text-slate-700">Quick Menu</div>
              <div className="flex flex-wrap gap-2">
                <QuickCmd label="Menu (m)" cmd="m" />
                <QuickCmd label="Help (?)" cmd="?" />
                <QuickCmd label="Header (k)" cmd="k" />
                <QuickCmd label="Exit (x)" cmd="x" />
                <QuickCmd label="Toggle Cellular (d)" cmd="d" />
                <QuickCmd label="Toggle Wi-Fi (g)" cmd="g" />
                <QuickCmd label="Restart (u)" cmd="u" confirm="Restart ESP now?" />
                <QuickCmd label="List SD (p)" cmd="p" />
                <QuickCmd label="Delete on SD (q)" cmd="q" />
              </div>
              <p className="mt-3 text-xs text-slate-500">
                For device-specific settings, use <strong>a</strong> (Devices) then the appropriate sub-menu for slope/zero/enable.
              </p>
            </div>

            {/* Custom command */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-medium text-slate-700">Send Raw Command</div>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customCmd}
                  onChange={(e) => setCustomCmd(e.target.value)}
                  placeholder="e.g., m  or  k  or  a"
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                />
                <button
                  disabled={!isConnected || sending || !customCmd}
                  onClick={() => void send(customCmd)}
                  className="rounded-xl bg-slate-900 px-3 py-1.5 text-white disabled:opacity-50"
                >
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">Your configured newline (above) will be appended automatically.</p>
            </div>
          </section>
        )}

        {/* Log */}
        {activeTab === "log" && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-medium text-slate-700">Raw Serial Log</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setRawLog([])}
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  Clear
                </button>
                <button
                  onClick={() => navigator.clipboard.writeText(rawLog.join("\n"))}
                  className="rounded-lg border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
                >
                  Copy
                </button>
              </div>
            </div>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-xs text-slate-700">
{rawLog.join("\n")}
            </pre>
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-7xl px-4 pb-8 pt-4 text-center text-xs text-slate-500">
        <p>
          Tip: A new data line typically appears every 3–4 s (or ~12–15 s if NO₂ is present). Use the "Header" quick command
          to capture column labels if they don’t appear automatically.
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
