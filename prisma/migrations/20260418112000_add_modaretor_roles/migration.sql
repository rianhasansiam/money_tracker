-- Add the new global role and team role used by moderator-level users.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'MODARETOR';
ALTER TYPE "TeamMemberRole" ADD VALUE IF NOT EXISTS 'MODARETOR';
