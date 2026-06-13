import express from "express";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();



app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PDF_PATH = "/tmp/latest.pdf";
const htmlTemplate = fs.readFileSync(path.join(__dirname, "template.html"), "utf8");

const visualBasePath = path.join(__dirname, "visual-base.png");
const visualBaseDataUri = fs.existsSync(visualBasePath)
  ? `data:image/png;base64,${fs.readFileSync(visualBasePath).toString("base64")}`
  : "";




// ══════════════════════════════════════════════════════════════
// § 1  UTILITIES
// ══════════════════════════════════════════════════════════════

const safe = (v, fallback = "—") => {
  if (v === undefined || v === null || v === "") return fallback;
  return String(v);
};

const clamp = (v) => Math.max(0, Math.min(100, v));

// ══════════════════════════════════════════════════════════════
// § 2  INPUT NORMALIZATION  (no recursion, no self-call)
// ══════════════════════════════════════════════════════════════

function normalizeInput(raw) {
  if (!raw) return {};

  // Label-based extraction for Make.com / webhook payloads
  if (raw.data && Array.isArray(raw.data.fields)) {
    const parsed = {};
    raw.data.fields.forEach((f) => {
      const label = (f.label || "").toLowerCase();
      const value = f.value || "";
      if (label.includes("application")) parsed.application = value;
      if (label.includes("material") && !label.includes("bio") && !label.includes("target"))
        parsed.material = value;
      if (label.includes("bio") || label.includes("target"))
        parsed.bio_material = value;
      if (label.includes("processing")) parsed.processing = value;
      if (label.includes("equipment"))  parsed.equipment   = value;
      if (label.includes("scale"))      parsed.scale        = value;
      if (label.includes("stage"))      parsed.project_stage = value;
      if (label.includes("issue"))      parsed.issues       = value;
      if (label.includes("concern"))    parsed.concern      = value;
      if (label.includes("note"))       parsed.notes        = value;
    });
    return parsed;
  }

  // Direct JSON body (from Claude artifact / API test)
  return raw;
}

// ══════════════════════════════════════════════════════════════
// § 3  SCORING ENGINE
// ══════════════════════════════════════════════════════════════


// =========================================================
// RELEASE FIX: Equipment form mapping + risk penalty logic
// Purpose:
// - map real paid-access form fields into report engine fields
// - prevent overly optimistic HIGH results for hot-fill / sealing / gauge / no-modification risks
// =========================================================

