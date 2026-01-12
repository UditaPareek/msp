import { useEffect, useMemo, useState } from "react";
import dagre from "dagre";
import { API_BASE } from "./config";

/**
 * MSP Lite UI — App.jsx (professional shell + New Project flow)
 *
 * What this version adds (without breaking your existing APIs):
 * - Top navigation like MSP tools: Dashboard / Gantt / Network / Resources / Risks / Reports
 * - "+ New Project" modal that calls POST /createProject (your new function)
 * - Milestone capture (LOI, Design Handover, etc.) + COMM_CONTRACT required
 * - Internal commissioning derived = Contract - 30 days (fixed policy) shown in UI
 * - Existing task edit flows preserved (duration, dependency type/lag, delete dependency)
 * - Adaptive Gantt ticks to avoid clutter
 *
 * Assumed APIs:
 * - GET  /getSchedule?projectId=...&versionId=latest
 * - GET  /getDependencies?projectId=...
 * - POST /updateTask
 * - POST /updateDependency
 * - POST /deleteDependency
 * - POST /createProject   (NEW)
 * - POST /recalculate?projectId=... (optional; kept for debug)
 */

const TABS = [
  { key: "dashboard", label: "Dashboard" },
  { key: "gantt", label: "Gantt Chart" },
  { key: "network", label: "Network" },
  { key: "resources", label: "Resources" },
  { key: "risks", label: "Risks" },
  { key: "reports", label: "Reports" },
];

