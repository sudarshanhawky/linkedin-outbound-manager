import * as XLSX from "xlsx";

// HAWKY statuses (funnel order: status only moves forward)
// 0→Not Contacted, 1→Request Sent, 2→Message Sent, 3→Replied, 4→Converted, 5→Not Interested, 6→Wrong Person
export type ContactStatus =
  | "Not Contacted"
  | "Request Sent"
  | "Message Sent"
  | "Replied"
  | "Converted"
  | "Not Interested"
  | "Wrong Person";

export type Contact = {
  id: string;
  name: string;
  company: string;
  jobTitle: string;
  linkedIn: string;
  status: ContactStatus;
  campaigns: string[];
  senders: string[];
};

export const FUNNEL_RANK: Record<ContactStatus, number> = {
  "Not Contacted": 0,
  "Request Sent": 1,
  "Message Sent": 2,
  Replied: 3,
  Converted: 4,
  "Not Interested": 5,
  "Wrong Person": 6,
};

export const DEAD_END_STATUSES: ContactStatus[] = ["Not Interested", "Wrong Person"];

function normalizeHeader(h: string): string {
  return String(h ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const HEADER_MAP: Record<string, keyof Contact> = {
  name: "name",
  "full name": "name",
  fullname: "name",
  contact: "name",
  "contact name": "name",
  company: "company",
  organization: "company",
  org: "company",
  "company name": "company",
  "job title": "jobTitle",
  jobtitle: "jobTitle",
  title: "jobTitle",
  position: "jobTitle",
  role: "jobTitle",
  linkedin: "linkedIn",
  "linkedin url": "linkedIn",
  "linkedin profile": "linkedIn",
  profile: "linkedIn",
  "profile url": "linkedIn",
  url: "linkedIn",
  status: "status",
  campaign: "campaigns",
  campaigns: "campaigns",
  "all campaigns": "campaigns",
  "campaign name": "campaigns",
  campaignname: "campaigns",
  sender: "senders",
  senders: "senders",
  "all senders": "senders",
  "sent by": "senders",
  "sender name": "senders",
  sendername: "senders",
};

function parseList(val: unknown): string[] {
  if (val === undefined || val === null) return [];
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  const s = String(val).trim();
  if (!s) return [];
  return s.split(/[,;|\n]/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Map PROSP STATUS + PROSP TAG from Excel to HAWKY status.
 * Returns ContactStatus or "SKIP" to not import the row.
 */
export function mapProspStatusToHawky(
  prospStatus: string,
  prospTag: string
): ContactStatus | "SKIP" {
  const s = String(prospStatus ?? "").trim().toLowerCase();
  const tag = String(prospTag ?? "").trim().toLowerCase();

  if (s === "duplicate") return "SKIP";

  if (s === "contacted") return "Message Sent";
  if (["in campaign", "not accepted"].includes(s)) return "Request Sent";
  if (["not contacted", "failed"].includes(s)) return "Not Contacted";

  if (s === "replied") {
    if (["", "nurturing", "wrong timing", "other"].includes(tag)) return "Replied";
    if (
      tag.includes("interested") ||
      tag.includes("scheduled") ||
      tag.includes("already in pipeline")
    )
      return "Converted";
    if (tag.includes("not interested")) return "Not Interested";
    if (tag.includes("non icp") || tag.includes("wrong")) return "Wrong Person";
    return "Replied";
  }

  return "Not Contacted";
}

/** Get Status and Tags from a row (column headers: "Status", "Tags"). */
function getStatusAndTagFromRow(row: Record<string, unknown>): { status: string; tag: string } {
  let status = "";
  let tag = "";
  for (const [key, value] of Object.entries(row)) {
    const norm = normalizeHeader(key);
    if (norm === "status") status = String(value ?? "").trim();
    if (norm === "tags" || norm === "tag") tag = String(value ?? "").trim();
  }
  return { status, tag };
}

function normalizeUrl(val: unknown): string {
  let s = String(val ?? "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

/** Get normalized LinkedIn URL from a row for grouping. Returns empty string if none. */
function getLinkedInKey(row: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(row)) {
    const norm = normalizeHeader(key);
    if (HEADER_MAP[norm] === "linkedIn") {
      const url = normalizeUrl(value);
      if (url) return url;
    }
  }
  return "";
}

/** Collect all values from row that map to campaigns (single value or list). */
function getCampaignValuesFromRow(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    const norm = normalizeHeader(key);
    if (HEADER_MAP[norm] === "campaigns") {
      out.push(...parseList(value));
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Collect all values from row that map to senders (single value or list). */
function getSenderValuesFromRow(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    const norm = normalizeHeader(key);
    if (HEADER_MAP[norm] === "senders") {
      out.push(...parseList(value));
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Merge rows that share the same LinkedIn URL into one row per contact.
 * - Campaigns/senders: union from all rows (no duplicates).
 * - Status: highest funnel rank among mapped statuses (status only moves forward).
 * - Rows that map to SKIP are excluded from the merge.
 */
export function mergeRowsByLinkedInUrl(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  const byUrl = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const { status: rowStatus, tag: rowTag } = getStatusAndTagFromRow(row);
    const mapped = mapProspStatusToHawky(rowStatus, rowTag);
    if (mapped === "SKIP") continue;
    const key = getLinkedInKey(row);
    const k = key || `__no_url_${Math.random().toString(36)}`;
    if (!byUrl.has(k)) byUrl.set(k, []);
    byUrl.get(k)!.push(row);
  }
  const merged: Record<string, unknown>[] = [];
  for (const [linkedInUrl, group] of byUrl) {
    if (linkedInUrl.startsWith("__no_url_")) {
      for (const row of group) merged.push(row);
      continue;
    }
    const campaignsSet = new Set<string>();
    const sendersSet = new Set<string>();
    let bestStatus: ContactStatus = "Not Contacted";
    let bestRank = -1;
    let firstRow: Record<string, unknown> = {};
    for (const row of group) {
      getCampaignValuesFromRow(row).forEach((c) => campaignsSet.add(c));
      getSenderValuesFromRow(row).forEach((s) => sendersSet.add(s));
      const { status: rowStatus, tag: rowTag } = getStatusAndTagFromRow(row);
      const mapped = mapProspStatusToHawky(rowStatus, rowTag);
      if (mapped !== "SKIP" && typeof mapped === "string") {
        const rank = FUNNEL_RANK[mapped];
        if (rank > bestRank) {
          bestRank = rank;
          bestStatus = mapped;
        }
      }
      if (Object.keys(firstRow).length === 0) firstRow = row;
    }
    const mergedRow: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(firstRow)) {
      const norm = normalizeHeader(key);
      const field = HEADER_MAP[norm];
      if (field !== "campaigns" && field !== "senders") {
        mergedRow[key] = value;
      }
    }
    mergedRow.linkedIn = linkedInUrl;
    mergedRow.campaigns = [...campaignsSet];
    mergedRow.senders = [...sendersSet];
    mergedRow.status = bestStatus;
    merged.push(mergedRow);
  }
  return merged;
}

export function rowToContact(
  row: Record<string, unknown>,
  index: number,
  idPrefix: string
): Contact {
  const mapped: Record<string, string | string[]> = {};
  const campaignsAcc: string[] = [];
  const sendersAcc: string[] = [];

  for (const [key, value] of Object.entries(row)) {
    const norm = normalizeHeader(key);
    const field = HEADER_MAP[norm];
    if (!field) continue;
    if (value === undefined || value === null) continue;
    if (field === "campaigns") {
      campaignsAcc.push(...parseList(value));
    } else if (field === "senders") {
      sendersAcc.push(...parseList(value));
    } else if (field === "status") {
      const s = String(value).trim();
      if (s && FUNNEL_RANK[s as ContactStatus] !== undefined) {
        mapped[field] = s as ContactStatus;
      }
    } else if (field === "linkedIn") {
      const s = normalizeUrl(value);
      if (s) mapped[field] = s;
    } else {
      const str = String(value).trim();
      if (str) (mapped as Record<string, string>)[field] = str;
    }
  }

  const c = mapped as unknown as Partial<Contact>;
  const campaigns = [...new Set(campaignsAcc.filter(Boolean))];
  const senders = [...new Set(sendersAcc.filter(Boolean))];

  let resolvedStatus: ContactStatus;
  if (c.status && FUNNEL_RANK[c.status as ContactStatus] !== undefined) {
    resolvedStatus = c.status as ContactStatus;
  } else {
    const { status: rowStatus, tag: rowTag } = getStatusAndTagFromRow(row);
    const hawky = mapProspStatusToHawky(rowStatus, rowTag);
    resolvedStatus = hawky === "SKIP" ? "Not Contacted" : hawky;
  }

  return {
    id: `${idPrefix}-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    name: c.name ?? "",
    company: c.company ?? "",
    jobTitle: c.jobTitle ?? "",
    linkedIn: c.linkedIn ?? "",
    status: resolvedStatus,
    campaigns,
    senders,
  };
}

export function parseWorkbookFile(
  file: File
): Promise<{ workbook: XLSX.WorkBook; sheetNames: string[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target?.result;
        if (!data || !(data instanceof ArrayBuffer)) {
          reject(new Error("Could not read file"));
          return;
        }
        const workbook = XLSX.read(data, { type: "array" });
        const sheetNames = workbook.SheetNames.filter(
          (n) => workbook.Sheets[n] && workbook.Sheets[n]["!ref"]
        );
        resolve({ workbook, sheetNames });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsArrayBuffer(file);
  });
}

export function getSheetRowCount(workbook: XLSX.WorkBook, sheetName: string): number {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return 0;
  const ref = sheet["!ref"];
  if (!ref) return 0;
  const range = XLSX.utils.decode_range(ref);
  return range.e.r - range.s.r + 1;
}

export function getRowsFromSheets(
  workbook: XLSX.WorkBook,
  sheetNames: string[]
): Record<string, unknown>[] {
  const allRows: Record<string, unknown>[] = [];
  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });
    for (const row of rows) {
      if (Object.keys(row).length > 0) allRows.push(row);
    }
  }
  return allRows;
}

/**
 * Merge imported contacts into existing list by LinkedIn URL.
 * - New campaign/sender: append (no duplicate).
 * - Status: upgrade only if incoming rank > current rank; dead-ends (Not Interested, Wrong Person) lock forever.
 */
export function mergeImportedWithExisting(
  existing: Contact[],
  incoming: Contact[]
): Contact[] {
  const byLinkedIn = new Map<string, Contact>();
  for (const c of existing) {
    const key = normalizeUrl(c.linkedIn) || c.id;
    byLinkedIn.set(key, { ...c, campaigns: [...c.campaigns], senders: [...c.senders] });
  }
  for (const inc of incoming) {
    const key = normalizeUrl(inc.linkedIn);
    if (!key) continue;
    const current = byLinkedIn.get(key);
    if (!current) {
      byLinkedIn.set(key, { ...inc });
      continue;
    }
    const currentRank = FUNNEL_RANK[current.status];
    const incomingRank = FUNNEL_RANK[inc.status];
    if (DEAD_END_STATUSES.includes(current.status)) {
      continue;
    }
    const nextStatus = incomingRank > currentRank ? inc.status : current.status;
    const campaignSet = new Set(current.campaigns);
    inc.campaigns.forEach((c) => campaignSet.add(c));
    const senderSet = new Set(current.senders);
    inc.senders.forEach((s) => senderSet.add(s));
    byLinkedIn.set(key, {
      ...current,
      status: nextStatus,
      campaigns: [...campaignSet],
      senders: [...senderSet],
    });
  }
  return Array.from(byLinkedIn.values());
}

const CHUNK_SIZE = 500;

export async function importInChunks(
  rows: Record<string, unknown>[],
  idPrefix: string,
  existingContacts: Contact[],
  onChunk: (fullMergedContacts: Contact[]) => void,
  onProgress: (current: number, total: number) => void
): Promise<void> {
  const total = rows.length;
  let accumulated: Contact[] = existingContacts;
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    const chunk = rows
      .slice(i, i + CHUNK_SIZE)
      .map((row, j) => rowToContact(row, i + j, idPrefix));
    accumulated = mergeImportedWithExisting(accumulated, chunk);
    onChunk(accumulated);
    onProgress(Math.min(i + CHUNK_SIZE, total), total);
    await new Promise((r) => setTimeout(r, 0));
  }
}
