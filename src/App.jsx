import { useEffect, useMemo, useRef, useState } from "react";
import dagre from "dagre";
import { API_BASE } from "./config";

/**
 * MSP Lite — App.jsx
 *
 * Implemented (as per your requirement):
 * 1) Task Table: ONLY per-task "Add Dependency" (task + link type + lag). No big dependency cards.
 * 2) Circular dependency prevention (UI-level DFS check) before POST /addDependency.
 * 3) Drag-to-link in Gantt (drag bar -> drop on another bar) creates FS+0 by default.
 * 4) New Project modal: template hidden (uses fixed template name silently).
 * 5) Gantt connectors stay visible (SVG above rows).
 */

const TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "gantt", label: "Gantt" },
  { key: "network", label: "Network" },
  { key: "table", label: "Task Table" },
];

const BUFFER_DAYS_FIXED = 30;
const FIXED_TEMPLATE_NAME = "Template 3 (Imported from Google Sheet)";

const MILESTONE_FIELDS = [
  { key: "LOI", label: "LOI (Project Start)", required: true },
  { key: "DES_HANDOVER", label: "Design Handover Date" },
  { key: "LAND_BOUNDARY", label: "Final Land Boundary" },
  { key: "INV_FINAL", label: "Inverter Finalisation" },
  { key: "MOD_FINAL", label: "Module Finalisation" },
  { key: "GSS_END_SLD", label: "GSS End SLD" },
  { key: "LOCAL_APPROVAL_DWG", label: "Local State Approved Equipment Structure Drawing" },
  { key: "GSS_INPUTS_CHECKLIST", label: "Filled Checklist of GSS Inputs" },
  { key: "COMM_CONTRACT", label: "Commissioning (as per Contract)", required: true },
];

/* =========================================================
   Graph utilities (cycle prevention + duplicate prevention)
   ========================================================= */
function normalizeId(v) {
  return v == null ? null : String(v);
}

function buildAdjacency(depPairs) {
  const adj = new Map();
  for (const e of depPairs) {
    const p = normalizeId(e.predId);
    const s = normalizeId(e.succId);
    if (!p || !s) continue;
    if (!adj.has(p)) adj.set(p, []);
    adj.get(p).push(s);
  }
  return adj;
}

// returns true if adding edge pred->succ would create a cycle
function wouldCreateCycle(depPairs, predId, succId) {
  const P = normalizeId(predId);
  const S = normalizeId(succId);
  if (!P || !S) return true;
  if (P === S) return true;

  const adj = buildAdjacency(depPairs);

  // add the proposed edge
  if (!adj.has(P)) adj.set(P, []);
  adj.get(P).push(S);

  // cycle exists iff S can reach P
  const seen = new Set();
  function dfs(n) {
    if (n === P) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    const nx = adj.get(n) || [];
    for (const k of nx) if (dfs(k)) return true;
    return false;
  }
  return dfs(S);
}

function isDuplicateEdge(depPairs, predId, succId) {
  const P = normalizeId(predId);
  const S = normalizeId(succId);
  return depPairs.some((e) => normalizeId(e.predId) === P && normalizeId(e.succId) === S);
}

/* =========================================================
   APP
   ========================================================= */
