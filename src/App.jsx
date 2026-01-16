import { useEffect, useMemo, useState } from "react";
import dagre from "dagre";
import { API_BASE } from "./config";

/**
 * MSP Lite — App.jsx (Professional + New Project + Date-based targets)
 *
 * Your requirements implemented in UI (WITHOUT breaking existing API contract):
 * 1) Target dates shown as dd-MMM-yy (NOT day numbers)
 *    - Uses project LOI date as Project Start (projectStartDate)
 *    - Converts ES/EF/LS/LF day numbers -> real dates
 *
 * 2) MSP-like UI (less cluttered)
 *    - Top nav + project bar + tabs
 *    - Clean task grid + date columns
 *    - Gantt uses date ticks (weekly) not raw day labels
 *
 * 3) New Project from UI (calls POST /createProject)
 *    - LOI required (Project Start)
 *    - Commissioning (Contract) required
 *    - Buffer policy fixed 30 days (UI sends 30; backend may ignore if hardcoded)
 *    - Internal commissioning derived = Contract - 30 days (display + sent)
 *    - Milestone capture included
 *
 * IMPORTANT:
 * - "Ratio-based duration scaling" MUST be done in backend /createProject.
 *   UI cannot safely do it because template duration (T = MAX(EF)) lives in SQL.
 *   UI simply sends LOI + commissioning contract + bufferDays=30 + templateName.
 *
 * Assumed APIs:
 * - GET  /getSchedule?projectId=...&versionId=latest
 * - GET  /getDependencies?projectId=...
 * - POST /updateTask
 * - POST /updateDependency
 * - POST /deleteDependency
 * - POST /createProject   (must implement ratio scaling inside)
 * - POST /recalculate?projectId=... (optional; used after edits)
 */

const TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "gantt", label: "Gantt" },
  { key: "network", label: "Network" },
  { key: "table", label: "Task Table" },
];