function pickFirst(obj, keys, fallback = "") {
  for (const key of keys) {
    const value = obj && obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return fallback;
}

function looksLikeMaterial(value) {
  const v = String(value || "").toLowerCase();
  return /\b(ldpe|lldpe|hdpe|pp|pet|ps|pla|pbat|pha|pe)\b/.test(v);
}


// =========================================================
// RELEASE ACCESS CONTROL: one-assessment token system
// Initial assessment: one use only
// Feedback bonus: issue a separate token for one additional assessment
// =========================================================

const EQUIPMENT_DEMO_TOKEN_REGISTRY = new Map();

function registerEquipmentDemoToken(token, meta = {}) {
  if (!token) return;
  EQUIPMENT_DEMO_TOKEN_REGISTRY.set(String(token).trim(), {
    token: String(token).trim(),
    maxUses: Number(meta.maxUses || 1),
    usedCount: 0,
    type: meta.type || "initial",
    company: meta.company || "",
    createdAt: new Date().toISOString()
  });
}

// Current shared token kept for immediate release continuity.
// New customer-specific tokens should be sent by email individually.
[
  "FVE-ILN-202606-EQ01",
  "FVE-ILN-202606-EQ02",
  "FVE-ILN-202606-EQ03",
  "FVE-ILN-202606-EQ04",
  "FVE-ILN-202606-EQ05",
  "FVE-ILN-202606-EQ06",
  "FVE-ILN-202606-EQ07",
  "FVE-ILN-202606-EQ08",
  "FVE-ILN-202606-EQ09",
  "FVE-ILN-202606-EQ10",
  "FVE-ILN-202606-EQ11",
  "FVE-ILN-202606-EQ12",
  "FVE-ILN-202606-EQ13",
  "FVE-ILN-202606-EQ14",
  "FVE-ILN-202606-EQ15",
  "FVE-ILN-202606-EQ16",
  "FVE-ILN-202606-EQ17",
  "FVE-ILN-202606-EQ18",
  "FVE-ILN-202606-EQ19",
  "FVE-ILN-202606-EQ20"
].forEach((token, index) => registerEquipmentDemoToken(token, {
  type: "initial",
  company: `Initial demo ${index + 1}`,
  maxUses: 1
}));

[
  "FVE-ILN-202606-FB01",
  "FVE-ILN-202606-FB02",
  "FVE-ILN-202606-FB03",
  "FVE-ILN-202606-FB04",
  "FVE-ILN-202606-FB05",
  "FVE-ILN-202606-FB06",
  "FVE-ILN-202606-FB07",
  "FVE-ILN-202606-FB08",
  "FVE-ILN-202606-FB09",
  "FVE-ILN-202606-FB10"
].forEach((token, index) => registerEquipmentDemoToken(token, {
  type: "feedback_bonus",
  company: `Feedback bonus ${index + 1}`,
  maxUses: 1
}));

if (process.env.EQUIPMENT_DEMO_TOKEN) {
  registerEquipmentDemoToken(process.env.EQUIPMENT_DEMO_TOKEN, {
    type: "initial_env",
    company: "Environment token",
    maxUses: 1
  });
}

function extractEquipmentDemoToken(req) {
  const direct =
    req.query?.token ||
    req.body?.token ||
    req.headers?.["x-demo-token"] ||
    req.headers?.["x-equipment-demo-token"];

  if (direct) return String(direct).trim();

  const referer = req.headers?.referer || req.headers?.referrer;
  if (referer) {
    try {
      const url = new URL(referer);
      return String(url.searchParams.get("token") || "").trim();
    } catch (_) {
      return "";
    }
  }

  return "";
}

function isInternalAutofillTest(req) {
  const referer = req.headers?.referer || req.headers?.referrer || "";
  try {
    const url = new URL(referer);
    return Boolean(url.searchParams.get("test"));
  } catch (_) {
    return false;
  }
}

function getEquipmentDemoTokenRecord(token) {
  if (!token) return null;
  return EQUIPMENT_DEMO_TOKEN_REGISTRY.get(String(token).trim()) || null;
}

function isValidDemoToken(token) {
  const record = getEquipmentDemoTokenRecord(token);
  if (!record) return false;
  return record.usedCount < record.maxUses;
}

function consumeEquipmentDemoToken(req) {
  // Internal test URLs with &test=1..5 should not consume customer tokens.
  if (isInternalAutofillTest(req)) {
    return { ok: true, skipped: true, reason: "internal_test" };
  }

  const token = extractEquipmentDemoToken(req);
  const record = getEquipmentDemoTokenRecord(token);

  if (!record) {
    return {
      ok: false,
      status: 403,
      message: "Invalid or missing demo access. Please request a new assessment access link."
    };
  }

  if (record.usedCount >= record.maxUses) {
    return {
      ok: false,
      status: 410,
      message: "This assessment access has already been used. Please request another assessment access if needed."
    };
  }

  record.usedCount += 1;
  record.usedAt = new Date().toISOString();

  return { ok: true, token, record };
}


function normalizeEquipmentFormPayload(raw = {}) {
  const productType = pickFirst(raw, [
    "product_type",
    "productType",
    "product",
    "Product type",
    "type"
  ]);

  const applicationRaw = pickFirst(raw, [
    "application",
    "product_application",
    "productApplication",
    "Application"
  ]);

  const currentMaterialRaw = pickFirst(raw, [
    "current_material",
    "currentMaterial",
    "material",
    "Current material"
  ]);

  const targetMaterial = pickFirst(raw, [
    "target_biodegradable_material",
    "target_material",
    "bio_material",
    "biomaterial",
    "transition_material",
    "Target biodegradable material"
  ]);

  const application =
    looksLikeMaterial(applicationRaw) && productType
      ? productType
      : (applicationRaw || productType || "this application");

  const currentMaterial =
    currentMaterialRaw ||
    (looksLikeMaterial(applicationRaw) ? applicationRaw : "");

  const processing = pickFirst(raw, [
    "processing_method",
    "processingMethod",
    "processing",
    "process",
    "Processing method"
  ]);

  const equipment = pickFirst(raw, [
    "equipment_type",
    "equipmentType",
    "equipment",
    "line",
    "Equipment type"
  ]);

  const issues = pickFirst(raw, [
    "known_issues",
    "knownIssues",
    "issues",
    "Known issues with the current product or process"
  ]);

  const concern = pickFirst(raw, [
    "main_technical_concern",
    "technical_concern",
    "concern",
    "critical_area",
    "Which area is most critical?",
    "Main technical concern"
  ]);

  const additionalNotes = pickFirst(raw, [
    "additional_notes",
    "additionalNotes",
    "notes",
    "Additional notes"
  ]);

  const dieInfo = pickFirst(raw, [
    "die_mold_information",
    "die_mold_info",
    "die_info",
    "Die / mold information"
  ]);

  return {
    ...raw,

    // canonical fields used by report engine
    application,
    product_type: productType,
    material: currentMaterial || pickFirst(raw, ["material"], "current material"),
    current_material: currentMaterial || pickFirst(raw, ["material"], ""),
    bio_material: targetMaterial || pickFirst(raw, ["bio_material"], "target biodegradable material"),
    target_material: targetMaterial,
    processing,
    equipment,
    issues,
    concern,
    additional_notes: additionalNotes,
    die_mold_information: dieInfo,

    // combined narrative context used by risk logic
    _risk_context: [
      application,
      productType,
      currentMaterial,
      targetMaterial,
      processing,
      equipment,
      issues,
      concern,
      additionalNotes,
      dieInfo,
      pickFirst(raw, ["what_matters_most", "What matters most for this product?"]),
      pickFirst(raw, ["critical_area", "Which area is most critical?"])
    ].filter(Boolean).join(" | ")
  };
}

function applyEquipmentRiskPenalties(scores, input = {}) {
  const out = { ...scores };
  const ctx = String(input._risk_context || Object.values(input).join(" ")).toLowerCase();

  const lower = (field) => String(input[field] || "").toLowerCase();

  const has = (...words) => words.some(w => ctx.includes(w));

  let thermalPenalty = 0;
  let flowPenalty = 0;
  let mechanicalPenalty = 0;

  // High-risk use conditions
  if (has("hot-fill", "hot fill", "high temperature filling")) {
    thermalPenalty += 18;
    mechanicalPenalty += 8;
  }

  if (has("high-speed", "high speed", "higher line-speed", "higher line speed")) {
    flowPenalty += 8;
  }

  if (has("no equipment modification", "no modification", "existing line only", "minimize equipment modification")) {
    thermalPenalty += 5;
    flowPenalty += 5;
  }

  // Known failure modes
  if (has("unstable sealing", "seal-window", "seal window", "seal strength", "sealing")) {
    flowPenalty += 7;
    mechanicalPenalty += 5;
  }

  if (has("thickness variation", "gauge variation", "dimensional variation", "warpage", "poor output consistency", "bubble instability")) {
    flowPenalty += 9;
    mechanicalPenalty += 5;
  }

  if (has("pressure fluctuation", "melt instability", "melt strength variation", "output inconsistency")) {
    flowPenalty += 8;
  }

  // Material-specific sensitivity
  if (has("pha")) {
    thermalPenalty += 8;
    flowPenalty += 5;
  }

  if (has("pla", "pbat")) {
    thermalPenalty += 7;
  }

  if (has("processing stability", "thermal stability")) {
    thermalPenalty += 4;
    flowPenalty += 4;
  }

  out.thermal = Math.max(35, Math.round((Number(out.thermal) || 0) - thermalPenalty));
  out.flow = Math.max(35, Math.round((Number(out.flow) || 0) - flowPenalty));
  out.mechanical = Math.max(35, Math.round((Number(out.mechanical) || 0) - mechanicalPenalty));

  out.total = Math.round((out.thermal + out.flow + out.mechanical) / 3);

  return out;
}


function calculateScores(input) {
  let thermal   = 85;
  let flow       = 85;
  let mechanical = 85;

  const mat = (input.material    || "").toUpperCase();
  const bio = (input.bio_material || "").toUpperCase();
  const app = (input.application  || "").toUpperCase();

  // Material adjustments
  if ((mat.includes("CPP") || mat.includes("PP")) && !mat.includes("PET")) thermal -= 10;
  if (mat.includes("PE") && !mat.includes("PET")) thermal -= 5;
  if (mat.includes("PET")) thermal -= 25;

  // Biomaterial adjustments
  if (bio.includes("PLA")) thermal -= 10;
  if (bio.includes("PHA") || bio.includes("PHB")) flow -= 10;

  // Application adjustments
  if (app.includes("FILM"))   flow       -= 15;
  if (app.includes("INJECT")) mechanical -= 10;

  thermal   = clamp(thermal);
  flow       = clamp(flow);
  mechanical = clamp(mechanical);

  const bottleneck = Math.min(thermal, flow, mechanical);
  const avg        = (thermal + flow + mechanical) / 3;
  const total      = Math.round(bottleneck * 0.7 + avg * 0.3);

  return { thermal, flow, mechanical, total };
}

// ══════════════════════════════════════════════════════════════
// § 4  CONSTRAINT LOGIC  — tie-breaking: Flow > Thermal > Mechanical
// ══════════════════════════════════════════════════════════════

function getConstraint(scores) {
  const min = Math.min(scores.thermal, scores.flow, scores.mechanical);

  if (scores.flow === min) {
    return {
      type:    "FLOW",
      score:   scores.flow,
      factor:  "flow consistency during extended production runs",
      impact:  "production consistency, yield rate, and operational efficiency",
      control: "pressure stability, melt uniformity, and extrusion flow balance",
    };
  }

  if (scores.thermal === min) {
    return {
      type:    "THERMAL",
      score:   scores.thermal,
      factor:  "thermal stability under processing conditions",
      impact:  "material degradation risk and process reliability",
      control: "temperature control precision and thermal distribution",
    };
  }

  return {
    type:    "MECHANICAL",
    score:   scores.mechanical,
    factor:  "mechanical integrity under load conditions",
    impact:  "product strength and structural performance",
    control: "material strength consistency and structural reliability",
  };
}

// ══════════════════════════════════════════════════════════════
// § 5  DECISION ENGINE
// ══════════════════════════════════════════════════════════════

function determineDecision(total) {
  if (total >= 75) return { decision: "GO",            level: "HIGH"     };
  if (total >= 55) return { decision: "CONDITIONAL GO", level: "MODERATE" };
  return              { decision: "HOLD",           level: "LOW"      };
}

// ══════════════════════════════════════════════════════════════
// § 6  ECONOMIC IMPACT
// ══════════════════════════════════════════════════════════════

function calculateEconomic(total) {
  if (total >= 75) return "+5–15%";
  if (total >= 55) return "+15–30%";
  return "+30%+";
}

// ══════════════════════════════════════════════════════════════
// § 7  EXECUTIVE SUMMARY  (9-branch: LOW / MODERATE×3 / HIGH×1)
//       LOW ×1, MODERATE×FLOW, MODERATE×THERMAL, MODERATE×MECHANICAL,
//       HIGH ×1  → 5 primary branches; nuance layered by scores inside each
// ══════════════════════════════════════════════════════════════

function generateExecutive(scores, decision, economic, constraint) {
  const { thermal, flow, mechanical, total } = scores;
  const scoreBlock = `Thermal (${thermal}) / Flow (${flow}) / Mechanical (${mechanical}) / Composite: ${total}`;

  // ── LOW ────────────────────────────────────────────────────
  if (decision.level === "LOW") {
    return (
      `This assessment indicates LOW feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is critically constrained by instability in ${constraint.factor} (score: ${constraint.score}/100). ` +
      `This constraint is expected to severely impact ${constraint.impact}, making stable production unsustainable under existing conditions. ` +
      `Observed instability levels indicate high risk of operational failure, excessive scrap generation, and unacceptable output variability.\n\n` +
      `Material cost variance is projected at ${economic}, reflecting the re-engineering requirements implied by the current configuration.\n\n` +
      `Deployment Decision: HOLD — Commercial-scale deployment is not recommended. ` +
      `A fundamental reassessment of material compatibility or processing architecture is required before further validation proceeds.`
    );
  }

  // ── MODERATE / FLOW ────────────────────────────────────────
  if (decision.level === "MODERATE" && constraint.type === "FLOW") {
    return (
      `This assessment indicates MODERATE feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is operationally viable but constrained by flow-related instability. ` +
      `Variability in ${constraint.factor} (score: ${constraint.score}/100) may impact ${constraint.impact}, ` +
      `particularly under extended production cycles and high line-speed conditions. ` +
      `Melt behaviour management represents the primary challenge for achieving stable commercial operation.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `A controlled pilot validation phase is recommended with specific focus on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO`
    );
  }

  // ── MODERATE / THERMAL ─────────────────────────────────────
  if (decision.level === "MODERATE" && constraint.type === "THERMAL") {
    return (
      `This assessment indicates MODERATE feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is operationally viable but thermally sensitive. ` +
      `Instability in ${constraint.factor} (score: ${constraint.score}/100) may influence ${constraint.impact}, ` +
      `particularly under elevated or variable processing temperatures. ` +
      `The target biodegradable material's narrow thermal window requires precision temperature control to prevent degradation onset during sustained production.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `Pilot validation is recommended with emphasis on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO`
    );
  }

  // ── MODERATE / MECHANICAL ──────────────────────────────────
  if (decision.level === "MODERATE") {
    return (
      `This assessment indicates MODERATE feasibility for the evaluated material transition within the current processing framework.\n\n` +
      `${scoreBlock}\n\n` +
      `The system is viable but exhibits structural sensitivity under load conditions. ` +
      `Limitations in ${constraint.factor} (score: ${constraint.score}/100) may affect ${constraint.impact}, ` +
      `particularly in demanding application environments. ` +
      `Product performance consistency must be validated through controlled mechanical testing before commercial commitment.\n\n` +
      `Material cost variance is projected at ${economic}. ` +
      `Pilot validation is recommended with focus on ${constraint.control}.\n\n` +
      `Deployment Decision: CONDITIONAL GO`
    );
  }

  // ── HIGH ───────────────────────────────────────────────────
  return (
    `This assessment indicates HIGH feasibility for the evaluated material transition within the current processing framework.\n\n` +
    `${scoreBlock}\n\n` +
    `The system demonstrates strong compatibility across all key processing parameters. ` +
    `Minor sensitivity to ${constraint.factor} (score: ${constraint.score}/100) may exist, ` +
    `but does not significantly impact ${constraint.impact} under standard operating conditions. ` +
    `Stable production is achievable with standard process controls and no fundamental redesign requirement.\n\n` +
    `Material cost variance is projected at ${economic}.\n\n` +
    `Deployment Decision: GO — Proceed to controlled pilot validation and gradual scale-up.`
  );
}

// ══════════════════════════════════════════════════════════════
// § 8  RISK STRUCTURE  (Primary / Secondary / Mechanism)
// ══════════════════════════════════════════════════════════════


function detectApplicationFamily(input) {
  const app = (input.application || "").toUpperCase();
  const processing = (input.processing || "").toUpperCase();

  if (app.includes("FILM") || app.includes("BAG") || app.includes("SHEET") || processing.includes("EXTRUSION")) {
    return "film_extrusion";
  }
  if (app.includes("INJECT") || processing.includes("INJECTION")) {
    return "injection_molding";
  }
  if (app.includes("BLOW") || processing.includes("BLOW")) {
    return "blow_molding";
  }
  return "general_processing";
}

function describeMaterialMechanism(mat, bio, app, constraint) {
  const matUpper = (mat || "").toUpperCase();
  const bioUpper = (bio || "").toUpperCase();
  const appFamily = detectApplicationFamily({ application: app });

  const sourceMaterial =
    matUpper.includes("LDPE") || matUpper.includes("PE")
      ? "polyethylene-based systems generally provide a wider melt-processing tolerance, lower moisture sensitivity, and broader residence-time stability"
      : matUpper.includes("PP") || matUpper.includes("CPP")
      ? "polypropylene-based systems generally provide a higher thermal processing window and comparatively stable melt strength under established process settings"
      : matUpper.includes("PET")
      ? "PET-based systems rely on high-temperature processing stability and well-controlled drying and crystallisation behaviour"
      : "the current incumbent material generally provides a known processing envelope and established machine-response profile";

  const targetMaterial =
    bioUpper.includes("PLA") && bioUpper.includes("PBAT")
      ? "the PLA/PBAT blend introduces a narrower processing window governed by PLA thermal sensitivity, PBAT-driven flexibility, blend morphology, and viscosity balance"
      : bioUpper.includes("PLA")
      ? "PLA introduces a narrower thermal window, hydrolysis sensitivity, and crystallisation-dependent dimensional behaviour"
      : bioUpper.includes("PHA") || bioUpper.includes("PHB")
      ? "PHA-based materials introduce elevated sensitivity to thermal history, residence time, and melt stability under continuous processing"
      : bioUpper.includes("PBAT")
      ? "PBAT-based materials introduce high flexibility but may require close control of melt strength, draw stability, and cooling behaviour"
      : "the target biodegradable material introduces a less familiar processing window requiring tighter validation of thermal, rheological, and mechanical response";

  const applicationMechanism =
    appFamily === "film_extrusion"
      ? "In film or sheet conversion, small changes in melt viscosity can translate directly into gauge variation, draw resonance, seal-window drift, surface non-uniformity, and web stability issues."
      : appFamily === "injection_molding"
      ? "In injection moulding, this mismatch can appear as filling imbalance, gate freeze variation, sink marks, warpage, dimensional drift, or cycle-time sensitivity."
      : appFamily === "blow_molding"
      ? "In blow moulding, the main expression of this mismatch is likely to appear through parison stability, wall-thickness distribution, melt strength retention, and cooling-related deformation."
      : "At process level, this mismatch can appear as reduced process tolerance, increased start-up sensitivity, and higher dependency on controlled machine settings.";

  return (
    `${sourceMaterial}, whereas ${targetMaterial}. ` +
    `Under ${safe(app, "the declared application")} conditions, the resulting property mismatch concentrates around ${constraint.factor}. ` +
    `${applicationMechanism} ` +
    `As a result, ${constraint.impact} may move outside the qualified operating envelope unless ${constraint.control} are validated through structured trials.`
  );
}

function generateTechnicalEvidenceList(input, constraint) {
  const appFamily = detectApplicationFamily(input);
  const base = [
    "supplier TDS with melt flow / viscosity data, melting or softening range, recommended processing temperature, drying conditions, and residence-time limitations",
    "SDS and material composition disclosure sufficient to screen degradation, additive, and handling risks",
    "evidence of previous processing under a similar conversion method and comparable machine configuration",
  ];

  if (constraint.type === "FLOW") {
    base.push("rheology or MFR/MFI data across the relevant temperature range, including sensitivity to shear rate and residence time");
  }
  if (constraint.type === "THERMAL") {
    base.push("thermal stability evidence such as DSC/TGA, degradation onset guidance, and maximum recommended melt temperature");
  }
  if (constraint.type === "MECHANICAL") {
    base.push("mechanical property data under application-relevant conditions, including tensile, elongation, impact, flexural, or tear performance as applicable");
  }

  if (appFamily === "film_extrusion") {
    base.push("film-specific data such as gauge stability, seal initiation temperature, hot tack, drawdown behaviour, blocking tendency, and coefficient of friction");
  } else if (appFamily === "injection_molding") {
    base.push("injection-specific data such as mould shrinkage, cycle-time range, gate behaviour, warpage tendency, and dimensional stability");
  }

  return base;
}

function generateRisk(scores, constraint, input) {
  const mat = safe(input.material,    "the source material");
  const bio = safe(input.bio_material, "the target biodegradable material");
  const app = safe(input.application,  "the current processing application");

  // ── Primary — constraint dimension only ────────────────────
  const primary = constraint.score < 55
    ? `Critical instability in ${constraint.factor} (${constraint.score}/100) is expected to cause production failure, ` +
      `excessive scrap generation, and uncontrolled output variability under continuous operating conditions. ` +
      `This risk alone is sufficient to prevent commercial deployment without fundamental process redesign.`
    : `Variability in ${constraint.factor} (${constraint.score}/100) is the primary operational risk for this transition. ` +
      `This directly affects ${constraint.impact} and must be managed through rigorous control of ${constraint.control}. ` +
      `Risk exposure increases proportionally under extended production cycles and elevated throughput conditions.`;

  // ── Secondary — interaction between the TWO non-constraint dimensions ──
  let dimA, scoreA, dimB, scoreB;
  if (constraint.type === "FLOW") {
    dimA = "thermal";    scoreA = scores.thermal;
    dimB = "mechanical"; scoreB = scores.mechanical;
  } else if (constraint.type === "THERMAL") {
    dimA = "flow";       scoreA = scores.flow;
    dimB = "mechanical"; scoreB = scores.mechanical;
  } else {
    dimA = "thermal";    scoreA = scores.thermal;
    dimB = "flow";       scoreB = scores.flow;
  }

  const secondary =
    `${dimA.charAt(0).toUpperCase() + dimA.slice(1)} variability (${scoreA}/100) interacts with ` +
    `${dimB} performance (${scoreB}/100), amplifying instability in process consistency under continuous ` +
    `production conditions. If ${dimA} parameters drift outside the validated tolerance window, ` +
    `${dimB} behaviour is expected to degrade in tandem — compounding output variability beyond ` +
    `what the primary constraint alone predicts.`;

  // ── Mechanism — material/process origin ─────────────────────
  const mechanism = describeMaterialMechanism(mat, bio, app, constraint);

  return { primary, secondary, mechanism };
}

// ══════════════════════════════════════════════════════════════
// § 9  PROCESSING SECTION  (correct score dependencies enforced)
// ══════════════════════════════════════════════════════════════

function generateProcessing(scores, constraint) {
  // Processing window — constraint score dependent
  let processingWindow;
  if (constraint.score < 55) {
    processingWindow =
      `Processing window is critically narrow and unstable. The ${constraint.type} constraint ` +
      `(${constraint.score}/100) limits usable parameters to conditions incompatible with continuous ` +
      `commercial production. Significant control intervention and likely equipment modification are required.`;
  } else if (constraint.score < 75) {
    processingWindow =
      `Processing window is operable but restricted by ${constraint.factor} (${constraint.score}/100). ` +
      `Sustained production requires tightly validated parameters; deviations outside the established range ` +
      `will cause measurable output instability and increased scrap rates.`;
  } else {
    processingWindow =
      `Processing window is broad and compatible with standard operating parameters. ` +
      `${constraint.factor.charAt(0).toUpperCase() + constraint.factor.slice(1)} ` +
      `(${constraint.score}/100) does not impose critical restrictions under normal production conditions.`;
  }

  // Thermal behaviour — MUST use scores.thermal
  let thermalBehavior;
  if (scores.thermal >= 75) {
    thermalBehavior =
      `Stable — operating within safe thermal band with acceptable degradation margin (Thermal: ${scores.thermal}/100). ` +
      `Temperature control requirements are consistent with standard biodegradable polymer processing protocol.`;
  } else if (scores.thermal >= 55) {
    thermalBehavior =
      `Marginal — processing temperature is near the material's degradation threshold (Thermal: ${scores.thermal}/100). ` +
      `Active zone-by-zone temperature monitoring is required to prevent thermal degradation onset ` +
      `during extended production runs.`;
  } else {
    thermalBehavior =
      `Unstable — thermal window is incompatible with stable biodegradable processing (Thermal: ${scores.thermal}/100). ` +
      `Degradation risk under standard operating temperature is high; ` +
      `thermal profile redesign is required before pilot validation.`;
  }

  // Flow characteristics — MUST use scores.flow
  let flowCharacteristics;
  if (scores.flow >= 75) {
    flowCharacteristics =
      `Consistent — melt rheology within acceptable processing range (Flow: ${scores.flow}/100). ` +
      `Standard screw configuration and pressure settings are expected to maintain melt uniformity ` +
      `across production runs without active intervention.`;
  } else if (scores.flow >= 55) {
    flowCharacteristics =
      `Variable — melt flow requires active stabilisation (Flow: ${scores.flow}/100). ` +
      `Pressure fluctuation risk during extended extrusion cycles necessitates real-time monitoring, ` +
      `screw speed adjustment, and reduced throughput during the validation phase.`;
  } else {
    flowCharacteristics =
      `Unstable — melt behaviour is incompatible with continuous production (Flow: ${scores.flow}/100). ` +
      `Significant flow instability is expected, resulting in unacceptable gauge variation, ` +
      `potential line shutdowns, and high off-specification output rates.`;
  }

  return { processingWindow, thermalBehavior, flowCharacteristics };
}

// ══════════════════════════════════════════════════════════════
// § 10  PRODUCT SECTION
// ══════════════════════════════════════════════════════════════

function generateProduct(scores) {
  // Mechanical behaviour — scores.mechanical
  const mechanical = scores.mechanical >= 75
    ? `Structural integrity of the final product is achievable under standard processing conditions (${scores.mechanical}/100). ` +
      `Mechanical performance meets commercial specification without formulation adjustment.`
    : scores.mechanical >= 55
    ? `Mechanical performance is adequate but sensitive to process consistency (${scores.mechanical}/100). ` +
      `Property variation between production batches is expected without active control measures.`
    : `Mechanical performance is below commercial threshold (${scores.mechanical}/100). ` +
      `Structural integrity risk is high; product specification compliance cannot be guaranteed ` +
      `without material reformulation or process redesign.`;

  // Surface quality — scores.flow
  const surface = scores.flow >= 75
    ? `Surface finish is expected to meet specification. Consistent melt flow (${scores.flow}/100) ` +
      `supports uniform surface formation under standard die and cooling conditions.`
    : scores.flow >= 55
    ? `Surface quality is conditionally acceptable. Flow variability (${scores.flow}/100) may introduce ` +
      `surface inconsistencies, particularly during die start-up and extended high-speed runs.`
    : `Surface quality is unreliable under current parameters (${scores.flow}/100). Melt instability ` +
      `is expected to generate streaking, pitting, and uneven gloss at commercial production speeds.`;

  // Structural consistency — scores.total
  const structural = scores.total >= 75
    ? `Structural consistency is achievable within the defined processing envelope. Dimensional stability ` +
      `and wall thickness uniformity are expected to meet pilot validation targets.`
    : scores.total >= 55
    ? `Structural consistency is conditional on parameter control (Total: ${scores.total}/100). ` +
      `Dimensional variation is expected at the margins of the processing window; ` +
      `tooling and cooling adjustments may be required.`
    : `Structural consistency is not achievable under current conditions (Total: ${scores.total}/100). ` +
      `Dimensional variance and structural failure risk exceed commercial tolerance without process redesign.`;

  return { mechanical, surface, structural };
}

// ══════════════════════════════════════════════════════════════
// § 11  QUALITY SECTION
// ══════════════════════════════════════════════════════════════

function generateQuality(scores) {
  const minScore = Math.min(scores.thermal, scores.flow, scores.mechanical);

  // Stability — bottleneck (min) score
  const stability     = minScore >= 75 ? "High" : minScore >= 55 ? "Moderate" : "Low";
  const stabilityNote = minScore >= 75
    ? `Process stability index: ${minScore}/100. Acceptable for commercial deployment under standard QC protocol.`
    : minScore >= 55
    ? `Process stability index: ${minScore}/100. Conditional acceptance — enhanced in-line monitoring and SPC required.`
    : `Process stability index: ${minScore}/100. Below commercial threshold. Redesign required before deployment.`;

  // Consistency — Flow score
  const consistency     = scores.flow >= 75 ? "High" : scores.flow >= 55 ? "Moderate" : "Low";
  const consistencyNote = scores.flow >= 75
    ? `Flow consistency index: ${scores.flow}/100. Production consistency achievable within standard parameter tolerance.`
    : scores.flow >= 55
    ? `Flow consistency index: ${scores.flow}/100. Closed-loop pressure control recommended to limit batch-to-batch variability.`
    : `Flow consistency index: ${scores.flow}/100. High variability expected. Output consistency cannot be assured without flow stabilisation.`;

  return { stability, stabilityNote, consistency, consistencyNote };
}

// ══════════════════════════════════════════════════════════════
// § 12  EXPECTED DEVIATIONS  (Film / Injection / Low / Default)
//        Returns HTML <li> string for direct injection into <ul>
// ══════════════════════════════════════════════════════════════

function generateExpectedDeviations(input, scores) {
  const appFamily = detectApplicationFamily(input);
  const minScore = Math.min(scores.thermal, scores.flow, scores.mechanical);
  let items;

  if (appFamily === "film_extrusion") {
    const gaugeRange = scores.flow < 65 ? "15–25" : "8–12";
    items = [
      `Gauge or thickness variation of approximately ±${gaugeRange}% may appear across the web width where melt pressure or draw stability drifts outside the qualified range`,
      `Seal-window instability may occur if melt temperature, cooling rate, or blend morphology changes during extended production runs`,
      `Surface haze, streaking, blocking tendency, or uneven gloss may increase during die start-up, high line-speed operation, or pressure fluctuation events`,
      `Output consistency may decline during long runs if drying, residence time, and extrusion pressure are not controlled as validated parameters`,
    ];
  } else if (appFamily === "injection_molding") {
    const dimRange = scores.mechanical < 65 ? "0.3–0.8" : "0.1–0.3";
    items = [
      `Dimensional variation of approximately ±${dimRange} mm may appear on critical features where filling balance or shrinkage behaviour changes`,
      `Warpage, sink marks, or incomplete filling may occur where flow resistance, gate freeze timing, or cooling distribution differs from the incumbent resin`,
      `Cycle-time sensitivity may increase if crystallisation, cooling rate, or demoulding behaviour differs from the existing material system`,
      `Surface quality may become unstable if melt temperature, injection speed, and holding pressure are not re-qualified for the candidate material`,
    ];
  } else if (appFamily === "blow_molding") {
    items = [
      `Wall-thickness distribution may become less uniform where melt strength or parison stability differs from the incumbent material`,
      `Parison sag, cooling-related deformation, or bottle/profile instability may occur during start-up and extended production runs`,
      `Mechanical consistency may vary if the candidate material cannot maintain stable melt strength across the full processing cycle`,
    ];
  } else if (minScore < 55) {
    items = [
      `Critical instability across the main processing dimensions may prevent repeatable output under current assumptions`,
      `High variability in dimensions, surface quality, and mechanical performance is expected across production batches`,
      `Material degradation, flow interruption, or off-specification output may occur unless material selection or process architecture is revised`,
    ];
  } else {
    items = [
      `Moderate process variability may appear during initial trials while the usable processing envelope is being established`,
      `Output inconsistency may increase near the boundary of validated temperature, pressure, cooling, or residence-time conditions`,
      `Further deviation characterisation is required under production-scale conditions before commercial acceptance`,
    ];
  }

  return items.map((item) => `<li>${item}</li>`).join("\n");
}

// ══════════════════════════════════════════════════════════════
// § 13  APPLICATION IMPLICATION
// ══════════════════════════════════════════════════════════════

function generateApplicationImplication(decision, input) {
  const app = safe(input.application, "this application");
  if (decision.level === "HIGH") {
    return (
      `${app} is viable for commercial deployment. The material transition is technically feasible ` +
      `within the current processing framework. Standard monitoring protocols apply during initial production ramp-up.`
    );
  }
  if (decision.level === "MODERATE") {
    return (
      `${app} is viable subject to process optimisation. Pilot-scale validation is required before ` +
      `commercial commitment. Constraint control measures must be implemented and verified prior to full deployment.`
    );
  }
  return (
    `${app} is not recommended for commercial deployment at the current feasibility level. ` +
    `Material reformulation or application redesign is required before re-evaluation.`
  );
}

// ══════════════════════════════════════════════════════════════
// § 14  NEXT STEPS  (decision + constraint aware)
// ══════════════════════════════════════════════════════════════

function generateNextStep(decision, constraint, scores) {
  if (decision.level === "HIGH") {
    return (
      `Based on the HIGH feasibility assessment (Total: ${scores.total}/100), the system is ready for controlled pilot deployment.\n\n` +
      `Initiate pilot production with monitoring focused on ${constraint.factor}. ` +
      `Validate yield stability and product consistency under continuous production conditions ` +
      `before committing to full commercial scale-up. ` +
      `Document validated process parameters, material handling requirements, and acceptance criteria as the baseline for ongoing quality control.`
    );
  }

  if (decision.level === "MODERATE") {
    return (
      `Based on the MODERATE feasibility assessment (Total: ${scores.total}/100), ` +
      `engineering validation targeting ${constraint.type.toLowerCase()} performance is required before pilot approval.\n\n` +
      `Implement control measures for ${constraint.control}. ` +
      `Before pilot approval, confirm supplier technical evidence, define acceptable machine settings, and execute structured parameter trials to characterise the usable processing window. ` +
      `The validation plan should include start-up behaviour, steady-state operation, extended-run stability, and application-level output consistency. ` +
      `Re-evaluate system stability after stabilisation controls are confirmed, then proceed to pilot validation with defined acceptance criteria.`
    );
  }

  return (
    `Based on the LOW feasibility assessment (Total: ${scores.total}/100), ` +
    `commercial transition under the current configuration is not recommended.\n\n` +
    `Suspend transition planning and evaluate alternative material grades or process architecture modifications. ` +
    `Address the critical constraint in ${constraint.factor} specifically. ` +
    `A revised evaluation should be submitted after design modifications are validated at laboratory scale.`
  );
}

// ══════════════════════════════════════════════════════════════
// § 15  HTML INJECTION
// ══════════════════════════════════════════════════════════════

function injectHtml(template, data) {
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const val = data[key];
    if (val === undefined || val === null) return "—";
    return String(val);
  });
}

