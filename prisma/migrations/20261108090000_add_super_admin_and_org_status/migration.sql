-- AlterTable
ALTER TABLE `User` ADD COLUMN `isSuperAdmin` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Organization` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

