import { JiraService } from "./jira.service";

function createPrisma() {
  const prisma = {
    jiraIssue: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findFirst: jest.fn(),
    },
    testCase: {
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    bug: {
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) =>
    fn(prisma),
  );
  return prisma;
}

describe("JiraService issue edit and delete", () => {
  const config = { get: jest.fn() };

  it("updates title and key and keeps acceptance criteria when text is unchanged", async () => {
    const prisma = createPrisma();
    prisma.jiraIssue.findUnique
      .mockResolvedValueOnce({
        id: "iss-1",
        key: "QA-1",
        acceptanceCriteria: [{ text: "user can cancel" }],
      })
      .mockResolvedValueOnce(null);
    prisma.jiraIssue.findFirst.mockResolvedValue({
      id: "iss-1",
      key: "QA-2",
      title: "Cancel order",
    });

    const service = new JiraService(prisma as never, config as never);
    const saved = await service.updateIssue("iss-1", {
      key: "qa-2",
      title: "Cancel order",
      description: "updated",
      priority: "High",
      acceptanceCriteria: ["user can cancel"],
    });

    expect(prisma.jiraIssue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "iss-1" },
        data: expect.objectContaining({
          key: "QA-2",
          title: "Cancel order",
          priority: "High",
        }),
      }),
    );
    const data = (prisma.jiraIssue.update as jest.Mock).mock.calls[0][0].data;
    expect(data.acceptanceCriteria).toBeUndefined();
    expect(saved.key).toBe("QA-2");
  });

  it("rejects a key that belongs to another issue", async () => {
    const prisma = createPrisma();
    prisma.jiraIssue.findUnique
      .mockResolvedValueOnce({
        id: "iss-1",
        key: "QA-1",
        acceptanceCriteria: [],
      })
      .mockResolvedValueOnce({ id: "iss-2", key: "QA-9" });

    const service = new JiraService(prisma as never, config as never);
    await expect(
      service.updateIssue("iss-1", { key: "QA-9", title: "Other" }),
    ).rejects.toThrow(/already exists/);
    expect(prisma.jiraIssue.update).not.toHaveBeenCalled();
  });

  it("accepts non-numeric keys such as QA-DEMO", async () => {
    const prisma = createPrisma();
    prisma.jiraIssue.findUnique.mockResolvedValueOnce({
      id: "iss-1",
      key: "QA-DEMO",
      acceptanceCriteria: [],
    });
    prisma.jiraIssue.findFirst.mockResolvedValue({
      id: "iss-1",
      key: "QA-DEMO",
      title: "Demo",
    });
    const service = new JiraService(prisma as never, config as never);
    await service.updateIssue("iss-1", {
      key: "QA-DEMO",
      title: "Demo renamed",
    });
    expect(prisma.jiraIssue.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ key: "QA-DEMO", title: "Demo renamed" }),
      }),
    );
  });

  it("rejects an empty title", async () => {
    const prisma = createPrisma();
    prisma.jiraIssue.findUnique.mockResolvedValue({
      id: "iss-1",
      key: "QA-1",
      acceptanceCriteria: [],
    });
    const service = new JiraService(prisma as never, config as never);
    await expect(
      service.updateIssue("iss-1", { key: "QA-1", title: "   " }),
    ).rejects.toThrow(/key and title/);
  });

  it("deletes the issue together with its test cases and bugs", async () => {
    const prisma = createPrisma();
    prisma.jiraIssue.findUnique.mockResolvedValue({ id: "iss-1", key: "QA-1" });
    prisma.testCase.findMany.mockResolvedValue([{ id: "tc-1" }]);

    const service = new JiraService(prisma as never, config as never);
    const result = await service.deleteIssue("iss-1");

    expect(prisma.bug.deleteMany).toHaveBeenCalled();
    expect(prisma.testCase.deleteMany).toHaveBeenCalledWith({
      where: { jiraIssueId: "iss-1" },
    });
    expect(prisma.jiraIssue.delete).toHaveBeenCalledWith({
      where: { id: "iss-1" },
    });
    expect(result).toEqual({ deleted: true, id: "iss-1", key: "QA-1" });
  });

  it("fails when the issue to delete does not exist", async () => {
    const prisma = createPrisma();
    prisma.jiraIssue.findUnique.mockResolvedValue(null);
    const service = new JiraService(prisma as never, config as never);
    await expect(service.deleteIssue("missing")).rejects.toThrow(/not found/);
    expect(prisma.jiraIssue.delete).not.toHaveBeenCalled();
  });
});
