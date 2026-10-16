import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { all, run, uid } from "../db.ts";

// Seed boards: every entry was verified live against its ATS's public API by scripts/mine-boards.ts
// (job lists, company directories, Common Crawl, AI Dev Jobs; re-run it to grow the list). Users can add
// any board from the dashboard (Settings → Career pages) or POST /api/v1/sources.
export const SEED_COMPANIES: { name: string; ats: string; board: string }[] = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./boards.json", import.meta.url)), "utf8"),
);

export function seedCompanies() {
  for (const c of SEED_COMPANIES) {
    run("INSERT OR IGNORE INTO companies(id, name, ats, board) VALUES(?,?,?,?)", uid("co"), c.name, c.ats, c.board);
  }
}

export interface CompanyRow {
  id: string;
  name: string;
  ats: string;
  board: string;
  active: number;
  last_polled_at: string | null;
  last_error: string | null;
  job_count: number;
  next_poll_at: string | null;
  fail_count: number;
}

export const listCompanies = () => all<CompanyRow>("SELECT * FROM companies ORDER BY name");

export function addCompany(name: string, ats: string, board: string) {
  run("INSERT OR IGNORE INTO companies(id, name, ats, board) VALUES(?,?,?,?)", uid("co"), name, ats, board);
  return all<CompanyRow>("SELECT * FROM companies WHERE ats = ? AND board = ?", ats, board)[0];
}
