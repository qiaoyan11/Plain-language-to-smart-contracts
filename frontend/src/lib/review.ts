import { useState, useEffect } from "react";
import type { Project } from "@/api/client";

type Milestone = Project["milestones"][number];

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** A duration in words: "14 days", "1 day 6 hours", "3 hours", "5 minutes". */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days >= 3 || (days >= 1 && hours === 0)) return plural(days, "day");
  if (days >= 1) return `${plural(days, "day")} ${plural(hours, "hour")}`;
  if (hours >= 3 || (hours >= 1 && minutes === 0)) return plural(hours, "hour");
  if (hours >= 1) return `${plural(hours, "hour")} ${plural(minutes, "minute")}`;
  if (minutes >= 1) return plural(minutes, "minute");
  return "less than a minute";
}

/** Where a milestone stands in a v2 review, or null for an agreement without a review period. */
export type ReviewStage =
  | { kind: "notDelivered" }
  | { kind: "inReview"; endsAt: number; remaining: number }
  | { kind: "reviewOver"; endsAt: number };

export function reviewStage(
  project: Project,
  milestone: Milestone,
  now: number,
): ReviewStage | null {
  if (!project.review || milestone.paid) return null;
  if (!milestone.deliveredAt) return { kind: "notDelivered" };
  const endsAt = milestone.deliveredAt + project.review.periodSeconds;
  return now < endsAt
    ? { kind: "inReview", endsAt, remaining: endsAt - now }
    : { kind: "reviewOver", endsAt };
}

/** Change requests still allowed for a milestone, or null when the contract sets no limit. */
export function changesLeft(project: Project, milestone: Milestone): number | null {
  const limit = project.review?.changeRequestLimit ?? project.changeRequestLimit ?? 0;
  return limit === 0 ? null : Math.max(0, limit - (milestone.changeRequests ?? 0));
}

/** The agreed review period, before or after deployment. */
export function reviewPeriod(project: Project): number | null {
  return project.review?.periodSeconds ?? project.reviewPeriodSeconds ?? null;
}

/**
 * Chain time now. The snapshot carries the chain time when it was read; this keeps counting from
 * there so a review countdown moves, and a claim becomes available, without reloading.
 */
export function useChainNow(project: Project): number {
  const chainTime = project.review?.chainTime ?? 0;
  const [base, setBase] = useState({ chain: chainTime, at: Date.now() });
  const [tick, setTick] = useState(Date.now());
  if (base.chain !== chainTime) setBase({ chain: chainTime, at: Date.now() });
  useEffect(() => {
    if (!chainTime) return;
    const timer = setInterval(() => setTick(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [chainTime]);
  if (!chainTime) return 0;
  return base.chain + Math.max(0, Math.floor((tick - base.at) / 1000));
}
