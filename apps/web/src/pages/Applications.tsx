import { useState } from "react";
import { Link } from "react-router";
import { BriefcaseBusiness, Search } from "lucide-react";
import { useApplicationCountsQuery, useApplicationsQuery } from "../lib/api";
import { PageHeader } from "../components/AppLayout";
import { ApplicationsTable } from "../components/applications";
import { Button, Card, Empty, Input, Spinner, Tabs } from "../components/ui";

export default function Applications() {
  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const { data: rows, isLoading } = useApplicationsQuery({ tab, q });
  const { data: counts } = useApplicationCountsQuery();
  return (
    <>
      <PageHeader title="Applications" sub="Every application Ferry has prepared, sent, or needs your help with." />
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "all", label: "All", count: counts?.all },
              { id: "in_flight", label: "In flight", count: counts?.in_flight },
              { id: "needs", label: "Needs you", count: counts?.needs },
              { id: "submitted", label: "Submitted", count: counts?.submitted },
              { id: "failed", label: "Failed", count: counts?.failed },
              { id: "skipped", label: "Skipped", count: counts?.skipped },
            ]}
          />
          <div className="relative mb-2 w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input className="h-8 pl-9" placeholder="Filter by title or company" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {isLoading ? (
          <Spinner className="mx-auto my-16 h-6 w-6" />
        ) : (
          <ApplicationsTable
            rows={rows ?? []}
            empty={
              <Empty
                icon={<BriefcaseBusiness className="h-5 w-5" />}
                title={tab === "needs" ? "Nothing needs you right now" : "No applications yet"}
                sub="Pick a match and hit Apply. Ferry tailors your résumé, fills the form, and checks in before sending."
                action={
                  <Link to="/app/jobs">
                    <Button variant="primary">Browse matches</Button>
                  </Link>
                }
              />
            }
          />
        )}
      </Card>
    </>
  );
}
