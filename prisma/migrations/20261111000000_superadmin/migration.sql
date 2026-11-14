-- Super-Admin role + staff management. Additive only: no data is removed.

-- New role and audit action types.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPERADMIN';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'CREATE_ADMIN';
ALTER TYPE "AdminActionType" ADD VALUE IF NOT EXISTS 'DELETE_ADMIN';

-- Staff display name and last sign-in (for "last active" monitoring).
ALTER TABLE "users" ADD COLUMN "name" TEXT;
ALTER TABLE "users" ADD COLUMN "lastLoginAt" TIMESTAMP(3);

-- Keep the audit log when an admin is deleted: the actor link becomes NULL
-- and a name snapshot is kept in actorLabel / targetLabel.
ALTER TABLE "admin_actions" ADD COLUMN "actorLabel" TEXT;
ALTER TABLE "admin_actions" ADD COLUMN "targetLabel" TEXT;
ALTER TABLE "admin_actions" ALTER COLUMN "actorId" DROP NOT NULL;
ALTER TABLE "admin_actions" DROP CONSTRAINT "admin_actions_actorId_fkey";
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
