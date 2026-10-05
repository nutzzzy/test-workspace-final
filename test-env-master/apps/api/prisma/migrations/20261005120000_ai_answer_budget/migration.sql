-- Longest time a model may spend writing one answer; at the limit the answer written so far is used. 0 = no limit.
ALTER TABLE "ai_connections" ADD COLUMN "answerBudgetMs" INTEGER NOT NULL DEFAULT 180000;
