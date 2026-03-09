"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import type { Contact, ContactStatus } from "./import-utils";
import {
  getRowsFromSheets,
  getSheetRowCount,
  importInChunks,
  mergeRowsByLinkedInUrl,
  parseWorkbookFile,
} from "./import-utils";
import { getSupabase } from "./supabase";

const USER_NAME_KEY = "linkedin-outbound-username";
const CONTACTS_LOCAL_KEY = "linkedin-outbound-contacts";
const SUPABASE_TABLE = "contacts";

const STATUS_OPTIONS: ContactStatus[] = [
  "Not Contacted",
  "Request Sent",
  "Message Sent",
  "Replied",
  "Converted",
  "Not Interested",
  "Wrong Person",
];

// Supabase types for DB row (snake_case)
type ContactRow = {
  id: string;
  name: string;
  company: string;
  job_title: string;
  linkedin: string;
  status: string;
  campaigns: string[];
  senders: string[];
};

function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name ?? "",
    company: row.company ?? "",
    jobTitle: row.job_title ?? "",
    linkedIn: row.linkedin ?? "",
    status: row.status as Contact["status"],
    campaigns: Array.isArray(row.campaigns) ? row.campaigns : [],
    senders: Array.isArray(row.senders) ? row.senders : [],
  };
}

function contactToRow(c: Contact): ContactRow {
  return {
    id: c.id,
    name: c.name,
    company: c.company,
    job_title: c.jobTitle,
    linkedin: c.linkedIn,
    status: c.status,
    campaigns: c.campaigns,
    senders: c.senders,
  };
}

const SORT_FIELDS = [
  { value: "name", label: "Name" },
  { value: "company", label: "Company" },
  { value: "status", label: "Status" },
  { value: "jobTitle", label: "Job Title" },
] as const;

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

const DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  select: 48,
  name: 140,
  company: 120,
  jobTitle: 160,
  linkedIn: 44,
  status: 120,
  campaigns: 180,
  senders: 140,
};

/** Expand "IND_LIST 5,6,7" into ["IND_LIST 5", "IND_LIST 6", "IND_LIST 7"] for filter options. */
function expandCampaignForFilter(campaign: string): string[] {
  const m = campaign.match(/^(.+?)\s+([\d,]+)$/);
  if (!m) return [campaign];
  const prefix = m[1].trim();
  const parts = m[2].split(",").map((n) => n.trim()).filter(Boolean);
  if (parts.length <= 1) return [campaign];
  return parts.map((p) => `${prefix} ${p}`);
}

const STATUS_RULES_MODAL_CONTENT = (
  <div className="space-y-5 text-sm text-slate-700">
    <section>
      <h3 className="mb-2 font-semibold text-slate-900">Status / Tags → App status (from Excel)</h3>
      <ul className="list-inside list-disc space-y-1">
        <li><strong>Contacted</strong> (any tag) → Message Sent</li>
        <li><strong>In Campaign</strong> (any tag) → Request Sent</li>
        <li><strong>not accepted</strong> (any tag) → Request Sent</li>
        <li><strong>Not Contacted</strong> / <strong>failed</strong> → Not Contacted</li>
        <li><strong>Replied</strong> + tag blank / nurturing / wrong timing / other → Replied</li>
        <li><strong>Replied</strong> + tag contains &quot;Interested&quot; / &quot;Scheduled&quot; / &quot;Already in pipeline&quot; → Converted</li>
        <li><strong>Replied</strong> + tag contains &quot;Not interested&quot; → Not Interested</li>
        <li><strong>Replied</strong> + tag contains &quot;Non ICP&quot; / &quot;Wrong&quot; → Wrong Person</li>
        <li><strong>duplicate</strong> → SKIP (row not imported)</li>
      </ul>
    </section>
    <section>
      <h3 className="mb-2 font-semibold text-slate-900">Funnel order (status only moves forward)</h3>
      <p className="mb-1">0 → Not Contacted → 1 → Request Sent → 2 → Message Sent → 3 → Replied → 4 → Converted</p>
      <p>5 → Not Interested (dead-end) · 6 → Wrong Person (dead-end)</p>
    </section>
    <section>
      <h3 className="mb-2 font-semibold text-slate-900">Rules for existing contacts (on import)</h3>
      <ul className="list-inside list-disc space-y-1">
        <li>Incoming rank &gt; current rank → Upgrade status</li>
        <li>Incoming rank ≤ current → Keep current</li>
        <li>Current = Not Interested or Wrong Person → Locked, ignore incoming</li>
        <li>New campaign name → Append (never overwrite)</li>
        <li>Same campaign name → Skip duplicate</li>
        <li>New sender name → Append (never overwrite)</li>
        <li>Same sender name → Skip duplicate</li>
      </ul>
    </section>
  </div>
);

