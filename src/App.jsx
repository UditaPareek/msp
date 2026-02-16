import { useEffect, useMemo, useRef, useState } from "react";
import dagre from "dagre";
import { API_BASE } from "./config";
import logo from "./assets/msp-lite-logo.png";

/**
 * MSP Lite — App.jsx (FULL)
 *
 * Included:
 * 1) Task Table: per-task duration edit + add/edit/delete deps
 * 2) Circular dependency prevention (UI DFS) + duplicate prevention
 * 3) Drag-to-link in Gantt (FS+0)
 * 4) New Project modal (template hidden; buffer fixed)
 * 5) Build job polling after createProject
 * 6) Edit Milestones AFTER project creation (updateProjectMilestones) + recalc+reload
 * 7) Task relations popup (preds/succs)
 *
 * FIXES ADDED (Milestones correctness):
 * - Prefer LOI milestone as project start (avoid stale ProjectStartDate)
 * - Parse milestones case-insensitively (map + array)
 * - Include COMM_INTERNAL in parsed milestone set
 * - Edit Milestones modal can edit LOI + Contract COD; Internal COD shows DB value if present,
 *   otherwise derived = Contract - bufferDays, and if Contract changes we also patch COMM_INTERNAL.
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
  { key: "GRID_STUDY", label: "Grid Study" },
  { key: "COMM_CONTRACT", label: "Commissioning (as per Contract)", required: true },
];

// Milestone keys we want to parse for the UI (includes Internal COD even if not in fields list)
const MILESTONE_KEYS_FOR_UI = Array.from(new Set([...MILESTONE_FIELDS.map((f) => f.key), "COMM_INTERNAL"]));

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

  // add proposed edge
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
  return (depPairs || []).some((e) => normalizeId(e.predId) === P && normalizeId(e.succId) === S);
}

/* =========================================================
   Date helpers
   ========================================================= */
function parseISO(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  // noon UTC avoids off-by-1 day
  return new Date(Date.UTC(y, mo, d, 12, 0, 0));
}