const BUFFER_DAYS_FIXED = 30;

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

  /* -------------------- tolerant parsing -------------------- */
  const normId = (v) => (v == null ? null : String(v));

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

  /* -------------------- date model (LOI = project start) -------------------- */
  // Best: backend returns schedule.project.projectStartDate (YYYY-MM-DD)
  // Fallback: if backend returns milestones array/object, read LOI there.
  const projectStartDate = useMemo(() => {
    const direct = parseISO(project?.projectStartDate);
    if (direct) return direct;

    // fallback: milestones as object
    if (project?.milestones && typeof project.milestones === "object") {
      const m = project.milestones;
      const loi = parseISO(m.LOI || m.loi || m.loiDate);
      if (loi) return loi;
    }

    // fallback: milestones as array
    if (Array.isArray(project?.Milestones)) {
      const loiRow = project.Milestones.find((x) => String(x?.Key || x?.key) === "LOI");
      const loi = parseISO(loiRow?.Date || loiRow?.date || loiRow?.Value || loiRow?.value);
      if (loi) return loi;
    }

    return null;
  }, [project?.projectStartDate, project?.milestones, project?.Milestones]);

  const needsStartDate = tasks.length > 0 && !projectStartDate;

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

  const taskById = useMemo(() => {
    const m = new Map();
    for (const t of tasks || []) m.set(normId(t.TaskId), t);
    return m;
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const depsBySuccessor = useMemo(() => {
    const m = new Map();
    (deps || []).forEach((d) => {
      const succ = normId(getSuccId(d));
      if (!succ) return;
      const arr = m.get(succ) || [];
      arr.push({ ...d, __id: getDepId(d) });
      m.set(succ, arr);
    });
    return m;
  }, [deps]); // eslint-disable-line react-hooks/exhaustive-deps

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
    } catch (e) {
      setError(e.message || String(e));
      setSchedule(null);
      setDeps([]);
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

  async function updateDependency(taskDependencyId, linkType, lagDays) {
    const idNum = Number(taskDependencyId);
    if (!Number.isFinite(idNum)) throw new Error("Invalid TaskDependencyId (API is not returning it).");

    const type = String(linkType || "FS").toUpperCase();
    const lagNum = Number.isFinite(Number(lagDays)) ? Number(lagDays) : 0;

    const { res, json } = await fetchJson(`${API_BASE}/updateDependency?t=${Date.now()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskDependencyId: idNum,
        linkType: type,
        lagDays: lagNum,
        // tolerate your backend casing:
        LinkType: type,
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
            <div style={s.projectName}>
              {project?.ProjectName ? project.ProjectName : "Load a Project"}
            </div>

            <div style={s.projectMeta}>
              <span>ProjectId: <b>{project?.ProjectId ?? projectId}</b></span>
              <span>•</span>
              <span>Version: <b>{version?.versionNo ?? "-"}</b></span>
              <span>•</span>
              <span>
                LOI Start:{" "}
                <b>{projectStartDate ? fmtDDMMMYY(projectStartDate) : "-"}</b>
              </span>
              <span>•</span>
              <span>
                Finish:{" "}
                <b>{kpi.finishDate ? fmtDDMMMYY(kpi.finishDate) : "-"}</b>
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
              <input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                style={s.input}
                disabled={loading}
              />
            </label>

            <button
              onClick={() => loadAll(projectId)}
              disabled={loading}
              style={{ ...s.btn, ...(loading ? s.btnDisabled : {}) }}
            >
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
            Missing LOI/projectStartDate from API.  
            UI cannot show correct dd-MMM-yy target dates until backend returns LOI as <code>project.projectStartDate</code>
            (or milestones include LOI).
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

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 14, marginTop: 14 }}>
              <div style={s.card}>
                <div style={s.cardHeader}>
                  <div>
                    <div style={s.cardTitle}>Gantt Preview</div>
                    <div style={s.cardSub}>Clean date-based axis (weekly ticks).</div>
                  </div>
                </div>
                {tasks.length && projectStartDate ? (
                  <GanttDates tasks={tasks} startDate={projectStartDate} compact />
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
                        <div key={normId(t.TaskId)} style={s.listRow}>
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
                <div style={s.cardTitle}>Gantt (Target Dates)</div>
                <div style={s.cardSub}>Weekly ticks. Bars represent ES→EF (target schedule).</div>
              </div>
            </div>

            {tasks.length && projectStartDate ? (
              <GanttDates tasks={tasks} startDate={projectStartDate} />
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
                <div style={s.cardTitle}>Task Table (Edit Duration / Dependencies)</div>
                <div style={s.cardSub}>
                  MSP logic: edit → backend recalculates → UI reload.
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
              depsBySuccessor={depsBySuccessor}
              taskById={taskById}
              disabled={loading}
              dayToDate={dayToDate}
              fmtDDMMMYY={fmtDDMMMYY}
              getPredId={getPredId}
              getLag={getLag}
              getType={getType}
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
              onUpdateDep={async (depId, type, lag) => {
                setError("");
                setLoading(true);
                setBusyMsg("Updating dependency...");
                try {
                  await updateDependency(depId, type, lag);
                  await recalcAndReload(projectId);
                } catch (e) {
                  setError(e.message || String(e));
                } finally {
                  setBusyMsg("");
                  setLoading(false);
                }
              }}
              onRemoveDep={async (depId) => {
                setError("");
                setLoading(true);
                setBusyMsg("Deleting dependency...");
                try {
                  await deleteDependency(depId);
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
          onCreate={async ({ projectName, templateName, milestones, loiDate, commissioningContractDate, commissioningInternalDate }) => {
            setError("");
            setLoading(true);
            setBusyMsg("Creating project from template (ratio scaling in backend)...");
            try {
              // NOTE: Your backend should use these to compute:
              // N = (CommInternal - LOI) days
              // T = MAX(EF) days from template’s latest version
              // Ratio = N/T; scaled durations; insert tasks; insert dependencies; calc schedule; persist LOI as projectStartDate.
              const out = await createProject({
                projectName,
                templateName,
                bufferDays: BUFFER_DAYS_FIXED,
                loiDate,
                commissioningContractDate,
                commissioningInternalDate,
                milestones, // still send the entire milestone object
              });

              const newId = String(out.projectId);
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

/* -------------------- New Project Modal -------------------- */
function NewProjectModal({ onClose, onCreate, loading, bufferDays }) {
  const s = makeStyles();

  const [projectName, setProjectName] = useState("");
  const [templateName, setTemplateName] = useState("Solar EPC Master v1");

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
    return (
      projectName.trim().length > 0 &&
      !!parseISO(loiDate) &&
      !!parseISO(commContract)
    );
  }, [projectName, loiDate, commContract]);

  return (
    <div style={s.modalOverlay} onMouseDown={onClose}>
      <div
        style={s.modal}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={s.modalHeader}>
          <div>
            <div style={s.modalTitle}>Create New Project</div>
            <div style={s.modalSub}>
              LOI is Project Start. Internal COD is derived as Contract - {bufferDays} days. Backend must perform ratio scaling.
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

            <Field label="Template Name">
              <input
                style={s.inputWide}
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                disabled={loading}
              />
            </Field>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={s.sectionTitle}>Milestones</div>
            <div style={s.sectionSub}>
              Required: LOI + Commissioning (as per Contract).
            </div>

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
                templateName: templateName.trim() || "Solar EPC Master v1",
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

/* -------------------- Task Table -------------------- */
function TaskTable({
  tasks,
  depsBySuccessor,
  taskById,
  disabled,
  dayToDate,
  fmtDDMMMYY,
  getPredId,
  getLag,
  getType,
  onSaveDuration,
  onUpdateDep,
  onRemoveDep,
}) {
  const s = makeStyles();
  const normId = (v) => (v == null ? null : String(v));

  return (
    <div style={{ padding: 14, overflowX: "auto" }}>
      <table style={s.table}>
        <thead>
          <tr>
            {[
              "Workstream",
              "Task",
              "Dur",
              "Target Start",
              "Target Finish",
              "Float",
              "Critical",
              "Dependencies (Type/Lag)",
            ].map((h) => (
              <th key={h} style={s.th}>{h}</th>
            ))}
          </tr>
        </thead>

        <tbody>
          {(tasks || []).map((t, idx) => (
            <TaskRow
              key={normId(t.TaskId)}
              rowIndex={idx}
              task={t}
              taskById={taskById}
              depsForTask={depsBySuccessor.get(normId(t.TaskId)) || []}
              disabled={disabled}
              dayToDate={dayToDate}
              fmtDDMMMYY={fmtDDMMMYY}
              getPredId={getPredId}
              getLag={getLag}
              getType={getType}
              onSaveDuration={onSaveDuration}
              onUpdateDep={onUpdateDep}
              onRemoveDep={onRemoveDep}
            />
          ))}

          {!tasks?.length && (
            <tr>
              <td colSpan={8} style={{ padding: 14, color: "#475569" }}>No tasks found.</td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={s.note}>
        Dates shown are Target Dates (LOI + ES/EF). Durations & links update schedule after recalculation.
      </div>
    </div>
  );
}

function TaskRow({
  rowIndex,
  task,
  taskById,
  depsForTask,
  disabled,
  dayToDate,
  fmtDDMMMYY,
  getPredId,
  getLag,
  getType,
  onSaveDuration,
  onUpdateDep,
  onRemoveDep,
}) {
  const s = makeStyles();
  const isCrit = task.IsCritical === 1 || task.IsCritical === true;
  const [dur, setDur] = useState(task.DurationDays ?? "");

  useEffect(() => setDur(task.DurationDays ?? ""), [task.DurationDays]);

  const startDt = dayToDate(task.ES);
  const finishDt = dayToDate(task.EF);

  return (
    <tr style={{ background: isCrit ? "#fff7ed" : rowIndex % 2 === 0 ? "#ffffff" : "#fbfdff" }}>
      <td style={s.td}>{task.Workstream ?? ""}</td>
      <td style={{ ...s.td, fontWeight: 950 }}>{task.TaskName ?? ""}</td>

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

      <td style={s.tdMono}>{fmtDDMMMYY(startDt)}</td>
      <td style={s.tdMono}>{fmtDDMMMYY(finishDt)}</td>
      <td style={s.tdMono}>{task.TotalFloat ?? ""}</td>
      <td style={{ ...s.tdMono, fontWeight: 950, color: isCrit ? "#b45309" : "#0f172a" }}>
        {isCrit ? "YES" : ""}
      </td>

      <td style={{ ...s.td, minWidth: 520 }}>
        {depsForTask.length === 0 ? (
          <span style={{ color: "#64748b" }}>(none)</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {depsForTask.map((d) => {
              const depId = d.__id ?? null;
              const predIdRaw = getPredId(d);
              const pred = taskById.get(predIdRaw == null ? null : String(predIdRaw));
              const predName = pred ? `${pred.Workstream} — ${pred.TaskName}` : `TaskId ${String(predIdRaw ?? "")}`;

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
          </div>
        )}
      </td>
    </tr>
  );
}

function DepEditor({ depId, predName, initialType, initialLag, disabled, onUpdate, onRemove }) {
  const s = makeStyles();
  const [type, setType] = useState((initialType || "FS").toUpperCase());
  const [lag, setLag] = useState(String(initialLag ?? 0));

  useEffect(() => setType((initialType || "FS").toUpperCase()), [initialType]);
  useEffect(() => setLag(String(initialLag ?? 0)), [initialLag]);

  const canEdit = Number.isFinite(Number(depId));

  return (
    <div style={s.depRow}>
      <div style={s.depName}>{predName}</div>

      <select
        value={type}
        onChange={(e) => setType(e.target.value)}
        disabled={disabled || !canEdit}
        style={s.select}
      >
        <option value="FS">FS</option>
        <option value="SS">SS</option>
        <option value="FF">FF</option>
        <option value="SF">SF</option>
      </select>

      <input
        style={s.lagInput}
        value={lag}
        onChange={(e) => setLag(e.target.value)}
        disabled={disabled || !canEdit}
        type="number"
      />

      <button
        style={{ ...s.smallBtnDark, ...(disabled || !canEdit ? s.btnDisabled : {}) }}
        onClick={() => onUpdate(depId, type, lag === "" ? 0 : Number(lag))}
        disabled={disabled || !canEdit}
      >
        Update
      </button>

      <button
        style={{ ...s.smallBtnDanger, ...(disabled || !canEdit ? s.btnDisabled : {}) }}
        onClick={() => onRemove(depId)}
        disabled={disabled || !canEdit}
      >
        Remove
      </button>

      {!canEdit && <span style={s.depWarn}>Missing TaskDependencyId from getDependencies</span>}
    </div>
  );
}

/* -------------------- Date-based Gantt -------------------- */
function GanttDates({ tasks, startDate, compact = false }) {
  const s = makeStyles();
  const normId = (v) => (v == null ? null : String(v));

  const valid = (tasks || [])
    .map((t) => ({
      ...t,
      ES: Number.isFinite(Number(t.ES)) ? Number(t.ES) : 0,
      EF: Number.isFinite(Number(t.EF)) ? Number(t.EF) : 0,
    }))
    .map((t) => ({ ...t, EF: t.EF < t.ES ? t.ES : t.EF }));

  if (!valid.length) return null;

  const PX_PER_DAY = compact ? 6 : 10;
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

  // weekly ticks to avoid clutter
  const tickStep = 7;

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

  return (
    <div style={{ padding: compact ? 12 : 14 }}>
      <div style={{ overflowX: "auto", border: "1px solid #e5eaf0", borderRadius: 14, background: "#fff" }}>
        <div style={{ position: "relative", width: canvasW, height: canvasH }}>
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

          {/* rows */}
          <div style={{ position: "absolute", left: 0, top: HEADER_H, width: canvasW }}>
            {valid.map((t) => {
              const isCrit = t.IsCritical === 1 || t.IsCritical === true;
              const left = LEFT_COL_W + (t.ES - minStart) * PX_PER_DAY;
              const w = Math.max(1, (t.EF - t.ES) * PX_PER_DAY);

              const sDt = dayToDate(t.ES);
              const fDt = dayToDate(t.EF);

              return (
                <div
                  key={normId(t.TaskId)}
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
                    <div
                      style={{
                        position: "absolute",
                        left: (t.ES - minStart) * PX_PER_DAY,
                        top: (ROW_H - BAR_H) / 2,
                        height: BAR_H,
                        width: w,
                        borderRadius: 7,
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

      {!compact && (
        <div style={s.note}>
          Tick step is weekly to avoid clutter. If you want monthly ticks, change <code>tickStep</code> to 30.
        </div>
      )}
    </div>
  );
}

/* -------------------- Network Diagram -------------------- */
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
      if (!pred || !succ) return;
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
  }, [tasks, deps, getPredId, getSuccId, getDepId, getLag, getType]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!nodes.length) return null;
  const s = makeStyles();

  return (
    <div style={{ padding: 14 }}>
      <div style={s.note}>
        Nodes with orange border are critical tasks. Edges show type + lag.
      </div>

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
                  rx="10"
                  ry="10"
                  fill={isCrit ? "#fff7ed" : "#f8fafc"}
                  stroke={isCrit ? "#f59e0b" : "#94a3b8"}
                  strokeWidth={isCrit ? "3" : "2"}
                />
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
  // Force midnight local to avoid timezone shifting
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
    cardHeaderRight: { display: "flex", gap: 10, alignItems: "center" },
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
    smallBtnDanger: {
      padding: "6px 10px",
      borderRadius: 10,
      border: "1px solid #fecaca",
      background: "#fef2f2",
      color: "#991b1b",
      fontWeight: 950,
      cursor: "pointer",
    },

    depRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", border: "1px solid #e5eaf0", borderRadius: 12, background: "#fff" },
    depName: { minWidth: 260, fontWeight: 900 },
    select: { padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, background: "#fff", outline: "none" },
    lagInput: { width: 70, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, outline: "none" },
    depWarn: { color: "#b91c1c", fontSize: 12, fontWeight: 900, marginLeft: 6 },

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
  };
}