async function loadContactsFromSupabase(): Promise<Contact[]> {
  if (typeof window === "undefined") return [];
  const supabase = getSupabase();
  if (supabase) {
    try {
      const { data, error } = await supabase.from(SUPABASE_TABLE).select("*").order("id");
      if (error) {
        console.error("Supabase load error:", error);
        return loadContactsFromLocal();
      }
      return (data ?? []).map((row: ContactRow) => rowToContact(row));
    } catch (e) {
      console.error("Supabase load error:", e);
      return loadContactsFromLocal();
    }
  }
  return loadContactsFromLocal();
}

function loadContactsFromLocal(): Contact[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONTACTS_LOCAL_KEY);
    if (!raw) return [];
    const rows: ContactRow[] = JSON.parse(raw);
    return Array.isArray(rows) ? rows.map((row) => rowToContact(row)) : [];
  } catch {
    return [];
  }
}

async function saveContactsToSupabase(contacts: Contact[]) {
  if (typeof window === "undefined") return;
  const supabase = getSupabase();
  const rows = contacts.map(contactToRow);
  if (supabase) {
    try {
      const { error } = await supabase.from(SUPABASE_TABLE).upsert(rows, { onConflict: "id" });
      if (error) console.error("Supabase save error:", error);
    } catch (e) {
      console.error("Supabase save error:", e);
    }
  } else {
    try {
      localStorage.setItem(CONTACTS_LOCAL_KEY, JSON.stringify(rows));
    } catch (e) {
      console.error("LocalStorage save error:", e);
    }
  }
}

async function deleteContactsFromSupabase(ids: string[]): Promise<void> {
  if (typeof window === "undefined" || ids.length === 0) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from(SUPABASE_TABLE).delete().in("id", ids);
    if (error) console.error("Supabase delete error:", error);
  } catch (e) {
    console.error("Supabase delete error:", e);
  }
}

