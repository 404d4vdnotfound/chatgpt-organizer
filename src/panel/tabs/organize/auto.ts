import type { Dom } from "../../app/dom";
import type { PanelCache } from "../../app/cache";
import type { createBus } from "../../app/bus";
import { getBusy } from "../../app/state";
import { MSG, type AnyEvent } from "../../../shared/messages";
import type { ProjectItem } from "../../../shared/types";

type Bus = ReturnType<typeof createBus>;

type Proposal = {
  chatId: string;
  chatTitle: string;
  chatHref?: string;
  projectId: string;
  projectTitle: string;
  confidence: number;
  reason: string;
  selected: boolean;
};

type Ui = {
  box: HTMLDetailsElement;
  threshold: HTMLInputElement;
  scan: HTMLButtonElement;
  apply: HTMLButtonElement;
  toggle: HTMLInputElement;
  confirm: HTMLInputElement;
  status: HTMLDivElement;
  list: HTMLUListElement;
};

const MIN_REVIEW_CONFIDENCE = 0.7;
const DEFAULT_AUTO_CONFIDENCE = 0.9;
const MOVE_TIMEOUT_MS = 20 * 60 * 1000;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "best", "but", "by", "can", "do", "for", "from",
  "get", "how", "i", "in", "into", "is", "it", "me", "my", "of", "on", "or", "our", "the", "this",
  "to", "use", "using", "vs", "what", "when", "where", "which", "with", "you", "your",
]);

const TOPIC_FAMILIES: Array<{ projectHints: string[]; terms: string[] }> = [
  {
    projectHints: ["home assistant", "home automation", "smart home", "homekit"],
    terms: [
      "home assistant", "homekit", "aqara", "matter", "zigbee", "thread", "hacs", "ecobee", "eufy",
      "roborock", "rachio", "homepod", "apple tv", "sensor", "automation",
    ],
  },
  {
    projectHints: ["networking", "network", "unifi", "wifi", "wi fi"],
    terms: [
      "unifi", "udr", "u7", "u6", "wifi", "wi fi", "vlan", "ssid", "dns", "dhcp", "poe", "router",
      "access point", "tailscale", "wireguard", "vpn", "firewall", "multicast", "igmp",
    ],
  },
  {
    projectHints: ["qa", "testing", "quality assurance", "test automation"],
    terms: [
      "qa", "quality assurance", "test case", "testing", "regression", "playwright", "selenium", "cypress",
      "k6", "api test", "automation testing", "bug", "defect",
    ],
  },
  {
    projectHints: ["career", "jobs", "job search", "employment", "interview"],
    terms: [
      "resume", "cv", "interview", "job application", "linkedin", "recruiter", "salary", "hourly rate",
      "cover letter", "hiring", "job", "career",
    ],
  },
  {
    projectHints: ["software development", "development", "coding", "programming", "dev"],
    terms: [
      "typescript", "javascript", "python", "github", "git", "repository", "repo", "api", "node", "npm",
      "deno", "react", "nextjs", "next js", "database", "sqlite", "code", "coding",
    ],
  },
  {
    projectHints: ["legal", "court", "case", "litigation"],
    terms: [
      "court", "hearing", "motion", "filing", "attorney", "lawyer", "counsel", "contempt", "discovery",
      "mediation", "order", "judge", "magistrate", "case",
    ],
  },
  {
    projectHints: ["family", "parenting", "kids", "children"],
    terms: ["parenting", "school", "children", "child", "kids", "family", "custody", "visitation"],
  },
  {
    projectHints: ["automotive", "cars", "vehicles", "vehicle"],
    terms: ["car", "truck", "vehicle", "tire", "subaru", "silverado", "tahoe", "hitch", "carplay"],
  },
  {
    projectHints: ["travel", "trips", "vacation"],
    terms: ["flight", "airport", "hotel", "travel", "trip", "parking", "denver airport", "dia"],
  },
];