export default function App() {
  const s = useMemo(() => makeStyles(), []);

  const [activeTab, setActiveTab] = useState("dashboard");
  const [projectId, setProjectId] = useState("1");

  const [loading, setLoading] = useState(false);
  const [busyMsg, setBusyMsg] = useState("");
  const [error, setError] = useState("");

  const [schedule, setSchedule] = useState(null);
  const [deps, setDeps] = useState([]);

  const [showNewProject, setShowNewProject] = useState(false);

  // Task popup (from click)
  const [selectedTaskId, setSelectedTaskId] = useState(null);

  /* -------------------- tolerant parsing -------------------- */
  const tasks =
    schedule?.tasks ??
    schedule?.project?.tasks ??
    schedule?.Tasks ??
    schedule?.project?.Tasks ??
    [];

  const version =
    schedule?.version ??
    schedule?.project?.version ??
    schedule?.Version ??
    schedule?.project?.Version ??
    null;

  const project = schedule?.project ?? null;

  /* -------------------- dependency field tolerance -------------------- */
  // getDependencies returns:
  // TaskDependencyId, ProjectId, PredecessorTaskId, SuccessorTaskId, LinkType, LagDays
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

  const getDepId = (d) => {
    const raw =
      d.TaskDependencyId ??
      d.TaskDependencyID ??
      d.taskDependencyId ??
      d.taskDependencyID ??
      d.DependencyId ??
      d.dependencyId;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  const getType = (d) =>
    String(d.LinkType ?? d.linkType ?? d.Type ?? d.type ?? "FS").toUpperCase();

  const getLag = (d) => {
    const v = d.LagDays ?? d.lagDays ?? d.Lag ?? d.lag ?? 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  /* -------------------- normalized dependencies -------------------- */
  const depPairs = useMemo(() => {
    const out = [];
    for (const d of deps || []) {
      const pred = normalizeId(getPredId(d));
      const succ = normalizeId(getSuccId(d));
      if (!pred || !succ) continue;
      out.push({
        depId: getDepId(d),
        predId: pred,
        succId: succ,
        type: getType(d),
        lag: getLag(d),
        raw: d,
      });
    }
    return out;
  }, [deps]); // eslint-disable-line react-hooks/exhaustive-deps

  const taskById = useMemo(() => {
    const m = new Map();
    for (const t of tasks || []) m.set(normalizeId(t.TaskId), t);
    return m;
  }, [tasks]);

  /* -------------------- deps maps for popup -------------------- */
  const predecessorsByTask = useMemo(() => {
    const m = new Map();
    for (const e of depPairs) {
      const arr = m.get(e.succId) || [];
      arr.push(e);
      m.set(e.succId, arr);
    }
    return m;
  }, [depPairs]);

  const successorsByTask = useMemo(() => {
    const m = new Map();
    for (const e of depPairs) {
      const arr = m.get(e.predId) || [];
      arr.push(e);
      m.set(e.predId, arr);
    }
    return m;
  }, [depPairs]);

  const selectedTask = selectedTaskId ? taskById.get(normalizeId(selectedTaskId)) : null;
  const selectedPreds = selectedTaskId ? (predecessorsByTask.get(normalizeId(selectedTaskId)) || []) : [];
  const selectedSuccs = selectedTaskId ? (successorsByTask.get(normalizeId(selectedTaskId)) || []) : [];

  /* -------------------- date model (LOI = project start) -------------------- */
  const projectStartDate = useMemo(() => {
    const direct = parseISO(project?.projectStartDate);
    if (direct) return direct;

    if (project?.milestones && typeof project.milestones === "object") {
      const m = project.milestones;
      const loi = parseISO(m.LOI || m.loi || m.loiDate);
      if (loi) return loi;
    }

    if (Array.isArray(project?.Milestones)) {
      const loiRow = project.Milestones.find((x) => String(x?.Key || x?.key) === "LOI");
      const loi = parseISO(loiRow?.Date || loiRow?.date || loiRow?.Value || loiRow?.value);
      if (loi) return loi;
    }

    return null;
  }, [project?.projectStartDate, project?.milestones, project?.Milestones]);

  const dayToDate = (dayNo) => {
    if (!projectStartDate) return null;
    const n = Number(dayNo);
    if (!Number.isFinite(n)) return null;
    const d = new Date(projectStartDate.getTime());
    d.setDate(d.getDate() + n);
    return d;
  };

  const fmtDDMMMYY = (d) => {
    if (!(d instanceof Date) || isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  };

  const criticalCount = useMemo(() => {
    return (tasks || []).filter((t) => t.IsCritical === 1 || t.IsCritical === true).length;
  }, [tasks]);

  const needsStartDate = tasks.length > 0 && !projectStartDate;

  /* -------------------- fetch helpers -------------------- */
  async function safeJson(res) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 250)}`);
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

  /* -------------------- load / recalc / updates -------------------- */
  async function loadAll(nextProjectId = projectId) {
    setError("");
    setLoading(true);
    setBusyMsg("Loading schedule...");
    try {
      const bust = Date.now();
      const [sch, dep] = await Promise.all([
        fetchJson(`${API_BASE}/getSchedule?projectId=${encodeURIComponent(nextProjectId)}&versionId=latest&t=${bust}`),
        fetchJson(`${API_BASE}/getDependencies?projectId=${encodeURIComponent(nextProjectId)}&t=${bust}`),
      ]);

      if (!sch.res.ok || !sch.json?.ok) throw new Error(sch.json?.error || "Failed to load schedule");
      if (!dep.res.ok || !dep.json?.ok) throw new Error(dep.json?.error || "Failed to load dependencies");

      setSchedule(sch.json);

      const depsPayload =
        dep.json?.dependencies ??
        dep.json?.deps ??
        dep.json?.project?.dependencies ??
        dep.json?.project?.deps ??
        dep.json?.data ??
        [];

      setDeps(Array.isArray(depsPayload) ? depsPayload : []);
      setSelectedTaskId(null);
    } catch (e) {
      setError(e.message || String(e));
      setSchedule(null);
      setDeps([]);
      setSelectedTaskId(null);
    } finally {
      setBusyMsg("");
      setLoading(false);
    }
  }

  async function recalcOnly(nextProjectId = projectId) {
    const { res, json } = await fetchJson(
      `${API_BASE}/recalculate?projectId=${encodeURIComponent(nextProjectId)}&t=${Date.now()}`,
      { method: "POST" }
    );
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Recalculate failed");
    return json;
  }

  async function recalcAndReload(nextProjectId = projectId) {
    setError("");
    setLoading(true);
    setBusyMsg("Recalculating schedule...");
    try {
      await recalcOnly(nextProjectId);
      await loadAll(nextProjectId);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyMsg("");
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

  async function addDependencyApi({ projectId, predecessorTaskId, successorTaskId, linkType = "FS", lagDays = 0 }) {
    const { res, json } = await fetchJson(`${API_BASE}/addDependency?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        predecessorTaskId,
        successorTaskId,
        linkType, // backend may ignore (your sample hardcodes FS) but keep sending
        lagDays,
      }),
    });
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Add dependency failed");
    return json;
  }
  async function updateDependencyApi({ taskDependencyId, linkType, lagDays }) {
    const { res, json } = await fetchJson(`${API_BASE}/updateDependency?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskDependencyId,
        linkType: String(linkType || "FS").toUpperCase(),
        lagDays: Number.isFinite(Number(lagDays)) ? Number(lagDays) : 0,
      }),
    });
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Update dependency failed");
    return json;
  }
  
  async function deleteDependencyApi({ taskDependencyId }) {
    const { res, json } = await fetchJson(`${API_BASE}/deleteDependency?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskDependencyId }),
    });
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Delete dependency failed");
    return json;
  }
  async function createProject(payload) {
    const { res, json } = await fetchJson(`${API_BASE}/createProject?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Create project failed");
    return json;
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* -------------------- KPIs -------------------- */
  const kpi = useMemo(() => {
    const totalTasks = tasks.length || 0;
    const completed = (tasks || []).filter((t) => String(t.Status || "").toUpperCase() === "COMPLETED").length;
    const avgCompletion = totalTasks ? Math.round((completed / totalTasks) * 100) : 0;

    const finishDay = Number(version?.projectFinishDay);
    const finishDate = projectStartDate && Number.isFinite(finishDay) ? dayToDate(finishDay) : null;

    return {
      totalTasks,
      completed,
      avgCompletion,
      critical: criticalCount,
      finishDate,
    };
  }, [tasks, version?.projectFinishDay, criticalCount, projectStartDate]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------------------- Unified Add Dependency handler (cycle + dup check) -------------------- */
  async function addDependencyGuarded({ predecessorTaskId, successorTaskId, linkType, lagDays }) {
    const pid = project?.ProjectId ?? projectId;

    // basic
    if (!pid) throw new Error("Missing projectId");
    if (!predecessorTaskId || !successorTaskId) throw new Error("Predecessor and successor are required");
    if (String(predecessorTaskId) === String(successorTaskId)) throw new Error("A task cannot depend on itself");

    // duplicate
    if (isDuplicateEdge(depPairs, predecessorTaskId, successorTaskId)) {
      throw new Error("Dependency already exists (duplicate blocked)");
    }

    // cycle
    if (wouldCreateCycle(depPairs, predecessorTaskId, successorTaskId)) {
      throw new Error("Circular dependency detected. Operation blocked.");
    }

    setError("");
    setLoading(true);
    setBusyMsg("Adding dependency...");
    try {
      await addDependencyApi({
        projectId: pid,
        predecessorTaskId,
        successorTaskId,
        linkType: String(linkType || "FS").toUpperCase(),
        lagDays: Number.isFinite(Number(lagDays)) ? Number(lagDays) : 0,
      });
      await recalcAndReload(pid);
    } finally {
      setBusyMsg("");
      setLoading(false);
    }
  }

  return (
    <div style={s.page}>
      <GlobalCSS />

      {loading && (
        <div style={s.overlay}>
          <div style={s.overlayCard}>
            <Spinner size={18} />
            <div>
              <div style={s.overlayTitle}>{busyMsg || "Working..."}</div>
              <div style={s.overlaySub}>Please do not refresh while requests are running.</div>
            </div>
          </div>
        </div>
      )}

      {/* Top Nav */}
      <div style={s.topbar}>
        <div style={s.brandWrap}>
          <div style={s.brandDot} />
          <div>
            <div style={s.brandTitle}>MSP Lite</div>
            <div style={s.brandSub}>Scheduling • Critical Path • Baselines</div>
          </div>
        </div>

        <div style={s.tabs}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              style={{ ...s.tabBtn, ...(activeTab === t.key ? s.tabBtnActive : {}) }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={s.topActions}>
          <button
            style={s.btnPrimary}
            onClick={() => setShowNewProject(true)}
            disabled={loading}
            title="Create a new project from template"
          >
            + New Project
          </button>
        </div>
      </div>

      {/* Project Bar */}
      <div style={s.content}>
        <div style={s.projectBar}>
          <div style={s.projectLeft}>
            <div style={s.projectName}>{project?.ProjectName ? project.ProjectName : "Load a Project"}</div>

            <div style={s.projectMeta}>
              <span>
                ProjectId: <b>{project?.ProjectId ?? projectId}</b>
              </span>
              <span>•</span>
              <span>
                Version: <b>{version?.versionNo ?? "-"}</b>
              </span>
              <span>•</span>
              <span>
                LOI Start: <b>{projectStartDate ? fmtDDMMMYY(projectStartDate) : "-"}</b>
              </span>
              <span>•</span>
              <span>
                Finish: <b>{kpi.finishDate ? fmtDDMMMYY(kpi.finishDate) : "-"}</b>
              </span>
              <span>•</span>
              <span>
                Critical: <b>{kpi.critical}/{kpi.totalTasks}</b>
              </span>
            </div>
          </div>

          <div style={s.projectRight}>
            <label style={s.inlineLabel}>
              Project ID
              <input value={projectId} onChange={(e) => setProjectId(e.target.value)} style={s.input} disabled={loading} />
            </label>

            <button onClick={() => loadAll(projectId)} disabled={loading} style={{ ...s.btn, ...(loading ? s.btnDisabled : {}) }}>
              Load
            </button>

            <button
              onClick={() => recalcAndReload(projectId)}
              disabled={loading}
              style={{ ...s.btnDark, ...(loading ? s.btnDisabled : {}) }}
              title="Recalculate (recommended after edits)"
            >
              Recalculate
            </button>
          </div>
        </div>

        {error && <div style={s.error}>Error: {error}</div>}

        {needsStartDate && (
          <div style={s.warn}>
            Missing LOI/projectStartDate from API. UI cannot show dd-MMM-yy target dates until backend returns LOI as{" "}
            <code>project.projectStartDate</code> (or milestones include LOI).
          </div>
        )}

        {/* Dashboard */}
        {activeTab === "dashboard" && (
          <>
            <div style={s.card}>
              <div style={s.cardHeader}>
                <div>
                  <div style={s.cardTitle}>Project Summary</div>
                  <div style={s.cardSub}>Target dates are derived from LOI + ES/EF day offsets.</div>
                </div>
              </div>

              <div style={s.kpiGrid}>
                <KpiCard label="Total Tasks" value={kpi.totalTasks} />
                <KpiCard label="Completed" value={kpi.completed} />
                <KpiCard label="Avg Completion" value={`${kpi.avgCompletion}%`} />
                <KpiCard label="Critical Tasks" value={`${kpi.critical}`} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.6fr 0.4fr", gap: 14, marginTop: 14 }}>
              <div style={s.card}>
                <div style={s.cardHeader}>
                  <div>
                    <div style={s.cardTitle}>Gantt Preview</div>
                    <div style={s.cardSub}>
                      Connectors + arrows. Click bar for preds/succs. Drag bar → bar to add FS link.
                    </div>
                  </div>
                </div>
                {tasks.length && projectStartDate ? (
                  <GanttDates
                    tasks={tasks}
                    deps={deps}
                    depPairs={depPairs}
                    startDate={projectStartDate}
                    compact
                    onTaskClick={(id) => setSelectedTaskId(id)}
                    onDragLink={(predId, succId) =>
                      addDependencyGuarded({ predecessorTaskId: predId, successorTaskId: succId, linkType: "FS", lagDays: 0 })
                        .catch((e) => setError(e.message || String(e)))
                    }
                  />
                ) : (
                  <EmptyState text="Load a project (and LOI) to see a date-based Gantt." />
                )}
              </div>

              <div style={s.card}>
                <div style={s.cardHeader}>
                  <div>
                    <div style={s.cardTitle}>Critical Path (Top)</div>
                    <div style={s.cardSub}>Tasks flagged critical by backend.</div>
                  </div>
                </div>

                {tasks.length ? (
                  <div style={{ padding: 12 }}>
                    {(tasks || [])
                      .filter((t) => t.IsCritical === 1 || t.IsCritical === true)
                      .slice(0, 12)
                      .map((t) => (
                        <div key={normalizeId(t.TaskId)} style={s.listRow}>
                          <div style={{ fontWeight: 950 }}>{t.TaskName}</div>
                          <div style={s.listMeta}>
                            {t.Workstream} • Start {fmtDDMMMYY(dayToDate(t.ES))} • Finish {fmtDDMMMYY(dayToDate(t.EF))}
                          </div>
                        </div>
                      ))}

                    {(tasks || []).filter((t) => t.IsCritical === 1 || t.IsCritical === true).length === 0 && (
                      <div style={s.muted}>No critical tasks returned. Check schedule calc.</div>
                    )}
                  </div>
                ) : (
                  <EmptyState text="No schedule loaded." />
                )}
              </div>
            </div>
          </>
        )}

        {/* Gantt */}
        {activeTab === "gantt" && (
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <div style={s.cardTitle}>Gantt (Target Dates + Connections)</div>
                <div style={s.cardSub}>
                  Drag-to-link enabled: drag bar → bar to add FS link (lag 0). Click bar for preds/succs.
                </div>
              </div>
            </div>

            {tasks.length && projectStartDate ? (
              <GanttDates
                tasks={tasks}
                deps={deps}
                depPairs={depPairs}
                startDate={projectStartDate}
                onTaskClick={(id) => setSelectedTaskId(id)}
                onDragLink={(predId, succId) =>
                  addDependencyGuarded({ predecessorTaskId: predId, successorTaskId: succId, linkType: "FS", lagDays: 0 })
                    .catch((e) => setError(e.message || String(e)))
                }
              />
            ) : (
              <EmptyState text="Load a project (and LOI) to view date-based Gantt." />
            )}
          </div>
        )}

        {/* Network */}
        {activeTab === "network" && (
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <div style={s.cardTitle}>Network Diagram</div>
                <div style={s.cardSub}>DAG layout using Dagre. Edges labelled type + lag.</div>
              </div>
            </div>

            {tasks.length ? (
              <NetworkDiagram
                tasks={tasks}
                deps={deps}
                getPredId={getPredId}
                getSuccId={getSuccId}
                getDepId={getDepId}
                getLag={getLag}
                getType={getType}
              />
            ) : (
              <EmptyState text="Load a project to view network." />
            )}
          </div>
        )}

        {/* Task Table */}
        {activeTab === "table" && (
          <div style={s.card}>
            <div style={s.cardHeader}>
              <div>
                <div style={s.cardTitle}>Task Table (Edit Duration / Add Dependencies)</div>
                <div style={s.cardSub}>
                  Per task: choose predecessor + link type + lag, then Add. (Circular + duplicate blocked)
                </div>
              </div>

              <div style={s.cardHeaderRight}>
                <button
                  style={{ ...s.btnDark, ...(loading ? s.btnDisabled : {}) }}
                  disabled={loading}
                  onClick={() => recalcAndReload(projectId)}
                >
                  Recalculate
                </button>
              </div>
            </div>

            <TaskTable
              tasks={tasks}
              disabled={loading}
              dayToDate={dayToDate}
              fmtDDMMMYY={fmtDDMMMYY}
              depPairs={depPairs}
              onSaveDuration={async (taskId, newDur) => {
                setError("");
                setLoading(true);
                setBusyMsg("Updating duration...");
                try {
                  await updateDuration(taskId, newDur);
                  await recalcAndReload(projectId);
                } catch (e) {
                  setError(e.message || String(e));
                } finally {
                  setBusyMsg("");
                  setLoading(false);
                }
              }}
              onAddDep={async ({ predecessorTaskId, successorTaskId, linkType, lagDays }) => {
                try {
                  await addDependencyGuarded({ predecessorTaskId, successorTaskId, linkType, lagDays });
                } catch (e) {
                  setError(e.message || String(e));
                }
              }}
              onUpdateDep={async ({ taskDependencyId, linkType, lagDays }) => {
                try {
                  setError("");
                  setLoading(true);
                  setBusyMsg("Updating dependency...");
                  await updateDependencyApi({ taskDependencyId, linkType, lagDays });
                  await recalcAndReload(projectId);
                } catch (e) {
                  setError(e.message || String(e));
                } finally {
                  setBusyMsg("");
                  setLoading(false);
                }
              }}
              onDeleteDep={async ({ taskDependencyId }) => {
                try {
                  setError("");
                  setLoading(true);
                  setBusyMsg("Deleting dependency...");
                  await deleteDependencyApi({ taskDependencyId });
                  await recalcAndReload(projectId);
                } catch (e) {
                  setError(e.message || String(e));
                } finally {
                  setBusyMsg("");
                  setLoading(false);
                }
              }}
            />
          </div>
        )}
      </div>

      {/* New Project Modal */}
      {showNewProject && (
        <NewProjectModal
          bufferDays={BUFFER_DAYS_FIXED}
          onClose={() => setShowNewProject(false)}
          loading={loading}
          onCreate={async ({ projectName, milestones, loiDate, commissioningContractDate, commissioningInternalDate }) => {
            setError("");
            setLoading(true);
            setBusyMsg("Creating project...");
            try {
              const out = await createProject({
                projectName,
                templateName: FIXED_TEMPLATE_NAME, // applied silently
                bufferDays: BUFFER_DAYS_FIXED,
                loiDate,
                commissioningContractDate,
                commissioningInternalDate,
                milestones,
              });

              const newId = String(out.projectId);
              await recalcOnly(newId);
              setProjectId(newId);
              setShowNewProject(false);
              await loadAll(newId);
              setActiveTab("dashboard");
            } catch (e) {
              setError(e.message || String(e));
            } finally {
              setBusyMsg("");
              setLoading(false);
            }
          }}
        />
      )}

      {/* Task Relations Popup */}
      {selectedTask && (
        <TaskRelationsModal
          onClose={() => setSelectedTaskId(null)}
          task={selectedTask}
          dayToDate={dayToDate}
          fmtDDMMMYY={fmtDDMMMYY}
          preds={selectedPreds}
          succs={selectedSuccs}
          taskById={taskById}
        />
      )}
    </div>
  );
}

/* =========================================================
   Components
   ========================================================= */

function GlobalCSS() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      button, input, select { font-family: inherit; }
      ::-webkit-scrollbar { height: 10px; width: 10px; }
      ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 12px; }
      ::-webkit-scrollbar-track { background: #eef2f7; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `}</style>
  );
}

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