// ══════════════════════════════════════════════════════════════
// § 16  DYNAMIC OVERLAY  (UNCHANGED from original spec)
//        Generates overlay elements only; base image handled by template
// ══════════════════════════════════════════════════════════════


function generateScoreBars(scores) {
  const items = [
    { label: "Thermal behaviour", short: "Thermal", value: scores.thermal, cls: "thermal" },
    { label: "Flow characteristics", short: "Flow", value: scores.flow, cls: "flow" },
    { label: "Mechanical behaviour", short: "Mechanical", value: scores.mechanical, cls: "mechanical" }
  ];

  return `
    <div class="score-profile">
      ${items.map(item => `
        <div class="score-profile-row">
          <div class="score-profile-label">${item.short}</div>
          <div class="score-profile-track">
            <div class="score-profile-fill ${item.cls}" style="width:${Math.max(4, Math.min(100, item.value))}%"></div>
          </div>
          <div class="score-profile-value">${item.value}</div>
        </div>
      `).join("")}
    </div>
  `;
}



function generateOverlay(scores) {
  const angle = -90 + scores.total * 1.8;

  function getAmplitude(score) {
    if (score >= 85) return 1.6;
    if (score >= 80) return 3;
    if (score >= 70) return 5;
    if (score >= 60) return 9;
    return 13;
  }

  const ampLeft  = getAmplitude(scores.thermal);
  const ampRight = getAmplitude(scores.flow);

  return `
<div style="position:absolute;top:45px;left:150px;text-align:center;z-index:2;">
  <div style="font-size:28px;color:#2f3a44;">230°C</div>
  <div style="font-size:16px;color:#5b6770;">${scores.thermal}</div>
</div>

<div style="position:absolute;top:45px;left:470px;text-align:center;z-index:2;">
  <div style="font-size:28px;color:#d62c2c;">180°C</div>
  <div style="font-size:16px;color:#d62c2c;">${scores.flow}</div>
</div>

<svg style="position:absolute;left:280px;bottom:90px;z-index:2;" width="90" height="35">
  <path d="M0 18 C15 ${18 - ampLeft}, 30 ${18 + ampLeft}, 45 18 C60 ${18 - ampLeft}, 75 ${18 + ampLeft}, 90 18"
    fill="none" stroke="#4f7c8a" stroke-width="1.8" opacity="0.85"/>
</svg>

<svg style="position:absolute;left:430px;bottom:90px;z-index:2;" width="90" height="35">
  <path d="M0 18 C15 ${18 - ampRight}, 30 ${18 + ampRight}, 45 18 C60 ${18 - ampRight}, 75 ${18 + ampRight}, 90 18"
    fill="none" stroke="#d62c2c" stroke-width="1.8" opacity="0.85"/>
</svg>

<svg style="position:absolute;right:20px;bottom:10px;z-index:2;" viewBox="0 0 200 120" width="140" height="90">
  <defs>
    <linearGradient id="g">
      <stop offset="0%"   stop-color="#22c55e"/>
      <stop offset="50%"  stop-color="#fde047"/>
      <stop offset="100%" stop-color="#ef4444"/>
    </linearGradient>
  </defs>
  <path d="M20 100 A80 80 0 0 1 180 100 L100 100 Z" fill="url(#g)"/>
  <g transform="rotate(${angle} 100 100)">
    <line x1="100" y1="100" x2="100" y2="25" stroke="#111" stroke-width="3"/>
  </g>
  <circle cx="100" cy="100" r="4" fill="#111"/>
</svg>`;
}