function normalize(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

function includesTerm(normalizedText: string, term: string): boolean {
  const n = normalize(term);
  if (!n) return false;
  return ` ${normalizedText} `.includes(` ${n} `) || normalizedText.includes(n);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function projectMatchesHint(projectTitle: string, hint: string): boolean {
  const p = normalize(projectTitle);
  const h = normalize(hint);
  return p === h || p.includes(h) || h.includes(p);
}

function buildLearnedProfiles(projects: ProjectItem[]) {
  const profiles = new Map<string, Map<string, number>>();
  const docFreq = new Map<string, number>();

  for (const project of projects) {
    const weights = new Map<string, number>();

    for (const token of tokens(project.title || "")) {
      weights.set(token, (weights.get(token) || 0) + 4);
    }

    for (const conversation of project.conversations || []) {
      for (const token of new Set(tokens(conversation.title || ""))) {
        weights.set(token, (weights.get(token) || 0) + 1);
      }
    }

    profiles.set(project.gizmoId, weights);
    for (const token of weights.keys()) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  return { profiles, docFreq };
}

function scoreProject(args: {
  chatTitle: string;
  project: ProjectItem;
  projectCount: number;
  learnedWeights: Map<string, number>;
  docFreq: Map<string, number>;
}): { score: number; reason: string } {
  const chatNorm = normalize(args.chatTitle);
  const chatTokenList = tokens(args.chatTitle);
  const chatTokens = new Set(chatTokenList);
  const projectNorm = normalize(args.project.title || "");
  const projectTokens = tokens(args.project.title || "");

  let score = 0;
  let reason = "";

  if (projectNorm.length >= 3 && includesTerm(chatNorm, projectNorm)) {
    score = 0.99;
    reason = "project name appears in chat title";
  }

  if (projectTokens.length) {
    const overlap = projectTokens.filter((t) => chatTokens.has(t));
    if (overlap.length) {
      const ratio = overlap.length / projectTokens.length;
      const tokenScore = overlap.length === projectTokens.length
        ? (projectTokens.length >= 2 ? 0.96 : 0.86)
        : 0.72 + ratio * 0.14;
      if (tokenScore > score) {
        score = tokenScore;
        reason = `project-title match: ${overlap.join(", ")}`;
      }
    }
  }

  for (const family of TOPIC_FAMILIES) {
    if (!family.projectHints.some((hint) => projectMatchesHint(args.project.title || "", hint))) continue;

    const matched = family.terms.filter((term) => includesTerm(chatNorm, term));
    if (!matched.length) continue;

    const familyScore = Math.min(0.98, 0.94 + Math.min(0.04, (matched.length - 1) * 0.02));
    if (familyScore > score) {
      score = familyScore;
      reason = `topic match: ${matched.slice(0, 4).join(", ")}`;
    }
  }

  const learnedMatches: Array<{ token: string; value: number }> = [];
  for (const token of chatTokens) {
    const weight = args.learnedWeights.get(token) || 0;
    if (!weight) continue;

    const df = args.docFreq.get(token) || 1;
    const idf = Math.log((1 + args.projectCount) / (1 + df)) + 1;
    const value = Math.min(4, weight) * idf;
    learnedMatches.push({ token, value });
  }

  learnedMatches.sort((a, b) => b.value - a.value);
  if (learnedMatches.length) {
    const raw = learnedMatches.reduce((sum, x) => sum + x.value, 0);
    const learnedScore = learnedMatches.length >= 2
      ? Math.min(0.95, 0.84 + Math.min(0.11, raw * 0.018))
      : Math.min(0.88, 0.78 + raw * 0.02);

    if (learnedScore > score) {
      score = learnedScore;
      reason = `learned from existing project chats: ${learnedMatches.slice(0, 4).map((x) => x.token).join(", ")}`;
    }
  }

  return { score: clamp01(score), reason };
}

function buildProposals(singleChats: any[], projects: ProjectItem[], threshold: number): Proposal[] {
  if (!singleChats.length || !projects.length) return [];

  const { profiles, docFreq } = buildLearnedProfiles(projects);
  const out: Proposal[] = [];

  for (const chat of singleChats) {
    const title = String(chat?.title || "").trim();
    if (!chat?.id || !title) continue;

    const scored = projects
      .map((project) => {
        const learnedWeights = profiles.get(project.gizmoId) || new Map<string, number>();
        const s = scoreProject({
          chatTitle: title,
          project,
          projectCount: projects.length,
          learnedWeights,
          docFreq,
        });
        return { project, ...s };
      })
      .filter((x) => x.score >= MIN_REVIEW_CONFIDENCE)
      .sort((a, b) => b.score - a.score);

    if (!scored.length) continue;

    const best = scored[0];
    const second = scored[1];

    // Conservative ambiguity guard: do not suggest when two projects score almost equally.
    if (second && second.score >= 0.8 && best.score - second.score < 0.04) continue;

    out.push({
      chatId: chat.id,
      chatTitle: title,
      chatHref: chat.href,
      projectId: best.project.gizmoId,
      projectTitle: best.project.title || "Untitled project",
      confidence: best.score,
      reason: best.reason || "title similarity",
      selected: best.score >= threshold,
    });
  }

  return out.sort((a, b) => b.confidence - a.confidence || a.chatTitle.localeCompare(b.chatTitle));
}

export function createAutoOrganize(args: {
  dom: Dom;
  bus: Bus;
  cache: PanelCache;
  prepareAndRunMove: (ids: string[], gizmoId: string) => void;
}) {
  const { dom, bus, cache, prepareAndRunMove } = args;
  let ui: Ui | null = null;
  let proposals: Proposal[] = [];
  let running = false;

  function q<T extends Element>(root: ParentNode, selector: string): T {
    const el = root.querySelector(selector) as T | null;
    if (!el) throw new Error(`[auto-organize] Missing ${selector}`);
    return el;
  }

  function thresholdValue(): number {
    const raw = Number(ui?.threshold.value ?? DEFAULT_AUTO_CONFIDENCE);
    if (!Number.isFinite(raw)) return DEFAULT_AUTO_CONFIDENCE;
    return Math.max(MIN_REVIEW_CONFIDENCE, Math.min(1, raw));
  }

  function setControlsDisabled(disabled: boolean) {
    if (!ui) return;
    ui.scan.disabled = disabled;
    ui.threshold.disabled = disabled;
    ui.toggle.disabled = disabled;
    ui.confirm.disabled = disabled;
    const selectedCount = proposals.filter((p) => p.selected).length;
    ui.apply.disabled = disabled || selectedCount === 0 || !ui.confirm.checked;
  }

  function updateStatus(prefix?: string) {
    if (!ui) return;
    const snap = cache.getSnapshot();
    const singles = snap.singleChats?.length || 0;
    const selected = proposals.filter((p) => p.selected).length;
    const unmatched = Math.max(0, singles - proposals.length);
    const base = `${singles} unprojected · ${proposals.length} suggested · ${selected} checked · ${unmatched} unmatched`;
    ui.status.textContent = prefix ? `${prefix} · ${base}` : base;
    setControlsDisabled(running);
  }

  function render() {
    if (!ui) return;
    ui.list.replaceChildren();

    for (const proposal of proposals) {
      const li = document.createElement("li");
      li.style.padding = "8px 0";

      const label = document.createElement("label");
      label.style.display = "grid";
      label.style.gridTemplateColumns = "20px 1fr";
      label.style.gap = "8px";
      label.style.alignItems = "start";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = proposal.selected;
      cb.disabled = running;
      cb.addEventListener("change", () => {
        proposal.selected = cb.checked;
        if (ui) ui.confirm.checked = false;
        updateStatus();
      });

      const body = document.createElement("div");
      const title = document.createElement("div");
      title.textContent = proposal.chatTitle;

      const destination = document.createElement("div");
      destination.className = "muted";
      destination.textContent = `→ ${proposal.projectTitle} · ${Math.round(proposal.confidence * 100)}% · ${proposal.reason}`;

      body.append(title, destination);
      label.append(cb, body);
      li.append(label);
      ui.list.append(li);
    }

    ui.toggle.checked = proposals.length > 0 && proposals.every((p) => p.selected);
    ui.toggle.indeterminate = proposals.some((p) => p.selected) && !proposals.every((p) => p.selected);
    updateStatus();
  }

  function scan(prefix?: string) {
    if (!ui) return;
    if (getBusy() || running) {
      ui.status.textContent = "Blocked: another operation is running.";
      return;
    }

    const snap = cache.getSnapshot();
    const projects = snap.projects || [];
    const singles = snap.singleChats || [];

    if (!projects.length) {
      proposals = [];
      render();
      ui.status.textContent = "No native Projects loaded. Refresh Projects first.";
      return;
    }

    proposals = buildProposals(singles, projects, thresholdValue());
    ui.confirm.checked = false;
    render();
    if (prefix) updateStatus(prefix);
  }

  function waitForMove(ids: string[], gizmoId: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let runId: string | null = null;
      let settled = false;

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(ok);
      };

      const off = bus.on((msg: AnyEvent) => {
        const m = msg as any;
        if (m?.gizmoId !== gizmoId) return;

        if (m?.type === MSG.MOVE_CHATS_TO_PROJECT_PROGRESS) {
          if (!runId) runId = String(m.runId || "");
          return;
        }

        if (m?.type === MSG.MOVE_CHATS_TO_PROJECT_DONE) {
          const eventRunId = String(m.runId || "");
          if (runId && eventRunId && eventRunId !== runId) return;
          finish(Number(m.failCount || 0) === 0 && Number(m.okCount || 0) === ids.length);
        }
      });

      const timer = window.setTimeout(() => finish(false), MOVE_TIMEOUT_MS);

      try {
        prepareAndRunMove(ids, gizmoId);
      } catch {
        finish(false);
      }
    });
  }

  async function applyChecked() {
    if (!ui || running) return;
    if (getBusy()) {
      ui.status.textContent = "Blocked: another operation is running.";
      return;
    }
    if (!ui.confirm.checked) {
      ui.status.textContent = "Blocked: review the proposals and tick the confirmation box first.";
      return;
    }

    const selected = proposals.filter((p) => p.selected);
    if (!selected.length) {
      ui.status.textContent = "Nothing checked.";
      return;
    }

    const grouped = new Map<string, { title: string; items: Proposal[] }>();
    for (const proposal of selected) {
      const group = grouped.get(proposal.projectId) || { title: proposal.projectTitle, items: [] };
      group.items.push(proposal);
      grouped.set(proposal.projectId, group);
    }

    running = true;
    setControlsDisabled(true);

    let moved = 0;
    let groupIndex = 0;
    let failed = false;

    try {
      for (const [projectId, group] of grouped) {
        groupIndex++;
        ui.status.textContent = `Moving ${group.items.length} chat(s) to ${group.title} · group ${groupIndex}/${grouped.size}`;

        const ok = await waitForMove(group.items.map((p) => p.chatId), projectId);
        if (!ok) {
          failed = true;
          ui.status.textContent = `Stopped: move to ${group.title} did not complete cleanly. Review the Organize execution log.`;
          break;
        }

        moved += group.items.length;
      }
    } finally {
      running = false;
      setControlsDisabled(false);
    }

    if (!failed) {
      scan(`Moved ${moved} chat${moved === 1 ? "" : "s"} into native ChatGPT Projects`);
    }
  }

  function mountUi() {
    if (ui) return;

    const box = document.createElement("details");
    box.id = "autoOrganizeBox";
    box.className = "searchBox";
    box.open = true;
    box.innerHTML = `
      <summary>Auto Organize (native Projects)</summary>
      <div class="muted" style="margin:8px 0;">
        Analyzes only chats that are not already in a Project. Suggestions use project names, existing project chat titles, and conservative topic matching. No custom folders are created.
      </div>
      <div class="row" style="align-items:end;">
        <label class="fieldInline">
          <span>Auto-check confidence ≥</span>
          <input id="autoOrganizeThreshold" type="number" min="0.70" max="1.00" step="0.01" value="0.90" style="width:80px;" />
        </label>
        <button id="btnAutoOrganizeScan" type="button">Scan suggestions</button>
        <button id="btnAutoOrganizeApply" type="button" class="subtle" disabled>Apply checked</button>
      </div>
      <div class="row" style="margin-top:8px;">
        <label class="toggleAll"><input id="cbAutoOrganizeToggleAll" type="checkbox" /> Select all shown</label>
        <label class="confirm" style="margin-left:auto;"><input id="cbAutoOrganizeConfirm" type="checkbox" /> I reviewed these native Project moves.</label>
      </div>
      <div id="autoOrganizeStatus" class="muted" style="margin:8px 0;"></div>
      <ul id="autoOrganizeList" class="list"></ul>
    `;

    const grid = dom.viewOrganize.querySelector(".organizeGrid2x2");
    if (grid?.parentNode) grid.parentNode.insertBefore(box, grid);
    else dom.viewOrganize.append(box);

    ui = {
      box,
      threshold: q<HTMLInputElement>(box, "#autoOrganizeThreshold"),
      scan: q<HTMLButtonElement>(box, "#btnAutoOrganizeScan"),
      apply: q<HTMLButtonElement>(box, "#btnAutoOrganizeApply"),
      toggle: q<HTMLInputElement>(box, "#cbAutoOrganizeToggleAll"),
      confirm: q<HTMLInputElement>(box, "#cbAutoOrganizeConfirm"),
      status: q<HTMLDivElement>(box, "#autoOrganizeStatus"),
      list: q<HTMLUListElement>(box, "#autoOrganizeList"),
    };

    ui.scan.addEventListener("click", () => scan());
    ui.apply.addEventListener("click", () => void applyChecked());
    ui.toggle.addEventListener("change", () => {
      for (const proposal of proposals) proposal.selected = ui!.toggle.checked;
      ui!.confirm.checked = false;
      render();
    });
    ui.confirm.addEventListener("change", () => setControlsDisabled(running));
    ui.threshold.addEventListener("change", () => {
      const threshold = thresholdValue();
      for (const proposal of proposals) proposal.selected = proposal.confidence >= threshold;
      ui!.confirm.checked = false;
      render();
    });

    updateStatus();
  }

  return {
    bind() {
      mountUi();
    },
    refresh() {
      if (ui && !running) updateStatus();
    },
    dispose() {
      ui?.box.remove();
      ui = null;
      proposals = [];
    },
  };
}