function KpiCard({ label, value }) {
  const s = makeStyles();
  return (
    <div style={s.kpiCard}>
      <div style={s.kpiValue}>{value}</div>
      <div style={s.kpiLabel}>{label}</div>
    </div>
  );
}

function EmptyState({ text }) {
  const s = makeStyles();
  return <div style={{ padding: 14, color: "#475569", fontWeight: 900 }}>{text}</div>;
}

/* -------------------- Task Relations Modal -------------------- */
function TaskRelationsModal({ onClose, task, preds, succs, taskById, dayToDate, fmtDDMMMYY }) {
  const s = makeStyles();
  const start = dayToDate(task.ES);
  const finish = dayToDate(task.EF);

  const fmtRel = (e) => {
    const pred = taskById.get(String(e.predId || ""));
    const succ = taskById.get(String(e.succId || ""));
    return {
      predName: pred ? `${pred.Workstream} — ${pred.TaskName}` : `TaskId ${String(e.predId)}`,
      succName: succ ? `${succ.Workstream} — ${succ.TaskName}` : `TaskId ${String(e.succId)}`,
      type: e.type || "FS",
      lag: Number(e.lag || 0),
    };
  };

  return (
    <div style={s.modalOverlay} onMouseDown={onClose}>
      <div style={s.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <div>
            <div style={s.modalTitle}>Task Relations</div>
            <div style={s.modalSub}>Predecessors and successors for the selected task.</div>
          </div>
          <button style={s.iconBtn} onClick={onClose}>✕</button>
        </div>

        <div style={s.modalBody}>
          <div style={s.relHeaderCard}>
            <div style={{ fontWeight: 950, fontSize: 16 }}>{task.TaskName}</div>
            <div style={s.relMeta}>
              <span><b>Workstream:</b> {task.Workstream || "-"}</span>
              <span>•</span>
              <span><b>Duration:</b> {task.DurationDays ?? "-"}</span>
              <span>•</span>
              <span><b>Target:</b> {fmtDDMMMYY(start)} → {fmtDDMMMYY(finish)}</span>
              <span>•</span>
              <span><b>Critical:</b> {(task.IsCritical === 1 || task.IsCritical === true) ? "YES" : "NO"}</span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
            <div style={s.relCard}>
              <div style={s.relTitle}>Predecessors</div>
              <div style={s.relSub}>Edges going into this task.</div>

              {preds.length === 0 ? (
                <div style={s.muted}>No predecessors.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {preds.map((e, i) => {
                    const x = fmtRel(e);
                    return (
                      <div key={i} style={s.relRow}>
                        <div style={s.relRowMain}>{x.predName}</div>
                        <div style={s.relRowMeta}>{x.type}{x.lag ? ` +${x.lag}` : ""}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={s.relCard}>
              <div style={s.relTitle}>Successors</div>
              <div style={s.relSub}>Edges going out from this task.</div>

              {succs.length === 0 ? (
                <div style={s.muted}>No successors.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {succs.map((e, i) => {
                    const x = fmtRel(e);
                    return (
                      <div key={i} style={s.relRow}>
                        <div style={s.relRowMain}>{x.succName}</div>
                        <div style={s.relRowMeta}>{x.type}{x.lag ? ` +${x.lag}` : ""}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={s.modalFooter}>
          <button style={s.btn} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* -------------------- New Project Modal (template hidden) -------------------- */
function NewProjectModal({ onClose, onCreate, loading, bufferDays }) {
  const s = makeStyles();

  const [projectName, setProjectName] = useState("");
  const [milestones, setMilestones] = useState(() => {
    const o = {};
    for (const f of MILESTONE_FIELDS) o[f.key] = "";
    return o;
  });

  const loiDate = milestones.LOI || "";
  const commContract = milestones.COMM_CONTRACT || "";

  const commissioningInternalDate = useMemo(() => {
    const d = parseISO(commContract);
    if (!d) return "";
    const x = new Date(d.getTime());
    x.setDate(x.getDate() - Number(bufferDays || 30));
    return toISO(x);
  }, [commContract, bufferDays]);

  const canSubmit = useMemo(() => {
    return projectName.trim().length > 0 && !!parseISO(loiDate) && !!parseISO(commContract);
  }, [projectName, loiDate, commContract]);

  return (
    <div style={s.modalOverlay} onMouseDown={onClose}>
      <div style={s.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <div>
            <div style={s.modalTitle}>Create New Project</div>
            <div style={s.modalSub}>
              LOI is project start. Internal commissioning = Contract - {bufferDays} days. (Template applied automatically.)
            </div>
          </div>
          <button style={s.iconBtn} onClick={onClose} disabled={loading}>✕</button>
        </div>

        <div style={s.modalBody}>
          <div style={s.formGrid}>
            <Field label="Project Name" required>
              <input
                style={s.inputWide}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g., NTPC Barethi 315MW"
                disabled={loading}
              />
            </Field>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={s.sectionTitle}>Milestones</div>
            <div style={s.sectionSub}>Required: LOI + Commissioning (as per Contract).</div>

            <div style={s.milestoneGrid}>
              {MILESTONE_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} required={!!f.required}>
                  <input
                    type="date"
                    style={s.inputWide}
                    value={milestones[f.key] || ""}
                    onChange={(e) => setMilestones((p) => ({ ...p, [f.key]: e.target.value }))}
                    disabled={loading}
                  />
                </Field>
              ))}

              <Field label="Commissioning (as per internal schedule)" hint={`Derived = Contract - ${bufferDays} days`}>
                <input type="date" style={s.inputWide} value={commissioningInternalDate} readOnly />
              </Field>
            </div>
          </div>
        </div>

        <div style={s.modalFooter}>
          <button style={s.btn} onClick={onClose} disabled={loading}>Cancel</button>
          <button
            style={{ ...s.btnPrimary, ...(!canSubmit || loading ? s.btnDisabled : {}) }}
            disabled={!canSubmit || loading}
            onClick={() => {
              onCreate({
                projectName: projectName.trim(),
                milestones: { ...milestones, COMM_INTERNAL: commissioningInternalDate },
                loiDate,
                commissioningContractDate: commContract,
                commissioningInternalDate,
              });
            }}
          >
            {loading ? (
              <>
                <Spinner size={14} /> Creating…
              </>
            ) : (
              "Create Project"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, required, hint, children }) {
  const s = makeStyles();
  return (
    <div style={s.field}>
      <div style={s.fieldLabel}>
        <span>{label}</span>
        {required && <span style={s.req}>Required</span>}
      </div>
      {children}
      {hint && <div style={s.fieldHint}>{hint}</div>}
    </div>
  );
}

/* -------------------- Task Table (per-task Add Dependency only) -------------------- */
/* -------------------- Task Table (GROUPED) -------------------- */
function TaskTable({
  tasks,
  disabled,
  dayToDate,
  fmtDDMMMYY,
  depPairs,
  onSaveDuration,
  onAddDep,
  onUpdateDep,
  onDeleteDep,
}) {
  const s = makeStyles();

  // -------- group config (Workstream -> part1 -> part2 -> part3) ----------
  function splitParts(taskName) {
    const raw = String(taskName || "").trim();
    if (!raw) return ["(Unnamed)"];
    // split strictly on " - " (not partial hyphen)
    const parts = raw.split(" - ").map((x) => x.trim()).filter(Boolean);
    // use up to 3 parts for grouping
    return parts.length ? parts.slice(0, 3) : [raw];
  }

  // Node structure:
  // { id, label, depth, children: Map, taskIds: [], agg: {durSum, minES, maxEF, count} }
function buildTree(tasksList) {
  const root = { id: "ROOT", label: "ROOT", depth: -1, children: new Map(), taskIds: [], agg: null };

  const taskById = new Map();
  (tasksList || []).forEach((t) => taskById.set(normalizeId(t.TaskId), t));

  function getOrCreate(parent, id, label, depth) {
    if (!parent.children.has(id)) {
      parent.children.set(id, { id, label, depth, children: new Map(), taskIds: [], agg: null });
    }
    return parent.children.get(id);
  }

  // Step 1) Build Workstream -> Part-1 nodes, and collect tasks "raw" under Part-1
  for (const t of tasksList || []) {
    const tid = normalizeId(t.TaskId);
    if (!tid) continue;

    const ws = String(t.Workstream || "(No Workstream)").trim() || "(No Workstream)";
    const parts = splitParts(t.TaskName); // returns up to 3 parts

    const wsNode = getOrCreate(root, `WS:${ws}`, ws, 0);

    const p1 = parts[0] || "(No Part-1)";
    const p1Node = getOrCreate(wsNode, `P1:${ws}::${p1}`, p1, 1);

    // store raw attachments for decision on Part-2 grouping
    if (!p1Node._raw) p1Node._raw = [];
    p1Node._raw.push({
      tid,
      p2: (parts[1] || "").trim(), // may be empty
      // p3 exists but we NEVER group by it; it's just part of task name leaf
    });
  }

  // Step 2) For each Part-1 node, decide whether Part-2 grouping is needed
  for (const wsNode of root.children.values()) {
    for (const p1Node of wsNode.children.values()) {
      const raw = p1Node._raw || [];

      // distinct non-empty Part-2 values under this Part-1
      const p2Set = new Set(raw.map((x) => x.p2).filter(Boolean));

      // If Part-2 doesn't differentiate (0 or 1 unique non-empty values) => attach tasks directly to Part-1
      if (p2Set.size <= 1) {
        p1Node.taskIds = raw.map((x) => x.tid);
        delete p1Node._raw;
        continue;
      }

      // Else create Part-2 groups (depth = 2) and attach tasks there
      for (const x of raw) {
        const p2Label = x.p2 || "(No Part-2)";
        const p2Node = getOrCreate(p1Node, `P2:${wsNode.label}::${p1Node.label}::${p2Label}`, p2Label, 2);
        p2Node.taskIds.push(x.tid);
      }

      delete p1Node._raw;
    }
  }

  // Step 3) Compute aggregates bottom-up
  function computeAgg(node) {
    let durSum = 0;
    let minES = null;
    let maxEF = null;
    let count = 0;

    for (const tid of node.taskIds || []) {
      const t = taskById.get(tid);
      if (!t) continue;

      const d = Number(t.DurationDays);
      if (Number.isFinite(d)) durSum += d;

      const es = Number(t.ES);
      const ef = Number(t.EF);
      if (Number.isFinite(es)) minES = minES == null ? es : Math.min(minES, es);
      if (Number.isFinite(ef)) maxEF = maxEF == null ? ef : Math.max(maxEF, ef);

      count += 1;
    }

    for (const child of node.children.values()) {
      const a = computeAgg(child);
      if (!a) continue;

      durSum += a.durSum;
      if (a.minES != null) minES = minES == null ? a.minES : Math.min(minES, a.minES);
      if (a.maxEF != null) maxEF = maxEF == null ? a.maxEF : Math.max(maxEF, a.maxEF);
      count += a.count;
    }

    node.agg = { durSum, minES, maxEF, count };
    return node.agg;
  }

  computeAgg(root);
  return { root, taskById };
}


  const { root, taskById } = useMemo(() => buildTree(tasks), [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // expanded state: default collapsed (only show Workstream groups)
  const [expanded, setExpanded] = useState(() => new Set());

  // helpers
  const toggle = (nodeId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const expandAll = () => {
    const all = new Set();
    function walk(n) {
      for (const c of n.children.values()) {
        all.add(c.id);
        walk(c);
      }
    }
    walk(root);
    setExpanded(all);
  };

  const collapseAll = () => setExpanded(new Set());

  // flatten tree into table rows
  const flatRows = useMemo(() => {
    const out = [];

    function pushGroup(node) {
      // skip ROOT
      if (node.depth >= 0) {
        out.push({ kind: "group", node });
      }

      const isOpen = node.depth < 0 ? true : expanded.has(node.id);
      if (!isOpen) return;

      // children first (so structure is visible)
      for (const child of node.children.values()) {
        pushGroup(child);
      }

      // then tasks directly under this group
      for (const tid of node.taskIds || []) {
        const t = taskById.get(tid);
        if (t) out.push({ kind: "task", task: t });
      }
    }

    const wsNodes = Array.from(root.children.values());

const WS_PRIORITY = ["INPUT", "DESIGN"]; // required order
wsNodes.sort((a, b) => {
  const A = String(a.label || "").toUpperCase();
  const B = String(b.label || "").toUpperCase();

  const ia = WS_PRIORITY.indexOf(A);
  const ib = WS_PRIORITY.indexOf(B);

  if (ia !== -1 || ib !== -1) {
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  }
  return A.localeCompare(B);
});

for (const wsNode of wsNodes) pushGroup(wsNode);


    return out;
  }, [root, taskById, expanded]);

  return (
    <div style={{ padding: 14, overflowX: "auto" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <button style={s.btn} onClick={expandAll} disabled={disabled}>
          Expand All
        </button>
        <button style={s.btn} onClick={collapseAll} disabled={disabled}>
          Collapse All
        </button>
      </div>

      <table style={s.table}>
        <thead>
          <tr>
            {["Workstream / Group / Task", "Dur", "Target Start", "Target Finish", "Float", "Critical", "Dependencies (Add Only)"].map(
              (h) => (
                <th key={h} style={s.th}>
                  {h}
                </th>
              )
            )}
          </tr>
        </thead>

        <tbody>
          {flatRows.map((r, idx) => {
            if (r.kind === "group") {
              return (
                <GroupRow
                  key={r.node.id}
                  node={r.node}
                  expanded={expanded.has(r.node.id)}
                  onToggle={() => toggle(r.node.id)}
                  dayToDate={dayToDate}
                  fmtDDMMMYY={fmtDDMMMYY}
                  disabled={disabled}
                />
              );
            }

            // task row (FULL columns)
            return (
              <TaskRow
                key={normalizeId(r.task.TaskId)}
                rowIndex={idx}
                task={r.task}
                tasks={tasks}
                depPairs={depPairs}
                disabled={disabled}
                dayToDate={dayToDate}
                fmtDDMMMYY={fmtDDMMMYY}
                onSaveDuration={onSaveDuration}
                onAddDep={onAddDep}
                onUpdateDep={onUpdateDep}
                onDeleteDep={onDeleteDep}
              />
            );
          })}

          {!tasks?.length && (
            <tr>
              <td colSpan={7} style={{ padding: 14, color: "#475569" }}>
                No tasks found.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={s.note}>
        Dates shown are Target Dates (LOI + ES/EF). Group rows are aggregated: Start = min(ES), Finish = max(EF), Dur = sum(DurationDays).
      </div>
    </div>
  );
}

function GroupRow({ node, expanded, onToggle, dayToDate, fmtDDMMMYY, disabled }) {
  const s = makeStyles();

  const hasChildren = node.children && node.children.size > 0;
  const hasTasks = (node.taskIds || []).length > 0;
  const canToggle = hasChildren || hasTasks;

  const a = node.agg || { durSum: 0, minES: null, maxEF: null, count: 0 };
  const start = a.minES == null ? null : dayToDate(a.minES);
  const finish = a.maxEF == null ? null : dayToDate(a.maxEF);

  const indentPx = 12 + node.depth * 16;

  return (
    <tr style={{ background: "#f1f5f9" }}>
      <td style={{ ...s.td, fontWeight: 950 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: indentPx }}>
          <button
            type="button"
            onClick={onToggle}
            disabled={disabled || !canToggle}
            style={{
              width: 28,
              height: 28,
              borderRadius: 10,
              border: "1px solid #e5eaf0",
              background: "#fff",
              cursor: disabled || !canToggle ? "not-allowed" : "pointer",
              fontWeight: 950,
            }}
            title={canToggle ? "Expand/Collapse" : "No children"}
          >
            {canToggle ? (expanded ? "–" : "+") : "·"}
          </button>

          <div style={{ minWidth: 0 }}>
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {node.label} <span style={{ color: "#64748b", fontWeight: 900 }}>({a.count})</span>
            </div>
          </div>
        </div>
      </td>

      {/* Group row: ONLY Dur + Target Start/Finish */}
      <td style={s.tdMono}>{Number.isFinite(Number(a.durSum)) ? a.durSum : ""}</td>
      <td style={s.tdMono}>{start ? fmtDDMMMYY(start) : ""}</td>
      <td style={s.tdMono}>{finish ? fmtDDMMMYY(finish) : ""}</td>

      {/* No Float/Critical/Deps at group level */}
      <td style={s.tdMono}></td>
      <td style={s.tdMono}></td>
      <td style={s.td}></td>
    </tr>
  );
}

/* -------------------- Individual Task Row (UNCHANGED behavior) -------------------- */
function TaskRow({
  rowIndex,
  task,
  tasks,
  depPairs,
  disabled,
  dayToDate,
  fmtDDMMMYY,
  onSaveDuration,
  onAddDep,
  onUpdateDep,
  onDeleteDep,
}) {
  const s = makeStyles();
  const isCrit = task.IsCritical === 1 || task.IsCritical === true;

  const [dur, setDur] = useState(task.DurationDays ?? "");
  useEffect(() => setDur(task.DurationDays ?? ""), [task.DurationDays]);

  const startDt = dayToDate(task.ES);
  const finishDt = dayToDate(task.EF);

  return (
    <tr style={{ background: isCrit ? "#fff7ed" : rowIndex % 2 === 0 ? "#ffffff" : "#fbfdff" }}>
      {/* Workstream / Task */}
      <td style={s.td}>
        <div style={{ fontWeight: 800, color: "#64748b", fontSize: 12 }}>{task.Workstream ?? ""}</div>
        <div style={{ fontWeight: 950 }}>{task.TaskName ?? ""}</div>
      </td>

      {/* Dur + Save */}
      <td style={s.td}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            style={s.tdInput}
            value={dur}
            onChange={(e) => setDur(e.target.value)}
            disabled={disabled}
            type="number"
            min="0"
          />
          <button
            style={{ ...s.smallBtnDark, ...(disabled ? s.btnDisabled : {}) }}
            onClick={() => onSaveDuration(task.TaskId, dur === "" ? 0 : Number(dur))}
            disabled={disabled}
          >
            Save
          </button>
        </div>
      </td>

      {/* Target Start/Finish */}
      <td style={s.tdMono}>{fmtDDMMMYY(startDt)}</td>
      <td style={s.tdMono}>{fmtDDMMMYY(finishDt)}</td>

      {/* Float/Critical */}
      <td style={s.tdMono}>{task.TotalFloat ?? ""}</td>
      <td style={{ ...s.tdMono, fontWeight: 950, color: isCrit ? "#b45309" : "#0f172a" }}>{isCrit ? "YES" : ""}</td>

      {/* Dependencies */}
      <td style={{ ...s.td, minWidth: 520 }}>
        <PerTaskDependencies
          tasks={tasks}
          depPairs={depPairs}
          successorTaskId={task.TaskId}
          disabled={disabled}
          onAdd={onAddDep}
          onUpdateDep={onUpdateDep}
          onDeleteDep={onDeleteDep}
        />
      </td>
    </tr>
  );
}

function PerTaskDependencies({
  tasks,
  depPairs,
  successorTaskId,
  disabled,
  onAdd,
  onUpdateDep,
  onDeleteDep,
}) {
  const s = makeStyles();
  const succ = normalizeId(successorTaskId);

  const taskLabelById = useMemo(() => {
    const m = new Map();
    (tasks || []).forEach((t) => {
      m.set(normalizeId(t.TaskId), `${t.Workstream || ""} — ${t.TaskName || ""}`.trim());
    });
    return m;
  }, [tasks]);
  const succLabel = taskLabelById.get(succ) || `TaskId ${succ}`;
  // existing deps INTO this successor
  const existing = useMemo(() => {
    return (depPairs || [])
      .filter((e) => normalizeId(e.succId) === succ && Number.isFinite(Number(e.depId)))
      .map((e) => ({
        depId: Number(e.depId),
        predId: normalizeId(e.predId),
        type: String(e.type || "FS").toUpperCase(),
        lag: Number(e.lag || 0),
      }));
  }, [depPairs, succ]);

  // Add-new controls
  const [pred, setPred] = useState("");
  const [type, setType] = useState("FS");
  const [lag, setLag] = useState("0");

  const options = (tasks || [])
    .filter((t) => normalizeId(t.TaskId) !== succ)
    .map((t) => ({
      id: normalizeId(t.TaskId),
      label: `${t.Workstream || ""} — ${t.TaskName || ""}`.trim(),
    }));

  const canAdd =
    !disabled &&
    pred &&
    normalizeId(pred) !== succ &&
    !isDuplicateEdge(depPairs, pred, succ) &&
    !wouldCreateCycle(depPairs, pred, succ);

  const dup = pred && isDuplicateEdge(depPairs, pred, succ);
  const cyc = pred && wouldCreateCycle(depPairs, pred, succ);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* Existing dependencies list */}
      <div style={s.depListBox}>
        <div style={s.depListTitle}>Predecessors</div>

        {existing.length === 0 ? (
          <div style={s.muted}>No dependencies for this task.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {existing.map((d) => (
              <DepRow
                key={d.depId}
                dep={d}
                fromLabel={taskLabelById.get(d.predId) || `TaskId ${d.predId}`}
                toLabel={succLabel}
                disabled={disabled}
                onSave={(next) => onUpdateDep(next)}
                onDelete={(id) => onDeleteDep({ taskDependencyId: id })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add new dependency */}
      <div style={s.perTaskDepWrap}>
        <div style={s.perTaskDepTitle}>Add Dependency</div>

        <select
          value={pred}
          onChange={(e) => setPred(e.target.value)}
          disabled={disabled}
          style={s.addDepSelect}
        >
          <option value="">Predecessor Task</option>
          {options.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>

        <select value={type} onChange={(e) => setType(e.target.value)} disabled={disabled} style={s.typeSelect}>
          <option value="FS">FS</option>
          <option value="SS">SS</option>
          <option value="FF">FF</option>
          <option value="SF">SF</option>
        </select>

        <input
          type="number"
          value={lag}
          onChange={(e) => setLag(e.target.value)}
          disabled={disabled}
          style={s.addDepLag}
          title="Lag (days)"
        />

        <button
          style={{ ...s.smallBtnDark, ...(!canAdd ? s.btnDisabled : {}) }}
          disabled={!canAdd}
          onClick={() => {
            onAdd({
              predecessorTaskId: Number(pred),
              successorTaskId: Number(succ),
              linkType: type,
              lagDays: lag === "" ? 0 : Number(lag) || 0,
            });
            setPred("");
            setType("FS");
            setLag("0");
          }}
        >
          Add
        </button>

        {(dup || cyc) && <div style={s.depInlineWarn}>{dup ? "Duplicate blocked." : "Cycle blocked."}</div>}
      </div>
    </div>
  );
}

function DepRow({ dep, fromLabel, toLabel, disabled, onSave, onDelete }) {
  const s = makeStyles();

  const [type, setType] = useState(dep.type || "FS");
  const [lag, setLag] = useState(String(dep.lag ?? 0));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setType(dep.type || "FS");
    setLag(String(dep.lag ?? 0));
    setDirty(false);
  }, [dep.depId, dep.type, dep.lag]);

  const hasId = Number.isFinite(Number(dep.depId));
  const canSave = !disabled && dirty && hasId;

  return (
    <div style={s.depRow2}>
      <div style={s.depFromTo}>
        <div style={s.depLine} title={fromLabel}>
          <span style={s.depText}>{fromLabel}</span>
        </div>
      
        {!hasId && (
          <div style={s.depInlineWarn}>
            Missing TaskDependencyId from API. Update/Delete disabled.
          </div>
        )}
      </div>

      <select
        value={type}
        disabled={disabled || !hasId}
        onChange={(e) => {
          setType(e.target.value);
          setDirty(true);
        }}
        style={s.typeSelectSmall}
      >
        <option value="FS">FS</option>
        <option value="SS">SS</option>
        <option value="FF">FF</option>
        <option value="SF">SF</option>
      </select>

      <input
        type="number"
        value={lag}
        disabled={disabled || !hasId}
        onChange={(e) => {
          setLag(e.target.value);
          setDirty(true);
        }}
        style={s.addDepLagSmall}
        title="Lag (days)"
      />

      <button
        style={{ ...s.smallBtnDark, ...(!canSave ? s.btnDisabled : {}) }}
        disabled={!canSave}
        onClick={() =>
          onSave({
            taskDependencyId: dep.depId,
            linkType: type,
            lagDays: lag === "" ? 0 : Number(lag) || 0,
          })
        }
      >
        Save
      </button>

      <button
        style={{ ...s.smallBtnDanger, ...(disabled || !hasId ? s.btnDisabled : {}) }}
        disabled={disabled || !hasId}
        onClick={() => onDelete(dep.depId)}
      >
        Delete
      </button>
    </div>
  );
}


/* -------------------- Date-based Gantt WITH CONNECTORS + CLICK + DRAG-TO-LINK -------------------- */
function GanttDates({ tasks, deps, depPairs, startDate, compact = false, onTaskClick, onDragLink }) {
  const s = makeStyles();

  const containerRef = useRef(null);
  const [drag, setDrag] = useState(null); // { fromId, x, y, startX, startY }

  const valid = (tasks || [])
    .map((t) => ({
      ...t,
      ES: Number.isFinite(Number(t.ES)) ? Number(t.ES) : 0,
      EF: Number.isFinite(Number(t.EF)) ? Number(t.EF) : 0,
    }))
    .map((t) => ({ ...t, EF: t.EF < t.ES ? t.ES : t.EF }));

  if (!valid.length) return null;

  const PX_PER_DAY = compact ? 8 : 10;
  const LEFT_COL_W = compact ? 320 : 420;
  const ROW_H = compact ? 26 : 30;
  const BAR_H = compact ? 10 : 14;
  const HEADER_H = compact ? 26 : 32;

  const minStart = Math.min(...valid.map((t) => t.ES));
  const maxFinish = Math.max(...valid.map((t) => t.EF));
  const totalDays = Math.max(1, maxFinish - minStart);
  const timelineW = totalDays * PX_PER_DAY;
  const canvasW = LEFT_COL_W + timelineW;
  const canvasH = HEADER_H + valid.length * ROW_H;

  const tickStep = compact ? 14 : 7;

  const dayToDate = (dayNo) => {
    const n = Number(dayNo);
    if (!Number.isFinite(n)) return null;
    const d = new Date(startDate.getTime());
    d.setDate(d.getDate() + n);
    return d;
  };

  const fmt = (d) => {
    if (!(d instanceof Date) || isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  };

  // geometry map for hit testing (drop target)
  const geom = useMemo(() => {
    const m = new Map();
    valid.forEach((t, idx) => {
      const rowTop = HEADER_H + idx * ROW_H;
      const xStart = LEFT_COL_W + (t.ES - minStart) * PX_PER_DAY;
      const xEnd = LEFT_COL_W + (t.EF - minStart) * PX_PER_DAY;
      const barTop = rowTop + (ROW_H - BAR_H) / 2;
      m.set(normalizeId(t.TaskId), {
        t,
        idx,
        rowTop,
        rowBottom: rowTop + ROW_H,
        xStart,
        xEnd,
        barTop,
        barBottom: barTop + BAR_H,
        yMid: rowTop + ROW_H / 2,
      });
    });
    return m;
  }, [valid, HEADER_H, ROW_H, BAR_H, LEFT_COL_W, minStart, PX_PER_DAY]);

  // normalize edges pred->succ
  const edges = useMemo(() => {
    const out = [];
    (deps || []).forEach((d) => {
      const pred = normalizeId(getPredFromRaw(d));
      const succ = normalizeId(getSuccFromRaw(d));
      if (!pred || !succ) return;
      const from = geom.get(pred);
      const to = geom.get(succ);
      if (!from || !to) return;

      const type = String(d.LinkType ?? d.linkType ?? "FS").toUpperCase();
      const lag = Number(d.LagDays ?? d.lagDays ?? 0) || 0;

      out.push({ pred, succ, type, lag, from, to });
    });
    return out;
  }, [deps, geom]);

  function getPredFromRaw(d) {
    return d.PredecessorTaskId ?? d.predecessorTaskId ?? d.PredecessorId ?? d.predId ?? d.predTaskId;
  }
  function getSuccFromRaw(d) {
    return d.SuccessorTaskId ?? d.successorTaskId ?? d.SuccessorId ?? d.succId ?? d.succTaskId;
  }

  const getAnchorX = (g, which) => (which === "start" ? g.xStart : g.xEnd);
  const resolveAnchors = (e) => {
    let fromWhich = "end";
    let toWhich = "start";
    if (e.type === "SS") { fromWhich = "start"; toWhich = "start"; }
    else if (e.type === "FF") { fromWhich = "end"; toWhich = "end"; }
    else if (e.type === "SF") { fromWhich = "start"; toWhich = "end"; }
    return {
      x1: getAnchorX(e.from, fromWhich),
      y1: e.from.yMid,
      x2: getAnchorX(e.to, toWhich),
      y2: e.to.yMid,
    };
  };

  function startDrag(fromTaskId, clientX, clientY) {
    if (!onDragLink) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    setDrag({
      fromId: normalizeId(fromTaskId),
      startX: x,
      startY: y,
      x,
      y,
    });

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function onMove(e) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDrag((p) => (p ? { ...p, x, y } : p));
  }

  function findDropTarget(x, y) {
    // must drop on a bar region (not just row)
    for (const [id, g] of geom.entries()) {
      if (x >= g.xStart && x <= g.xEnd && y >= g.barTop && y <= g.barBottom) {
        return id;
      }
    }
    return null;
  }

  function onUp(e) {
    try {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      setDrag((cur) => {
        if (!cur) return null;
        const toId = findDropTarget(x, y);

        if (toId && toId !== cur.fromId) {
          // UI-level quick checks before calling handler (extra safety)
          if (isDuplicateEdge(depPairs || [], cur.fromId, toId)) return null;
          if (wouldCreateCycle(depPairs || [], cur.fromId, toId)) return null;

          onDragLink?.(Number(cur.fromId), Number(toId));
        }
        return null;
      });
    } finally {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
  }

  return (
    <div style={{ padding: compact ? 12 : 14 }}>
      <div style={{ overflowX: "auto", border: "1px solid #e5eaf0", borderRadius: 14, background: "#fff" }}>
        <div
          ref={containerRef}
          style={{ position: "relative", width: canvasW, height: canvasH }}
        >
          {/* left header */}
          <div style={{ position: "absolute", left: 0, top: 0, width: LEFT_COL_W, height: HEADER_H, ...s.ganttHeader }}>
            Task
          </div>

          {/* timeline header */}
          <div style={{ position: "absolute", left: LEFT_COL_W, top: 0, width: timelineW, height: HEADER_H, ...s.ganttHeader }}>
            {Array.from({ length: totalDays + 1 }).map((_, i) => {
              if (i % tickStep !== 0) return null;
              const dt = dayToDate(minStart + i);
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: i * PX_PER_DAY,
                    top: 0,
                    height: HEADER_H,
                    borderLeft: "1px solid #eef2f7",
                    fontSize: 11,
                    color: "#64748b",
                    paddingLeft: 6,
                    display: "flex",
                    alignItems: "center",
                    whiteSpace: "nowrap",
                    userSelect: "none",
                  }}
                >
                  {fmt(dt)}
                </div>
              );
            })}
          </div>

          {/* ROWS */}
          <div style={{ position: "absolute", left: 0, top: HEADER_H, width: canvasW, zIndex: 2 }}>
            {valid.map((t) => {
              const isCrit = t.IsCritical === 1 || t.IsCritical === true;
              const w = Math.max(1, (t.EF - t.ES) * PX_PER_DAY);

              const sDt = dayToDate(t.ES);
              const fDt = dayToDate(t.EF);

              const barLeft = (t.ES - minStart) * PX_PER_DAY;

              return (
                <div
                  key={normalizeId(t.TaskId)}
                  style={{
                    display: "flex",
                    height: ROW_H,
                    borderBottom: "1px solid #eef2f7",
                  }}
                >
                  <div style={{ width: LEFT_COL_W, padding: "6px 10px", overflow: "hidden" }}>
                    <div style={{ fontWeight: 950, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t.TaskName}
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b", fontWeight: 800 }}>
                      {t.Workstream} • {fmt(sDt)} → {fmt(fDt)}
                    </div>
                  </div>

                  <div style={{ position: "relative", width: timelineW, background: "#fafafa" }}>
                    <button
                      type="button"
                      onClick={() => onTaskClick && onTaskClick(t.TaskId)}
                      onMouseDown={(e) => startDrag(t.TaskId, e.clientX, e.clientY)}
                      style={{
                        position: "absolute",
                        left: barLeft,
                        top: (ROW_H - BAR_H) / 2,
                        height: BAR_H,
                        width: w,
                        borderRadius: 7,
                        background: isCrit ? "#f59e0b" : "#94a3b8",
                        border: "1px solid rgba(15,23,42,0.15)",
                        cursor: onDragLink ? "crosshair" : "pointer",
                        padding: 0,
                      }}
                      title={onDragLink ? "Click for details. Drag to link." : "Click to view predecessors/successors"}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* SVG overlay for dependency connectors */}
          <svg
            width={canvasW}
            height={canvasH}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              pointerEvents: "none",
              zIndex: 6,
            }}
          >
            <defs>
              <marker id="arrowGantt" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
                <path d="M0,0 L9,3 L0,6 Z" fill="#111" />
              </marker>
            </defs>

            {edges.map((e, idx) => {
              const { x1, y1, x2, y2 } = resolveAnchors(e);
              const dir = x2 >= x1 ? 1 : -1;
              const gap = 14;
              const midX = x1 + dir * gap;
              const d = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;

              return (
                <path
                  key={idx}
                  d={d}
                  fill="none"
                  stroke="#111"
                  strokeWidth="1.4"
                  opacity="0.55"
                  markerEnd="url(#arrowGantt)"
                />
              );
            })}

            {/* Drag preview line */}
            {drag && (
              <>
                <path
                  d={`M ${drag.startX} ${drag.startY} L ${drag.x} ${drag.y}`}
                  fill="none"
                  stroke="#0f172a"
                  strokeWidth="1.8"
                  opacity="0.65"
                  markerEnd="url(#arrowGantt)"
                />
              </>
            )}
          </svg>
        </div>
      </div>

      {!compact && (
        <div style={s.note}>
          Tip: Drag bar → bar to create dependency (FS + 0). Add non-FS links + lag from Task Table.
        </div>
      )}
    </div>
  );
}

/* -------------------- Network Diagram -------------------- */
function NetworkDiagram({ tasks, deps, getPredId, getSuccId, getDepId, getLag, getType }) {
  const normId = (v) => (v == null ? null : String(v));

  // ✅ keep only critical tasks
  const criticalTasks = useMemo(() => {
    return (tasks || []).filter((t) => t.IsCritical === 1 || t.IsCritical === true);
  }, [tasks]);

  const criticalIdSet = useMemo(() => {
    return new Set(criticalTasks.map((t) => normId(t.TaskId)));
  }, [criticalTasks]);

  const { nodes, edges, w, h } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    const NODE_W = 240;
    const NODE_H = 70;

    // ✅ nodes: critical only
    for (const t of criticalTasks) g.setNode(normId(t.TaskId), { width: NODE_W, height: NODE_H });

    // ✅ edges: only between critical nodes
    const edgeList = [];
    (deps || []).forEach((d) => {
      const pred = normId(getPredId(d));
      const succ = normId(getSuccId(d));
      if (!pred || !succ) return;

      if (!criticalIdSet.has(pred) || !criticalIdSet.has(succ)) return;

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

    const nodeList = criticalTasks.map((t) => {
      const n = g.node(normId(t.TaskId));
      return { id: normId(t.TaskId), task: t, x: n?.x ?? 0, y: n?.y ?? 0, w: NODE_W, h: NODE_H };
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
  }, [criticalTasks, deps, getPredId, getSuccId, getDepId, getLag, getType, criticalIdSet]);

  if (!nodes.length) {
    const s = makeStyles();
    return <div style={{ padding: 14, color: "#64748b", fontWeight: 900 }}>No critical path tasks to display.</div>;
  }

  const s = makeStyles();

  return (
    <div style={{ padding: 14 }}>
      <div style={s.note}>Showing only Critical Path nodes + their internal dependencies.</div>
      <div style={{ overflow: "auto", border: "1px solid #e5eaf0", borderRadius: 14, background: "#fff" }}>
        <svg width={w} height={h} style={{ background: "#fff" }}>
          <defs>
            <marker id="arrowNet" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
              <path d="M0,0 L9,3 L0,6 Z" fill="#111" />
            </marker>
          </defs>

          {edges.map((e) => (
            <g key={e.id}>
              <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#111" strokeWidth="1.6" markerEnd="url(#arrowNet)" opacity="0.85" />
              <text x={(e.x1 + e.x2) / 2} y={(e.y1 + e.y2) / 2 - 6} fontSize="11" fill="#444">
                {e.label}
              </text>
            </g>
          ))}

          {nodes.map((n) => {
            const x = n.x - n.w / 2;
            const y = n.y - n.h / 2;
            return (
              <g key={n.id}>
                <rect x={x} y={y} width={n.w} height={n.h} rx="10" ry="10" fill="#fff7ed" stroke="#f59e0b" strokeWidth="3" />
                <text x={x + 10} y={y + 22} fontSize="12" fontWeight="700" fill="#111">
                  {n.task.TaskName}
                </text>
                <text x={x + 10} y={y + 42} fontSize="11" fill="#333">
                  {n.task.Workstream} | ES {n.task.ES ?? ""} EF {n.task.EF ?? ""}
                </text>
                <text x={x + 10} y={y + 58} fontSize="11" fill="#444">
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


/* =========================================================
   Date helpers
   ========================================================= */
function parseISO(s) {
  if (!s) return null;
  const d = new Date(String(s).slice(0, 10) + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}
function toISO(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* =========================================================
   Styles
   ========================================================= */
function makeStyles() {
  const pageBg = "#f6f8fb";
  const cardBg = "#ffffff";
  const border = "#e5eaf0";
  const text = "#0f172a";
  const sub = "#64748b";
  const dark = "#0f172a";

  return {
    page: {
      minHeight: "100vh",
      background: pageBg,
      color: text,
      fontFamily:
        'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "Liberation Sans", sans-serif',
    },

    topbar: {
      position: "sticky",
      top: 0,
      zIndex: 50,
      background: cardBg,
      borderBottom: `1px solid ${border}`,
      padding: "12px 18px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },

    brandWrap: { display: "flex", alignItems: "center", gap: 10 },
    brandDot: { width: 34, height: 34, borderRadius: 10, background: "linear-gradient(135deg, #0f172a, #1f2937)" },
    brandTitle: { fontWeight: 950, letterSpacing: 0.2 },
    brandSub: { fontSize: 12, color: sub, fontWeight: 800 },

    tabs: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    tabBtn: {
      border: `1px solid ${border}`,
      background: "#fff",
      color: text,
      padding: "8px 10px",
      borderRadius: 10,
      fontWeight: 900,
      cursor: "pointer",
    },
    tabBtnActive: {
      border: "1px solid #0ea5a4",
      boxShadow: "0 0 0 3px rgba(14,165,164,0.10)",
    },

    topActions: { display: "flex", alignItems: "center", gap: 10 },

    content: { maxWidth: 1600, margin: "0 auto", padding: "16px 18px 28px" },

    projectBar: {
      background: cardBg,
      border: `1px solid ${border}`,
      borderRadius: 14,
      padding: 14,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    },
    projectLeft: { display: "flex", flexDirection: "column", gap: 6 },
    projectName: { fontWeight: 950, fontSize: 18 },
    projectMeta: { display: "flex", gap: 10, flexWrap: "wrap", color: sub, fontSize: 12, fontWeight: 900 },

    projectRight: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
    inlineLabel: { display: "flex", alignItems: "center", gap: 8, fontWeight: 900, color: "#334155" },
    input: {
      width: 90,
      padding: "8px 10px",
      borderRadius: 10,
      border: `1px solid ${border}`,
      outline: "none",
      background: "#fff",
    },

    btn: {
      padding: "8px 12px",
      borderRadius: 10,
      border: `1px solid ${border}`,
      background: "#ffffff",
      color: text,
      fontWeight: 900,
      cursor: "pointer",
    },
    btnDark: {
      padding: "8px 12px",
      borderRadius: 10,
      border: `1px solid ${dark}`,
      background: dark,
      color: "#fff",
      fontWeight: 950,
      cursor: "pointer",
    },
    btnPrimary: {
      padding: "10px 14px",
      borderRadius: 12,
      border: "1px solid #0ea5a4",
      background: "#0ea5a4",
      color: "#ffffff",
      fontWeight: 950,
      cursor: "pointer",
    },
    btnDisabled: { opacity: 0.55, cursor: "not-allowed" },

    error: {
      marginTop: 12,
      background: "#fef2f2",
      border: "1px solid #fecaca",
      color: "#991b1b",
      padding: "10px 12px",
      borderRadius: 12,
      fontWeight: 900,
    },
    warn: {
      marginTop: 12,
      background: "#fff7ed",
      border: "1px solid #fed7aa",
      color: "#92400e",
      padding: "10px 12px",
      borderRadius: 12,
      fontWeight: 900,
    },

    card: {
      marginTop: 14,
      background: cardBg,
      border: `1px solid ${border}`,
      borderRadius: 14,
      boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      overflow: "hidden",
    },
    cardHeader: {
      padding: 14,
      borderBottom: `1px solid ${border}`,
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 10,
      flexWrap: "wrap",
    },
    cardHeaderRight: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
    cardTitle: { fontWeight: 950, fontSize: 16 },
    cardSub: { fontSize: 12, color: sub, fontWeight: 800 },

    kpiGrid: {
      padding: 14,
      display: "grid",
      gridTemplateColumns: "repeat(4, minmax(180px, 1fr))",
      gap: 12,
    },
    kpiCard: {
      background: "#f8fafc",
      border: `1px solid ${border}`,
      borderRadius: 14,
      padding: 14,
      textAlign: "center",
    },
    kpiValue: { fontWeight: 950, fontSize: 28, color: "#0ea5a4" },
    kpiLabel: { marginTop: 6, fontWeight: 900, color: "#334155" },

    listRow: { padding: "10px 0", borderBottom: `1px solid ${border}` },
    listMeta: { fontSize: 12, color: sub, fontWeight: 800, marginTop: 2 },
    muted: { color: sub, fontWeight: 800 },

    table: { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 },
    th: {
      textAlign: "left",
      padding: "10px 10px",
      background: "#f1f5f9",
      borderBottom: `1px solid ${border}`,
      fontWeight: 950,
      color: text,
      whiteSpace: "nowrap",
      position: "sticky",
      top: 0,
      zIndex: 1,
    },
    td: { padding: "10px 10px", borderBottom: "1px solid #eef2f7", verticalAlign: "top", color: text },
    tdMono: { padding: "10px 10px", borderBottom: "1px solid #eef2f7", verticalAlign: "top", color: text, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
    tdInput: { width: 72, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, outline: "none" },

    smallBtnDark: {
      padding: "6px 10px",
      borderRadius: 10,
      border: `1px solid ${dark}`,
      background: dark,
      color: "#fff",
      fontWeight: 950,
      cursor: "pointer",
    },

    ganttHeader: { display: "flex", alignItems: "center", paddingLeft: 10, fontWeight: 950, color: "#334155", background: "#fff", borderBottom: `1px solid ${border}` },

    note: { marginTop: 10, fontSize: 12, color: sub, fontWeight: 800 },

    overlay: {
      position: "fixed",
      inset: 0,
      background: "rgba(15, 23, 42, 0.25)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 9999,
    },
    overlayCard: {
      background: "#ffffff",
      border: `1px solid ${border}`,
      borderRadius: 12,
      padding: "16px 18px",
      minWidth: 420,
      boxShadow: "0 10px 25px rgba(0,0,0,0.12)",
      display: "flex",
      gap: 12,
      alignItems: "center",
    },
    overlayTitle: { fontWeight: 950, color: text },
    overlaySub: { fontSize: 12, color: sub, fontWeight: 800 },

    modalOverlay: {
      position: "fixed",
      inset: 0,
      background: "rgba(15,23,42,0.35)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 10000,
      padding: 16,
    },
    modal: {
      width: "min(980px, 100%)",
      background: "#fff",
      borderRadius: 16,
      border: `1px solid ${border}`,
      boxShadow: "0 25px 70px rgba(0,0,0,0.30)",
      overflow: "hidden",
    },
    modalHeader: {
      padding: 14,
      borderBottom: `1px solid ${border}`,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
    },
    modalTitle: { fontWeight: 950, fontSize: 16 },
    modalSub: { fontSize: 12, color: sub, fontWeight: 800, marginTop: 4 },
    iconBtn: {
      border: `1px solid ${border}`,
      background: "#fff",
      borderRadius: 10,
      width: 36,
      height: 36,
      cursor: "pointer",
      fontWeight: 950,
    },
    modalBody: { padding: 14 },
    modalFooter: {
      padding: 14,
      borderTop: `1px solid ${border}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: 10,
    },
    formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
    milestoneGrid: { marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 },

    field: { display: "flex", flexDirection: "column", gap: 6 },
    fieldLabel: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontWeight: 950, fontSize: 12 },
    fieldHint: { fontSize: 12, color: sub, fontWeight: 800 },
    req: {
      fontSize: 11,
      padding: "2px 8px",
      borderRadius: 999,
      background: "#fff7ed",
      border: "1px solid #fed7aa",
      color: "#b45309",
      fontWeight: 950,
    },
    inputWide: {
      width: "100%",
      padding: "10px 10px",
      borderRadius: 12,
      border: `1px solid ${border}`,
      outline: "none",
      background: "#fff",
    },

    relHeaderCard: {
      background: "#f8fafc",
      border: "1px solid #e5eaf0",
      borderRadius: 14,
      padding: 12,
    },
    relMeta: { display: "flex", gap: 10, flexWrap: "wrap", color: sub, fontSize: 12, fontWeight: 900, marginTop: 6 },
    relCard: {
      background: "#ffffff",
      border: "1px solid #e5eaf0",
      borderRadius: 14,
      padding: 12,
    },
    relTitle: { fontWeight: 950 },
    relSub: { fontSize: 12, color: sub, fontWeight: 800, marginTop: 4, marginBottom: 10 },
    relRow: { padding: "10px 10px", border: "1px solid #eef2f7", borderRadius: 12, background: "#fff", display: "flex", justifyContent: "space-between", gap: 10 },
    relRowMain: { fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    relRowMeta: { fontSize: 12, color: sub, fontWeight: 900, whiteSpace: "nowrap" },

    sectionTitle: { fontWeight: 950, fontSize: 14 },
    sectionSub: { fontSize: 12, color: sub, fontWeight: 800, marginTop: 4 },

    // per-task add dep
    perTaskDepWrap: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
      padding: "8px 10px",
      border: "1px solid #e5eaf0",
      borderRadius: 12,
      background: "#fff",
    },
    perTaskDepTitle: { fontWeight: 950, color: "#334155", fontSize: 12, marginRight: 4 },
    addDepSelect: {
      width: 260,
      padding: "6px 8px",
      borderRadius: 10,
      border: "1px solid #e5eaf0",
      background: "#fff",
      outline: "none",
    },
    typeSelect: {
      width: 80,
      padding: "6px 8px",
      borderRadius: 10,
      border: "1px solid #e5eaf0",
      background: "#fff",
      outline: "none",
    },
    addDepLag: {
      width: 80,
      padding: "6px 8px",
      borderRadius: 10,
      border: "1px solid #e5eaf0",
      outline: "none",
    },
    depInlineWarn: { color: "#b91c1c", fontSize: 12, fontWeight: 900, marginLeft: 6 },
    depListBox: {
      border: "1px solid #e5eaf0",
      borderRadius: 12,
      padding: 10,
      background: "#fff",
    },
    depListTitle: { fontWeight: 950, color: "#334155", fontSize: 12, marginBottom: 8 },
    
    depRow: {
      display: "grid",
      gridTemplateColumns: "1fr 90px 90px 80px 80px",
      gap: 8,
      alignItems: "center",
      border: "1px solid #eef2f7",
      borderRadius: 12,
      padding: "8px 10px",
      background: "#fff",
    },
    depPred: {
      fontWeight: 900,
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
    typeSelectSmall: {
      width: 90,
      padding: "6px 8px",
      borderRadius: 10,
      border: "1px solid #e5eaf0",
      background: "#fff",
      outline: "none",
    },
    addDepLagSmall: {
      width: 90,
      padding: "6px 8px",
      borderRadius: 10,
      border: "1px solid #e5eaf0",
      outline: "none",
    },
    smallBtnDanger: {
      padding: "6px 10px",
      borderRadius: 10,
      border: "1px solid #b91c1c",
      background: "#b91c1c",
      color: "#fff",
      fontWeight: 950,
      cursor: "pointer",
    },
    depRow2: {
  display: "grid",
  gridTemplateColumns: "1fr 90px 90px 80px 80px",
  gap: 8,
  alignItems: "center",
  border: "1px solid #eef2f7",
  borderRadius: 12,
  padding: "10px 10px",
  background: "#fff",
},

depFromTo: {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 0,
},

depLine: {
  display: "flex",
  alignItems: "flex-start",
  gap: 0,
  minWidth: 0,
},

depTag: {
  fontSize: 10,
  fontWeight: 950,
  padding: "2px 8px",
  borderRadius: 999,
  background: "#f1f5f9",
  border: "1px solid #e5eaf0",
  color: "#334155",
  flex: "0 0 auto",
},

depText: {
  fontWeight: 900,
  color: "#0f172a",
  whiteSpace: "normal",     // ✅ allow wrap
  overflow: "visible",
  lineHeight: 1.2,
},

  };
}