// ══════════════════════════════════════════════════════════════
// § 17  MAIN ROUTE  (single POST, single try/catch)
// ══════════════════════════════════════════════════════════════

app.post("/generate-report", async (req, res) => {
  
  const input = normalizeEquipmentFormPayload(req.body || {});

// Emergency release correction:
// If the form sends material text into application, correct it before scoring/report rendering.
if (looksLikeMaterial(input.application)) {
  const originalApplicationValue = input.application;

  input.current_material = input.current_material || input.material || originalApplicationValue;
  input.material = input.current_material;

  input.application =
    input.product_type ||
    input.productType ||
    input.product ||
    input.product_application ||
    input.productApplication ||
    "Dry goods packaging film / shopping bag";
}

// Ensure risk penalty logic sees all submitted values.
input._risk_context = Object.values(input)
  .filter(v => v !== undefined && v !== null)
  .map(v => String(v))
  .join(" | ");
try {
    console.log("RAW BODY:", JSON.stringify(req.body, null, 2));

    const input = normalizeInput(req.body);

    // --- Deterministic engine ---
    const tokenUse = consumeEquipmentDemoToken(req);
    if (!tokenUse.ok) {
      return res.status(tokenUse.status || 403).json({
        error: tokenUse.message
      });
    }

    const scores     = applyEquipmentRiskPenalties(calculateScores(input), input);
    const constraint = getConstraint(scores);
    const decision   = determineDecision(scores.total);
    const economic   = calculateEconomic(scores.total);

    // --- Text generators ---
    const risk       = generateRisk(scores, constraint, input);
    const processing = generateProcessing(scores, constraint);
    const product    = generateProduct(scores);
    const quality    = generateQuality(scores);

    // --- Template data map ---
    const htmlData = {
      // Cover
      assessment_type:    "Technical Hypothesis",
      application:         safe(looksLikeMaterial(input.application) ? (input.product_type || input.productType || input.product || "Dry goods packaging film / shopping bag") : input.application),
      material_transition: safe(input.bio_material),
      report_date:         new Date().toISOString().split("T")[0],

      // §01 Executive
      compatibility_level: decision.level,
      executive_summary:   generateExecutive(scores, decision, economic, constraint),
      key_risk:            risk.primary,

      // §02 Processing
      processing_window:    processing.processingWindow,
      thermal_behavior:     processing.thermalBehavior,
      flow_characteristics: processing.flowCharacteristics,

      // §03 Product
      mechanical_behavior:   product.mechanical,
      surface_quality:        product.surface,
      structural_consistency: product.structural,
      application_implication: generateApplicationImplication(decision, input),

      // §04 Failure analysis
      primary_risk_title:   constraint.type === "FLOW" ? "Process Flow Variability" : constraint.type === "THERMAL" ? "Thermal Processing Constraint" : "Mechanical Performance Constraint",
      primary_risk:          risk.primary,
      secondary_risk_title: "Process Interaction Risk",
      secondary_risk:        risk.secondary,
      mechanism:             risk.mechanism,

      // §05 Quality
      stability:        quality.stability,
      stability_note:   quality.stabilityNote,
      consistency:      quality.consistency,
      consistency_note: quality.consistencyNote,
      expected_deviations: generateExpectedDeviations(input, scores),

      // Progress bar
      pha_score: scores.total,

      // §06 Visualization
      base_image: visualBaseDataUri,
      dynamic_overlay: `<div style="position:relative;width:700px;height:240px;margin:0 auto;">
  <img src="${visualBaseDataUri}"
       style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:1;" />
  ${generateOverlay(scores)}
</div>`,

      // §07 Next step
      score_bars_html: generateScoreBars(scores),
      next_step: generateNextStep(decision, constraint, scores),

      // Metadata
      decision:        decision.decision,
      economic_impact: economic,
    };

    // --- HTML → PDF via Puppeteer ---
    const html = injectHtml(htmlTemplate, htmlData);

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
    });

    await browser.close();

    fs.writeFileSync(PDF_PATH, pdf);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=fairvia-report.pdf");
    res.send(pdf);

  } catch (err) {
    console.error("[/generate-report] Error:", err);
    res.status(500).json({ error: "PDF generation failed", detail: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// AUXILIARY ROUTES
// ══════════════════════════════════════════════════════════════

app.get("/latest-pdf", (req, res) => {
  if (!fs.existsSync(PDF_PATH)) {
    return res.status(404).send("No PDF available yet.");
  }
  res.setHeader("Content-Type", "application/pdf");
  res.sendFile(PDF_PATH);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════

app.get("/report-ready", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "report-ready.html"));
});

app.get("/equipment-access", (req, res) => {
  const token = String(req.query.token || "");
  if (!isValidDemoToken(token)) {
    return res.status(403).send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>FairVia™ Demo Access</title>
          <style>
            body {
              margin: 0;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
              background: #f6f9fb;
              color: #102033;
              display: grid;
              place-items: center;
              min-height: 100vh;
            }
            .card {
              width: min(560px, calc(100vw - 40px));
              background: white;
              border: 1px solid #dbe4ea;
              border-radius: 22px;
              padding: 34px;
              box-shadow: 0 24px 70px rgba(16,32,51,.08);
            }
            .eyebrow {
              font-size: 12px;
              letter-spacing: .16em;
              text-transform: uppercase;
              color: #7fa6b8;
              font-weight: 800;
              margin-bottom: 12px;
            }
            h1 {
              margin: 0 0 12px;
              font-size: 28px;
            }
            p {
              margin: 0;
              color: #6b7a88;
              line-height: 1.7;
            }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="eyebrow">FairVia™ Equipment Demo</div>
            <h1>Demo access required</h1>
            <p>This assessment form is available only through an issued demo access link.</p>
          </div>
        </body>
      </html>
    `);
  }

  res.sendFile(path.join(__dirname, "public", "equipment-access.html"));
});



// ============================================================
// FairVia Access Credit API — Supabase-backed admin key issuing
// Added safely after existing equipment-access routes.
// ============================================================

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ACCESS_KEY_SECRET = process.env.ACCESS_KEY_SECRET || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

if (!ADMIN_TOKEN) {
  console.warn("⚠️ ADMIN_TOKEN not set — admin key creation API disabled");
}

function getAdminToken(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return req.headers["x-admin-token"] || req.query.admin_token || "";
}

function hashAccessKey(plainKey) {
  if (!ACCESS_KEY_SECRET) {
    throw new Error("ACCESS_KEY_SECRET is not configured");
  }

  return crypto
    .createHash("sha256")
    .update(`${ACCESS_KEY_SECRET}:${plainKey}`)
    .digest("hex");
}

function generatePlainAccessKey() {
  const randomPart = crypto.randomBytes(18).toString("base64url").toUpperCase();
  return `FV-${randomPart}`;
}

function defaultMaxUsesForPlan(planType) {
  if (planType === "customer_adoption_pack") return 3;
  if (planType === "partner_member_pilot") return 5;
  return 1;
}

function publicBaseUrl(req) {
  const envBase = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (envBase) return envBase;

  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function supabaseFetch(pathname, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
  }

  const response = await fetch(`${SUPABASE_URL}${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `Supabase request failed: ${response.status} ${typeof data === "string" ? data : JSON.stringify(data)}`
    );
  }

  return data;
}

app.post("/api/access/create-admin", async (req, res) => {
  try {
    const token = getAdminToken(req);

    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: "unauthorized",
      });
    }

    const organisationName = String(req.body.organisation_name || "").trim();
    const contactEmail = String(req.body.contact_email || "").trim();
    const organisationType = String(req.body.organisation_type || "single_company").trim();
    const planType = String(req.body.plan_type || "introductory_pre_pilot_assessment").trim();

    const maxUses = Number.isFinite(Number(req.body.max_uses))
      ? Number(req.body.max_uses)
      : defaultMaxUsesForPlan(planType);

    if (!organisationName) {
      return res.status(400).json({
        ok: false,
        error: "organisation_name_required",
      });
    }

    const plainKey = generatePlainAccessKey();
    const accessKeyHash = hashAccessKey(plainKey);
    const accessKeyPrefix = plainKey.slice(0, 10);

    const expiresAt = req.body.expires_at
      ? new Date(req.body.expires_at).toISOString()
      : new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

    const payload = {
      access_key_hash: accessKeyHash,
      access_key_prefix: accessKeyPrefix,
      organisation_name: organisationName,
      contact_email: contactEmail || null,
      organisation_type: organisationType,
      plan_type: planType,
      max_uses: maxUses,
      used_count: 0,
      status: "active",
      expires_at: expiresAt,
      metadata: req.body.metadata || {},
    };

    const inserted = await supabaseFetch("/rest/v1/assessment_access_keys", {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    const base = publicBaseUrl(req);
    const accessUrl = `${base}/equipment-access?token=${encodeURIComponent(plainKey)}`;

    return res.json({
      ok: true,
      access_key: plainKey,
      access_key_prefix: accessKeyPrefix,
      access_url: accessUrl,
      organisation_name: organisationName,
      organisation_type: organisationType,
      plan_type: planType,
      max_uses: maxUses,
      remaining_uses: maxUses,
      expires_at: expiresAt,
      stored: Array.isArray(inserted) ? inserted[0] : inserted,
      note: "The plain access key is shown only once. Store it securely.",
    });
  } catch (err) {
    console.error("[Access Create Admin ERROR]", err);
    return res.status(500).json({
      ok: false,
      error: "access_key_creation_failed",
      detail: err.message,
    });
  }
});

app.post("/api/access/verify", async (req, res) => {
  try {
    const plainKey = String(req.body.access_key || req.query.token || req.query.access_key || "").trim();

    if (!plainKey) {
      return res.status(400).json({
        ok: false,
        error: "access_key_required",
      });
    }

    const accessKeyHash = hashAccessKey(plainKey);

    const result = await supabaseFetch("/rest/v1/rpc/verify_assessment_access_key", {
      method: "POST",
      body: JSON.stringify({
        p_access_key_hash: accessKeyHash,
      }),
    });

    const row = Array.isArray(result) ? result[0] : result;

    return res.json({
      ok: true,
      access: row,
    });
  } catch (err) {
    console.error("[Access Verify ERROR]", err);
    return res.status(500).json({
      ok: false,
      error: "access_key_verify_failed",
      detail: err.message,
    });
  }
});


const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[FairVia Equipment Demo] Server running on port ${PORT}`);
});
