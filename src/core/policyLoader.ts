// src/core/policyLoader.ts
// Loads policy JSON files from the policies/ directory.
// Plain data, plain code.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Policy, Symptom } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// policies/ lives at the workspace root, two levels up from src/core/
const POLICIES_DIR = join(__dirname, "..", "..", "policies");

/**
 * Load a single policy by symptom key (e.g. "cough" → policies/cough.json).
 */
export function loadPolicy(symptom: Symptom): Policy {
  const path = join(POLICIES_DIR, `${symptom}.json`);
  const raw = readFileSync(path, "utf-8");
  const policy = JSON.parse(raw) as Policy;
  validatePolicy(policy);
  return policy;
}

/**
 * Load all policies from the policies directory.
 */
export function loadAllPolicies(): Map<Symptom, Policy> {
  const map = new Map<Symptom, Policy>();
  const files = readdirSync(POLICIES_DIR).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const raw = readFileSync(join(POLICIES_DIR, file), "utf-8");
    const policy = JSON.parse(raw) as Policy;
    validatePolicy(policy);
    map.set(policy.id as Symptom, policy);
  }
  return map;
}

/**
 * Validate a policy has the required fields and the PENDING_CLINICIAN_REVIEW
 * status (spec rule 13).
 */
export function validatePolicy(policy: Policy): void {
  if (!policy.id) throw new Error("Policy missing 'id'");
  if (!policy.version) throw new Error(`Policy '${policy.id}' missing 'version'`);
  if (policy.status !== "PENDING_CLINICIAN_REVIEW") {
    throw new Error(
      `Policy '${policy.id}' status must be PENDING_CLINICIAN_REVIEW (got: ${policy.status})`
    );
  }
  if (!Array.isArray(policy.redFlags)) throw new Error(`Policy '${policy.id}' missing 'redFlags' array`);
  if (!Array.isArray(policy.rules)) throw new Error(`Policy '${policy.id}' missing 'rules' array`);
  if (typeof policy.checkinEveryDays !== "number") {
    throw new Error(`Policy '${policy.id}' missing 'checkinEveryDays'`);
  }
}
