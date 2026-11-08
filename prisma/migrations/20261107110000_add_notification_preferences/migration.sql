-- AlterTable
ALTER TABLE `User` ADD COLUMN `notifyDeployFailures` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `notifyDeploySuccess` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `notifyTeamChanges` BOOLEAN NOT NULL DEFAULT true;