const MILESTONE_FIELDS = [
  { key: "LOI", label: "LOI" },
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
  const [activeTab, setActiveTab] = useState("dashboard");

  const [projectId, setProjectId] = useState("1");
  const [loading, setLoading] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [error, setError] = useState("");

  const [schedule, setSchedule] = useState(null);
  const [deps, setDeps] = useState([]);

  const [showNewProject, setShowNewProject] = useState(false);

  // Normalize IDs as strings
  const normId = (v) => (v == null ? null : String(v));

  // Tasks + version tolerance
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

  const criticalCount = useMemo(() => {
    return (tasks || []).filter((t) => t.IsCritical === 1 || t.IsCritical === true).length;
  }, [tasks]);

  const taskById = useMemo(() => {
    const m = new Map();
    for (const t of tasks || []) m.set(normId(t.TaskId), t);
    return m;
  }, [tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // successor -> deps
  const depsBySuccessor = useMemo(() => {
    const m = new Map();
    (deps || []).forEach((d) => {
      const succ = normId(getSuccId(d));
      if (succ == null) return;
      const arr = m.get(succ) || [];
      arr.push({ ...d, __id: getDepId(d) });
      m.set(succ, arr);
    });
    return m;
  }, [deps]); // eslint-disable-line react-hooks/exhaustive-deps

  /** =========================
   *  Fetch helpers
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
  async function loadAll(nextProjectId = projectId) {
    setError("");
    setLoading(true);
    try {
      const bust = Date.now();
      const [sch, dep] = await Promise.all([
        fetchJson(
          `${API_BASE}/getSchedule?projectId=${encodeURIComponent(
            nextProjectId
          )}&versionId=latest&t=${bust}`
        ),
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
    setIsRecalculating(true);
    setLoading(true);
    try {
      await recalcOnly(nextProjectId);
      await loadAll(nextProjectId);
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
    if (!Number.isFinite(idNum)) throw new Error("Invalid TaskDependencyId (API is not returning it).");

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

  /** =========================
   *  Styling
   *  ========================= */
  const styles = useMemo(() => makeStyles(), []);

  const kpi = useMemo(() => {
    const totalTasks = tasks.length || 0;
    const completed = (tasks || []).filter((t) => String(t.Status || "").toUpperCase() === "COMPLETED").length;
    const avgCompletion = totalTasks ? Math.round((completed / totalTasks) * 100) : 0;

    // crude: unique resources placeholder (you need a Resource API to do real count)
    const resources = 0;

    return {
      activeProjects: 1, // because UI is focused on current project; you need a project list API for portfolio
      totalTasks,
      resources,
      avgCompletion,
      critical: criticalCount,
    };
  }, [tasks, criticalCount]);

  /** =========================
   *  Render
   *  ========================= */
  return (
    <div style={styles.page}>
      <GlobalCSS />

      {/* Overlay */}
      {isRecalculating && (
        <div style={styles.overlay}>
          <div style={styles.overlayCard}>
            <Spinner size={18} />
            <div>
              <div style={styles.overlayTitle}>Recalculating schedule</div>
              <div style={styles.overlaySub}>Computing ES/EF/LS/LF, float, critical path…</div>
            </div>
          </div>
        </div>
      )}

      {/* Top Nav */}
      <div style={styles.topbar}>
        <div style={styles.brandWrap}>
          <div style={styles.brandDot} />
          <div>
            <div style={styles.brandTitle}>MSP Lite</div>
            <div style={styles.brandSub}>Project scheduling & network planning</div>
          </div>
        </div>

        <div style={styles.tabs}>
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              style={{
                ...styles.tabBtn,
                ...(activeTab === t.key ? styles.tabBtnActive : {}),
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={styles.topActions}>
          <button
            style={styles.btnPrimary}
            onClick={() => setShowNewProject(true)}
            disabled={loading}
            title="Create new project from template"
          >
            + New Project
          </button>
        </div>
      </div>

      {/* Header / Project Bar */}
      <div style={styles.content}>
        <div style={styles.projectBar}>
          <div style={styles.projectLeft}>
            <div style={styles.projectName}>
              {project?.ProjectName ? project.ProjectName : "Select / Load Project"}
            </div>
            <div style={styles.projectMeta}>
              <span>ProjectId: {project?.ProjectId ?? projectId}</span>
              <span>•</span>
              <span>Version: {version?.versionNo ?? "-"}</span>
              <span>•</span>
              <span>Finish Day: {version?.projectFinishDay ?? "-"}</span>
              <span>•</span>
              <span>Critical: {kpi.critical}/{kpi.totalTasks}</span>
            </div>
          </div>

          <div style={styles.projectRight}>
            <label style={styles.inlineLabel}>
              Project ID
              <input
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                style={styles.input}
              />
            </label>

            <button
              onClick={() => loadAll(projectId)}
              disabled={loading}
              style={{ ...styles.btn, ...(loading ? styles.btnDisabled : {}) }}
            >
              {loading && !isRecalculating ? (
                <>
                  <Spinner size={14} /> Loading
                </>
              ) : (
                "Load"
              )}
            </button>

            <button
              onClick={() => recalcAndReload(projectId)}
              disabled={loading}
              style={{ ...styles.btnDark, ...(loading ? styles.btnDisabled : {}) }}
              title="Debug recalculation (ideally auto-trigger on edits in backend)"
            >
              {isRecalculating ? (
                <>
                  <Spinner size={14} /> Recalculating
                </>
              ) : (
                "Recalculate"
              )}
            </button>
          </div>
        </div>

        {/* Error */}
        {error && <div style={styles.error}>Error: {error}</div>}

        {/* TAB CONTENT */}
        {activeTab === "dashboard" && (
          <>
            <div style={styles.card}>
              <div style={styles.cardHeader}>
                <div style={styles.cardTitle}>Portfolio Overview</div>
              </div>

              <div style={styles.kpiGrid}>
                <KpiCard label="Active Projects" value={kpi.activeProjects} />
                <KpiCard label="Total Tasks" value={kpi.totalTasks} />
                <KpiCard label="Resources" value={kpi.resources} hint="(coming via Resource API)" />
                <KpiCard label="Avg Completion" value={`${kpi.avgCompletion}%`} />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 14, marginTop: 14 }}>
              <div style={styles.card}>
                <div style={styles.cardHeader}>
                  <div style={styles.cardTitle}>Timeline Snapshot</div>
                  <div style={styles.cardSub}>
                    Gantt preview (critical highlighted). Use the Gantt tab for full view.
                  </div>
                </div>
                {tasks.length ? (
                  <GanttLiteLinked
                    compact
                    tasks={tasks}
                    deps={deps}
                    getPredId={getPredId}
                    getSuccId={getSuccId}
                    getDepId={getDepId}
                  />
                ) : (
                  <EmptyState text="No schedule loaded yet." />
                )}
              </div>

              <div style={styles.card}>
                <div style={styles.cardHeader}>
                  <div style={styles.cardTitle}>Critical Path Summary</div>
                  <div style={styles.cardSub}>Top critical tasks (float = 0)</div>
                </div>

                {tasks.length ? (
                  <div style={{ padding: 12 }}>
                    {(tasks || [])
                      .filter((t) => t.IsCritical === 1 || t.IsCritical === true)
                      .slice(0, 10)
                      .map((t) => (
                        <div key={normId(t.TaskId)} style={styles.listRow}>
                          <div style={{ fontWeight: 900 }}>{t.TaskName}</div>
                          <div style={styles.listMeta}>
                            {t.Workstream} • ES {t.ES ?? "-"} • EF {t.EF ?? "-"}
                          </div>
                        </div>
                      ))}
                    {(tasks || []).filter((t) => t.IsCritical === 1 || t.IsCritical === true).length === 0 && (
                      <div style={styles.muted}>No critical tasks found (unexpected). Check schedule.</div>
                    )}
                  </div>
                ) : (
                  <EmptyState text="Load a project to see critical path." />
                )}
              </div>
            </div>

            <div style={styles.card} style={{ ...styles.card, marginTop: 14 }}>
              <div style={styles.cardHeader}>
                <div style={styles.cardTitle}>Task Table (Edit Durations & Dependencies)</div>
                <div style={styles.cardSub}>
                  MSP behavior should be: edit → backend recalculates → UI reloads latest version.
                </div>
              </div>
              <TaskTable
                tasks={tasks}
                depsBySuccessor={depsBySuccessor}
                taskById={taskById}
                loading={loading}
                getPredId={getPredId}
                getLag={getLag}
                getType={getType}
                onSaveDuration={async (taskId, newDur) => {
                  setError("");
                  setLoading(true);
                  try {
                    await updateDuration(taskId, newDur);
                    await recalcAndReload(projectId);
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
                    await recalcAndReload(projectId);
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
                    await recalcAndReload(projectId);
                  } catch (e) {
                    setError(e.message || String(e));
                  } finally {
                    setLoading(false);
                  }
                }}
              />
            </div>
          </>
        )}

        {activeTab === "gantt" && (
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.cardTitle}>Gantt Chart</div>
              <div style={styles.cardSub}>Linked visualization using computed ES/EF</div>
            </div>
            {tasks.length ? (
              <GanttLiteLinked
                tasks={tasks}
                deps={deps}
                getPredId={getPredId}
                getSuccId={getSuccId}
                getDepId={getDepId}
              />
            ) : (
              <EmptyState text="Load a project to view the Gantt." />
            )}
          </div>
        )}

        {activeTab === "network" && (
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.cardTitle}>Network Diagram</div>
              <div style={styles.cardSub}>DAG layout using Dagre (dependency-driven)</div>
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
              <EmptyState text="Load a project to view the network." />
            )}
          </div>
        )}

        {activeTab === "resources" && (
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.cardTitle}>Resources</div>
              <div style={styles.cardSub}>
                Not implemented yet (requires Resource tables + API). Keep UI placeholder here.
              </div>
            </div>
            <EmptyState text="Add Resource model + endpoints to enable this tab." />
          </div>
        )}

        {activeTab === "risks" && (
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.cardTitle}>Risks</div>
              <div style={styles.cardSub}>
                Next step: show critical tasks, negative float, late tasks, long chains.
              </div>
            </div>
            {tasks.length ? (
              <div style={{ padding: 12 }}>
                <div style={styles.sectionTitle}>Critical Tasks</div>
                <div style={styles.muted}>
                  You can enhance this after backend auto-versioning is added to updateTask/updateDependency.
                </div>
                <div style={{ marginTop: 10 }}>
                  {(tasks || [])
                    .filter((t) => t.IsCritical === 1 || t.IsCritical === true)
                    .slice(0, 15)
                    .map((t) => (
                      <div key={normId(t.TaskId)} style={styles.riskRow}>
                        <div style={{ fontWeight: 900 }}>{t.TaskName}</div>
                        <div style={styles.listMeta}>
                          {t.Workstream} • ES {t.ES ?? "-"} • EF {t.EF ?? "-"} • Float {t.TotalFloat ?? "-"}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            ) : (
              <EmptyState text="Load a project to view risks." />
            )}
          </div>
        )}

        {activeTab === "reports" && (
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.cardTitle}>Reports</div>
              <div style={styles.cardSub}>
                Next step: export schedule versions, baseline variance, critical path report.
              </div>
            </div>
            <EmptyState text="Add report endpoints later. UI is ready." />
          </div>
        )}
      </div>

      {/* New Project Modal */}
      {showNewProject && (
        <NewProjectModal
          onClose={() => setShowNewProject(false)}
          onCreate={async ({ projectName, templateName, milestones }) => {
            setError("");
            setLoading(true);
            try {
              const out = await createProject({ projectName, templateName, milestones });
              // Immediately load this project
              const newId = String(out.projectId);
              setProjectId(newId);
              setShowNewProject(false);
              // Load schedule
              await loadAll(newId);
              setActiveTab("dashboard");
            } catch (e) {
              setError(e.message || String(e));
            } finally {
              setLoading(false);
            }
          }}
          loading={loading}
        />
      )}
    </div>
  );
}

