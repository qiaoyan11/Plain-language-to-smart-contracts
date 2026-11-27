import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Shell } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import {
  api,
  formatWei,
  LIST_UNAVAILABLE,
  reconnectDelay,
  type DraftSummary,
  type ProjectSummary,
} from "@/api/client";

export const Route = createFileRoute("/projects/")({
  head: () => ({ meta: [{ title: "Your projects · Accord" }] }),
  component: ProjectsPage,
});

const stageText: Record<ProjectSummary["stage"], string> = {
  needsConfirmation: "Needs your confirmation",
  readyToGenerate: "Confirmed · contract not generated yet",
  generating: "Generating and checking the contract",
  readyToDeploy: "Checks passed · ready to deploy",
  checksNotPassed: "Contract checks did not pass",
  notDeployed: "Not deployed yet",
  awaitingDeposit: "Deployed · waiting for the deposit",
  paying: "Funded · waiting for milestone approval",
  complete: "All milestones paid",
  unknown: "Status unavailable · open the project to check again",
};

const stageTone: Record<ProjectSummary["stage"], string> = {
  complete: "bg-success/10 text-success",
  paying: "bg-accent text-primary",
  awaitingDeposit: "bg-accent text-primary",
  readyToDeploy: "bg-accent text-primary",
  needsConfirmation: "bg-muted text-foreground",
  readyToGenerate: "bg-muted text-foreground",
  generating: "bg-muted text-foreground",
  notDeployed: "bg-muted text-foreground",
  checksNotPassed: "bg-destructive/10 text-destructive",
  unknown: "bg-destructive/10 text-destructive",
};

function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

function draftStatus(draft: DraftSummary) {
  if (draft.awaitingReply) return "The last message has no reply yet";
  return draft.status === "readyForConfirmation" ? "Ready to review" : "Questions still open";
}

function ProjectItem({ project }: { project: ProjectSummary }) {
  const title = (
    <span className="break-words text-base font-medium underline-offset-4 hover:underline">
      {project.name}
    </span>
  );
  return (
    <li className="border-b border-border py-4">
      {project.kind === "agreement" ? (
        <Link to="/projects/$id" params={{ id: project.id }}>
          {title}
        </Link>
      ) : (
        <Link to="/reference-projects/$id" params={{ id: project.id }}>
          {title}
        </Link>
      )}
      <p className="mt-2">
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${stageTone[project.stage]}`}
        >
          {stageText[project.stage]}
        </span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {project.kind === "agreement" ? "AI-generated contract" : "Handwritten reference contract"}
        {" · "}
        {formatWei(project.totalAmountWei)} test ETH
        {project.contractAddress && project.paidCount !== null
          ? ` · ${project.paidCount} of ${project.milestoneCount} milestones paid`
          : ` · ${project.milestoneCount} milestone${project.milestoneCount === 1 ? "" : "s"}`}
        {when(project.createdAt) && ` · created ${when(project.createdAt)}`}
      </p>
    </li>
  );
}

export function ProjectsPage() {
  const nav = useNavigate();
  const projects = useQuery({
    queryKey: ["project-list"],
    queryFn: api.listProjects,
    retry: false,
    refetchOnReconnect: "always",
    refetchInterval: (q) => reconnectDelay(q.state.error),
  });
  const drafts = useQuery({
    queryKey: ["draft-list"],
    queryFn: api.listDrafts,
    retry: false,
    refetchInterval: (q) => reconnectDelay(q.state.error),
  });
  const outdated = projects.error?.message === LIST_UNAVAILABLE;
  return (
    <Shell step="Your projects">
      <h1>Your projects</h1>
      <p className="intro">
        Agreements and reference projects saved by the local demo on this computer. Opening one only
        reads its status. It never sends a payment.
      </p>
      <Button asChild>
        <Link to="/">Describe a new agreement</Link>
      </Button>
      {Boolean(drafts.data?.length) && (
        <section className="mt-10" aria-label="Unfinished conversations">
          <h2>Unfinished conversations</h2>
          <ul className="mt-3 border-t border-border">
            {drafts.data!.map((draft) => (
              <li
                key={draft.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-4"
              >
                <div className="min-w-0">
                  <p className="break-words font-medium">{draft.name ?? "Untitled agreement"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {draftStatus(draft)}
                    {when(draft.updatedAt) && ` · updated ${when(draft.updatedAt)}`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Continue conversation: ${draft.name ?? "Untitled agreement"}`}
                  onClick={() => {
                    api.setActiveDraftId(draft.id);
                    void nav({ to: "/" });
                  }}
                >
                  Continue conversation
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mt-10" aria-label="Saved projects">
        <h2>Saved projects</h2>
        {projects.data ? (
          projects.data.length ? (
            <ul className="mt-3 border-t border-border">
              {projects.data.map((project) => (
                <ProjectItem key={project.id} project={project} />
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm">
              No saved projects yet. Confirmed agreements and reference projects appear here.
            </p>
          )
        ) : projects.isError ? (
          <div role="alert" className="mt-3 text-sm">
            <p>
              {outdated
                ? "The running local server cannot list projects yet. Restart the local demo (stop it, then run npm run demo:web) and reload this page. Your saved projects are kept."
                : reconnectDelay(projects.error)
                  ? "Reconnecting to the local server…"
                  : projects.error.message}
            </p>
            {!reconnectDelay(projects.error) && (
              <Button className="mt-3" variant="outline" onClick={() => void projects.refetch()}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm">Loading saved projects…</p>
        )}
      </section>
    </Shell>
  );
}