function toISO(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function anyToISODate(v) {
  if (!v) return "";
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function pickDate(...vals) {
  for (const v of vals) {
    const iso = anyToISODate(v);
    if (iso) return iso;
  }
  return "";
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
  const [showEditMilestones, setShowEditMilestones] = useState(false);

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

  /* -------------------- tolerant task id -------------------- */
  const getTaskId = (t) => t?.TaskId ?? t?.TaskID ?? t?.taskId ?? t?.id;

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
  }, [deps]);

  const taskById = useMemo(() => {
    const m = new Map();
    for (const t of tasks || []) m.set(normalizeId(getTaskId(t)), t);
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
  const selectedPreds = selectedTaskId ? predecessorsByTask.get(normalizeId(selectedTaskId)) || [] : [];
  const selectedSuccs = selectedTaskId ? successorsByTask.get(normalizeId(selectedTaskId)) || [] : [];

  /* -------------------- date model (LOI = project start) -------------------- */
  // ✅ Prefer LOI milestone (source of truth). Fallback to Project table start date.
  const projectStartDate = useMemo(() => {
    let loi = null;

    if (project?.milestones && typeof project.milestones === "object") {
      const norm = {};
      for (const [k, v] of Object.entries(project.milestones)) {
        norm[String(k).trim().toUpperCase()] = v;
      }
      loi = parseISO(norm.LOI);
    }

    if (!loi && Array.isArray(project?.Milestones)) {
      for (const row of project.Milestones) {
        const code = String(row?.MilestoneCode ?? row?.Key ?? row?.key ?? "").trim().toUpperCase();
        if (code === "LOI") {
          const dt = row?.MilestoneDate ?? row?.Date ?? row?.date ?? row?.Value ?? row?.value;
          loi = parseISO(dt);
          break;
        }
      }
    }

    if (loi) return loi;

    const direct = parseISO(project?.projectStartDate || project?.ProjectStartDate);
    return direct || null;
  }, [project]);

  const dayToDate = (dayNo) => {
    if (!projectStartDate) return null;
    const n = Number(dayNo);
    if (!Number.isFinite(n)) return null;
    const d = new Date(projectStartDate.getTime());
    d.setUTCDate(d.getUTCDate() + n);
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

  /* -------------------- milestone parsing for Edit Milestones modal (CORRECT) -------------------- */
  const currentMilestones = useMemo(() => {
    const out = {};
    for (const k of MILESTONE_KEYS_FOR_UI) out[k] = "";

    // 1) milestones map (case-insensitive)
    if (project?.milestones && typeof project.milestones === "object") {
      const norm = {};
      for (const [k, v] of Object.entries(project.milestones)) {
        norm[String(k).trim().toUpperCase()] = v;
      }
      for (const k of Object.keys(out)) out[k] = anyToISODate(norm[k]);
    }

    // 2) milestones array (case-insensitive)
    if (Array.isArray(project?.Milestones)) {
      for (const row of project.Milestones) {
        const code = String(row?.MilestoneCode ?? row?.Key ?? row?.key ?? "").trim().toUpperCase();
        const dt = row?.MilestoneDate ?? row?.Date ?? row?.date ?? row?.Value ?? row?.value;
        if (code && code in out) out[code] = anyToISODate(dt);
      }
    }

    // 3) hard fallbacks
    out.LOI =
      out.LOI ||
      pickDate(project?.projectStartDate, project?.ProjectStartDate, project?.LOI, project?.loi);

    out.COMM_CONTRACT =
      out.COMM_CONTRACT ||
      pickDate(
        project?.contractCOD,
        project?.contractCod,
        project?.ContractCOD,
        project?.COMM_CONTRACT
      );

    out.COMM_INTERNAL =
      out.COMM_INTERNAL ||
      pickDate(
        project?.internalCOD,
        project?.internalCod,
        project?.InternalCOD,
        project?.COMM_INTERNAL
      );

    // If still missing internal, derive from contract
    if (!out.COMM_INTERNAL && out.COMM_CONTRACT) {
      const d = parseISO(out.COMM_CONTRACT);
      if (d) {
        const x = new Date(d.getTime());
        x.setUTCDate(x.getUTCDate() - Number(BUFFER_DAYS_FIXED || 30));
        out.COMM_INTERNAL = toISO(x);
      }
    }

    return out;
  }, [project]);

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
        fetchJson(
          `${API_BASE}/getSchedule?projectId=${encodeURIComponent(nextProjectId)}&versionId=latest&t=${bust}`
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
        linkType,
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

  // update milestones after project creation
  async function updateProjectMilestonesApi({ projectId, milestones }) {
    const { res, json } = await fetchJson(`${API_BASE}/updateProjectMilestones?t=${Date.now()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, milestones }),
    });
    if (!res.ok || !json?.ok) throw new Error(json?.error || "Update milestones failed");
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

    if (!pid) throw new Error("Missing projectId");
    if (!predecessorTaskId || !successorTaskId) throw new Error("Predecessor and successor are required");
    if (String(predecessorTaskId) === String(successorTaskId)) throw new Error("A task cannot depend on itself");

    if (isDuplicateEdge(depPairs, predecessorTaskId, successorTaskId)) {
      throw new Error("Dependency already exists (duplicate blocked)");
    }

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
          <img
            src={logo}
            alt="MSP Lite"
            style={{ width: 34, height: 34, borderRadius: 10, objectFit: "contain" }}
          />
          <div>
            <div style={s.brandTitle}>RaySphere</div>
            <div style={s.brandSub}>Powering Projects • Controlling Outcomes</div>
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
                Critical:{" "}
                <b>
                  {kpi.critical}/{kpi.totalTasks}
                </b>
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

            <button
              onClick={() => setShowEditMilestones(true)}
              disabled={loading || !(project?.ProjectId ?? projectId)}
              style={{ ...s.btn, ...(loading ? s.btnDisabled : {}) }}
              title="Update milestone dates for this project"
            >
              Edit Milestones
            </button>
          </div>
        </div>

        {error && <div style={s.error}>Error: {error}</div>}

        {needsStartDate && (
          <div style={s.warn}>
            Missing LOI/projectStartDate from API. UI cannot show dd-MMM-yy target dates until backend returns LOI as{" "}
            <code>project.milestones.LOI</code> (or milestones include LOI).
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

            <div style={s.twoCol}>
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
                    onTaskClick={(id) => setSelectedTaskId(normalizeId(id))}
                    onDragLink={(predId, succId) =>
                      addDependencyGuarded({
                        predecessorTaskId: predId,
                        successorTaskId: succId,
                        linkType: "FS",
                        lagDays: 0,
                      }).catch((e) => setError(e.message || String(e)))
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
                        <div key={normalizeId(getTaskId(t))} style={s.listRow}>
                          <div style={{ fontWeight: 900 }}>{t.TaskName}</div>
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
                <div style={s.cardSub}>Drag-to-link enabled: drag bar → bar to add FS link (lag 0).</div>
              </div>
            </div>

            {tasks.length && projectStartDate ? (
              <GanttDates
                tasks={tasks}
                deps={deps}
                depPairs={depPairs}
                startDate={projectStartDate}
                onTaskClick={(id) => setSelectedTaskId(normalizeId(id))}
                onDragLink={(predId, succId) =>
                  addDependencyGuarded({
                    predecessorTaskId: predId,
                    successorTaskId: succId,
                    linkType: "FS",
                    lagDays: 0,
                  }).catch((e) => setError(e.message || String(e)))
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
                <div style={s.cardSub}>DAG layout using Dagre. Showing critical-only nodes (fast).</div>
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
                  Per task: edit duration, view/edit/delete deps. Add deps via search (duplicate/cycle blocked).
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
          onCreate={async ({ projectName, milestones }) => {
            setError("");
            setLoading(true);
            setBusyMsg("Creating project...");
            try {
              const out = await createProject({
                projectName,
                templateName: FIXED_TEMPLATE_NAME,
                bufferDays: BUFFER_DAYS_FIXED,
                milestones,
              });

              const newId = String(out.projectId);
              const jobId = String(out.jobId);

              setBusyMsg("Building project from template (3000 tasks)…");
              setProjectId(newId);

              // poll job status
              const start = Date.now();
              while (true) {
                const { res, json } = await fetchJson(
                  `${API_BASE}/getBuildJobStatus?jobId=${encodeURIComponent(jobId)}&t=${Date.now()}`
                );
                if (!res.ok || !json?.ok) throw new Error(json?.error || "Job status failed");

                const status = String(json.status || "").toUpperCase();
                if (status === "DONE") break;
                if (status === "FAILED") throw new Error(`Build failed at ${json.step}: ${json.error || "Unknown error"}`);

                if (Date.now() - start > 10 * 60 * 1000) {
                  throw new Error("Build is taking too long. Check job status in DB.");
                }

                await new Promise((r) => setTimeout(r, 2500));
              }

              setShowNewProject(false);
              setBusyMsg("Recalculating schedule...");
              await recalcOnly(newId);
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

      {/* Edit Milestones Modal */}
      {showEditMilestones && (
        <EditMilestonesModal
          loading={loading}
          bufferDays={BUFFER_DAYS_FIXED}
          initial={currentMilestones}
          onClose={() => setShowEditMilestones(false)}
          onSave={async (milestonesPatch) => {
            setError("");
            setLoading(true);
            setBusyMsg("Updating milestones...");
            try {
              const pid = Number(project?.ProjectId ?? projectId);
              await updateProjectMilestonesApi({ projectId: pid, milestones: milestonesPatch });
              setShowEditMilestones(false);
              await recalcAndReload(String(pid));
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
  return <div style={{ padding: 14, color: "#475569", fontWeight: 800 }}>{text}</div>;
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
          <button style={s.iconBtn} onClick={onClose}>
            ✕
          </button>
        </div>

        <div style={s.modalBody}>
          <div style={s.relHeaderCard}>
            <div style={{ fontWeight: 900, fontSize: 16 }}>{task.TaskName}</div>
            <div style={s.relMeta}>
              <span>
                <b>Workstream:</b> {task.Workstream || "-"}
              </span>
              <span>•</span>
              <span>
                <b>Duration:</b> {task.DurationDays ?? "-"}
              </span>
              <span>•</span>
              <span>
                <b>Target:</b> {fmtDDMMMYY(start)} → {fmtDDMMMYY(finish)}
              </span>
              <span>•</span>
              <span>
                <b>Critical:</b> {task.IsCritical === 1 || task.IsCritical === true ? "YES" : "NO"}
              </span>
            </div>
          </div>

          <div style={s.relGrid}>
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
                        <div style={s.relRowMeta}>
                          {x.type}
                          {x.lag ? ` +${x.lag}` : ""}
                        </div>
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
                        <div style={s.relRowMeta}>
                          {x.type}
                          {x.lag ? ` +${x.lag}` : ""}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={s.modalFooter}>
          <button style={s.btn} onClick={onClose}>
            Close
          </button>
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
    x.setUTCDate(x.getUTCDate() - Number(bufferDays || 30));
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
          <button style={s.iconBtn} onClick={onClose} disabled={loading}>
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
          <button style={s.btn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            style={{ ...s.btnPrimary, ...(!canSubmit || loading ? s.btnDisabled : {}) }}
            disabled={!canSubmit || loading}
            onClick={() => {
              onCreate({
                projectName: projectName.trim(),
                milestones: { ...milestones, COMM_INTERNAL: commissioningInternalDate },
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

/* -------------------- Edit Milestones Modal (correct LOI/Contract/Internal behavior) -------------------- */
function EditMilestonesModal({ onClose, onSave, loading, initial, bufferDays }) {
  const s = makeStyles();

  // Allow editing LOI + COMM_CONTRACT + optional milestones (everything in MILESTONE_FIELDS)
  const EDIT_FIELDS = MILESTONE_FIELDS;

  const [vals, setVals] = useState(() => {
    const o = {};
    for (const f of EDIT_FIELDS) o[f.key] = initial?.[f.key] || "";
    return o;
  });

  useEffect(() => {
    const o = {};
    for (const f of EDIT_FIELDS) o[f.key] = initial?.[f.key] || "";
    setVals(o);
  }, [initial]); // keep in sync if project changes

  const contractISO = anyToISODate(vals.COMM_CONTRACT);
  const prevContractISO = anyToISODate(initial?.COMM_CONTRACT);
  const dbInternalISO = anyToISODate(initial?.COMM_INTERNAL);

  const internalDerived = useMemo(() => {
    if (!contractISO) return "";
    const d = parseISO(contractISO);
    if (!d) return "";
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() - Number(bufferDays || 30));
    return toISO(x);
  }, [contractISO, bufferDays]);

  const internalShown = useMemo(() => {
    // If DB has internal and contract unchanged, show DB internal; else show derived
    if (dbInternalISO && contractISO === prevContractISO) return dbInternalISO;
    return internalDerived;
  }, [dbInternalISO, contractISO, prevContractISO, internalDerived]);

  // PATCH: empty string => null (clear milestone)
  const patch = useMemo(() => {
    const p = {};

    for (const f of EDIT_FIELDS) {
      const next = anyToISODate(vals[f.key]);
      const prev = anyToISODate(initial?.[f.key]);
      if (next !== prev) p[f.key] = next ? next : null;
    }

    // Keep COMM_INTERNAL consistent with Contract COD:
    if (contractISO) {
      if (contractISO !== prevContractISO || !dbInternalISO) {
        p.COMM_INTERNAL = internalDerived ? internalDerived : null;
      }
    } else if (prevContractISO) {
      p.COMM_INTERNAL = null;
    }

    return p;
  }, [vals, initial, contractISO, prevContractISO, dbInternalISO, internalDerived, EDIT_FIELDS]);

  return (
    <div style={s.modalOverlay} onMouseDown={onClose}>
      <div style={s.modal} onMouseDown={(e) => e.stopPropagation()}>
        <div style={s.modalHeader}>
          <div>
            <div style={s.modalTitle}>Edit Milestones</div>
            <div style={s.modalSub}>
              LOI + Contract COD affect schedule base. Internal COD shown is Contract − {bufferDays} days. Save triggers Recalculate.
            </div>
          </div>
          <button style={s.iconBtn} onClick={onClose} disabled={loading}>
            ✕
          </button>
        </div>

        <div style={s.modalBody}>
          <div style={s.sectionTitle}>Reference (live)</div>
          <div style={s.sectionSub}>
            LOI: <b>{anyToISODate(vals.LOI) || "-"}</b> • Contract COD: <b>{contractISO || "-"}</b> • Internal COD:{" "}
            <b>{internalShown || "-"}</b>
          </div>

          <div style={{ marginTop: 12 }}>
            <div style={s.sectionTitle}>Milestones</div>
            <div style={s.milestoneGrid}>
              {EDIT_FIELDS.map((f) => (
                <Field key={f.key} label={f.label} required={!!f.required}>
                  <input
                    type="date"
                    style={s.inputWide}
                    value={vals[f.key] || ""}
                    onChange={(e) => setVals((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    disabled={loading}
                  />
                </Field>
              ))}

              <Field label="Commissioning (internal schedule)" hint={`Derived = Contract - ${bufferDays} days`}>
                <input type="date" style={s.inputWide} value={internalShown || ""} readOnly />
              </Field>
            </div>
          </div>
        </div>

        <div style={s.modalFooter}>
          <button style={s.btn} onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            style={{ ...s.btnPrimary, ...(loading ? s.btnDisabled : {}) }}
            disabled={loading}
            onClick={() => onSave(patch)}
          >
            Save Milestones
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

/* -------------------- Task Table (GROUPED) -------------------- */
function TaskTable({ tasks, disabled, dayToDate, fmtDDMMMYY, depPairs, onSaveDuration, onAddDep, onUpdateDep, onDeleteDep }) {
  const s = makeStyles();

  function splitParts(taskName) {
    const raw = String(taskName || "").trim();
    if (!raw) return ["(Unnamed)"];
    const parts = raw.split(" - ").map((x) => x.trim()).filter(Boolean);
    return parts.length ? parts.slice(0, 3) : [raw];
  }

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

    for (const t of tasksList || []) {
      const tid = normalizeId(t.TaskId);
      if (!tid) continue;

      const ws = String(t.Workstream || "(No Workstream)").trim() || "(No Workstream)";
      const parts = splitParts(t.TaskName);

      const wsNode = getOrCreate(root, `WS:${ws}`, ws, 0);
      const p1 = parts[0] || "(No Part-1)";
      const p1Node = getOrCreate(wsNode, `P1:${ws}::${p1}`, p1, 1);

      if (!parts[1]) {
        p1Node.taskIds.push(tid);
        continue;
      }

      const p2 = parts[1];
      const p2Node = getOrCreate(p1Node, `P2:${ws}::${p1}::${p2}`, p2, 2);

      if (!parts[2]) {
        p2Node.taskIds.push(tid);
        continue;
      }

      const p3 = parts[2];
      const p3Node = getOrCreate(p2Node, `P3:${ws}::${p1}::${p2}::${p3}`, p3, 3);
      p3Node.taskIds.push(tid);
    }

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
  const [expanded, setExpanded] = useState(() => new Set());

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

  const flatRows = useMemo(() => {
    const out = [];

    function pushGroup(node) {
      if (node.depth >= 0) out.push({ kind: "group", node });
      const isOpen = node.depth < 0 ? true : expanded.has(node.id);
      if (!isOpen) return;

      for (const child of node.children.values()) pushGroup(child);
      for (const tid of node.taskIds || []) {
        const t = taskById.get(tid);
        if (t) out.push({ kind: "task", task: t });
      }
    }

    for (const wsNode of root.children.values()) pushGroup(wsNode);
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
        <div style={s.note}>
          Grouping: <b>Workstream → Part-1 → Part-2 → Part-3</b> (split by <code>{" - "}</code>).
        </div>
      </div>

      <table style={s.table}>
        <thead>
          <tr>
            {["Workstream / Group / Task", "Dur", "Target Start", "Target Finish", "Float", "Critical", "Dependencies"].map((h) => (
              <th key={h} style={s.th}>
                {h}
              </th>
            ))}
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

      <div style={s.note}>Dates shown are Target Dates (LOI + ES/EF). Group rows: Start=min(ES), Finish=max(EF), Dur=sum(DurationDays).</div>
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
      <td style={{ ...s.td, fontWeight: 900 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, paddingLeft: indentPx }}>
          <button
            type="button"
            onClick={onToggle}
            disabled={disabled || !canToggle}
            style={s.toggleBtn}
            title={canToggle ? "Expand/Collapse" : "No children"}
          >
            {canToggle ? (expanded ? "–" : "+") : "·"}
          </button>

          <div style={{ minWidth: 0 }}>
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {node.label} <span style={{ color: "#64748b", fontWeight: 700 }}>({a.count})</span>
            </div>
          </div>
        </div>
      </td>

      <td style={s.tdMono}>{Number.isFinite(Number(a.durSum)) ? a.durSum : ""}</td>
      <td style={s.tdMono}>{start ? fmtDDMMMYY(start) : ""}</td>
      <td style={s.tdMono}>{finish ? fmtDDMMMYY(finish) : ""}</td>

      <td style={s.tdMono}></td>
      <td style={s.tdMono}></td>
      <td style={s.td}></td>
    </tr>
  );
}

function TaskRow({ rowIndex, task, tasks, depPairs, disabled, dayToDate, fmtDDMMMYY, onSaveDuration, onAddDep, onUpdateDep, onDeleteDep }) {
  const s = makeStyles();
  const isCrit = task.IsCritical === 1 || task.IsCritical === true;

  const [dur, setDur] = useState(task.DurationDays ?? "");
  useEffect(() => setDur(task.DurationDays ?? ""), [task.DurationDays]);

  const startDt = dayToDate(task.ES);
  const finishDt = dayToDate(task.EF);

  return (
    <tr style={{ background: isCrit ? "#fff7ed" : rowIndex % 2 === 0 ? "#ffffff" : "#fbfdff" }}>
      <td style={s.td}>
        <div style={{ fontWeight: 700, color: "#64748b", fontSize: 12 }}>{task.Workstream ?? ""}</div>
        <div style={{ fontWeight: 900 }}>{task.TaskName ?? ""}</div>
      </td>

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
      <td style={{ ...s.tdMono, fontWeight: 900, color: isCrit ? "#b45309" : "#0f172a" }}>{isCrit ? "YES" : ""}</td>

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

/**
 * PERF FIX:
 * - Collapsed by default
 * - Uses search + limited option list (prevents rendering 3000 options everywhere)
 */
function PerTaskDependencies({ tasks, depPairs, successorTaskId, disabled, onAdd, onUpdateDep, onDeleteDep }) {
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

  const [openAdd, setOpenAdd] = useState(false);
  const [q, setQ] = useState(""); // search query
  const [pred, setPred] = useState("");
  const [type, setType] = useState("FS");
  const [lag, setLag] = useState("0");

  const options = useMemo(() => {
    return (tasks || [])
      .filter((t) => normalizeId(t.TaskId) !== succ)
      .map((t) => ({
        id: normalizeId(t.TaskId),
        label: `${t.Workstream || ""} — ${t.TaskName || ""}`.trim(),
      }));
  }, [tasks, succ]);

  const filteredOptions = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options.slice(0, 120);
    const out = [];
    for (const o of options) {
      if (o.label.toLowerCase().includes(needle)) out.push(o);
      if (out.length >= 200) break;
    }
    return out;
  }, [options, q]);

  const dup = pred && isDuplicateEdge(depPairs, pred, succ);
  const cyc = pred && wouldCreateCycle(depPairs, pred, succ);

  const canAdd =
    !disabled &&
    !!pred &&
    normalizeId(pred) !== succ &&
    !dup &&
    !cyc;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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

      <div style={s.perTaskDepWrap}>
        <button
          type="button"
          style={s.btn}
          disabled={disabled}
          onClick={() => {
            setOpenAdd((v) => !v);
            if (!openAdd) {
              setQ("");
              setPred("");
              setType("FS");
              setLag("0");
            }
          }}
        >
          {openAdd ? "Hide Add Dependency" : "Add Dependency"}
        </button>

        {openAdd && (
          <>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", width: "100%" }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                disabled={disabled}
                placeholder="Search predecessor (type to filter)"
                style={{ ...s.addDepSelect, width: 300 }}
              />

              <select value={pred} onChange={(e) => setPred(e.target.value)} disabled={disabled} style={s.addDepSelect}>
                <option value="">Select predecessor…</option>
                {filteredOptions.map((x) => (
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
                  setQ("");
                }}
              >
                Add
              </button>

              {(dup || cyc) && (
                <div style={s.depInlineWarn}>{dup ? "Duplicate blocked." : "Cycle blocked."}</div>
              )}

              <div style={{ ...s.note, marginTop: 0 }}>
                Showing {filteredOptions.length} of {options.length}. Refine search to find the right predecessor.
              </div>
            </div>
          </>
        )}
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
        <div style={{ fontSize: 11, color: "#64748b", fontWeight: 700 }}>→ {toLabel}</div>
        {!hasId && <div style={s.depInlineWarn}>Missing TaskDependencyId from API. Update/Delete disabled.</div>}
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
    d.setUTCDate(d.getUTCDate() + n);
    return d;
  };

  const fmt = (d) => {
    if (!(d instanceof Date) || isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });
  };

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

  function getPredFromRaw(d) {
    return d.PredecessorTaskId ?? d.predecessorTaskId ?? d.PredecessorId ?? d.predId ?? d.predTaskId;
  }
  function getSuccFromRaw(d) {
    return d.SuccessorTaskId ?? d.successorTaskId ?? d.SuccessorId ?? d.succId ?? d.succTaskId;
  }

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

  const getAnchorX = (g, which) => (which === "start" ? g.xStart : g.xEnd);
  const resolveAnchors = (e) => {
    let fromWhich = "end";
    let toWhich = "start";
    if (e.type === "SS") {
      fromWhich = "start";
      toWhich = "start";
    } else if (e.type === "FF") {
      fromWhich = "end";
      toWhich = "end";
    } else if (e.type === "SF") {
      fromWhich = "start";
      toWhich = "end";
    }
    return { x1: getAnchorX(e.from, fromWhich), y1: e.from.yMid, x2: getAnchorX(e.to, toWhich), y2: e.to.yMid };
  };

  function startDrag(fromTaskId, clientX, clientY) {
    if (!onDragLink) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    setDrag({ fromId: normalizeId(fromTaskId), startX: x, startY: y, x, y });

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
    for (const [id, g] of geom.entries()) {
      if (x >= g.xStart && x <= g.xEnd && y >= g.barTop && y <= g.barBottom) return id;
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
      <div style={s.ganttWrap}>
        <div ref={containerRef} style={{ position: "relative", width: canvasW, height: canvasH }}>
          <div style={{ position: "absolute", left: 0, top: 0, width: LEFT_COL_W, height: HEADER_H, ...s.ganttHeader }}>
            Task
          </div>

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

          <div style={{ position: "absolute", left: 0, top: HEADER_H, width: canvasW, zIndex: 2 }}>
            {valid.map((t) => {
              const isCrit = t.IsCritical === 1 || t.IsCritical === true;
              const w = Math.max(1, (t.EF - t.ES) * PX_PER_DAY);

              const sDt = dayToDate(t.ES);
              const fDt = dayToDate(t.EF);

              const barLeft = (t.ES - minStart) * PX_PER_DAY;

              return (
                <div key={normalizeId(t.TaskId)} style={{ display: "flex", height: ROW_H, borderBottom: "1px solid #eef2f7" }}>
                  <div style={{ width: LEFT_COL_W, padding: "6px 10px", overflow: "hidden" }}>
                    <div style={{ fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {t.TaskName}
                    </div>
                    <div style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>
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

          <svg
            width={canvasW}
            height={canvasH}
            style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none", zIndex: 6 }}
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

            {drag && (
              <path
                d={`M ${drag.startX} ${drag.startY} L ${drag.x} ${drag.y}`}
                fill="none"
                stroke="#0f172a"
                strokeWidth="1.8"
                opacity="0.65"
                markerEnd="url(#arrowGantt)"
              />
            )}
          </svg>
        </div>
      </div>

      {!compact && <div style={s.note}>Tip: Drag bar → bar to create dependency (FS + 0). Add non-FS links + lag in Task Table.</div>}
    </div>
  );
}

/* -------------------- Network Diagram (critical only for performance) -------------------- */
function NetworkDiagram({ tasks, deps, getPredId, getSuccId, getDepId, getLag, getType }) {
  const normId = (v) => (v == null ? null : String(v));

  const criticalTasks = useMemo(() => (tasks || []).filter((t) => t.IsCritical === 1 || t.IsCritical === true), [tasks]);
  const criticalIdSet = useMemo(() => new Set(criticalTasks.map((t) => normId(t.TaskId))), [criticalTasks]);

  const { nodes, edges, w, h } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));

    const NODE_W = 240;
    const NODE_H = 70;

    for (const t of criticalTasks) g.setNode(normId(t.TaskId), { width: NODE_W, height: NODE_H });

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
      edgeList.push({ id: String(depId), from: pred, to: succ, label: `${type}${lag !== 0 ? `+${lag}` : ""}` });
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

  if (!nodes.length) return <div style={{ padding: 14, color: "#64748b", fontWeight: 800 }}>No critical path tasks to display.</div>;
  const s = makeStyles();

  return (
    <div style={{ padding: 14 }}>
      <div style={s.note}>Showing only Critical Path nodes + their internal dependencies.</div>
      <div style={s.netWrap}>
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
   Styles
   ========================================================= */
function makeStyles() {
  const border = "#e5eaf0";
  const text = "#0f172a";
  const sub = "#64748b";
  const dark = "#0f172a";

  return {
    page: { minHeight: "100vh", background: "#f6f8fb", color: text, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial" },
    topbar: { position: "sticky", top: 0, zIndex: 50, background: "#fff", borderBottom: `1px solid ${border}`, padding: "12px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
    brandWrap: { display: "flex", alignItems: "center", gap: 10 },
    brandTitle: { fontWeight: 900 },
    brandSub: { fontSize: 12, color: sub, fontWeight: 700 },

    tabs: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
    tabBtn: { border: `1px solid ${border}`, background: "#fff", color: text, padding: "8px 10px", borderRadius: 10, fontWeight: 800, cursor: "pointer" },
    tabBtnActive: { border: "1px solid #0ea5a4", boxShadow: "0 0 0 3px rgba(14,165,164,0.10)" },

    topActions: { display: "flex", alignItems: "center", gap: 10 },
    content: { maxWidth: 1600, margin: "0 auto", padding: "16px 18px 28px" },

    projectBar: { background: "#fff", border: `1px solid ${border}`, borderRadius: 14, padding: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.04)" },
    projectLeft: { display: "flex", flexDirection: "column", gap: 6 },
    projectName: { fontWeight: 900, fontSize: 18 },
    projectMeta: { display: "flex", gap: 10, flexWrap: "wrap", color: sub, fontSize: 12, fontWeight: 700 },
    projectRight: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
    inlineLabel: { display: "flex", alignItems: "center", gap: 8, fontWeight: 800, color: "#334155" },
    input: { width: 90, padding: "8px 10px", borderRadius: 10, border: `1px solid ${border}`, outline: "none", background: "#fff" },

    btn: { padding: "8px 12px", borderRadius: 10, border: `1px solid ${border}`, background: "#fff", color: text, fontWeight: 800, cursor: "pointer" },
    btnDark: { padding: "8px 12px", borderRadius: 10, border: `1px solid ${dark}`, background: dark, color: "#fff", fontWeight: 900, cursor: "pointer" },
    btnPrimary: { padding: "10px 14px", borderRadius: 12, border: "1px solid #0ea5a4", background: "#0ea5a4", color: "#fff", fontWeight: 900, cursor: "pointer" },
    btnDisabled: { opacity: 0.55, cursor: "not-allowed" },

    error: { marginTop: 12, background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b", padding: "10px 12px", borderRadius: 12, fontWeight: 800 },
    warn: { marginTop: 12, background: "#fff7ed", border: "1px solid #fed7aa", color: "#92400e", padding: "10px 12px", borderRadius: 12, fontWeight: 800 },

    card: { marginTop: 14, background: "#fff", border: `1px solid ${border}`, borderRadius: 14, boxShadow: "0 1px 2px rgba(0,0,0,0.04)", overflow: "hidden" },
    cardHeader: { padding: 14, borderBottom: `1px solid ${border}`, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10, flexWrap: "wrap" },
    cardHeaderRight: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
    cardTitle: { fontWeight: 900, fontSize: 16 },
    cardSub: { fontSize: 12, color: sub, fontWeight: 700 },

    twoCol: { display: "grid", gridTemplateColumns: "1.6fr 0.4fr", gap: 14, marginTop: 14 },

    kpiGrid: { padding: 14, display: "grid", gridTemplateColumns: "repeat(4, minmax(180px, 1fr))", gap: 12 },
    kpiCard: { background: "#f8fafc", border: `1px solid ${border}`, borderRadius: 14, padding: 14, textAlign: "center" },
    kpiValue: { fontWeight: 900, fontSize: 28, color: "#0ea5a4" },
    kpiLabel: { marginTop: 6, fontWeight: 800, color: "#334155" },

    listRow: { padding: "10px 0", borderBottom: `1px solid ${border}` },
    listMeta: { fontSize: 12, color: sub, fontWeight: 700, marginTop: 2 },
    muted: { color: sub, fontWeight: 700 },

    table: { width: "100%", borderCollapse: "separate", borderSpacing: 0, fontSize: 13 },
    th: { textAlign: "left", padding: "10px 10px", background: "#f1f5f9", borderBottom: `1px solid ${border}`, fontWeight: 900, color: text, whiteSpace: "nowrap", position: "sticky", top: 0, zIndex: 1 },
    td: { padding: "10px 10px", borderBottom: "1px solid #eef2f7", verticalAlign: "top", color: text },
    tdMono: { padding: "10px 10px", borderBottom: "1px solid #eef2f7", verticalAlign: "top", color: text, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
    tdInput: { width: 72, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, outline: "none" },

    smallBtnDark: { padding: "6px 10px", borderRadius: 10, border: `1px solid ${dark}`, background: dark, color: "#fff", fontWeight: 900, cursor: "pointer" },
    smallBtnDanger: { padding: "6px 10px", borderRadius: 10, border: "1px solid #b91c1c", background: "#b91c1c", color: "#fff", fontWeight: 900, cursor: "pointer" },

    note: { marginTop: 10, fontSize: 12, color: sub, fontWeight: 700 },

    overlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.25)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999 },
    overlayCard: { background: "#fff", border: `1px solid ${border}`, borderRadius: 12, padding: "16px 18px", minWidth: 420, boxShadow: "0 10px 25px rgba(0,0,0,0.12)", display: "flex", gap: 12, alignItems: "center" },
    overlayTitle: { fontWeight: 900, color: text },
    overlaySub: { fontSize: 12, color: sub, fontWeight: 700 },

    modalOverlay: { position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10000, padding: 16 },
    modal: { width: "min(980px, 100%)", background: "#fff", borderRadius: 16, border: `1px solid ${border}`, boxShadow: "0 25px 70px rgba(0,0,0,0.30)", overflow: "hidden" },
    modalHeader: { padding: 14, borderBottom: `1px solid ${border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
    modalTitle: { fontWeight: 900, fontSize: 16 },
    modalSub: { fontSize: 12, color: sub, fontWeight: 700, marginTop: 4 },
    iconBtn: { border: `1px solid ${border}`, background: "#fff", borderRadius: 10, width: 36, height: 36, cursor: "pointer", fontWeight: 900 },
    modalBody: { padding: 14 },
    modalFooter: { padding: 14, borderTop: `1px solid ${border}`, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10 },

    formGrid: { display: "grid", gridTemplateColumns: "1fr", gap: 12 },
    milestoneGrid: { marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 },

    field: { display: "flex", flexDirection: "column", gap: 6 },
    fieldLabel: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontWeight: 900, fontSize: 12 },
    fieldHint: { fontSize: 12, color: sub, fontWeight: 700 },
    req: { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#fff7ed", border: "1px solid #fed7aa", color: "#b45309", fontWeight: 900 },
    inputWide: { width: "100%", padding: "10px 10px", borderRadius: 12, border: `1px solid ${border}`, outline: "none", background: "#fff" },

    relHeaderCard: { background: "#f8fafc", border: `1px solid ${border}`, borderRadius: 14, padding: 12 },
    relMeta: { display: "flex", gap: 10, flexWrap: "wrap", color: sub, fontSize: 12, fontWeight: 700, marginTop: 6 },
    relGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 },
    relCard: { background: "#fff", border: `1px solid ${border}`, borderRadius: 14, padding: 12 },
    relTitle: { fontWeight: 900 },
    relSub: { fontSize: 12, color: sub, fontWeight: 700, marginTop: 4, marginBottom: 10 },
    relRow: { padding: "10px 10px", border: "1px solid #eef2f7", borderRadius: 12, background: "#fff", display: "flex", justifyContent: "space-between", gap: 10 },
    relRowMain: { fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    relRowMeta: { fontSize: 12, color: sub, fontWeight: 800, whiteSpace: "nowrap" },

    sectionTitle: { fontWeight: 900, fontSize: 14 },
    sectionSub: { fontSize: 12, color: sub, fontWeight: 700, marginTop: 4 },

    perTaskDepWrap: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 10px", border: `1px solid ${border}`, borderRadius: 12, background: "#fff" },
    addDepSelect: { width: 260, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, background: "#fff", outline: "none" },
    typeSelect: { width: 80, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, background: "#fff", outline: "none" },
    addDepLag: { width: 80, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, outline: "none" },
    typeSelectSmall: { width: 90, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, background: "#fff", outline: "none" },
    addDepLagSmall: { width: 90, padding: "6px 8px", borderRadius: 10, border: `1px solid ${border}`, outline: "none" },

    depInlineWarn: { color: "#b91c1c", fontSize: 12, fontWeight: 800, marginLeft: 6 },
    depListBox: { border: `1px solid ${border}`, borderRadius: 12, padding: 10, background: "#fff" },
    depListTitle: { fontWeight: 900, color: "#334155", fontSize: 12, marginBottom: 8 },

    depRow2: { display: "grid", gridTemplateColumns: "1fr 90px 90px 80px 80px", gap: 8, alignItems: "center", border: "1px solid #eef2f7", borderRadius: 12, padding: "10px 10px", background: "#fff" },
    depFromTo: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
    depLine: { display: "flex", alignItems: "flex-start", minWidth: 0 },
    depText: { fontWeight: 800, color: "#0f172a", whiteSpace: "normal", overflow: "visible", lineHeight: 1.2 },

    ganttWrap: { overflowX: "auto", border: `1px solid ${border}`, borderRadius: 14, background: "#fff" },
    ganttHeader: { display: "flex", alignItems: "center", paddingLeft: 10, fontWeight: 900, color: "#334155", background: "#fff", borderBottom: `1px solid ${border}` },

    netWrap: { overflow: "auto", border: `1px solid ${border}`, borderRadius: 14, background: "#fff" },

    toggleBtn: { width: 28, height: 28, borderRadius: 10, border: `1px solid ${border}`, background: "#fff", cursor: "pointer", fontWeight: 900 },
  };
}