/** =========================
 *  Global CSS
 *  ========================= */
function GlobalCSS() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      button { font-family: inherit; }
      input, select { font-family: inherit; }
      ::-webkit-scrollbar { height: 10px; width: 10px; }
      ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 12px; }
      ::-webkit-scrollbar-track { background: #f1f5f9; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `}</style>
  );
}

/** =========================
 *  New Project Modal
 *  ========================= */
function NewProjectModal({ onClose, onCreate, loading }) {
  const [projectName, setProjectName] = useState("");
  const [templateName, setTemplateName] = useState("Solar EPC Master v1");
  const [milestones, setMilestones] = useState(() => {
    const o = {};
    for (const f of MILESTONE_FIELDS) o[f.key] = "";
    return o;
  });

  // Derived internal commissioning (Contract - 30d)
  const commContract = milestones.COMM_CONTRACT;
  const commInternal = useMemo(() => {
    const d = parseISODate(commContract);
    if (!d) return "";
    const x = new Date(d.getTime());
    x.setDate(x.getDate() - 30);
    return toISODate(x);
  }, [commContract]);

  const canSubmit = useMemo(() => {
    return projectName.trim().length > 0 && !!parseISODate(milestones.COMM_CONTRACT);
  }, [projectName, milestones.COMM_CONTRACT]);

  const s = makeStyles();

  return (
    <div style={s.modalOverlay} onMouseDown={onClose}>
      <div
        style={s.modal}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
      >
        <div style={s.modalHeader}>
          <div>
            <div style={s.modalTitle}>Create New Project</div>
            <div style={s.modalSub}>
              Captures milestones and generates tasks from the template.
            </div>
          </div>
          <button style={s.iconBtn} onClick={onClose} disabled={loading} title="Close">
            ✕
          </button>
        </div>

        <div style={s.modalBody}>
          <div style={s.formGrid}>
            <Field label="Project Name" required>
              <input
                style={s.inputWide}
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="e.g., Serentica Fatehgarh (300MW)"
              />
            </Field>

            <Field label="Template Name">
              <input
                style={s.inputWide}
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                placeholder="Solar EPC Master v1"
              />
            </Field>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={s.sectionTitle}>Milestones</div>
            <div style={s.sectionSub}>
              Commissioning (as per Contract) is mandatory. Internal commissioning is derived as Contract - 30 days.
            </div>

            <div style={s.milestoneGrid}>
              {MILESTONE_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} required={!!f.required}>
                  <input
                    type="date"
                    style={s.inputWide}
                    value={milestones[f.key] || ""}
                    onChange={(e) =>
                      setMilestones((p) => ({ ...p, [f.key]: e.target.value }))
                    }
                  />
                </Field>
              ))}

              <Field label="Commissioning (as per internal schedule)" hint="Derived: Contract - 30 days">
                <input type="date" style={s.inputWide} value={commInternal} readOnly />
              </Field>
            </div>
          </div>
        </div>

        <div style={s.modalFooter}>
          <button style={s.btn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            style={{ ...s.btnPrimary, ...(loading || !canSubmit ? s.btnDisabled : {}) }}
            disabled={loading || !canSubmit}
            onClick={() => {
              const payload = {
                projectName: projectName.trim(),
                templateName: templateName.trim() || "Solar EPC Master v1",
                milestones: {
                  ...milestones,
                  // You can optionally send COMM_INTERNAL too (backend can ignore if it derives)
                  COMM_INTERNAL: commInternal,
                },
              };
              onCreate(payload);
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

function parseISODate(s) {
  if (!s) return null;
  const d = new Date(String(s) + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}
function toISODate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** =========================
 *  KPI Card
 *  ========================= */
function KpiCard({ label, value, hint }) {
  const s = makeStyles();
  return (
    <div style={s.kpiCard}>
      <div style={s.kpiValue}>{value}</div>
      <div style={s.kpiLabel}>{label}</div>
      {hint && <div style={s.kpiHint}>{hint}</div>}
    </div>
  );
}

function EmptyState({ text }) {
  const s = makeStyles();
  return (
    <div style={{ padding: 14, color: "#475569", fontWeight: 800 }}>
      {text}
    </div>
  );
}

/** =========================
 *  Task Table
 *  ========================= */
function TaskTable({
  tasks,
  depsBySuccessor,
  taskById,
  loading,
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
    <div style={{ overflowX: "auto" }}>
      <table style={s.table}>
        <thead>
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
              <th key={h} style={s.th}>
                {h}
              </th>
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
              disabled={loading}
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
              <td colSpan={10} style={{ padding: 14, color: "#475569" }}>
                No tasks found.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 10, color: "#64748b", fontSize: 12, fontWeight: 800 }}>
        Note: ES/EF/LS/LF/Float/Critical are computed. Edit only Duration and existing Dependencies (Type/Lag).
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

  const rowBg = rowIndex % 2 === 0 ? "#ffffff" : "#fbfdff";
  const critBg = "#fff7ed";

  return (
    <tr style={{ background: isCrit ? critBg : rowBg }}>
      <td style={s.td}>{task.Workstream ?? ""}</td>
      <td style={{ ...s.td, fontWeight: 900 }}>{task.TaskName ?? ""}</td>

      <td style={s.td}>
        <input
          style={s.tdInput}
          value={dur}
          onChange={(e) => setDur(e.target.value)}
          disabled={disabled}
        />
        <button
          style={{ ...s.smallBtnDark, ...(disabled ? s.btnDisabled : {}) }}
          onClick={() => onSaveDuration(task.TaskId, dur === "" ? 0 : Number(dur))}
          disabled={disabled}
        >
          Save
        </button>
      </td>

      <td style={s.td}>{task.ES ?? ""}</td>
      <td style={s.td}>{task.EF ?? ""}</td>
      <td style={s.td}>{task.LS ?? ""}</td>
      <td style={s.td}>{task.LF ?? ""}</td>
      <td style={s.td}>{task.TotalFloat ?? ""}</td>
      <td style={{ ...s.td, fontWeight: 900, color: isCrit ? "#b45309" : "#0f172a" }}>
        {isCrit ? "YES" : ""}
      </td>

      <td style={{ ...s.td, minWidth: 460 }}>
        {depsForTask.length === 0 ? (
          <span style={{ color: "#64748b" }}>(none)</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {depsForTask.map((d) => {
              const depId = d.__id ?? null;
              const predIdRaw = getPredId(d);
              const pred = taskById.get(predIdRaw == null ? null : String(predIdRaw));
              const predName = pred ? `${pred.Workstream} - ${pred.TaskName}` : String(predIdRaw ?? "");

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
        placeholder="lag"
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

      {!canEdit && (
        <span style={s.depWarn}>Missing TaskDependencyId in getDependencies API</span>
      )}
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
 *  Gantt (Linked) — Adaptive ticks
 *  ========================= */
function GanttLiteLinked({ tasks, deps, getPredId, getSuccId, getDepId, compact = false }) {
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
  const BAR_TOP_OFFSET = (ROW_H - BAR_H) / 2;
  const HEADER_H = compact ? 22 : 28;

  const minStart = Math.min(...valid.map((t) => t.ES));
  const maxFinish = Math.max(...valid.map((t) => t.EF));
  const totalDays = Math.max(1, maxFinish - minStart);
  const timelineW = totalDays * PX_PER_DAY;

  // Adaptive tick step to avoid clutter
  const pickTickStep = (pxPerDay) => {
    const minLabelPx = compact ? 90 : 80;
    const raw = Math.ceil(minLabelPx / Math.max(1, pxPerDay));
    const nice = [1, 2, 3, 5, 7, 10, 14, 21, 28, 30];
    return nice.find((s) => s >= raw) || raw;
  };
  const TICK_STEP = pickTickStep(PX_PER_DAY);

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

  const shell = makeStyles();

  return (
    <div style={{ padding: compact ? 0 : 12 }}>
      <div
        style={{
          overflowX: "auto",
          border: compact ? "none" : "1px solid #e2e8f0",
          background: "#ffffff",
          borderRadius: compact ? 0 : 12,
          padding: compact ? 0 : 12,
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
              background: "#ffffff",
            }}
          >
            {Array.from({ length: totalDays + 1 }).map((_, i) => {
              if (i % TICK_STEP !== 0) return null;
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
                    paddingLeft: 6,
                    whiteSpace: "nowrap",
                    userSelect: "none",
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
                  strokeWidth={compact ? "1.3" : "1.8"}
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
                    <div style={{ fontWeight: 900 }}>{t.TaskName}</div>
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
                      overflow: "hidden",
                    }}
                  >
                    {Array.from({ length: totalDays + 1 }).map((_, i) => (
                      <div
                        key={i}
                        style={{
                          position: "absolute",
                          left: i * PX_PER_DAY,
                          top: 0,
                          bottom: 0,
                          width: 1,
                          background: i % TICK_STEP === 0 ? "#e2e8f0" : "#f1f5f9",
                          opacity: i % TICK_STEP === 0 ? 1 : 0.8,
                        }}
                      />
                    ))}

                    <div
                      style={{
                        position: "absolute",
                        left,
                        top: BAR_TOP_OFFSET,
                        height: BAR_H,
                        width,
                        borderRadius: 6,
                        background: isCrit ? "#f59e0b" : "#94a3b8",
                        zIndex: 2,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {!compact && (
          <div style={shell.note}>
            Lines are drawn predecessor → successor for visibility. Scheduling semantics depend on backend LinkType/LagDays.
          </div>
        )}
      </div>
    </div>
  );
}

/** =========================
 *  Network Diagram (Dagre)
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
  const s = makeStyles();

  return (
    <div style={{ padding: 12 }}>
      <div style={s.note}>
        Nodes with orange border are tasks where IsCritical=true. Edges are labelled with LinkType + Lag.
      </div>

      <div style={{ overflow: "auto", border: "1px solid #e2e8f0", borderRadius: 12 }}>
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
                  rx="10"
                  ry="10"
                  fill={isCrit ? "#fff7ed" : "#f8fafc"}
                  stroke={isCrit ? "#f59e0b" : "#94a3b8"}
                  strokeWidth={isCrit ? "3" : "2"}
                />
                <text x={x + 10} y={y + 22} fontSize="12" fontWeight="700" fill="#111">
                  #{n.task.TaskId} {n.task.TaskName}
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

/** =========================
 *  Styles factory
 *  ========================= */
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
    brandDot: {
      width: 34,
      height: 34,
      borderRadius: 10,
      background: "linear-gradient(135deg, #0f172a, #1f2937)",
    },
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
    projectLeft: { display: "flex", flexDirection: "column", gap: 4 },
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
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
    },
    btnDark: {
      padding: "8px 12px",
      borderRadius: 10,
      border: `1px solid ${dark}`,
      background: dark,
      color: "#fff",
      fontWeight: 950,
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
    },
    btnPrimary: {
      padding: "10px 14px",
      borderRadius: 12,
      border: "1px solid #0ea5a4",
      background: "#0ea5a4",
      color: "#ffffff",
      fontWeight: 950,
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
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
    kpiHint: { marginTop: 4, fontSize: 12, color: sub, fontWeight: 800 },

    sectionTitle: { fontWeight: 950, marginBottom: 6 },
    sectionSub: { fontSize: 12, color: sub, fontWeight: 800 },

    listRow: { padding: "10px 0", borderBottom: `1px solid ${border}` },
    listMeta: { fontSize: 12, color: sub, fontWeight: 800, marginTop: 2 },
    muted: { color: sub, fontWeight: 800 },

    riskRow: {
      padding: "10px 12px",
      border: `1px solid ${border}`,
      borderRadius: 12,
      marginBottom: 10,
      background: "#fff",
    },

    table: {
      width: "100%",
      borderCollapse: "separate",
      borderSpacing: 0,
      fontSize: 13,
    },
    th: {
      textAlign: "left",
      padding: "10px 10px",
      background: "#f1f5f9",
      borderBottom: `1px solid ${border}`,
      fontWeight: 950,
      color: text,
      whiteSpace: "nowrap",
    },
    td: {
      padding: "10px 10px",
      borderBottom: "1px solid #eef2f7",
      verticalAlign: "top",
      color: text,
    },
    tdInput: {
      width: 70,
      padding: "6px 8px",
      borderRadius: 10,
      border: `1px solid ${border}`,
      outline: "none",
    },
    smallBtnDark: {
      marginLeft: 8,
      padding: "6px 10px",
      borderRadius: 10,
      border: `1px solid ${dark}`,
      background: dark,
      color: "#fff",
      fontWeight: 950,
      cursor: "pointer",
    },
    smallBtnDanger: {
      marginLeft: 8,
      padding: "6px 10px",
      borderRadius: 10,
      border: "1px solid #fecaca",
      background: "#fef2f2",
      color: "#991b1b",
      fontWeight: 950,
      cursor: "pointer",
    },
    depRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    depName: { minWidth: 250, fontWeight: 900 },
    select: {
      padding: "6px 8px",
      borderRadius: 10,
      border: `1px solid ${border}`,
      background: "#fff",
      outline: "none",
    },
    lagInput: {
      width: 70,
      padding: "6px 8px",
      borderRadius: 10,
      border: `1px solid ${border}`,
      outline: "none",
    },
    depWarn: { color: "#b91c1c", fontSize: 12, fontWeight: 900, marginLeft: 6 },

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
      minWidth: 360,
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
