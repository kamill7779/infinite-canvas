-- AlterEnum
ALTER TYPE "GenStatus" ADD VALUE IF NOT EXISTS 'running';

-- AlterTable
ALTER TABLE "GenerationRecord"
    ADD COLUMN "jobId" TEXT,
    ADD COLUMN "clientRequestId" TEXT,
    ADD COLUMN "startedAt" TIMESTAMP(3),
    ADD COLUMN "finishedAt" TIMESTAMP(3),
    ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