export default function Home() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [supabaseConfigured, setSupabaseConfigured] = useState(false);

  useEffect(() => {
    setUserName(typeof window !== "undefined" ? localStorage.getItem(USER_NAME_KEY) || "User" : "User");
    setSupabaseConfigured(!!getSupabase());
    loadContactsFromSupabase().then((list) => {
      setContacts(list);
      setHydrated(true);
    });
  }, []);

  const setContactsAndPersist = useCallback((next: Contact[] | ((prev: Contact[]) => Contact[])) => {
    setContacts((prev) => {
      const nextList = typeof next === "function" ? next(prev) : next;
      saveContactsToSupabase(nextList).catch(() => {});
      return nextList;
    });
  }, []);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [filterStatusSet, setFilterStatusSet] = useState<Set<string>>(new Set());
  const [filterCampaignSet, setFilterCampaignSet] = useState<Set<string>>(new Set());
  const [filterSenderSet, setFilterSenderSet] = useState<Set<string>>(new Set());
  const [filterStatusOpen, setFilterStatusOpen] = useState(false);
  const [filterCampaignOpen, setFilterCampaignOpen] = useState(false);
  const [filterSenderOpen, setFilterSenderOpen] = useState(false);
  const [rulesModalOpen, setRulesModalOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [userName, setUserName] = useState("");
  const [sortBy, setSortBy] = useState<string>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [pageSize, setPageSize] = useState<number>(20);
  const [currentPage, setCurrentPage] = useState(1);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(DEFAULT_COLUMN_WIDTHS);
  const [resizingCol, setResizingCol] = useState<string | null>(null);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);
  const [bulkCampaignOpen, setBulkCampaignOpen] = useState(false);
  const [bulkSenderOpen, setBulkSenderOpen] = useState(false);
  const bulkActionsRef = useRef<HTMLDivElement>(null);
  const filterBarRef = useRef<HTMLDivElement>(null);
  const selectAllCheckboxRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resizeStartX = useRef(0);
  const resizeStartW = useRef(0);

  const [importOpen, setImportOpen] = useState(false);
  const [importWorkbook, setImportWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [importSheetNames, setImportSheetNames] = useState<string[]>([]);
  const [importSelectedSheets, setImportSelectedSheets] = useState<Set<string>>(new Set());
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const allCampaigns = useMemo(() => {
    const set = new Set<string>();
    contacts.forEach((c) =>
      c.campaigns.forEach((name) => {
        expandCampaignForFilter(name).forEach((x) => set.add(x));
      })
    );
    return Array.from(set).sort();
  }, [contacts]);

  const allSenders = useMemo(() => {
    const set = new Set<string>();
    contacts.forEach((c) => c.senders.forEach((x) => set.add(x)));
    return Array.from(set).sort();
  }, [contacts]);

  const filteredAndSortedContacts = useMemo(() => {
    let list = [...contacts];
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => {
        const name = (c.name ?? "").toLowerCase();
        const company = (c.company ?? "").toLowerCase();
        const jobTitle = (c.jobTitle ?? "").toLowerCase();
        const linkedIn = (c.linkedIn ?? "").toLowerCase();
        const status = (c.status ?? "").toLowerCase();
        const campaigns = (c.campaigns ?? []).join(" ").toLowerCase();
        const senders = (c.senders ?? []).join(" ").toLowerCase();
        return [name, company, jobTitle, linkedIn, status, campaigns, senders].some((s) => s.includes(q));
      });
    }
    if (filterStatusSet.size > 0) {
      list = list.filter((c) => filterStatusSet.has(c.status));
    }
    if (filterCampaignSet.size > 0) {
      list = list.filter((c) =>
        c.campaigns.some((name) =>
          expandCampaignForFilter(name).some((exp) => filterCampaignSet.has(exp))
        )
      );
    }
    if (filterSenderSet.size > 0) {
      list = list.filter((c) =>
        c.senders.some((s) => filterSenderSet.has(s))
      );
    }
    list.sort((a, b) => {
      const aVal = String((a as Record<string, unknown>)[sortBy] ?? "").toLowerCase();
      const bVal = String((b as Record<string, unknown>)[sortBy] ?? "").toLowerCase();
      const cmp = aVal.localeCompare(bVal);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [contacts, searchQuery, filterStatusSet, filterCampaignSet, filterSenderSet, sortBy, sortDir]);

  const totalFiltered = filteredAndSortedContacts.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
  const pageStart = (currentPage - 1) * pageSize;
  const paginatedContacts = useMemo(
    () => filteredAndSortedContacts.slice(pageStart, pageStart + pageSize),
    [filteredAndSortedContacts, pageStart, pageSize]
  );

  useEffect(() => {
    setCurrentPage((p) => Math.min(Math.max(1, p), totalPages));
  }, [totalPages, searchQuery, filterStatusSet, filterCampaignSet, filterSenderSet, sortBy, sortDir]);

  const handleResizeStart = useCallback((colKey: string, e: React.MouseEvent) => {
    e.preventDefault();
    setResizingCol(colKey);
    resizeStartX.current = e.clientX;
    resizeStartW.current = columnWidths[colKey] ?? DEFAULT_COLUMN_WIDTHS[colKey];
  }, [columnWidths]);

  useEffect(() => {
    if (!resizingCol) return;
    const minW = 60;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - resizeStartX.current;
      const newW = Math.max(minW, resizeStartW.current + delta);
      setColumnWidths((prev) => ({ ...prev, [resizingCol]: newW }));
    };
    const onUp = () => setResizingCol(null);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [resizingCol]);

  useEffect(() => {
    const el = selectAllCheckboxRef.current;
    if (!el) return;
    const pageIds = paginatedContacts.map((c) => c.id);
    const onPage = pageIds.length;
    const selectedOnPage = pageIds.filter((id) => selectedIds.has(id)).length;
    el.indeterminate = selectedOnPage > 0 && selectedOnPage < onPage;
  }, [selectedIds, paginatedContacts]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        bulkActionsRef.current &&
        !bulkActionsRef.current.contains(event.target as Node)
      ) {
        setBulkStatusOpen(false);
        setBulkCampaignOpen(false);
        setBulkSenderOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    function handleFilterClickOutside(event: MouseEvent) {
      if (
        filterBarRef.current &&
        !filterBarRef.current.contains(event.target as Node)
      ) {
        setFilterStatusOpen(false);
        setFilterCampaignOpen(false);
        setFilterSenderOpen(false);
      }
    }
    document.addEventListener("mousedown", handleFilterClickOutside);
    return () => document.removeEventListener("mousedown", handleFilterClickOutside);
  }, []);

  const toggleSelectAll = () => {
    const pageIds = new Set(paginatedContacts.map((c) => c.id));
    const allOnPageSelected = pageIds.size > 0 && [...pageIds].every((id) => selectedIds.has(id));
    if (allOnPageSelected) {
      const next = new Set(selectedIds);
      pageIds.forEach((id) => next.delete(id));
      setSelectedIds(next);
    } else {
      const next = new Set(selectedIds);
      pageIds.forEach((id) => next.add(id));
      setSelectedIds(next);
    }
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const bulkDelete = async () => {
    const idsToDelete = Array.from(selectedIds);
    if (idsToDelete.length === 0 || !confirm(`Delete ${idsToDelete.length} contact(s)?`)) return;
    await deleteContactsFromSupabase(idsToDelete);
    setContactsAndPersist((prev) => prev.filter((c) => !idsToDelete.includes(c.id)));
    setSelectedIds(new Set());
  };

  const bulkUpdateStatus = (status: ContactStatus) => {
    setContactsAndPersist((prev) =>
      prev.map((c) =>
        selectedIds.has(c.id) ? { ...c, status } : c
      )
    );
    setBulkStatusOpen(false);
    setSelectedIds(new Set());
  };

  const bulkAddCampaign = (campaign: string) => {
    if (!campaign.trim()) return;
    setContactsAndPersist((prev) =>
      prev.map((c) =>
        selectedIds.has(c.id)
          ? {
              ...c,
              campaigns: c.campaigns.includes(campaign)
                ? c.campaigns
                : [...c.campaigns, campaign],
            }
          : c
      )
    );
    setBulkCampaignOpen(false);
    setSelectedIds(new Set());
  };

  const bulkSetSender = (sender: string) => {
    if (!sender.trim()) return;
    setContactsAndPersist((prev) =>
      prev.map((c) =>
        selectedIds.has(c.id) ? { ...c, senders: [sender] } : c
      )
    );
    setBulkSenderOpen(false);
    setSelectedIds(new Set());
  };

  const handleImportFileClick = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      setImportError(null);
      setImportProgress(null);
      try {
        const { workbook, sheetNames } = await parseWorkbookFile(file);
        if (sheetNames.length === 0) {
          setImportError("No sheets with data found in this file.");
          return;
        }
        setImportWorkbook(workbook);
        setImportSheetNames(sheetNames);
        setImportSelectedSheets(new Set(sheetNames));
        setImportOpen(true);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Failed to read file.");
      }
    },
    []
  );

  const importSelectAllSheets = () => {
    setImportSelectedSheets(new Set(importSheetNames));
  };

  const importDeselectAllSheets = () => {
    setImportSelectedSheets(new Set());
  };

  const importToggleSheet = (name: string) => {
    setImportSelectedSheets((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const importSelectedCount = useMemo(() => {
    if (!importWorkbook) return 0;
    let n = 0;
    importSelectedSheets.forEach((name) => {
      n += Math.max(0, getSheetRowCount(importWorkbook, name) - 1);
    });
    return n;
  }, [importWorkbook, importSelectedSheets]);

  const startImport = useCallback(async () => {
    if (!importWorkbook || importSelectedSheets.size === 0) return;
    setIsImporting(true);
    setImportError(null);
    setImportProgress({ current: 0, total: 1 });
    try {
      const sheetList = Array.from(importSelectedSheets);
      const rawRows = getRowsFromSheets(importWorkbook, sheetList);
      const rows = mergeRowsByLinkedInUrl(rawRows);
      const total = rows.length;
      if (total === 0) {
        setImportError("No rows found in selected sheets (first row is treated as headers).");
        setIsImporting(false);
        setImportProgress(null);
        return;
      }
      setImportProgress({ current: 0, total });
      const idPrefix = `imp-${Date.now()}`;
      await importInChunks(
        rows,
        idPrefix,
        contacts,
        (fullMergedList) => {
          setContactsAndPersist(fullMergedList);
        },
        (current, total) => {
          setImportProgress({ current, total });
        }
      );
      setImportOpen(false);
      setImportWorkbook(null);
      setImportSheetNames([]);
      setImportSelectedSheets(new Set());
      setImportProgress(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setIsImporting(false);
    }
  }, [importWorkbook, importSelectedSheets, contacts, setContactsAndPersist]);

  const closeImportModal = useCallback(() => {
    if (isImporting) return;
    setImportOpen(false);
    setImportWorkbook(null);
    setImportSheetNames([]);
    setImportSelectedSheets(new Set());
    setImportProgress(null);
    setImportError(null);
  }, [isImporting]);

  const contactsToExport = useMemo(() => {
    if (selectedIds.size > 0) {
      return contacts.filter((c) => selectedIds.has(c.id));
    }
    return filteredAndSortedContacts;
  }, [contacts, selectedIds, filteredAndSortedContacts]);

  const exportToExcel = useCallback(() => {
    setExportOpen(false);
    const rows = contactsToExport.map((c) => ({
      Name: c.name,
      Company: c.company,
      "Job Title": c.jobTitle,
      LinkedIn: c.linkedIn,
      Status: c.status,
      "All Campaigns": c.campaigns.join(", "),
      "All Senders": c.senders.join(", "),
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Contacts");
    XLSX.writeFile(wb, `contacts-export-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }, [contactsToExport]);

  const exportToCsv = useCallback(() => {
    setExportOpen(false);
    const headers = ["Name", "Company", "Job Title", "LinkedIn", "Status", "All Campaigns", "All Senders"];
    const rows = contactsToExport.map((c) => [
      c.name,
      c.company,
      c.jobTitle,
      c.linkedIn,
      c.status,
      c.campaigns.join(", "),
      c.senders.join(", "),
    ]);
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [headers.map(escape).join(","), ...rows.map((r) => r.map((c) => escape(String(c))).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `contacts-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [contactsToExport]);

  return (
    <div className="min-h-screen bg-slate-50">
      {hydrated && !supabaseConfigured && (
        <div className="bg-amber-100 border-b border-amber-300 px-4 py-2 text-center text-sm text-amber-900">
          Data is saved in this browser only. Add <code className="rounded bg-amber-200 px-1">NEXT_PUBLIC_SUPABASE_URL</code> and <code className="rounded bg-amber-200 px-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to <code className="rounded bg-amber-200 px-1">.env.local</code> and restart the app to sync to the Supabase table.
        </div>
      )}
      {/* Top nav */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 w-full max-w-[1400px] items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#0a66c2]">
              <svg
                className="h-5 w-5 text-white"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
              </svg>
            </div>
            <span className="text-base font-semibold tracking-tight text-slate-900">
              Outbound Manager
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                const name = window.prompt("Your name", userName);
                if (name != null && name.trim()) {
                  const trimmed = name.trim();
                  setUserName(trimmed);
                  try {
                    localStorage.setItem(USER_NAME_KEY, trimmed);
                  } catch {
                    // ignore
                  }
                }
              }}
              className="text-sm font-medium text-slate-700 hover:text-slate-900 hover:underline"
            >
              {userName}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
        {/* Page title and actions */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                Contacts
              </h1>
              <button
                type="button"
                onClick={() => setRulesModalOpen(true)}
                className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-[#0a66c2] focus:ring-offset-1"
                title="Status rules & how we read from Excel"
                aria-label="View status rules"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              Manage your LinkedIn outbound contacts and campaigns.
            </p>
          </div>
          <div className="flex flex-shrink-0 gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFileChange}
              className="hidden"
              aria-hidden
            />
            <button
              type="button"
              onClick={handleImportFileClick}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#0a66c2] focus:ring-offset-2"
            >
              <svg
                className="h-4 w-4 text-slate-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                />
              </svg>
              Import CSV or Excel
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setExportOpen((v) => !v)}
                className="inline-flex items-center gap-2 rounded-lg bg-[#0a66c2] px-4 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-[#004182] focus:outline-none focus:ring-2 focus:ring-[#0a66c2] focus:ring-offset-2"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                Export Contacts
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {exportOpen && (
                <>
                  <div className="fixed inset-0 z-10" aria-hidden onClick={() => setExportOpen(false)} />
                  <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                    <button
                      type="button"
                      onClick={exportToExcel}
                      className="block w-full px-4 py-2 text-left text-xs font-medium text-slate-900 hover:bg-slate-50"
                    >
                      Export as Excel (.xlsx)
                    </button>
                    <button
                      type="button"
                      onClick={exportToCsv}
                      className="block w-full px-4 py-2 text-left text-xs font-medium text-slate-900 hover:bg-slate-50"
                    >
                      Export as CSV
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Filters and sort bar */}
        <div ref={filterBarRef} className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 shadow-sm">
          <input
            type="search"
            placeholder="Search contacts…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-56 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-500 focus:border-[#0a66c2] focus:outline-none focus:ring-1 focus:ring-[#0a66c2]"
            aria-label="Search contacts"
          />
          <span className="py-1.5 text-xs font-medium text-slate-600">Filters</span>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setFilterStatusOpen((v) => !v);
                setFilterCampaignOpen(false);
                setFilterSenderOpen(false);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:border-[#0a66c2] focus:outline-none focus:ring-1 focus:ring-[#0a66c2]"
            >
              Status {filterStatusSet.size > 0 ? `(${filterStatusSet.size})` : ""}
            </button>
            {filterStatusOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-2 shadow-lg">
                <div className="flex gap-1 px-2 pb-2">
                  <button type="button" onClick={() => setFilterStatusSet(new Set(STATUS_OPTIONS))} className="text-[10px] font-medium text-[#0a66c2] hover:underline">Select all</button>
                  <button type="button" onClick={() => setFilterStatusSet(new Set())} className="text-[10px] font-medium text-slate-700 hover:underline">Clear</button>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {STATUS_OPTIONS.map((s) => (
                    <label key={s} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={filterStatusSet.has(s)}
                        onChange={(e) => {
                          const next = new Set(filterStatusSet);
                          if (e.target.checked) next.add(s);
                          else next.delete(s);
                          setFilterStatusSet(next);
                        }}
                        className="h-4 w-4 rounded border-slate-300 text-[#0a66c2]"
                      />
                      <span className="text-xs font-medium text-slate-900">{s}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setFilterCampaignOpen((v) => !v);
                setFilterStatusOpen(false);
                setFilterSenderOpen(false);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:border-[#0a66c2] focus:outline-none focus:ring-1 focus:ring-[#0a66c2]"
            >
              Campaign {filterCampaignSet.size > 0 ? `(${filterCampaignSet.size})` : ""}
            </button>
            {filterCampaignOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-64 rounded-lg border border-slate-200 bg-white py-2 shadow-lg">
                <div className="flex gap-1 px-2 pb-2">
                  <button type="button" onClick={() => setFilterCampaignSet(new Set(allCampaigns))} className="text-[10px] font-medium text-[#0a66c2] hover:underline">Select all</button>
                  <button type="button" onClick={() => setFilterCampaignSet(new Set())} className="text-[10px] font-medium text-slate-700 hover:underline">Clear</button>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {allCampaigns.map((c) => (
                    <label key={c} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={filterCampaignSet.has(c)}
                        onChange={(e) => {
                          const next = new Set(filterCampaignSet);
                          if (e.target.checked) next.add(c);
                          else next.delete(c);
                          setFilterCampaignSet(next);
                        }}
                        className="h-4 w-4 rounded border-slate-300 text-[#0a66c2]"
                      />
                      <span className="truncate text-xs font-medium text-slate-900">{c}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setFilterSenderOpen((v) => !v);
                setFilterStatusOpen(false);
                setFilterCampaignOpen(false);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:border-[#0a66c2] focus:outline-none focus:ring-1 focus:ring-[#0a66c2]"
            >
              Sender {filterSenderSet.size > 0 ? `(${filterSenderSet.size})` : ""}
            </button>
            {filterSenderOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-2 shadow-lg">
                <div className="flex gap-1 px-2 pb-2">
                  <button type="button" onClick={() => setFilterSenderSet(new Set(allSenders))} className="text-[10px] font-medium text-[#0a66c2] hover:underline">Select all</button>
                  <button type="button" onClick={() => setFilterSenderSet(new Set())} className="text-[10px] font-medium text-slate-700 hover:underline">Clear</button>
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {allSenders.map((s) => (
                    <label key={s} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={filterSenderSet.has(s)}
                        onChange={(e) => {
                          const next = new Set(filterSenderSet);
                          if (e.target.checked) next.add(s);
                          else next.delete(s);
                          setFilterSenderSet(next);
                        }}
                        className="h-4 w-4 rounded border-slate-300 text-[#0a66c2]"
                      />
                      <span className="text-xs font-medium text-slate-900">{s}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="h-4 w-px bg-slate-200" />
          <span className="py-1.5 text-xs font-medium text-slate-600">Sort</span>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:border-[#0a66c2] focus:outline-none focus:ring-1 focus:ring-[#0a66c2]"
          >
            {SORT_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            title={sortDir === "asc" ? "Ascending" : "Descending"}
          >
            {sortDir === "asc" ? (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
            {sortDir === "asc" ? "A–Z" : "Z–A"}
          </button>
        </div>

        {/* Bulk actions bar */}
        {selectedIds.size > 0 && (
          <div
            ref={bulkActionsRef}
            className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#0a66c2] bg-blue-50 px-4 py-3"
          >
            <span className="text-xs font-medium text-slate-700">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set(filteredAndSortedContacts.map((c) => c.id)))}
              className="text-xs font-medium text-[#0a66c2] hover:underline"
            >
              Select all {filteredAndSortedContacts.length.toLocaleString()} contacts
              {filteredAndSortedContacts.length !== contacts.length && " (filtered)"}
            </button>
            <button
              type="button"
              onClick={bulkDelete}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setBulkStatusOpen((v) => !v);
                  setBulkCampaignOpen(false);
                  setBulkSenderOpen(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Change status
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {bulkStatusOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => bulkUpdateStatus(s)}
                      className="block w-full px-4 py-2 text-left text-xs text-slate-700 hover:bg-slate-100"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setBulkCampaignOpen((v) => !v);
                  setBulkStatusOpen(false);
                  setBulkSenderOpen(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Change campaign
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {bulkCampaignOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                  {allCampaigns.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => bulkAddCampaign(c)}
                      className="block w-full px-4 py-2 text-left text-xs text-slate-700 hover:bg-slate-100"
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setBulkSenderOpen((v) => !v);
                  setBulkStatusOpen(false);
                  setBulkCampaignOpen(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Change sender
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {bulkSenderOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                  {allSenders.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => bulkSetSender(s)}
                      className="block w-full px-4 py-2 text-left text-xs text-slate-700 hover:bg-slate-100"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="ml-auto text-xs font-medium text-slate-600 hover:text-slate-900"
            >
              Clear selection
            </button>
          </div>
        )}

        {/* Table card */}
        {!hydrated ? (
          <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white py-24 text-xs text-slate-500">
            Loading…
          </div>
        ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table
              className="min-w-full table-fixed divide-y divide-slate-200"
              style={{ width: Object.values(columnWidths).reduce((a, b) => a + b, 0) }}
            >
              <colgroup>
                <col style={{ width: columnWidths.select }} />
                <col style={{ width: columnWidths.name }} />
                <col style={{ width: columnWidths.company }} />
                <col style={{ width: columnWidths.jobTitle }} />
                <col style={{ width: columnWidths.linkedIn }} />
                <col style={{ width: columnWidths.status }} />
                <col style={{ width: columnWidths.campaigns }} />
                <col style={{ width: columnWidths.senders }} />
              </colgroup>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left"
                    style={{ width: columnWidths.select, minWidth: 40 }}
                  >
                    <input
                      ref={selectAllCheckboxRef}
                      aria-label="Select all on page"
                      type="checkbox"
                      checked={
                        paginatedContacts.length > 0 &&
                        paginatedContacts.every((c) => selectedIds.has(c.id))
                      }
                      onChange={toggleSelectAll}
                      className="h-4 w-4 rounded border-slate-300 text-[#0a66c2] focus:ring-[#0a66c2]"
                    />
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("select", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    Name
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("name", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    Company
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("company", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    Job Title
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("jobTitle", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    LinkedIn
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("linkedIn", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    Status
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("status", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    All Campaigns
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("campaigns", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                  <th
                    scope="col"
                    className="relative bg-slate-50 px-4 py-3 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600"
                  >
                    All Senders
                    <span
                      role="presentation"
                      onMouseDown={(e) => handleResizeStart("senders", e)}
                      className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-[#0a66c2]/20"
                      style={{ touchAction: "none" }}
                    />
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 bg-white">
                {paginatedContacts.map((contact) => (
                  <tr
                    key={contact.id}
                    className={`transition hover:bg-slate-50 ${
                      selectedIds.has(contact.id) ? "bg-blue-50/50" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(contact.id)}
                        onChange={() => toggleSelect(contact.id)}
                        className="h-4 w-4 rounded border-slate-300 text-[#0a66c2] focus:ring-[#0a66c2]"
                      />
                    </td>
                    <td className="min-w-0 overflow-hidden truncate px-4 py-3 text-xs font-medium text-slate-900" title={contact.name}>
                      {contact.name}
                    </td>
                    <td className="min-w-0 overflow-hidden truncate px-4 py-3 text-xs text-slate-600" title={contact.company}>
                      {contact.company}
                    </td>
                    <td className="min-w-0 overflow-hidden truncate px-4 py-3 text-xs text-slate-600" title={contact.jobTitle}>
                      {contact.jobTitle}
                    </td>
                    <td className="min-w-0 px-2 py-3 text-center" title={contact.linkedIn}>
                      <a
                        href={contact.linkedIn}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center text-[#0a66c2] hover:opacity-80"
                        aria-label="Open LinkedIn profile"
                      >
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                        </svg>
                      </a>
                    </td>
                    <td className="min-w-0 overflow-hidden truncate px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          contact.status === "Converted"
                            ? "bg-emerald-100 text-emerald-800"
                            : contact.status === "Not Interested" || contact.status === "Wrong Person"
                              ? "bg-red-100 text-red-800"
                              : contact.status === "Replied"
                                ? "bg-blue-100 text-blue-800"
                                : contact.status === "Message Sent"
                                  ? "bg-violet-100 text-violet-800"
                                  : contact.status === "Request Sent"
                                    ? "bg-amber-100 text-amber-800"
                                    : "bg-slate-100 text-slate-800"
                        }`}
                      >
                        {contact.status}
                      </span>
                    </td>
                    <td className="min-w-0 overflow-hidden truncate px-4 py-3 text-xs text-slate-600" title={contact.campaigns.join(", ")}>
                      {contact.campaigns.join(", ")}
                    </td>
                    <td className="min-w-0 overflow-hidden truncate px-4 py-3 text-xs text-slate-600" title={contact.senders.join(", ")}>
                      {contact.senders.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        )}

        {/* Pagination */}
        {totalFiltered > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-center gap-4">
              <span className="text-xs text-slate-600">Rows per page</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 focus:border-[#0a66c2] focus:outline-none focus:ring-1 focus:ring-[#0a66c2]"
              >
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                Showing {pageStart + 1}–{Math.min(pageStart + pageSize, totalFiltered)} of{" "}
                {totalFiltered.toLocaleString()}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-white"
              >
                Previous
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => {
                  if (totalPages <= 7) return true;
                  if (p === 1 || p === totalPages) return true;
                  if (Math.abs(p - currentPage) <= 1) return true;
                  return false;
                })
                .reduce<React.ReactNode[]>((acc, p, i, arr) => {
                  const prev = arr[i - 1] as number | undefined;
                  if (prev !== undefined && p - prev > 1)
                    acc.push(
                      <span key={`ellip-${p}`} className="px-1 text-slate-400">
                        …
                      </span>
                    );
                  acc.push(
                    <button
                      key={p}
                      type="button"
                      onClick={() => setCurrentPage(p)}
                      className={`min-w-[2rem] rounded-lg px-2 py-1.5 text-xs font-medium ${
                        currentPage === p
                          ? "bg-[#0a66c2] text-white"
                          : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {p}
                    </button>
                  );
                  return acc;
                }, [])}
              <button
                type="button"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-white"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {filteredAndSortedContacts.length === 0 && (
          <p className="mt-6 text-center text-xs text-slate-500">
            No contacts match your filters. Clear filters or import more contacts.
          </p>
        )}
        {filteredAndSortedContacts.length > 0 && (
          <p className="mt-6 text-center text-xs text-slate-500">
            Import a CSV to add more contacts, or export your list anytime.
          </p>
        )}
      </main>

      {/* Import modal */}
      {importOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={(e) => e.target === e.currentTarget && closeImportModal()}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-200 px-6 py-4">
              <h2 className="text-base font-semibold text-slate-900">
                Select sheets to import
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Choose which sheets to load. First row of each sheet is used as headers.
              </p>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-6 py-4">
              {importError && (
                <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-xs text-red-800">
                  {importError}
                </div>
              )}
              {importProgress && isImporting ? (
                <div className="space-y-3 py-4">
                  <p className="text-xs font-medium text-slate-700">
                    Importing… {importProgress.current.toLocaleString()} of{" "}
                    {importProgress.total.toLocaleString()} contacts
                  </p>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-[#0a66c2] transition-all duration-300"
                      style={{
                        width: `${
                          importProgress.total > 0
                            ? (100 * importProgress.current) / importProgress.total
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex gap-2">
                    <button
                      type="button"
                      onClick={importSelectAllSheets}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={importDeselectAllSheets}
                      className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Deselect all
                    </button>
                  </div>
                  <ul className="space-y-2">
                    {importSheetNames.map((name) => {
                      const rowCount = importWorkbook
                        ? Math.max(0, getSheetRowCount(importWorkbook, name) - 1)
                        : 0;
                      return (
                        <li
                          key={name}
                          className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3 hover:bg-slate-50"
                        >
                          <input
                            type="checkbox"
                            id={`sheet-${name}`}
                            checked={importSelectedSheets.has(name)}
                            onChange={() => importToggleSheet(name)}
                            className="h-4 w-4 rounded border-slate-300 text-[#0a66c2] focus:ring-[#0a66c2]"
                          />
                          <label
                            htmlFor={`sheet-${name}`}
                            className="flex-1 cursor-pointer text-xs font-medium text-slate-900"
                          >
                            {name}
                          </label>
                          <span className="text-xs text-slate-500">
                            {rowCount.toLocaleString()} row{rowCount !== 1 ? "s" : ""}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-4 text-xs text-slate-600">
                    <strong>
                      {importSelectedSheets.size} sheet(s)
                    </strong>{" "}
                    selected, ~{" "}
                    <strong>{importSelectedCount.toLocaleString()}</strong>{" "}
                    contacts to import.
                  </p>
                </>
              )}
            </div>
            <div className="flex justify-end gap-3 border-t border-slate-200 px-6 py-4">
              <button
                type="button"
                onClick={closeImportModal}
                disabled={isImporting}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel
              </button>
              {!isImporting && (
                <button
                  type="button"
                  onClick={startImport}
                  disabled={importSelectedSheets.size === 0}
                  className="rounded-lg bg-[#0a66c2] px-4 py-2 text-xs font-medium text-white hover:bg-[#004182] disabled:opacity-50"
                >
                  {importSelectedCount > 0
                    ? `Import ${importSelectedCount.toLocaleString()} contacts`
                    : "Import"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Status rules modal */}
      {rulesModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          onClick={() => setRulesModalOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-slate-200 px-6 py-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">
                Status rules & how we read from Excel
              </h2>
              <button
                type="button"
                onClick={() => setRulesModalOpen(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              {STATUS_RULES_MODAL_CONTENT}
            </div>
            <div className="border-t border-slate-200 px-6 py-3 flex justify-end">
              <button
                type="button"
                onClick={() => setRulesModalOpen(false)}
                className="rounded-lg bg-[#0a66c2] px-4 py-2 text-xs font-medium text-white hover:bg-[#004182]"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
