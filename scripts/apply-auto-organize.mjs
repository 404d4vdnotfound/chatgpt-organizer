import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const file = path.join(process.cwd(), "src/panel/tabs/organize/tab.ts");
if (!fs.existsSync(file)) {
  console.error(`Missing ${file}. Run this from the repository root.`);
  process.exit(1);
}

let src = fs.readFileSync(file, "utf8");

function replaceOnce(label, oldText, newText) {
  if (src.includes(newText)) {
    console.log(`✓ ${label} already applied`);
    return;
  }
  const idx = src.indexOf(oldText);
  if (idx < 0) {
    console.error(`✗ Could not find expected anchor for: ${label}`);
    process.exit(1);
  }
  src = src.slice(0, idx) + newText + src.slice(idx + oldText.length);
  console.log(`✓ ${label}`);
}

replaceOnce(
  "import auto organizer",
  'import { ensureDevConfigLoaded, getDevConfigSnapshot } from "../../../shared/devConfigStore";\n',
  'import { ensureDevConfigLoaded, getDevConfigSnapshot } from "../../../shared/devConfigStore";\nimport { createAutoOrganize } from "./auto";\n'
);

replaceOnce(
  "initialize auto organizer",
  '  const model = createOrganizeModel();\n  const view = createOrganizeView(dom);\n\n  let offCache: (() => void) | null = null;\n',
  '  const model = createOrganizeModel();\n  const view = createOrganizeView(dom);\n\n  const autoOrganize = createAutoOrganize({\n    dom,\n    bus,\n    cache,\n    prepareAndRunMove(ids, gizmoId) {\n      // Auto Organize intentionally operates only on chats outside Projects.\n      // Put the existing manual mover into a deterministic state so its\n      // normal progress, audit logging, and cache update path remain authoritative.\n      dom.organizeSourceEl.value = "single";\n      dom.organizeFilterEl.value = "";\n      model.setSourceMode("single");\n      model.setFilter("");\n      model.selectedChatIds.clear();\n      model.setTargetProject(gizmoId);\n      for (const id of ids) model.toggleChat(id, true);\n      refreshUI();\n      runExecuteMove(ids, gizmoId);\n    },\n  });\n\n  let offCache: (() => void) | null = null;\n'
);

replaceOnce(
  "refresh auto organizer status",
  '    view.setSourceStatus(sourceChats.length ? "" : "No source chats loaded (refresh Single/Projects first).");\n    view.setProjectsStatus(projects.length ? "" : "No projects loaded (refresh Projects first).");\n  }\n',
  '    view.setSourceStatus(sourceChats.length ? "" : "No source chats loaded (refresh Single/Projects first).");\n    view.setProjectsStatus(projects.length ? "" : "No projects loaded (refresh Projects first).");\n    autoOrganize.refresh();\n  }\n'
);

replaceOnce(
  "bind auto organizer",
  '  function bind() {\n    dom.organizeSourceEl.addEventListener("change", () => {\n',
  '  function bind() {\n    autoOrganize.bind();\n\n    dom.organizeSourceEl.addEventListener("change", () => {\n'
);

replaceOnce(
  "dispose auto organizer",
  '    dispose() {\n      off();\n      offCache?.();\n',
  '    dispose() {\n      autoOrganize.dispose();\n      off();\n      offCache?.();\n'
);

fs.writeFileSync(file, src);
console.log("\nAuto Organize wiring applied to src/panel/tabs/organize/tab.ts");
