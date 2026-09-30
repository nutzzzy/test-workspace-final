import type { Prisma } from "@prisma/client";

export type CriterionInput = {
  key: string;
  text: string;
  orderIndex: number;
  origin?: string;
};

type CurrentCriterion = { id: string; key: string; text: string };

export type CriteriaSyncPlan = {
  keep: Array<{ id: string; next: CriterionInput }>;
  create: CriterionInput[];
  remove: string[];
};

/** Comparison key only; stored text is never modified by this. */
export function criterionMatchKey(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Decide which acceptance-criterion rows survive a rebuild.
 *
 * Rows are identified by id, and test-case links hang off that id, so a row
 * is only replaced when its criterion genuinely disappeared:
 *  1. same text (ignoring whitespace/case) → same row, even if its key or
 *     position changed;
 *  2. otherwise, when the list keeps the same length, the row at the same
 *     position is treated as the same criterion re-worded (an edit in place);
 *  3. anything left is created or removed.
 * A substring or similar-looking text never counts as a match.
 */
export function planCriteriaSync(
  current: CurrentCriterion[],
  next: CriterionInput[],
): CriteriaSyncPlan {
  const used = new Set<string>();
  const assigned = new Map<number, string>();

  next.forEach((item, index) => {
    const wanted = criterionMatchKey(item.text);
    const hit = current.find(
      (row) => !used.has(row.id) && criterionMatchKey(row.text) === wanted,
    );
    if (hit) {
      used.add(hit.id);
      assigned.set(index, hit.id);
    }
  });

  if (current.length === next.length) {
    next.forEach((_, index) => {
      if (assigned.has(index)) return;
      const row = current[index];
      if (row && !used.has(row.id)) {
        used.add(row.id);
        assigned.set(index, row.id);
      }
    });
  }

  const keep: CriteriaSyncPlan["keep"] = [];
  const create: CriterionInput[] = [];
  next.forEach((item, index) => {
    const id = assigned.get(index);
    if (id) keep.push({ id, next: item });
    else create.push(item);
  });
  const remove = current.filter((row) => !used.has(row.id)).map((row) => row.id);
  return { keep, create, remove };
}

/** Apply a rebuild inside the caller's transaction, preserving row ids and links. */
export async function syncAcceptanceCriteria(
  tx: Prisma.TransactionClient,
  jiraIssueId: string,
  next: CriterionInput[],
): Promise<CriteriaSyncPlan> {
  const current = await tx.acceptanceCriterion.findMany({
    where: { jiraIssueId },
    orderBy: { orderIndex: "asc" },
    select: { id: true, key: true, text: true },
  });
  const plan = planCriteriaSync(current, next);

  if (plan.remove.length > 0) {
    await tx.acceptanceCriterion.deleteMany({ where: { id: { in: plan.remove } } });
  }
  // Keys are unique per issue; park kept rows on a temporary key first so
  // swapping AC-01/AC-02 cannot collide mid-update.
  for (const { id } of plan.keep) {
    await tx.acceptanceCriterion.update({ where: { id }, data: { key: `__sync_${id}` } });
  }
  for (const { id, next: item } of plan.keep) {
    await tx.acceptanceCriterion.update({
      where: { id },
      data: {
        key: item.key,
        text: item.text,
        orderIndex: item.orderIndex,
        ...(item.origin ? { origin: item.origin } : {}),
      },
    });
  }
  if (plan.create.length > 0) {
    await tx.acceptanceCriterion.createMany({
      data: plan.create.map((item) => ({
        jiraIssueId,
        key: item.key,
        text: item.text,
        orderIndex: item.orderIndex,
        ...(item.origin ? { origin: item.origin } : {}),
      })),
    });
  }
  return plan;
}
