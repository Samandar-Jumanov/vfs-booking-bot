ALTER TABLE "profiles" ADD COLUMN "statusToken" TEXT;

UPDATE "profiles"
SET "statusToken" = 'st_' || substr(md5("id"), 1, 12)
WHERE "statusToken" IS NULL;

ALTER TABLE "profiles" ALTER COLUMN "statusToken" SET NOT NULL;

CREATE UNIQUE INDEX "profiles_statusToken_key" ON "profiles"("statusToken");
