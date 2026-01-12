import { useEffect, useMemo, useState } from "react";
import dagre from "dagre";
import { API_BASE } from "./config";

/**
 * MSP Lite UI — App.jsx (updated)
 * Adds:
 * 1) Recalculate loading overlay + spinner
 * 2) More formal UI styling (cards, buttons, table polish)
 * Keeps:
 * - Response-shape tolerance
 * - ID normalization
 * - Dependency-field tolerance
 */

export default function App() {
  const [projectId, setProjectId] = useState("1");
  const [loading, setLoading] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [error, setError] = useState("");

  const [schedule, setSchedule] = useState(null);
  const [deps, setDeps] = useState([]);

  // toggles
  const [showNetwork, setShowNetwork] = useState(false);
  const [showGantt, setShowGantt] = useState(true);

  // Normalize IDs as strings for consistent Map lookups
  const normId = (v) => (v == null ? null : String(v));

  // Your API returns tasks + version at the ROOT (not inside project)
  const tasks =
    schedule?.tasks ??
    schedule?.project?.tasks ?? // tolerance if backend changes later
    schedule?.Tasks ??
    schedule?.project?.Tasks ??
    [];

  const version =
    schedule?.version ??
    schedule?.project?.version ?? // tolerance
    schedule?.Version ??
    schedule?.project?.Version ??
    null;

  const criticalCount = useMemo(() => {
    return (tasks || []).filter((t) => t.IsCritical === 1 || t.IsCritical === true).length;
  }, [tasks]);

  const taskById = useMemo(() => {
    const m = new Map();
    for (const t of tasks || []) m.set(normId(t.TaskId), t);
    return m;
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  /** =========================
   *  Dependency field tolerance
   *  ========================= */
  const getPredId = (d) =>
    d.PredecessorTaskId ??
    d.PredecessorTaskID ??
    d.predecessorTaskId ??
    d.predecessorTaskID ??
    d.PredecessorId ??
    d.predecessorId ??
    d.predTaskId ??
    d.predId;

  const getSuccId = (d) =>
    d.SuccessorTaskId ??
    d.SuccessorTaskID ??
    d.successorTaskId ??
    d.successorTaskID ??
    d.SuccessorId ??
    d.successorId ??
    d.succTaskId ??
    d.succId;

  // IMPORTANT: do NOT create synthetic IDs like dep_${i}
  const getDepId = (d) => {
    const raw =
      d.TaskDependencyId ??
      d.TaskDependencyID ??
      d.taskDependencyId ??
      d.taskDependencyID ??
      d.DependencyId ??
      d.dependencyId;

    const n = Number(raw);
    return Number.isFinite(n) ? n : null; // null if missing
  };

  // DB column: LinkType, but tolerate older names
  const getType = (d) =>
    String(
      d.LinkType ??
        d.linkType ??
        d.DependencyType ??
        d.dependencyType ??
        d.Type ??
        d.type ??
        "FS"
    ).toUpperCase();

  const getLag = (d) => {
    const v = d.LagDays ?? d.lagDays ?? d.Lag ?? d.lag ?? 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  // Map successor -> deps
  const depsBySuccessor = useMemo(() => {
    const m = new Map();
    (deps || []).forEach((d) => {
      const succ = normId(getSuccId(d));
      if (succ == null) return;

      const arr = m.get(succ) || [];
      arr.push({ ...d, __id: getDepId(d) }); // depId can be null
      m.set(succ, arr);
    });
    return m;
  }, [deps]); // eslint-disable-line react-hooks/exhaustive-deps

  /** =========================
   *  Fetch helpers (NO CACHE)
   *  ========================= */
  async function safeJson(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        ...(options.headers || {}),
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    const json = await safeJson(res);
    return { res, json };
  }

  /** =========================
   *  Load / Recalc / Updates
   *  ========================= */
  async function loadAll() {
    setError("");
    setLoading(true);
    try {
      const bust = Date.now();

      const [sch, dep] = await Promise.all([
        fetchJson(
          `${API_BASE}/getSchedule?projectId=${encodeURIComponent(
            projectId
          )}&versionId=latest&t=${bust}`
        ),
        fetchJson(`${API_BASE}/getDependencies?projectId=${encodeURIComponent(projectId)}&t=${bust}`),
      ]);

      if (!sch.res.ok || !sch.json?.ok) {
        throw new Error(sch.json?.error || "Failed to load schedule");
      }
      if (!dep.res.ok || !dep.json?.ok) {
        throw new Error(dep.json?.error || "Failed to load dependencies");
      }

      // ✅ Schedule payload tolerance:
      // Most common: sch.json = { ok:true, project:{...}, tasks:[...], version:{...} }
      setSchedule(sch.json);

      // ✅ Deps payload tolerance:
      const depsPayload =
        dep.json?.dependencies ??
        dep.json?.deps ??
        dep.json?.project?.dependencies ??
        dep.json?.project?.deps ??
        dep.json?.data ??
        [];

      setDeps(Array.isArray(depsPayload) ? depsPayload : []);
    } catch (e) {
      setError(e.message || String(e));
      setSchedule(null);
      setDeps([]);
    } finally {
      setLoading(false);
    }
  }

  async function recalcOnly() {
    const { res, json } = await fetchJson(
      `${API_BASE}/recalculate?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`,
      { method: "POST" }
    );
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Recalculate failed");
    return json;
  }

  async function recalcAndReload() {
    setError("");
    setIsRecalculating(true);
    setLoading(true);
    try {
      await recalcOnly();
      await loadAll();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setIsRecalculating(false);
      setLoading(false);
    }
  }

  async function updateDuration(taskId, durationDays) {
    const { res, json } = await fetchJson(`${API_BASE}/updateTask?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, durationDays }),
    });
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Duration update failed");
  }

  async function updateDependency(taskDependencyId, linkType, lagDays) {
    const idNum = Number(taskDependencyId);
    if (!Number.isFinite(idNum)) {
      throw new Error("Invalid TaskDependencyId (API is not returning it).");
    }

    const type = String(linkType || "FS").toUpperCase();
    const lagNum = Number.isFinite(Number(lagDays)) ? Number(lagDays) : 0;

    const { res, json } = await fetchJson(`${API_BASE}/updateDependency?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskDependencyId: idNum,
        linkType: type,
        LinkType: type,
        lagDays: lagNum,
        LagDays: lagNum,
      }),
    });

    if (!res.ok || !json?.ok) throw new Error(json?.error || "Dependency update failed");
  }

  async function deleteDependency(taskDependencyId) {
    const idNum = Number(taskDependencyId);
    if (!Number.isFinite(idNum)) throw new Error("Invalid TaskDependencyId.");

    const { res, json } = await fetchJson(`${API_BASE}/deleteDependency?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskDependencyId: idNum }),
    });

    if (!res.ok || !json?.ok) throw new Error(json?.error || "Delete dependency failed");
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** =========================
   *  Styling helpers
   *  ========================= */
  const btn = {
    padding: "8px 12px",
    borderRadius: 10,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#0f172a",
    fontWeight: 700,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  };

  const btnPrimary = {
    ...btn,
    background: "#0f172a",
    color: "#ffffff",
    border: "1px solid #0f172a",
  };

  const btnDisabled = {
    opacity: 0.55,
    cursor: "not-allowed",
  };

  const inputStyle = {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    outline: "none",
  };

  /** =========================
   *  UI
   *  ========================= */
  return (
    <div
      style={{
        padding: 24,
        fontFamily:
          'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", sans-serif',
        maxWidth: 1600,
        margin: "0 auto",
        color: "#0f172a",
        background: "#f8fafc",
        minHeight: "100vh",
      }}
    >
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      {isRecalculating && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              padding: "16px 18px",
              minWidth: 340,
              boxShadow: "0 10px 25px rgba(0,0,0,0.12)",
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <Spinner size={18} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontWeight: 800, color: "#0f172a" }}>Recalculating schedule</div>
              <div style={{ fontSize: 12, color: "#475569" }}>
                Computing ES/EF/LS/LF, float, and critical path…
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 900 }}>MSP Lite UI</div>
        <div style={{ fontSize: 12, color: "#475569" }}>
          Schedule viewer and editor for Duration and Dependency attributes
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          padding: 12,
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
          Project ID
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            style={{ ...inputStyle, width: 90 }}
          />
        </label>

        <button onClick={loadAll} disabled={loading} style={{ ...btn, ...(loading ? btnDisabled : {}) }}>
          {loading && !isRecalculating ? (
            <>
              <Spinner size={14} /> Loading
            </>
          ) : (
            "Load"
          )}
        </button>

        <button
          onClick={recalcAndReload}
          disabled={loading}
          style={{ ...btnPrimary, ...(loading ? btnDisabled : {}) }}
        >
          {isRecalculating ? (
            <>
              <Spinner size={14} /> Recalculating
            </>
          ) : (
            "Recalculate"
          )}
        </button>

        <button
          onClick={() => setShowNetwork((v) => !v)}
          disabled={loading || tasks.length === 0}
          style={{ ...btn, ...((loading || tasks.length === 0) ? btnDisabled : {}) }}
        >
          {showNetwork ? "Hide Network Diagram" : "Show Network Diagram"}
        </button>

        <button
          onClick={() => setShowGantt((v) => !v)}
          disabled={loading || tasks.length === 0}
          style={{ ...btn, ...((loading || tasks.length === 0) ? btnDisabled : {}) }}
        >
          {showGantt ? "Hide Gantt Chart" : "Show Gantt Chart"}
        </button>

        {version && (
          <div style={{ marginLeft: "auto", fontSize: 12, color: "#334155", fontWeight: 700 }}>
            Version {version.versionNo} &nbsp;|&nbsp; Finish Day {version.projectFinishDay} &nbsp;|&nbsp;
            Critical {criticalCount}/{tasks.length}
          </div>
        )}
      </div>

      {error && (
        <div
          style={{
            marginTop: 12,
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            padding: "10px 12px",
            borderRadius: 12,
            fontWeight: 700,
          }}
        >
          Error: {error}
        </div>
      )}

      <div style={{ marginTop: 10, color: "#475569", fontSize: 12, fontWeight: 700 }}>
        Tasks: {tasks.length} &nbsp;|&nbsp; Dependencies: {deps.length}
      </div>

      {showNetwork && tasks.length > 0 && (
        <NetworkDiagram
          tasks={tasks}
          deps={deps}
          getPredId={getPredId}
          getSuccId={getSuccId}
          getDepId={getDepId}
          getLag={getLag}
          getType={getType}
        />
      )}

      {showGantt && tasks.length > 0 && (
        <GanttLiteLinked
          tasks={tasks}
          deps={deps}
          getPredId={getPredId}
          getSuccId={getSuccId}
          getDepId={getDepId}
        />
      )}

      <div style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>Task Table</div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
          }}
        >
          <table
            style={{
              width: "100%",
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: 13,
            }}
          >
            <thead style={{ background: "#f1f5f9" }}>
              <tr>
                {[
                  "Workstream",
                  "Task",
                  "Dur",
                  "ES",
                  "EF",
                  "LS",
                  "LF",
                  "Float",
                  "Critical",
                  "Dependencies (Edit Type + Lag)",
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "10px 10px",
                      borderBottom: "1px solid #e2e8f0",
                      fontWeight: 900,
                      color: "#0f172a",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {tasks.map((t, idx) => (
                <TaskRow
                  key={normId(t.TaskId)}
                  rowIndex={idx}
                  task={t}
                  taskById={taskById}
                  depsForTask={depsBySuccessor.get(normId(t.TaskId)) || []}
                  disabled={loading}
                  getDepId={getDepId}
                  getPredId={getPredId}
                  getLag={getLag}
                  getType={getType}
                  onSaveDuration={async (newDur) => {
                    setError("");
                    setLoading(true);
                    try {
                      await updateDuration(t.TaskId, newDur);
                      await recalcAndReload();
                    } catch (e) {
                      setError(e.message || String(e));
                    } finally {
                      setLoading(false);
                    }
                  }}
                  onUpdateDep={async (depId, type, lag) => {
                    setError("");
                    setLoading(true);
                    try {
                      await updateDependency(depId, type, lag);
                      await recalcAndReload();
                    } catch (e) {
                      setError(e.message || String(e));
                    } finally {
                      setLoading(false);
                    }
                  }}
                  onRemoveDep={async (depId) => {
                    setError("");
                    setLoading(true);
                    try {
                      await deleteDependency(depId);
                      await recalcAndReload();
                    } catch (e) {
                      setError(e.message || String(e));
                    } finally {
                      setLoading(false);
                    }
                  }}
                />
              ))}

              {tasks.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ padding: 14, color: "#475569" }}>
                    No tasks found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 12, color: "#475569", fontSize: 12 }}>
          Note: ES/EF/LS/LF/Float/Critical are computed. Edit only Duration and existing Dependencies
          (Type/Lag). No “Add Dependency” is provided.
        </div>
      </div>
    </div>
  );
}

/** =========================
 *  Spinner
 *  ========================= */
function Spinner({ size = 18 }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "2px solid #cbd5e1",
        borderTopColor: "#0f172a",
        display: "inline-block",
        animation: "spin 0.8s linear infinite",
        flex: "0 0 auto",
      }}
    />
  );
}

/** =========================
 *  Task Table Row
 *  ========================= */
function TaskRow({
  rowIndex,
  task,
  taskById,
  depsForTask,
  disabled,
  getDepId,
  getPredId,
  getLag,
  getType,
  onSaveDuration,
  onUpdateDep,
  onRemoveDep,
}) {
  const isCrit = task.IsCritical === 1 || task.IsCritical === true;
  const [dur, setDur] = useState(task.DurationDays ?? "");

  useEffect(() => setDur(task.DurationDays ?? ""), [task.DurationDays]);

  const rowBg = rowIndex % 2 === 0 ? "#ffffff" : "#fbfdff";
  const critBg = "#fff7ed";

  return (
    <tr style={{ background: isCrit ? critBg : rowBg }}>
      <td style={cell()}>{task.Workstream ?? ""}</td>
      <td style={cell({ fontWeight: 800 })}>{task.TaskName ?? ""}</td>

      <td style={cell()}>
        <input
          style={{
            width: 70,
            padding: "6px 8px",
            borderRadius: 10,
            border: "1px solid #cbd5e1",
            outline: "none",
          }}
          value={dur}
          onChange={(e) => setDur(e.target.value)}
          disabled={disabled}
        />
        <button
          style={{
            marginLeft: 8,
            padding: "6px 10px",
            borderRadius: 10,
            border: "1px solid #cbd5e1",
            background: "#0f172a",
            color: "#fff",
            fontWeight: 800,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.55 : 1,
          }}
          onClick={() => onSaveDuration(dur === "" ? 0 : Number(dur))}
          disabled={disabled}
        >
          Save
        </button>
      </td>

      <td style={cell()}>{task.ES ?? ""}</td>
      <td style={cell()}>{task.EF ?? ""}</td>
      <td style={cell()}>{task.LS ?? ""}</td>
      <td style={cell()}>{task.LF ?? ""}</td>
      <td style={cell()}>{task.TotalFloat ?? ""}</td>
      <td style={cell({ fontWeight: 900, color: isCrit ? "#b45309" : "#0f172a" })}>
        {isCrit ? "YES" : ""}
      </td>

      <td style={cell({ minWidth: 420 })}>
        {depsForTask.length === 0 ? (
          <span style={{ color: "#64748b" }}>(none)</span>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {depsForTask.map((d) => {
              const depId = d.__id ?? getDepId(d); // numeric or null
              const predIdRaw = getPredId(d);
              const pred = taskById.get(predIdRaw == null ? null : String(predIdRaw));
              const predName = pred
                ? `${pred.Workstream} - ${pred.TaskName}`
                : String(predIdRaw ?? "");

              return (
                <DepEditor
                  key={String(depId ?? `${predIdRaw}_${Math.random()}`)}
                  depId={depId}
                  predName={predName}
                  initialType={getType(d)}
                  initialLag={getLag(d)}
                  disabled={disabled}
                  onUpdate={onUpdateDep}
                  onRemove={onRemoveDep}
                />
              );
            })}
          </ul>
        )}
      </td>
    </tr>
  );
}

function cell(extra = {}) {
  return {
    padding: "10px 10px",
    borderBottom: "1px solid #eef2f7",
    verticalAlign: "top",
    color: "#0f172a",
    ...extra,
  };
}

function DepEditor({ depId, predName, initialType, initialLag, disabled, onUpdate, onRemove }) {
  const [type, setType] = useState((initialType || "FS").toUpperCase());
  const [lag, setLag] = useState(String(initialLag ?? 0));

  useEffect(() => setType((initialType || "FS").toUpperCase()), [initialType]);
  useEffect(() => setLag(String(initialLag ?? 0)), [initialLag]);

  const canEdit = Number.isFinite(Number(depId));

  const selectStyle = {
    padding: "6px 8px",
    borderRadius: 10,
    border: "1px solid #cbd5e1",
    background: "#fff",
    outline: "none",
  };

  const inputStyle = {
    width: 70,
    marginLeft: 8,
    padding: "6px 8px",
    borderRadius: 10,
    border: "1px solid #cbd5e1",
    outline: "none",
  };

  const btnMini = {
    marginLeft: 8,
    padding: "6px 10px",
    borderRadius: 10,
    border: "1px solid #cbd5e1",
    background: "#ffffff",
    color: "#0f172a",
    fontWeight: 800,
    cursor: disabled || !canEdit ? "not-allowed" : "pointer",
    opacity: disabled || !canEdit ? 0.55 : 1,
  };

  const btnDanger = {
    ...btnMini,
    background: "#fef2f2",
    border: "1px solid #fecaca",
    color: "#991b1b",
  };

  return (
    <li style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <span style={{ display: "inline-block", minWidth: 260, fontWeight: 700, color: "#0f172a" }}>
          {predName}
        </span>

        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          disabled={disabled || !canEdit}
          style={selectStyle}
        >
          <option value="FS">FS</option>
          <option value="SS">SS</option>
          <option value="FF">FF</option>
          <option value="SF">SF</option>
        </select>

        <input
          style={inputStyle}
          value={lag}
          onChange={(e) => setLag(e.target.value)}
          disabled={disabled || !canEdit}
          placeholder="lag"
        />

        <button
          style={{ ...btnMini, background: "#0f172a", color: "#fff", border: "1px solid #0f172a" }}
          onClick={() => onUpdate(depId, type, lag === "" ? 0 : Number(lag))}
          disabled={disabled || !canEdit}
        >
          Update
        </button>

        <button style={btnDanger} onClick={() => onRemove(depId)} disabled={disabled || !canEdit}>
          Remove
        </button>

        {!canEdit && (
          <span style={{ marginLeft: 6, color: "#b91c1c", fontSize: 12, fontWeight: 800 }}>
            Missing TaskDependencyId in getDependencies API
          </span>
        )}
      </div>
    </li>
  );
}

/** =========================
 *  Gantt (Linked)
 *  ========================= */
function GanttLiteLinked({ tasks, deps, getPredId, getSuccId, getDepId }) {
  const normId = (v) => (v == null ? null : String(v));

  const valid = (tasks || [])
    .map((t) => ({
      ...t,
      ES: Number.isFinite(Number(t.ES)) ? Number(t.ES) : 0,
      EF: Number.isFinite(Number(t.EF)) ? Number(t.EF) : 0,
    }))
    .map((t) => ({ ...t, EF: t.EF < t.ES ? t.ES : t.EF }));

  if (!valid.length) return null;

  const PX_PER_DAY = 10;
  const LEFT_COL_W = 400;
  const ROW_H = 30;
  const BAR_H = 14;
  const BAR_TOP_OFFSET = (ROW_H - BAR_H) / 2;
  const HEADER_H = 28;

  const minStart = Math.min(...valid.map((t) => t.ES));
  const maxFinish = Math.max(...valid.map((t) => t.EF));
  const totalDays = Math.max(1, maxFinish - minStart);
  const timelineW = totalDays * PX_PER_DAY;

  const rowIndexByTaskId = new Map();
  valid.forEach((t, idx) => rowIndexByTaskId.set(normId(t.TaskId), idx));
  const taskById = new Map(valid.map((t) => [normId(t.TaskId), t]));

  const barXStart = (task) => LEFT_COL_W + (task.ES - minStart) * PX_PER_DAY;
  const barXEnd = (task) => LEFT_COL_W + (task.EF - minStart) * PX_PER_DAY;
  const barMidY = (task) => {
    const idx = rowIndexByTaskId.get(normId(task.TaskId)) ?? 0;
    return HEADER_H + idx * ROW_H + BAR_TOP_OFFSET + BAR_H / 2;
  };

  const links = (deps || [])
    .map((d) => ({
      id: getDepId(d) ?? `skip_${Math.random()}`,
      predId: normId(getPredId(d)),
      succId: normId(getSuccId(d)),
    }))
    .filter((l) => l.predId != null && l.succId != null)
    .filter((l) => taskById.has(l.predId) && taskById.has(l.succId))
    .map((l) => ({ id: l.id, pred: taskById.get(l.predId), succ: taskById.get(l.succId) }));

  const canvasH = HEADER_H + valid.length * ROW_H;
  const canvasW = LEFT_COL_W + timelineW;

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontWeight: 900, marginBottom: 10 }}>
        Gantt (Linked) — Links: {links.length}
      </div>

      <div
        style={{
          overflowX: "auto",
          border: "1px solid #e2e8f0",
          background: "#ffffff",
          borderRadius: 12,
          padding: 12,
          boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
        }}
      >
        <div style={{ position: "relative", width: canvasW, height: canvasH }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: HEADER_H,
              width: LEFT_COL_W,
              fontWeight: 900,
              color: "#0f172a",
            }}
          >
            Task
          </div>

          <div
            style={{
              position: "absolute",
              left: LEFT_COL_W,
              top: 0,
              height: HEADER_H,
              width: timelineW,
            }}
          >
            {Array.from({ length: totalDays + 1 }).map((_, i) => {
              if (i % 5 !== 0) return null;
              const day = minStart + i;
              return (
                <div
                  key={day}
                  style={{
                    position: "absolute",
                    left: i * PX_PER_DAY,
                    top: 0,
                    height: HEADER_H,
                    borderLeft: "1px solid #eef2f7",
                    fontSize: 11,
                    color: "#64748b",
                    paddingLeft: 2,
                    whiteSpace: "nowrap",
                  }}
                >
                  {day}
                </div>
              );
            })}
          </div>

          <svg
            width={canvasW}
            height={canvasH}
            style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", zIndex: 10 }}
          >
            <defs>
              <marker id="arrowGantt" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L9,3 L0,6 Z" fill="#111" />
              </marker>
            </defs>

            {links.map((l) => {
              const x1 = barXEnd(l.pred);
              const y1 = barMidY(l.pred);
              const x2 = barXStart(l.succ);
              const y2 = barMidY(l.succ);
              const elbowX = Math.max(x1 + 14, x2 - 14);

              const d = `M ${x1} ${y1}
                         L ${elbowX} ${y1}
                         L ${elbowX} ${y2}
                         L ${x2} ${y2}`;

              return (
                <path
                  key={String(l.id)}
                  d={d}
                  fill="none"
                  stroke="#111"
                  strokeWidth="1.8"
                  markerEnd="url(#arrowGantt)"
                  opacity="0.85"
                />
              );
            })}
          </svg>

          <div style={{ position: "absolute", left: 0, top: HEADER_H, zIndex: 1 }}>
            {valid.map((t) => {
              const isCrit = t.IsCritical === 1 || t.IsCritical === true;
              const left = (t.ES - minStart) * PX_PER_DAY;
              const width = Math.max(1, (t.EF - t.ES) * PX_PER_DAY);

              return (
                <div
                  key={normId(t.TaskId)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: ROW_H,
                    borderBottom: "1px solid #f1f5f9",
                  }}
                >
                  <div style={{ width: LEFT_COL_W, paddingRight: 10 }}>
                    <div style={{ fontWeight: 800 }}>{t.TaskName}</div>
                    <div style={{ fontSize: 12, color: "#64748b" }}>
                      {t.Workstream} | ES {t.ES} EF {t.EF}
                    </div>
                  </div>

                  <div
                    style={{
                      position: "relative",
                      height: ROW_H,
                      width: timelineW,
                      background: "#fafafa",
                      border: "1px solid #f1f5f9",
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left,
                        top: BAR_TOP_OFFSET,
                        height: BAR_H,
                        width,
                        borderRadius: 6,
                        background: isCrit ? "#f59e0b" : "#94a3b8",
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 8, fontSize: 12, color: "#64748b" }}>
        Lines are drawn predecessor → successor for visibility. Actual scheduling behavior depends on backend LinkType/LagDays.
      </div>
    </div>
  );
}

/** =========================
 *  Network Diagram
 *  ========================= */
function NetworkDiagram({ tasks, deps, getPredId, getSuccId, getDepId, getLag, getType }) {
  const normId = (v) => (v == null ? null : String(v));

  const { nodes, edges, w, h } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    const NODE_W = 240;
    const NODE_H = 70;

    const taskMap = new Map((tasks || []).map((t) => [normId(t.TaskId), t]));

    for (const t of tasks || []) {
      g.setNode(normId(t.TaskId), { width: NODE_W, height: NODE_H });
    }

    const edgeList = [];
    (deps || []).forEach((d) => {
      const pred = normId(getPredId(d));
      const succ = normId(getSuccId(d));
      if (pred == null || succ == null) return;
      if (!taskMap.has(pred) || !taskMap.has(succ)) return;

      const depId = getDepId(d);
      if (!Number.isFinite(Number(depId))) return;

      g.setEdge(pred, succ, { id: String(depId) });

      const type = String(getType(d) || "FS").toUpperCase();
      const lag = Number(getLag(d) || 0);

      edgeList.push({
        id: String(depId),
        from: pred,
        to: succ,
        label: `${type}${lag !== 0 ? `+${lag}` : ""}`,
      });
    });

    dagre.layout(g);

    const nodeList = (tasks || []).map((t) => {
      const n = g.node(normId(t.TaskId));
      return {
        id: normId(t.TaskId),
        task: t,
        x: n?.x ?? 0,
        y: n?.y ?? 0,
        w: NODE_W,
        h: NODE_H,
      };
    });

    const edgeGeom = edgeList.map((e) => {
      const from = g.node(e.from);
      const to = g.node(e.to);
      return {
        ...e,
        x1: (from?.x ?? 0) + NODE_W / 2,
        y1: from?.y ?? 0,
        x2: (to?.x ?? 0) - NODE_W / 2,
        y2: to?.y ?? 0,
      };
    });

    const gw = (g.graph().width || 1200) + 80;
    const gh = (g.graph().height || 600) + 80;

    return { nodes: nodeList, edges: edgeGeom, w: gw, h: gh };
  }, [tasks, deps, getPredId, getSuccId, getDepId, getLag, getType]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!nodes.length) return null;

  return (
    <div
      style={{
        marginTop: 16,
        border: "1px solid #e2e8f0",
        padding: 12,
        borderRadius: 12,
        background: "#ffffff",
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ fontWeight: 900, margin: "0 0 10px 0" }}>
        Network Diagram (Critical Path Highlight)
      </div>

      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10 }}>
        Nodes with orange border are tasks where IsCritical=true.
      </div>

      <div style={{ overflow: "auto" }}>
        <svg width={w} height={h} style={{ background: "#fff" }}>
          <defs>
            <marker id="arrowNet" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
              <path d="M0,0 L9,3 L0,6 Z" fill="#111" />
            </marker>
          </defs>

          {edges.map((e) => (
            <g key={e.id}>
              <line
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="#111"
                strokeWidth="1.6"
                markerEnd="url(#arrowNet)"
                opacity="0.85"
              />
              <text x={(e.x1 + e.x2) / 2} y={(e.y1 + e.y2) / 2 - 6} fontSize="11" fill="#444">
                {e.label}
              </text>
            </g>
          ))}

          {nodes.map((n) => {
            const isCrit = n.task.IsCritical === 1 || n.task.IsCritical === true;
            const x = n.x - n.w / 2;
            const y = n.y - n.h / 2;

            return (
              <g key={n.id}>
                <rect
                  x={x}
                  y={y}
                  width={n.w}
                  height={n.h}
                  rx="8"
                  ry="8"
                  fill={isCrit ? "#fff7ed" : "#f8fafc"}
                  stroke={isCrit ? "#f59e0b" : "#94a3b8"}
                  strokeWidth={isCrit ? "3" : "2"}
                />
                <text x={x + 10} y={y + 20} fontSize="12" fontWeight="700" fill="#111">
                  #{n.task.TaskId} {n.task.TaskName}
                </text>
                <text x={x + 10} y={y + 40} fontSize="11" fill="#333">
                  {n.task.Workstream} | ES {n.task.ES ?? ""} EF {n.task.EF ?? ""}
                </text>
                <text x={x + 10} y={y + 56} fontSize="11" fill="#444">
                  Float: {n.task.TotalFloat ?? ""}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
