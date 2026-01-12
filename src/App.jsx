import { useEffect, useMemo, useState } from "react";
import dagre from "dagre";
import { API_BASE } from "./config";

export default function App() {
  const [projectId, setProjectId] = useState("1");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [schedule, setSchedule] = useState(null);
  const [deps, setDeps] = useState([]);

  // toggles
  const [showNetwork, setShowNetwork] = useState(false);
  const [showGantt, setShowGantt] = useState(true);

  const tasks = schedule?.tasks || [];
  const version = schedule?.version || null;

  const criticalCount = useMemo(() => {
    return tasks.filter((t) => t.IsCritical === 1 || t.IsCritical === true).length;
  }, [tasks]);

  const taskById = useMemo(() => {
    const m = new Map();
    for (const t of tasks) m.set(t.TaskId, t);
    return m;
  }, [tasks]);

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
      const succ = getSuccId(d);
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
        fetchJson(
          `${API_BASE}/getDependencies?projectId=${encodeURIComponent(projectId)}&t=${bust}`
        ),
      ]);

      if (!sch.res.ok || !sch.json?.ok)
        throw new Error(sch.json?.error || "Failed to load schedule");
      if (!dep.res.ok || !dep.json?.ok)
        throw new Error(dep.json?.error || "Failed to load dependencies");

      setSchedule(sch.json);
      setDeps(dep.json.dependencies || dep.json.deps || []);
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
    setLoading(true);
    try {
      await recalcOnly();
      await loadAll();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
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

  // REQUIRED on backend: POST /updateDependency
  // This sends both casings for tolerance: linkType + LinkType, lagDays + LagDays
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
   *  UI
   *  ========================= */
  return (
    <div style={{ padding: 24, fontFamily: "Arial", maxWidth: 1600 }}>
      <h2>MSP Lite UI</h2>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          Project ID:&nbsp;
          <input
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            style={{ width: 80 }}
          />
        </label>

        <button onClick={loadAll} disabled={loading}>
          Load
        </button>

        <button onClick={recalcAndReload} disabled={loading}>
          Recalculate
        </button>

        <button
          onClick={() => setShowNetwork((v) => !v)}
          disabled={loading || tasks.length === 0}
        >
          {showNetwork ? "Hide Network Diagram" : "Show Network Diagram"}
        </button>

        <button
          onClick={() => setShowGantt((v) => !v)}
          disabled={loading || tasks.length === 0}
        >
          {showGantt ? "Hide Gantt Chart" : "Show Gantt Chart"}
        </button>

        {version && (
          <span>
            Version {version.versionNo} | Finish Day {version.projectFinishDay} | Critical{" "}
            {criticalCount}/{tasks.length}
          </span>
        )}
      </div>

      {error && <div style={{ color: "red", marginTop: 10 }}>Error: {error}</div>}

      <div style={{ marginTop: 10, color: "#666" }}>
        Tasks: {tasks.length} | Dependencies: {deps.length}
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

      <table
        border="1"
        cellPadding="6"
        style={{ marginTop: 20, borderCollapse: "collapse", width: "100%" }}
      >
        <thead>
          <tr>
            <th>Workstream</th>
            <th>Task</th>
            <th>Dur</th>
            <th>ES</th>
            <th>EF</th>
            <th>LS</th>
            <th>LF</th>
            <th>Float</th>
            <th>Critical</th>
            <th>Dependencies (Edit Type + Lag)</th>
          </tr>
        </thead>

        <tbody>
          {tasks.map((t) => (
            <TaskRow
              key={t.TaskId}
              task={t}
              taskById={taskById}
              depsForTask={depsBySuccessor.get(t.TaskId) || []}
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
                  await recalcAndReload(); // ✅ single clean flow
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
                  await recalcAndReload(); // ✅ single clean flow
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
                  await recalcAndReload(); // ✅ single clean flow
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
              <td colSpan={10} style={{ padding: 14, color: "#666" }}>
                No tasks found.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 12, color: "#666" }}>
        Note: ES/EF/LS/LF/Float/Critical are computed. Edit only Duration and existing Dependencies
        (Type/Lag). No “Add Dependency” is provided.
      </div>
    </div>
  );
}

/** =========================
 *  Task Table Row
 *  ========================= */
function TaskRow({
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

  return (
    <tr style={{ background: isCrit ? "#ffeeba" : "white" }}>
      <td>{task.Workstream}</td>
      <td>{task.TaskName}</td>

      <td>
        <input
          style={{ width: 70 }}
          value={dur}
          onChange={(e) => setDur(e.target.value)}
          disabled={disabled}
        />
        <button
          style={{ marginLeft: 8 }}
          onClick={() => onSaveDuration(dur === "" ? 0 : Number(dur))}
          disabled={disabled}
        >
          Save
        </button>
      </td>

      <td>{task.ES ?? ""}</td>
      <td>{task.EF ?? ""}</td>
      <td>{task.LS ?? ""}</td>
      <td>{task.LF ?? ""}</td>
      <td>{task.TotalFloat ?? ""}</td>
      <td>{isCrit ? "YES" : ""}</td>

      <td>
        {depsForTask.length === 0 ? (
          <span style={{ color: "#666" }}>(none)</span>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {depsForTask.map((d) => {
              const depId = d.__id ?? getDepId(d); // should be numeric or null
              const predId = getPredId(d);
              const pred = taskById.get(predId);
              const predName = pred
                ? `${pred.Workstream} - ${pred.TaskName}`
                : String(predId);

              return (
                <DepEditor
                  key={String(depId ?? Math.random())}
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

function DepEditor({
  depId,
  predName,
  initialType,
  initialLag,
  disabled,
  onUpdate,
  onRemove,
}) {
  const [type, setType] = useState((initialType || "FS").toUpperCase());
  const [lag, setLag] = useState(String(initialLag ?? 0));

  useEffect(() => setType((initialType || "FS").toUpperCase()), [initialType]);
  useEffect(() => setLag(String(initialLag ?? 0)), [initialLag]);

  const canEdit = Number.isFinite(Number(depId));

  return (
    <li style={{ marginBottom: 6 }}>
      <span style={{ display: "inline-block", minWidth: 260 }}>{predName}</span>

      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        disabled={disabled || !canEdit}
      >
        <option value="FS">FS</option>
        <option value="SS">SS</option>
        <option value="FF">FF</option>
        <option value="SF">SF</option>
      </select>

      <input
        style={{ width: 70, marginLeft: 8 }}
        value={lag}
        onChange={(e) => setLag(e.target.value)}
        disabled={disabled || !canEdit}
        placeholder="lag"
      />

      <button
        style={{ marginLeft: 8 }}
        onClick={() => onUpdate(depId, type, lag === "" ? 0 : Number(lag))}
        disabled={disabled || !canEdit}
      >
        Update
      </button>

      <button
        style={{ marginLeft: 8 }}
        onClick={() => onRemove(depId)}
        disabled={disabled || !canEdit}
      >
        Remove
      </button>

      {!canEdit && (
        <span style={{ marginLeft: 10, color: "red", fontSize: 12 }}>
          Missing TaskDependencyId in getDependencies API
        </span>
      )}
    </li>
  );
}

/** =========================
 *  Gantt (Linked)
 *  ========================= */
function GanttLiteLinked({ tasks, deps, getPredId, getSuccId, getDepId }) {
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
  valid.forEach((t, idx) => rowIndexByTaskId.set(t.TaskId, idx));
  const taskById = new Map(valid.map((t) => [t.TaskId, t]));

  const barXStart = (task) => LEFT_COL_W + (task.ES - minStart) * PX_PER_DAY;
  const barXEnd = (task) => LEFT_COL_W + (task.EF - minStart) * PX_PER_DAY;
  const barMidY = (task) => {
    const idx = rowIndexByTaskId.get(task.TaskId) ?? 0;
    return HEADER_H + idx * ROW_H + BAR_TOP_OFFSET + BAR_H / 2;
  };

  const links = (deps || [])
    .map((d) => ({
      id: getDepId(d) ?? `skip_${Math.random()}`,
      predId: getPredId(d),
      succId: getSuccId(d),
    }))
    .filter((l) => l.predId != null && l.succId != null)
    .filter((l) => taskById.has(l.predId) && taskById.has(l.succId))
    .map((l) => ({ id: l.id, pred: taskById.get(l.predId), succ: taskById.get(l.succId) }));

  const canvasH = HEADER_H + valid.length * ROW_H;
  const canvasW = LEFT_COL_W + timelineW;

  return (
    <div style={{ marginTop: 22 }}>
      <h3 style={{ marginBottom: 10 }}>Gantt (Linked) — Links: {links.length}</h3>

      <div style={{ overflowX: "auto", border: "1px solid #ddd", padding: 12 }}>
        <div style={{ position: "relative", width: canvasW, height: canvasH }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              height: HEADER_H,
              width: LEFT_COL_W,
              fontWeight: "bold",
            }}
          >
            Task
          </div>

          <div style={{ position: "absolute", left: LEFT_COL_W, top: 0, height: HEADER_H, width: timelineW }}>
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
                    borderLeft: "1px solid #eee",
                    fontSize: 11,
                    color: "#666",
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
                  key={t.TaskId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    height: ROW_H,
                    borderBottom: "1px solid #f3f3f3",
                  }}
                >
                  <div style={{ width: LEFT_COL_W, paddingRight: 10 }}>
                    <div style={{ fontWeight: 600 }}>{t.TaskName}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>
                      {t.Workstream} | ES {t.ES} EF {t.EF}
                    </div>
                  </div>

                  <div
                    style={{
                      position: "relative",
                      height: ROW_H,
                      width: timelineW,
                      background: "#fafafa",
                      border: "1px solid #f0f0f0",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left,
                        top: BAR_TOP_OFFSET,
                        height: BAR_H,
                        width,
                        borderRadius: 4,
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

      <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
        Lines are drawn predecessor → successor for visibility. Actual scheduling behavior depends on backend LinkType/LagDays.
      </div>
    </div>
  );
}

/** =========================
 *  Network Diagram
 *  ========================= */
function NetworkDiagram({ tasks, deps, getPredId, getSuccId, getDepId, getLag, getType }) {
  const { nodes, edges, w, h } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    const NODE_W = 240;
    const NODE_H = 70;

    const taskMap = new Map((tasks || []).map((t) => [t.TaskId, t]));

    for (const t of tasks || []) {
      g.setNode(String(t.TaskId), { width: NODE_W, height: NODE_H });
    }

    const edgeList = [];
    (deps || []).forEach((d) => {
      const pred = getPredId(d);
      const succ = getSuccId(d);
      if (pred == null || succ == null) return;
      if (!taskMap.has(pred) || !taskMap.has(succ)) return;

      const depId = getDepId(d);
      if (!Number.isFinite(Number(depId))) return;

      g.setEdge(String(pred), String(succ), { id: String(depId) });

      const type = String(getType(d) || "FS").toUpperCase();
      const lag = Number(getLag(d) || 0);

      edgeList.push({
        id: String(depId),
        from: String(pred),
        to: String(succ),
        label: `${type}${lag !== 0 ? `+${lag}` : ""}`,
      });
    });

    dagre.layout(g);

    const nodeList = (tasks || []).map((t) => {
      const n = g.node(String(t.TaskId));
      return { id: String(t.TaskId), task: t, x: n.x, y: n.y, w: NODE_W, h: NODE_H };
    });

    const edgeGeom = edgeList.map((e) => {
      const from = g.node(e.from);
      const to = g.node(e.to);
      return { ...e, x1: from.x + NODE_W / 2, y1: from.y, x2: to.x - NODE_W / 2, y2: to.y };
    });

    const gw = (g.graph().width || 1200) + 80;
    const gh = (g.graph().height || 600) + 80;

    return { nodes: nodeList, edges: edgeGeom, w: gw, h: gh };
  }, [tasks, deps, getPredId, getSuccId, getDepId, getLag, getType]);

  if (!nodes.length) return null;

  return (
    <div style={{ marginTop: 16, border: "1px solid #ddd", padding: 12 }}>
      <h3 style={{ margin: "0 0 10px 0" }}>Network Diagram (Critical Path Highlight)</h3>

      <div style={{ fontSize: 12, color: "#666", marginBottom: 10 }}>
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
